"""
Hotel features end-to-end: setup/login/roles, rooms, every reception flow, staff & lock cards,
reports and settings - through the real server, a real WebSocket agent and the mock encoder.
"""
import sqlite3
import time
from datetime import datetime, timedelta

import httpx
import pytest

from app.config import Settings
from mock_dll import MockEncoder
from test_gateway_e2e import ADMIN, AgentThread, ServerThread

PASSWORD = "correct-horse-battery"


def at(dt):
    return dt.replace(second=0, microsecond=0).isoformat(timespec="minutes")


class Api:
    def __init__(self, base, token=None, key=None):
        headers = {}
        if token:
            headers["Authorization"] = "Bearer " + token
        if key:
            headers["X-API-Key"] = key
        self.c = httpx.Client(base_url=base, headers=headers, timeout=15)

    def __getattr__(self, name):
        return getattr(self.c, name)


def ok(r, code=200):
    assert r.status_code == code, "%s %s -> %s %s" % (r.request.method, r.request.url, r.status_code, r.text)
    return r.json() if r.content else None


def start_server(tmp_path, allow_uncalibrated=True):
    s = Settings(admin_keys=frozenset({ADMIN}), db_path=str(tmp_path / "hotel.db"), invoke_timeout=3.0,
                 allow_uncalibrated=allow_uncalibrated)
    return ServerThread(s)


def bootstrap(srv):
    anon = Api(srv.http)
    assert ok(anon.get("/v1/setup"))["needs_setup"] is True
    token = ok(anon.post("/v1/setup", json={"hotel_name": "Smart Zoom", "username": "boss", "name": "The Boss",
                                            "password": PASSWORD}))["token"]
    return Api(srv.http, token=token)


def wait_online(api, eid):
    for _ in range(200):
        if ok(api.get("/v1/encoders/" + eid))["online"]:
            return
        time.sleep(0.05)
    raise AssertionError("encoder offline")


def board(api):
    return {r["room_no"]: r for r in ok(api.get("/v1/reception/board"))["rooms"]}


@pytest.fixture
def hotel(tmp_path):
    with start_server(tmp_path) as srv:
        boss = bootstrap(srv)
        token = ok(boss.post("/v1/encoders", json={"id": "desk-1", "name": "Front Desk 1"}), 201)["token"]
        agent = AgentThread(srv.ws, "desk-1", token, encoder=MockEncoder()).start()
        try:
            wait_online(boss, "desk-1")
            yield srv, boss, agent
        finally:
            agent.stop()


# ---------------------------------------------------------------------------------------------
def test_setup_login_and_roles(tmp_path):
    with start_server(tmp_path) as srv:
        boss = bootstrap(srv)
        anon = Api(srv.http)
        assert ok(anon.get("/v1/setup"))["needs_setup"] is False
        assert anon.post("/v1/setup", json={"hotel_name": "x", "username": "evil", "name": "x",
                                            "password": PASSWORD}).status_code == 409
        assert anon.get("/v1/reception/board").status_code == 401

        me = ok(boss.get("/v1/auth/me"))
        assert me["role"] == "super" and "calibration" in me["permissions"]
        assert ok(boss.get("/v1/meta"))["hotel_name"] == "Smart Zoom"

        r = anon.post("/v1/auth/login", json={"username": "boss", "password": "nope"})
        assert r.status_code == 401 and r.json()["error"] == "bad_credentials"
        token = ok(anon.post("/v1/auth/login", json={"username": "BOSS", "password": PASSWORD}))["token"]
        assert ok(Api(srv.http, token=token).get("/v1/auth/me"))["operator"]["username"] == "boss"

        # operator management and role limits
        ok(boss.post("/v1/operators", json={"username": "desk", "name": "Desk", "role": "operator",
                                            "password": PASSWORD}), 201)
        mgr = ok(boss.post("/v1/operators", json={"username": "mgr", "name": "Manager", "role": "manager",
                                                  "password": PASSWORD}), 201)
        desk = Api(srv.http, token=ok(anon.post("/v1/auth/login", json={"username": "desk",
                                                                         "password": PASSWORD}))["token"])
        assert desk.get("/v1/operators").status_code == 403
        assert desk.put("/v1/settings", json={"hotel_name": "x"}).status_code == 403
        assert desk.post("/v1/buildings", json={"no": 1, "name": "A"}).status_code == 403
        assert boss.delete("/v1/operators/%d" % me["operator"]["id"]).status_code == 400
        r = boss.patch("/v1/operators/%d" % me["operator"]["id"], json={"role": "admin"})
        assert r.status_code == 400

        # deactivating an operator ends their session
        ok(boss.patch("/v1/operators/%d" % mgr["id"], json={"active": False}))
        assert anon.post("/v1/auth/login", json={"username": "mgr", "password": PASSWORD}).status_code == 401

        # password change
        ok(desk.post("/v1/auth/password", json={"current_password": PASSWORD,
                                                "new_password": "another-password"}), 204)
        ok(anon.post("/v1/auth/login", json={"username": "desk", "password": "another-password"}))

        # login lock-out after repeated failures
        for _ in range(5):
            anon.post("/v1/auth/login", json={"username": "desk", "password": "bad"})
        assert anon.post("/v1/auth/login", json={"username": "desk",
                                                  "password": "another-password"}).status_code == 429


