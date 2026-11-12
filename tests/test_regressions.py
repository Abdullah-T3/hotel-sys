"""
Regression tests for bugs found in the November 2026 review. Each test names the bug it guards.
Race conditions are reproduced with a deliberately slow mock encoder, so two requests really overlap.
"""
import sqlite3
import threading
import time
from datetime import datetime, timedelta

import pytest

from mock_dll import MockEncoder
from test_gateway_e2e import AgentThread
from test_hotel import PASSWORD, Api, at, board, bootstrap, ok, start_server, wait_online


class SlowEncoder(MockEncoder):
    """Writing a guest card takes 0.6 s - long enough for a second desk to act in between."""

    def _GuestCard(self, descs):
        time.sleep(0.6)
        return super()._GuestCard(descs)


def guest_card_calls(agent):
    return [args for fn, args in agent.encoder.calls if fn == "GuestCard"]


def login(srv, username):
    return Api(srv.http, token=ok(Api(srv.http).post("/v1/auth/login", json={"username": username,
                                                                              "password": PASSWORD}))["token"])


def in_parallel(*calls):
    """Run calls on threads; the second starts 0.2 s after the first (mid card-write)."""
    results = [None] * len(calls)

    def run(i, fn):
        results[i] = fn()
    threads = []
    for i, fn in enumerate(calls):
        th = threading.Thread(target=run, args=(i, fn))
        th.start()
        threads.append(th)
        time.sleep(0.2)
    for th in threads:
        th.join(15)
    return results


def set_stay(srv, stay_id, **cols):
    path = srv.server.config.app.state.db._conn.execute("PRAGMA database_list").fetchone()[2]
    con = sqlite3.connect(path)
    con.execute("UPDATE stays SET %s WHERE id=?" % ",".join("%s=?" % k for k in cols), (*cols.values(), stay_id))
    con.commit()
    con.close()


@pytest.fixture
def hotel(tmp_path):
    with start_server(tmp_path) as srv:
        boss = bootstrap(srv)
        token = ok(boss.post("/v1/encoders", json={"id": "d1", "name": "Desk"}), 201)["token"]
        agent = AgentThread(srv.ws, "d1", token, encoder=SlowEncoder()).start()
        try:
            wait_online(boss, "d1")
            ok(boss.post("/v1/buildings", json={"no": 1, "name": "Main"}), 201)
            ok(boss.post("/v1/rooms/batch", json={"building_no": 1, "floors": "1", "rooms": "101-104",
                                                  "max_cards": 1}), 201)
            for name, role in (("desk", "operator"), ("mgr", "manager")):
                ok(boss.post("/v1/operators", json={"username": name, "name": name, "role": role,
                                                    "password": PASSWORD}), 201)
            rooms = {r["room_no"]: r["id"] for r in ok(boss.get("/v1/rooms"))}
            yield srv, boss, agent, rooms
        finally:
            agent.stop()


def checkin_body(room_id, days=1, name="G"):
    return {"encoder_id": "d1", "room_id": room_id, "guest": {"name": name},
            "check_out": at(datetime.now() + timedelta(days=days))}


# --------------------------------------------------------------------------------------- availability
def test_overdue_room_is_not_free(hotel):
    """An overdue guest still occupies the room: it must not be sold again."""
    srv, boss, agent, rooms = hotel
    stay = ok(boss.post("/v1/reception/check-in", json=checkin_body(rooms["101"])), 201)
    set_stay(srv, stay["id"], check_out=at(datetime.now() - timedelta(hours=2)))
    assert board(boss)["101"]["status"] == "TO"

    now, later = at(datetime.now()), at(datetime.now() + timedelta(days=1))
    free = {r["room_no"] for r in ok(boss.get("/v1/rooms/available", params={"check_in": now, "check_out": later}))}
    assert "101" not in free
    writes = len(guest_card_calls(agent))
    r = boss.post("/v1/reception/check-in", json=checkin_body(rooms["101"]))
    assert r.status_code == 409 and r.json()["error"] == "room_occupied"
    assert len(guest_card_calls(agent)) == writes, "no card may be written for an occupied room"
    r = boss.post("/v1/reception/team", json={"leader": {"name": "T"}, "room_ids": [rooms["101"]], "check_out": later})
    assert r.status_code == 409