def test_rooms_definition(hotel):
    srv, boss, _ = hotel
    ok(boss.post("/v1/buildings", json={"no": 1, "name": "Main"}), 201)
    assert boss.post("/v1/buildings", json={"no": 1, "name": "Dup"}).status_code == 409
    r = ok(boss.post("/v1/rooms/batch", json={"building_no": 1, "floors": "1-2", "rooms": "101-203",
                                              "room_type": "Double", "price": 500, "max_cards": 3}), 201)
    assert r["created"] == ["101", "102", "103", "201", "202", "203"]
    assert ok(boss.post("/v1/rooms/batch", json={"building_no": 1, "floors": "1-2", "rooms": "101-203"}),
              201)["skipped"] == r["created"]
    assert boss.post("/v1/rooms/batch", json={"building_no": 1, "floors": "3-1", "rooms": "101-102"}).status_code == 422
    rooms = ok(boss.get("/v1/rooms?building_no=1"))
    room_101 = rooms[0]
    assert (room_101["floor_no"], room_101["lock_room"], room_101["price"]) == (1, 1, 500)
    ok(boss.patch("/v1/rooms/%d" % room_101["id"], json={"room_type": "Suite", "public_door": True}))
    assert boss.patch("/v1/rooms/%d" % room_101["id"], json={"room_no": "102"}).status_code == 409
    single = ok(boss.post("/v1/rooms", json={"building_no": 1, "floor_no": 3, "lock_room": 1, "room_no": "301"}), 201)
    ok(boss.delete("/v1/rooms/%d" % single["id"]), 204)
    assert all(r["status"] == "VC" for r in board(boss).values())


def test_reception_flows(hotel):
    srv, boss, agent = hotel
    ok(boss.post("/v1/buildings", json={"no": 1, "name": "Main"}), 201)
    ok(boss.post("/v1/rooms/batch", json={"building_no": 1, "floors": "1-2", "rooms": "101-203", "price": 400,
                                          "hour_start_price": 50, "hour_price": 20, "max_cards": 2}), 201)
    ok(boss.post("/v1/operators", json={"username": "desk", "name": "Desk", "role": "operator",
                                        "password": PASSWORD}), 201)
    desk = Api(srv.http, token=ok(Api(srv.http).post("/v1/auth/login", json={"username": "desk",
                                                                               "password": PASSWORD}))["token"])
    b = board(desk)
    now = datetime.now()
    tomorrow_noon = (now + timedelta(days=1)).replace(hour=12, minute=0)
    guest = {"name": "Ali Hassan", "sex": "M", "id_type": "Passport", "id_no": "P123", "phone": "+20100"}

    # --- walk-in check-in issues the card first, then records the stay
    stay = ok(desk.post("/v1/reception/check-in", json={
        "encoder_id": "desk-1", "room_id": b["101"]["id"], "guest": guest,
        "companions": [{"name": "Mona Hassan"}], "check_out": at(tomorrow_noon), "deposit": 100}), 201)
    assert stay["status"] == "active" and stay["cards_issued"] == 1 and stay["price"] == 400
    assert [g["name"] for g in stay["guests"]] == ["Ali Hassan", "Mona Hassan"]
    assert stay["cards"][0]["card_data"].startswith("D801360F3E010101")
    fn, args = agent.encoder.calls[-1]
    assert fn == "GuestCard" and args[2:5] == [["i", 1], ["i", 1], ["i", 1]]
    assert board(desk)["101"]["status"] == "OC"
    r = desk.post("/v1/reception/check-in", json={"encoder_id": "desk-1", "room_id": b["101"]["id"],
                                                  "guest": guest, "check_out": at(tomorrow_noon)})
    assert r.status_code == 409 and r.json()["error"] == "room_occupied"
    assert desk.post("/v1/reception/check-in", json={"encoder_id": "desk-1", "room_id": b["102"]["id"],
                                                     "guest": guest, "check_out": at(now - timedelta(hours=1))}
                     ).status_code == 422

    # --- copy card, max cards
    sid = stay["id"]
    assert ok(desk.post("/v1/stays/%d/cards" % sid, json={"encoder_id": "desk-1"}), 201)["cards_issued"] == 2
    r = desk.post("/v1/stays/%d/cards" % sid, json={"encoder_id": "desk-1"})
    assert r.status_code == 409 and r.json()["error"] == "max_cards"

    # --- card info recognises the card on the reader
    info = ok(desk.post("/v1/cards/inspect", json={"encoder_id": "desk-1"}))
    assert info["known"] and info["card"]["kind"] == "guest" and info["stay"]["id"] == sid
    assert info["card_type_code"] == 0x3E

    # --- extend (rewrites the card) and change room
    later = at(tomorrow_noon + timedelta(days=2))
    ext = ok(desk.post("/v1/stays/%d/extend" % sid, json={"check_out": later, "encoder_id": "desk-1"}))
    assert ext["check_out"] == later and ext["cards"][0]["note"] == "Extended"
    moved = ok(desk.post("/v1/stays/%d/move" % sid, json={"encoder_id": "desk-1", "room_id": b["102"]["id"]}))
    assert moved["room"]["room_no"] == "102" and moved["cards_issued"] == 1
    assert all(c["status"] == "replaced" for c in moved["cards"][1:])
    bd = board(desk)
    assert bd["101"]["status"] == "VD" and bd["102"]["status"] == "OC"
    ok(desk.put("/v1/rooms/%d/housekeeping" % b["101"]["id"], json={"housekeeping": "clean"}))
    assert board(desk)["101"]["status"] == "VC"
    ok(desk.put("/v1/rooms/%d/housekeeping" % b["203"]["id"], json={"housekeeping": "maintenance",
                                                                    "note": "AC broken"}))
    assert board(desk)["203"]["status"] == "OO"
    assert desk.put("/v1/rooms/%d/housekeeping" % b["102"]["id"],
                    json={"housekeeping": "maintenance"}).status_code == 409

    # --- reservations: availability, arrival, partial cancel
    ci, co = at(now), at(now + timedelta(days=2))
    avail = {r["room_no"] for r in ok(desk.get("/v1/rooms/available", params={"check_in": ci, "check_out": co}))}
    assert avail == {"101", "103", "201", "202"}
    party = ok(desk.post("/v1/reservations", json={"leader": {"name": "Tour Leader", "id_no": "T9"},
                                                   "room_ids": [b["201"]["id"], b["202"]["id"]],
                                                   "check_in": ci, "check_out": co}), 201)
    assert {s["status"] for s in party["stays"]} == {"reserved"}
    bd = board(desk)
    assert bd["201"]["status"] == "OT" and bd["202"]["reservation"]["party_name"] == "Tour Leader"
    r = desk.post("/v1/reception/check-in", json={"encoder_id": "desk-1", "room_id": b["201"]["id"],
                                                  "guest": guest, "check_out": co})
    assert r.status_code == 409 and r.json()["error"] == "room_reserved"
    s201 = next(s for s in party["stays"] if s["room_no"] == "201")
    s202 = next(s for s in party["stays"] if s["room_no"] == "202")
    assert ok(desk.post("/v1/stays/%d/arrive" % s201["id"], json={"encoder_id": "desk-1"}))["status"] == "active"
    ok(desk.post("/v1/parties/%d/cancel" % party["id"], json={"stay_ids": [s202["id"]]}))
    assert board(desk)["202"]["status"] == "VC"
    assert [p["id"] for p in ok(desk.get("/v1/parties", params={"kind": "reservation"}))] == [party["id"]]

    # --- team check-in, one card per room, group check-out
    team = ok(desk.post("/v1/reception/team", json={"leader": {"name": "Team Lead"},
                                                    "room_ids": [b["103"]["id"], b["202"]["id"]],
                                                    "check_out": at(tomorrow_noon)}), 201)
    for s in team["stays"]:
        assert ok(desk.post("/v1/stays/%d/cards" % s["id"], json={"encoder_id": "desk-1"}), 201)["cards_issued"] == 1
    assert board(desk)["103"]["status"] == "TM"
    ok(desk.post("/v1/parties/%d/checkout" % team["id"]))
    bd = board(desk)
    assert bd["103"]["status"] == "VD" and bd["202"]["status"] == "VD"

    # --- hourly
    hourly = ok(desk.post("/v1/reception/check-in", json={"encoder_id": "desk-1", "room_id": b["101"]["id"],
                                                          "kind": "hourly", "hours": 3, "guest": {"name": "H"}}), 201)
    assert hourly["price"] == 50 + 20 * 3 and board(desk)["101"]["status"] == "OH"

    # --- overdue: a stay whose check-out has passed shows as TO
    con = sqlite3.connect(str(srv.server.config.app.state.db._conn.execute("PRAGMA database_list").fetchone()[2]))
    con.execute("UPDATE stays SET check_out=? WHERE id=?", (at(now - timedelta(hours=1)), hourly["id"]))
    con.commit()
    con.close()
    assert board(desk)["101"]["status"] == "TO"
    ok(desk.post("/v1/stays/%d/checkout" % hourly["id"]))

    # --- check-out with the card: card of room 102 on the reader -> stay checked out, card erased
    ok(desk.post("/v1/stays/%d/cards" % sid, json={"encoder_id": "desk-1"}), 201)
    out = ok(desk.post("/v1/cards/checkout", json={"encoder_id": "desk-1"}))
    assert out["status"] == "checked_out" and out["cards"][0]["status"] == "erased"
    assert agent.encoder.card == "0" * 32
    r = desk.post("/v1/cards/checkout", json={"encoder_id": "desk-1"})
    assert r.status_code == 409

    # --- card erase
    ok(desk.post("/v1/stays/%d/cards" % s201["id"], json={"encoder_id": "desk-1"}), 201)
    erased = ok(desk.post("/v1/cards/erase", json={"encoder_id": "desk-1"}))
    assert erased["erased"] and erased["card"]["status"] == "erased"
    assert desk.post("/v1/cards/erase", json={"encoder_id": "desk-1"}).status_code == 409  # now blank

    # --- reports
    cards = ok(desk.get("/v1/reports/cards"))
    assert {c["kind"] for c in cards} == {"guest"} and len(cards) >= 8
    assert desk.get("/v1/reports/cards", params={"format": "csv"}).status_code == 403   # export = managers
    csv = boss.get("/v1/reports/cards", params={"format": "csv"})
    assert csv.status_code == 200 and csv.text.startswith("﻿ID,Type,Room")
    guests = ok(desk.get("/v1/reports/guests", params={"q": "Hassan"}))
    assert {g["name"] for g in guests} == {"Ali Hassan", "Mona Hassan"}
    assert desk.post("/v1/reports/cards/cleanup").status_code == 403
    assert ok(boss.post("/v1/reports/guests/cleanup"))["deleted"] >= 3