def test_early_arrival_respects_other_reservations(hotel):
    """Arriving early must not swallow another reservation of the same room."""
    srv, boss, agent, rooms = hotel
    d = lambda n: at(datetime.now() + timedelta(days=n))  # noqa: E731
    b = ok(boss.post("/v1/reservations", json={"leader": {"name": "B"}, "room_ids": [rooms["102"]],
                                               "check_in": d(3), "check_out": d(5)}), 201)
    a = ok(boss.post("/v1/reservations", json={"leader": {"name": "A"}, "room_ids": [rooms["102"]],
                                               "check_in": d(7), "check_out": d(9)}), 201)
    r = boss.post("/v1/stays/%d/arrive" % a["stays"][0]["id"], json={"encoder_id": "d1"})
    assert r.status_code == 409 and r.json()["error"] == "room_reserved"
    assert ok(boss.post("/v1/stays/%d/arrive" % b["stays"][0]["id"], json={"encoder_id": "d1"}))["status"] == "active"


# --------------------------------------------------------------------------------------- concurrency
def test_reservation_waits_for_walk_in_card_write(hotel):
    """While a walk-in card is being written, another desk cannot reserve the same room."""
    srv, boss, agent, rooms = hotel
    tomorrow = at(datetime.now() + timedelta(days=1))
    r1, r2 = in_parallel(
        lambda: boss.post("/v1/reception/check-in", json=checkin_body(rooms["103"])),
        lambda: boss.post("/v1/reservations", json={"leader": {"name": "R"}, "room_ids": [rooms["103"]],
                                                    "check_in": at(datetime.now()), "check_out": tomorrow}))
    assert sorted([r1.status_code, r2.status_code]) == [201, 409]
    assert r1.status_code == 201


def test_two_desks_cannot_exceed_card_limit(hotel):
    """Two desks issuing a card for the same stay at once: only one gets it (max_cards=1)."""
    srv, boss, agent, rooms = hotel
    team = ok(boss.post("/v1/reception/team", json={"leader": {"name": "T"}, "room_ids": [rooms["104"]],
                                                    "check_out": at(datetime.now() + timedelta(days=1))}), 201)
    sid = team["stays"][0]["id"]
    r1, r2 = in_parallel(lambda: boss.post("/v1/stays/%d/cards" % sid, json={"encoder_id": "d1"}),
                         lambda: boss.post("/v1/stays/%d/cards" % sid, json={"encoder_id": "d1"}))
    assert sorted([r1.status_code, r2.status_code]) == [201, 409]
    stay = ok(boss.get("/v1/stays/%d" % sid))
    assert stay["cards_issued"] == 1 and len(stay["cards"]) == 1
    assert [a[5] for a in guest_card_calls(agent)] == [["i", 0]], "exactly one card, as a new check-in"


def test_checkout_waits_for_card_write(hotel):
    """Checking out while a copy card is being written must not leave an active card behind."""
    srv, boss, agent, rooms = hotel
    ok(boss.patch("/v1/rooms/%d" % rooms["101"], json={"max_cards": 3}))
    stay = ok(boss.post("/v1/reception/check-in", json=checkin_body(rooms["101"])), 201)
    r1, r2 = in_parallel(lambda: boss.post("/v1/stays/%d/cards" % stay["id"], json={"encoder_id": "d1"}),
                         lambda: boss.post("/v1/stays/%d/checkout" % stay["id"]))
    assert (r1.status_code, r2.status_code) == (201, 200)
    after = ok(boss.get("/v1/stays/%d" % stay["id"]))
    assert after["status"] == "checked_out"
    assert not [c for c in after["cards"] if c["status"] == "active"]