def test_staff_and_lock_cards(hotel):
    srv, boss, agent = hotel
    ok(boss.post("/v1/buildings", json={"no": 2, "name": "Annex"}), 201)
    room = ok(boss.post("/v1/rooms", json={"building_no": 2, "floor_no": 5, "lock_room": 7, "room_no": "507"}), 201)
    ok(boss.post("/v1/operators", json={"username": "mgr", "name": "M", "role": "manager", "password": PASSWORD}), 201)
    mgr = Api(srv.http, token=ok(Api(srv.http).post("/v1/auth/login", json={"username": "mgr",
                                                                             "password": PASSWORD}))["token"])
    until = at(datetime.now() + timedelta(days=30))
    base = {"encoder_id": "desk-1", "holder": "Housekeeping A", "valid_to": until}

    floor = ok(mgr.post("/v1/staff-cards", json={**base, "kind": "floor", "building_no": 2, "floor_no": 5,
                                                  "time_from": "08:00", "time_to": "18:00"}), 201)
    assert floor["kind_label"] == "Floor card" and floor["card_data"].startswith("D801360FB2")
    assert agent.encoder.calls[-1][0] == "FloorCard"
    assert mgr.post("/v1/staff-cards", json={**base, "kind": "floor", "building_no": 2}).status_code == 422
    r = mgr.post("/v1/staff-cards", json={**base, "kind": "master"})
    assert r.status_code == 403
    master = ok(boss.post("/v1/staff-cards", json={**base, "kind": "master", "holder": "GM"}), 201)
    assert master["card_data"].startswith("D801360FBE")
    loss = ok(mgr.post("/v1/staff-cards", json={**base, "kind": "loss", "target_card_id": floor["id"]}), 201)
    assert loss["kind"] == "loss"
    cards = {c["id"]: c for c in ok(mgr.get("/v1/reports/cards"))}
    assert cards[floor["id"]]["status"] == "lost"

    assert mgr.post("/v1/lock-setup", json={"encoder_id": "desk-1", "kind": "authorization"}).status_code == 403
    auth = ok(boss.post("/v1/lock-setup", json={"encoder_id": "desk-1", "kind": "authorization"}), 201)
    assert auth["kind"] == "authorization"
    rs = ok(boss.post("/v1/lock-setup", json={"encoder_id": "desk-1", "kind": "room_set", "room_id": room["id"]}), 201)
    fn, args = agent.encoder.calls[-1]
    assert fn == "RoomSetCard" and args[2:6] == [["i", 2], ["i", 5], ["i", 7], ["s", "507"]] and rs["note"] == "Room 507"
    assert boss.post("/v1/lock-setup", json={"encoder_id": "desk-1", "kind": "group_set",
                                             "group_action": "set_one"}).status_code == 422
    ok(boss.post("/v1/lock-setup", json={"encoder_id": "desk-1", "kind": "group_set", "group_action": "set_one",
                                         "group_no": 5}), 201)
    ok(boss.put("/v1/settings", json={"lock_options": {"alarm": True, "music": True}, "co_id": 79375}))
    ok(boss.post("/v1/lock-setup", json={"encoder_id": "desk-1", "kind": "system"}), 201)
    fn, args = agent.encoder.calls[-1]
    # alarm(1) + remind_close(2, default on) + no_disturb(4, default on) + music(16) + guest deadbolt(64)
    assert fn == "SpecialCard" and args[1] == ["i", 1 | 2 | 4 | 16 | 64]

    # door-open records from a record card
    assert ok(mgr.post("/v1/reports/open-records/upload", json={"encoder_id": "desk-1"}))["uploaded"] == 4
    recs = ok(mgr.get("/v1/reports/open-records"))
    assert recs[0]["opened_at"] == "2026-11-08T17:33" and recs[0]["room_label"] == "101"


def test_uncalibrated_card_operations_are_blocked(tmp_path):
    with start_server(tmp_path, allow_uncalibrated=False) as srv:
        boss = bootstrap(srv)
        token = ok(boss.post("/v1/encoders", json={"id": "desk-1", "name": "Desk"}), 201)["token"]
        agent = AgentThread(srv.ws, "desk-1", token).start()
        try:
            wait_online(boss, "desk-1")
            ok(boss.post("/v1/buildings", json={"no": 1, "name": "Main"}), 201)
            room = ok(boss.post("/v1/rooms", json={"building_no": 1, "floor_no": 1, "lock_room": 1,
                                                   "room_no": "101"}), 201)
            meta = ok(boss.get("/v1/meta"))
            assert meta["calibrated"]["read_card"] is True and meta["calibrated"]["issue_guest"] is False
            r = boss.post("/v1/reception/check-in", json={
                "encoder_id": "desk-1", "room_id": room["id"], "guest": {"name": "X"},
                "check_out": at(datetime.now() + timedelta(days=1))})
            assert r.status_code == 409 and r.json()["error"] == "template_not_calibrated"
            assert board(boss)["101"]["status"] == "VC"          # nothing recorded
            assert not any(fn == "GuestCard" for fn, _ in agent.encoder.calls)
            # reading still works
            assert ok(boss.post("/v1/cards/inspect", json={"encoder_id": "desk-1"}))["known"] is False
        finally:
            agent.stop()