# --------------------------------------------------------------------------------------- cards
def test_extend_before_first_card_writes_a_check_in_card(hotel):
    """A team room without a card, extended with an encoder: that card must replace the old guest's card."""
    srv, boss, agent, rooms = hotel
    old = ok(boss.post("/v1/reception/check-in", json=checkin_body(rooms["102"], name="Old")), 201)
    ok(boss.post("/v1/stays/%d/checkout" % old["id"]))           # old guest leaves without the card
    team = ok(boss.post("/v1/reception/team", json={"leader": {"name": "T"}, "room_ids": [rooms["102"]],
                                                    "check_out": at(datetime.now() + timedelta(days=1))}), 201)
    sid = team["stays"][0]["id"]
    ok(boss.post("/v1/stays/%d/extend" % sid, json={"check_out": at(datetime.now() + timedelta(days=2)),
                                                    "encoder_id": "d1"}))
    assert guest_card_calls(agent)[-1][5] == ["i", 0], "first card of a stay is a new check-in card"
    cards = ok(boss.get("/v1/reports/cards", params={"q": "Old"}))
    assert cards and all(c["status"] in ("checked_out", "replaced") for c in cards)


def test_checkout_with_card_marks_only_that_card_erased(hotel):
    srv, boss, agent, rooms = hotel
    ok(boss.patch("/v1/rooms/%d" % rooms["101"], json={"max_cards": 3}))
    stay = ok(boss.post("/v1/reception/check-in", json=checkin_body(rooms["101"])), 201)
    ok(boss.post("/v1/stays/%d/cards" % stay["id"], json={"encoder_id": "d1"}), 201)   # copy is on the reader now
    out = ok(boss.post("/v1/cards/checkout", json={"encoder_id": "d1"}))
    assert sorted(c["status"] for c in out["cards"]) == ["checked_out", "erased"]


def test_front_desk_cannot_erase_unknown_master_card(hotel):
    """A master card made by the vendor software is unknown to us - front desk must not erase it."""
    srv, boss, agent, rooms = hotel
    agent.encoder.card = "D801360FBE0000630000000000000000"  # 0xBE = master card
    r = login(srv, "desk").post("/v1/cards/erase", json={"encoder_id": "d1"})
    assert r.status_code == 403
    assert ok(login(srv, "mgr").post("/v1/cards/erase", json={"encoder_id": "d1"}))["erased"]


def test_low_level_card_endpoints_need_calibration_permission(hotel):
    srv, boss, agent, rooms = hotel
    desk = login(srv, "desk")
    assert desk.post("/v1/encoders/d1/cards/erase").status_code == 403
    assert desk.post("/v1/encoders/d1/cards/guest", json={"building": 1, "floor": 1, "room": 1,
                                                          "start": at(datetime.now()),
                                                          "end": at(datetime.now() + timedelta(days=1))}
                     ).status_code == 403


def test_staff_card_numbers_never_repeat(hotel):
    """Card numbers must keep increasing after report cleanup deletes old cards."""
    srv, boss, agent, rooms = hotel
    body = {"encoder_id": "d1", "kind": "floor", "holder": "H", "building_no": 1, "floor_no": 1,
            "valid_to": at(datetime.now() + timedelta(days=30))}
    first = [ok(boss.post("/v1/staff-cards", json=body), 201) for _ in range(3)]
    ok(boss.post("/v1/staff-cards", json={**body, "kind": "loss", "target_card_id": first[2]["id"]}), 201)
    assert ok(boss.post("/v1/reports/cards/cleanup"))["deleted"] >= 1
    ok(boss.post("/v1/staff-cards", json=body), 201)
    indexes = [args[2] for fn, args in agent.encoder.calls if fn == "FloorCard"]
    assert indexes == [["i", 0], ["i", 1], ["i", 2], ["i", 3]]