# ---------------------------------------------------------------------------------------------
def test_languages_preferences_and_structured_errors(tmp_path):
    with start_server(tmp_path) as srv:
        anon = Api(srv.http)
        token = ok(anon.post("/v1/setup", json={"hotel_name": "فندق", "username": "boss", "name": "Boss",
                                                "password": PASSWORD, "language": "ar"}))["token"]
        boss = Api(srv.http, token=token)
        st = ok(anon.get("/v1/setup"))
        assert st["default_language"] == "ar" and st["languages"] == ["en", "ar", "zh", "ru", "tr", "vi"]
        assert ok(boss.get("/v1/auth/me"))["operator"]["language"] == "ar"

        ok(boss.put("/v1/auth/preferences", json={"language": "zh"}))
        assert ok(boss.get("/v1/auth/me"))["operator"]["language"] == "zh"
        assert boss.put("/v1/auth/preferences", json={"language": "xx"}).status_code == 422
        assert ok(boss.put("/v1/settings", json={"default_language": "ru"}))["default_language"] == "ru"
        assert boss.put("/v1/settings", json={"default_language": "de"}).status_code == 422
        assert ok(boss.get("/v1/meta"))["default_language"] == "ru"

        # errors carry the fields the UI needs to translate them
        r = anon.post("/v1/auth/login", json={"username": "boss", "password": "x"})
        assert r.json()["error"] == "bad_credentials"
        r = boss.post("/v1/operators", json={"username": "boss", "name": "x", "role": "operator", "password": PASSWORD})
        assert r.json()["error"] == "username_taken" and r.json()["username"] == "boss"

        tok = ok(boss.post("/v1/encoders", json={"id": "d1", "name": "Desk"}), 201)["token"]
        agent = AgentThread(srv.ws, "d1", tok).start()
        try:
            wait_online(boss, "d1")
            ok(boss.post("/v1/buildings", json={"no": 1, "name": "A"}), 201)
            room = ok(boss.post("/v1/rooms", json={"building_no": 1, "floor_no": 1, "lock_room": 1, "room_no": "101",
                                                   "max_cards": 1}), 201)
            body = {"encoder_id": "d1", "room_id": room["id"], "guest": {"name": "X"},
                    "check_out": at(datetime.now() + timedelta(days=1))}
            stay = ok(boss.post("/v1/reception/check-in", json=body), 201)
            r = boss.post("/v1/reception/check-in", json=body)
            assert r.json()["error"] == "room_occupied" and r.json()["room_no"] == "101"
            r = boss.post("/v1/stays/%d/cards" % stay["id"], json={"encoder_id": "d1"})
            assert r.json()["error"] == "max_cards" and (r.json()["room_no"], r.json()["max"]) == ("101", 1)
        finally:
            agent.stop()
        r = boss.post("/v1/encoders/d1/beep", json={})
        assert r.status_code == 503 and r.json()["error"] == "encoder_offline" and r.json()["encoder"] == "Desk"


def test_existing_database_gets_language_column(tmp_path):
    """Databases created before languages existed are upgraded in place."""
    path = tmp_path / "old.db"
    con = sqlite3.connect(str(path))
    con.executescript("""
        CREATE TABLE operators (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            note TEXT, created_at TEXT NOT NULL, last_login TEXT);
        INSERT INTO operators (username, name, role, password_hash, created_at) VALUES ('old', 'Old', 'super', 'x', 'now');
    """)
    con.commit()
    con.close()
    from app.db import Database
    db = Database(str(path))
    cols = {r["name"] for r in db.query("PRAGMA table_info(operators)")}
    assert "language" in cols
    assert db.one("SELECT username, language FROM operators") == {"username": "old", "language": None}
    db.close()