# --------------------------------------------------------------------------------------- reports & settings
def test_card_report_status_filter_applies_before_limit(hotel):
    srv, boss, agent, rooms = hotel
    stay = ok(boss.post("/v1/reception/check-in", json=checkin_body(rooms["101"])), 201)
    ok(boss.post("/v1/stays/%d/checkout" % stay["id"]))
    ok(boss.post("/v1/staff-cards", json={"encoder_id": "d1", "kind": "master", "holder": "GM",
                                          "valid_to": at(datetime.now() + timedelta(days=30))}), 201)
    rows = ok(boss.get("/v1/reports/cards", params={"status": "checked_out", "limit": 1}))
    assert len(rows) == 1 and rows[0]["status"] == "checked_out"
    rows = ok(boss.get("/v1/reports/cards", params={"status": "active", "limit": 5}))
    assert [r["kind"] for r in rows] == ["master"]


def test_cleanup_keeps_overdue_guests_card(hotel):
    srv, boss, agent, rooms = hotel
    stay = ok(boss.post("/v1/reception/check-in", json=checkin_body(rooms["101"])), 201)
    set_stay(srv, stay["id"], check_out=at(datetime.now() - timedelta(hours=1)))
    path = srv.server.config.app.state.db._conn.execute("PRAGMA database_list").fetchone()[2]
    con = sqlite3.connect(path)
    con.execute("UPDATE cards SET valid_to=? WHERE stay_id=?", (at(datetime.now() - timedelta(hours=1)), stay["id"]))
    con.commit()
    con.close()
    ok(boss.post("/v1/reports/cards/cleanup"))
    assert ok(boss.get("/v1/stays/%d" % stay["id"]))["cards"], "the overdue guest's card record must survive"
    assert ok(boss.post("/v1/cards/checkout", json={"encoder_id": "d1"}))["status"] == "checked_out"


def test_csv_export_needs_manager(hotel):
    srv, boss, agent, rooms = hotel
    desk, mgr = login(srv, "desk"), login(srv, "mgr")
    for path in ("/v1/reports/cards", "/v1/reports/guests", "/v1/reports/open-records"):
        assert desk.get(path).status_code == 200
        assert desk.get(path, params={"format": "csv"}).status_code == 403
        assert mgr.get(path, params={"format": "csv"}).status_code == 200


def test_changing_one_lock_option_keeps_the_others(hotel):
    srv, boss, agent, rooms = hotel
    ok(boss.put("/v1/settings", json={"lock_options": {"alarm": True, "remind_close": False, "disable_cover": True}}))
    opts = ok(boss.put("/v1/settings", json={"lock_options": {"music": True}}))["lock_options"]
    assert opts == {"alarm": True, "remind_close": False, "disable_cover": True, "music": True,
                    "no_disturb": True, "release_handle_lock": False}


def test_editing_operator_note_keeps_them_signed_in(hotel):
    srv, boss, agent, rooms = hotel
    desk = login(srv, "desk")
    op = next(o for o in ok(boss.get("/v1/operators")) if o["username"] == "desk")
    ok(boss.patch("/v1/operators/%d" % op["id"], json={"note": "night shift", "role": "operator"}))
    assert desk.get("/v1/auth/me").status_code == 200
    ok(boss.patch("/v1/operators/%d" % op["id"], json={"role": "manager"}))
    assert desk.get("/v1/auth/me").status_code == 401, "a real role change still ends the session"


def test_duplicate_errors_say_what_clashes(hotel):
    srv, boss, agent, rooms = hotel
    r = boss.post("/v1/rooms", json={"building_no": 1, "floor_no": 1, "lock_room": 1, "room_no": "101"})
    assert r.status_code == 409 and r.json()["error"] == "room_exists" and r.json()["room_no"] == "101"
    assert r.json()["lock"] == "1-1-1"
    r = boss.post("/v1/buildings", json={"no": 1, "name": "Again"})
    assert r.json()["error"] == "building_exists" and r.json()["no"] == 1
    r = boss.post("/v1/encoders", json={"id": "d1", "name": "Again"})
    assert r.json()["error"] == "encoder_exists" and r.json()["id"] == "d1"
