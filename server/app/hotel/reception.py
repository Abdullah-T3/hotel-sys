"""
Reception (CardLock: front desk): room board, check-in (walk-in / hourly / team),
reservations, extra cards, extend, change room, check-out, card info and erase.

Rule used everywhere: talk to the encoder FIRST, then write the database. If the
card cannot be written, nothing changes and the operator can simply retry.
"""
import asyncio
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Request

from ..cardops import run_template
from ..db import local_now
from ..errors import GatewayError, card_data_from, conflict, not_found
from ..security import Principal, require
from . import service as svc
from .models import (CancelIn, CardOnReaderIn, CheckInIn, CheckoutByCardIn, EncoderRef, ExtendIn, MoveIn,
                     ReservationIn, TeamCheckInIn)

router = APIRouter(prefix="/v1", tags=["reception"])
RECEPTION = require("reception")


# ----------------------------------------------------------------------------- helpers
def room_lock(state, room_id):
    locks = state.room_locks
    if room_id not in locks:
        locks[room_id] = asyncio.Lock()
    return locks[room_id]


async def issue_guest_card(state, p, encoder_id, room, start, end, card_index, audit_req):
    _, outs, _ = await run_template(
        state, p, encoder_id, "issue_guest",
        {"building": room["building_no"], "floor": room["floor_no"], "room": room["lock_room"],
         "start": start, "end": end, "card_index": card_index}, audit_req)
    return card_data_from(outs[-1]) if outs else None


def replace_previous_guest_cards(t, room_id, keep_stay_id):
    """A new check-in card makes the lock reject every older guest card for that room."""
    t.execute("UPDATE cards SET status='replaced' WHERE kind='guest' AND status='active' AND room_id=? "
              "AND (stay_id IS NULL OR stay_id != ?)", (room_id, keep_stay_id))


def add_guests(t, stay_id, primary, companions=()):
    t.execute("INSERT INTO guests (stay_id, name, sex, id_type, id_no, phone, is_primary) VALUES (?,?,?,?,?,?,1)",
              (stay_id, primary.name, primary.sex, primary.id_type, primary.id_no, primary.phone))
    for g in companions:
        t.execute("INSERT INTO guests (stay_id, name, sex, id_type, id_no, phone, is_primary) "
                  "VALUES (?,?,?,?,?,?,0)", (stay_id, g.name, g.sex, g.id_type, g.id_no, g.phone))


def checkout_stay(t, db, stay, erased_card_data=None):
    now = svc.fmt(local_now())
    t.execute("UPDATE stays SET status='checked_out', checked_out_at=? WHERE id=?", (now, stay["id"]))
    t.execute("UPDATE cards SET status='checked_out' WHERE stay_id=? AND status='active'", (stay["id"],))
    if erased_card_data:
        t.execute("UPDATE cards SET status='erased' WHERE stay_id=? AND card_data=?",
                  (stay["id"], erased_card_data))
    svc.mark_room_after_checkout(t, db, stay["room_id"])


async def read_card_on_reader(state, p, encoder_id):
    """Read whatever card is on the encoder and match it against issued cards."""
    _, outs, _ = await run_template(state, p, encoder_id, "read_card", {})
    data = card_data_from(outs[0])
    blank = not data or set(data) <= {"0"} or set(data) <= {"F"}
    type_code = None
    if not blank:
        try:
            ret, touts, _ = await run_template(state, p, encoder_id, "card_type", {"card": data},
                                               check_ret=False)
            if ret == 0 and touts:
                type_code = bytes.fromhex(touts[0])[0]
        except GatewayError:
            pass
    db = state.db
    row = db.one("SELECT * FROM cards WHERE card_data=? ORDER BY id DESC LIMIT 1", (data,)) if not blank else None
    card = svc.card_view(row) if row else None
    stay = svc.stay_detail(db, row["stay_id"]) if row and row["stay_id"] else None
    room = svc.room_or_404(db, row["room_id"]) if row and row["room_id"] and not stay else (stay or {}).get("room")
    return {"card_data": data, "blank": blank, "card_type_code": type_code, "known": bool(row),
            "card": card, "stay": stay, "room": room}


# ----------------------------------------------------------------------------- board
@router.get("/reception/board")
async def room_board(request: Request, p: Principal = Depends(require("reception"))):
    return svc.board(request.app.state.db)


# ----------------------------------------------------------------------------- check-in
@router.post("/reception/check-in", status_code=201)
async def check_in(body: CheckInIn, request: Request, p: Principal = Depends(RECEPTION)):
    state = request.app.state
    db = state.db
    room = svc.room_or_404(db, body.room_id)
    now = local_now()
    if body.kind == "hourly":
        check_out = now + timedelta(hours=body.hours)
        price = body.price if body.price is not None else room["hour_start_price"] + room["hour_price"] * body.hours
    else:
        check_out = svc.to_local(body.check_out)
        price = body.price if body.price is not None else room["price"]
    if check_out <= now:
        raise GatewayError(422, "validation_error", "Check-out time must be in the future")
    async with room_lock(state, room["id"]):
        svc.ensure_room_free(db, room, now, check_out, allow_reserved=body.allow_reserved)
        card = await issue_guest_card(state, p, body.encoder_id, room, now, check_out, 0,
                                      {"room": room["room_no"], "guest": body.guest.name, "kind": body.kind})
        with db.tx() as t:
            if t.one("SELECT id FROM stays WHERE room_id=? AND status='active'", (room["id"],)):
                raise conflict("Room %s was just taken by another check-in" % room["room_no"], "room_occupied",
                               room_no=room["room_no"])
            stay_id = t.insert(
                "INSERT INTO stays (room_id, kind, status, check_in, check_out, vip, price, deposit, cards_issued, "
                "note, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)",
                (room["id"], body.kind, "active", svc.fmt(now), svc.fmt(check_out), int(body.vip), price,
                 body.deposit, body.note, svc.fmt(now), p.actor))
            add_guests(t, stay_id, body.guest, body.companions)
            replace_previous_guest_cards(t, room["id"], stay_id)
            svc.insert_card(t, "guest", card, p, body.encoder_id, holder=body.guest.name, room_id=room["id"],
                            stay_id=stay_id, valid_from=now, valid_to=check_out)
            t.execute("UPDATE rooms SET housekeeping='clean' WHERE id=? AND housekeeping='dirty'", (room["id"],))
    db.audit(p.actor, "reception.check_in", True, request={"stay_id": stay_id, "room": room["room_no"]})
    return svc.stay_detail(db, stay_id)


@router.post("/reception/team", status_code=201)
async def team_check_in(body: TeamCheckInIn, request: Request, p: Principal = Depends(RECEPTION)):
    """Register a team in several rooms. Cards are then issued room by room (POST /stays/{id}/cards)."""
    db = request.app.state.db
    now = local_now()
    check_out = svc.to_local(body.check_out)
    if check_out <= now:
        raise GatewayError(422, "validation_error", "Check-out time must be in the future")
    rooms = [svc.room_or_404(db, rid) for rid in dict.fromkeys(body.room_ids)]
    for room in rooms:
        svc.ensure_room_free(db, room, now, check_out)
    with db.tx() as t:
        party_id = t.insert("INSERT INTO parties (kind, leader_name, leader_id_type, leader_id_no, phone, note, "
                            "created_at, created_by) VALUES ('team',?,?,?,?,?,?,?)",
                            (body.leader.name, body.leader.id_type, body.leader.id_no, body.leader.phone,
                             body.note, svc.fmt(now), p.actor))
        for room in rooms:
            stay_id = t.insert(
                "INSERT INTO stays (room_id, party_id, kind, status, check_in, check_out, price, deposit, "
                "created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (room["id"], party_id, "team", "active", svc.fmt(now), svc.fmt(check_out),
                 body.price if body.price is not None else room["price"], body.deposit, svc.fmt(now), p.actor))
            add_guests(t, stay_id, body.leader)
    db.audit(p.actor, "reception.team_check_in", True,
             request={"party_id": party_id, "rooms": [r["room_no"] for r in rooms]})
    return party_detail(db, party_id)


# ----------------------------------------------------------------------------- stays
@router.get("/stays/{stay_id}")
async def get_stay(stay_id: int, request: Request, p: Principal = Depends(RECEPTION)):
    return svc.stay_detail(request.app.state.db, stay_id)


@router.post("/stays/{stay_id}/cards", status_code=201)
async def issue_stay_card(stay_id: int, body: EncoderRef, request: Request, p: Principal = Depends(RECEPTION)):
    """Issue a card for an active stay: the first card is a new check-in, later ones are copies."""
    state = request.app.state
    db = state.db
    stay = svc.stay_or_404(db, stay_id)
    if stay["status"] != "active":
        raise conflict("This stay is not checked in", "not_active")
    room = svc.room_or_404(db, stay["room_id"])
    if stay["cards_issued"] >= room["max_cards"]:
        raise conflict("Room %s already has its maximum of %d cards" % (room["room_no"], room["max_cards"]),
                       "max_cards", room_no=room["room_no"], max=room["max_cards"])
    now = local_now()
    end = svc.parse(stay["check_out"])
    if end <= now:
        raise conflict("The stay is overdue - extend it before issuing a card", "overdue")
    guest = (svc.guests_of(db, stay_id) or [{"name": None}])[0]["name"]
    async with room_lock(state, room["id"]):
        index = stay["cards_issued"]
        card = await issue_guest_card(state, p, body.encoder_id, room, now, end, index,
                                      {"room": room["room_no"], "stay_id": stay_id, "copy": index > 0})
        with db.tx() as t:
            if index == 0:
                replace_previous_guest_cards(t, room["id"], stay_id)
            svc.insert_card(t, "guest", card, p, body.encoder_id, holder=guest, room_id=room["id"],
                            stay_id=stay_id, valid_from=now, valid_to=end,
                            note=None if index == 0 else "Copy %d" % index)
            t.execute("UPDATE stays SET cards_issued = cards_issued + 1 WHERE id=?", (stay_id,))
    return svc.stay_detail(db, stay_id)


@router.post("/stays/{stay_id}/extend")
async def extend_stay(stay_id: int, body: ExtendIn, request: Request, p: Principal = Depends(RECEPTION)):
    state = request.app.state
    db = state.db
    stay = svc.stay_or_404(db, stay_id)
    if stay["status"] not in ("active", "reserved"):
        raise conflict("Only current or reserved stays can be changed", "not_active")
    room = svc.room_or_404(db, stay["room_id"])
    now = local_now()
    new_out = svc.to_local(body.check_out)
    start = max(svc.parse(stay["check_in"]), now) if stay["status"] == "reserved" else now
    if new_out <= now or new_out <= svc.parse(stay["check_in"]):
        raise GatewayError(422, "validation_error", "The new check-out must be in the future")
    async with room_lock(state, room["id"]):
        for s in svc.overlapping(db, room["id"], start, new_out, exclude_stay_id=stay_id):
            raise conflict("Room %s is reserved from %s" % (room["room_no"], s["check_in"]), "room_reserved",
                           stay_id=s["id"], room_no=room["room_no"], check_in=s["check_in"], check_out=s["check_out"])
        card = None
        if body.encoder_id and stay["status"] == "active":
            card = await issue_guest_card(state, p, body.encoder_id, room, now, new_out,
                                          max(1, stay["cards_issued"]),
                                          {"room": room["room_no"], "stay_id": stay_id, "extend_to": new_out})
        with db.tx() as t:
            t.execute("UPDATE stays SET check_out=? WHERE id=?", (svc.fmt(new_out), stay_id))
            if card is not None:
                guest = (svc.guests_of(db, stay_id) or [{"name": None}])[0]["name"]
                svc.insert_card(t, "guest", card, p, body.encoder_id, holder=guest, room_id=room["id"],
                                stay_id=stay_id, valid_from=now, valid_to=new_out, note="Extended")
                t.execute("UPDATE stays SET cards_issued = cards_issued + 1 WHERE id=?", (stay_id,))
    db.audit(p.actor, "reception.extend", True, request={"stay_id": stay_id, "check_out": svc.fmt(new_out),
                                                         "card_rewritten": card is not None})
    return svc.stay_detail(db, stay_id)


@router.post("/stays/{stay_id}/move")
async def change_room(stay_id: int, body: MoveIn, request: Request, p: Principal = Depends(RECEPTION)):
    state = request.app.state
    db = state.db
    stay = svc.stay_or_404(db, stay_id)
    if stay["status"] != "active":
        raise conflict("Only checked-in guests can change room", "not_active")
    if body.room_id == stay["room_id"]:
        raise GatewayError(422, "validation_error", "Choose a different room")
    old_room = svc.room_or_404(db, stay["room_id"])
    new_room = svc.room_or_404(db, body.room_id)
    now = local_now()
    end = max(svc.parse(stay["check_out"]), now + timedelta(minutes=1))
    first, second = sorted([old_room["id"], new_room["id"]])
    async with room_lock(state, first), room_lock(state, second):
        svc.ensure_room_free(db, new_room, now, end)
        card = await issue_guest_card(state, p, body.encoder_id, new_room, now, end, 0,
                                      {"stay_id": stay_id, "from": old_room["room_no"], "to": new_room["room_no"]})
        with db.tx() as t:
            if t.one("SELECT id FROM stays WHERE room_id=? AND status='active'", (new_room["id"],)):
                raise conflict("Room %s was just taken" % new_room["room_no"], "room_occupied",
                               room_no=new_room["room_no"])
            t.execute("UPDATE cards SET status='replaced' WHERE stay_id=? AND status='active'", (stay_id,))
            t.execute("UPDATE stays SET room_id=?, cards_issued=1 WHERE id=?", (new_room["id"], stay_id))
            svc.mark_room_after_checkout(t, db, old_room["id"])
            replace_previous_guest_cards(t, new_room["id"], stay_id)
            guest = (svc.guests_of(db, stay_id) or [{"name": None}])[0]["name"]
            svc.insert_card(t, "guest", card, p, body.encoder_id, holder=guest, room_id=new_room["id"],
                            stay_id=stay_id, valid_from=now, valid_to=end,
                            note="Moved from %s" % old_room["room_no"])
    db.audit(p.actor, "reception.change_room", True,
             request={"stay_id": stay_id, "from": old_room["room_no"], "to": new_room["room_no"]})
    return svc.stay_detail(db, stay_id)


@router.post("/stays/{stay_id}/checkout")
async def checkout_without_card(stay_id: int, request: Request, p: Principal = Depends(RECEPTION)):
    """Check out without the card. Its card keeps working until it expires or the next guest's card is used."""
    db = request.app.state.db
    stay = svc.stay_or_404(db, stay_id)
    if stay["status"] != "active":
        raise conflict("This stay is not checked in", "not_active")
    with db.tx() as t:
        checkout_stay(t, db, stay)
    db.audit(p.actor, "reception.check_out", True, request={"stay_id": stay_id, "with_card": False})
    return svc.stay_detail(db, stay_id)


@router.post("/stays/{stay_id}/arrive")
async def arrive(stay_id: int, body: EncoderRef, request: Request, p: Principal = Depends(RECEPTION)):
    """Check in a reserved room and issue its card."""
    state = request.app.state
    db = state.db
    stay = svc.stay_or_404(db, stay_id)
    if stay["status"] != "reserved":
        raise conflict("This room is not reserved", "not_reserved")
    room = svc.room_or_404(db, stay["room_id"])
    now = local_now()
    end = svc.parse(stay["check_out"])
    if end <= now:
        raise conflict("The reservation has already ended - extend it first", "expired")
    async with room_lock(state, room["id"]):
        if room["housekeeping"] == "maintenance":
            raise conflict("Room %s is out of order" % room["room_no"], "room_out_of_order", room_no=room["room_no"])
        if svc.active_stay(db, room["id"]):
            raise conflict("Room %s is still occupied" % room["room_no"], "room_occupied", room_no=room["room_no"])
        guest = (svc.guests_of(db, stay_id) or [{"name": None}])[0]["name"]
        card = await issue_guest_card(state, p, body.encoder_id, room, now, end, 0,
                                      {"stay_id": stay_id, "room": room["room_no"], "reservation": True})
        with db.tx() as t:
            t.execute("UPDATE stays SET status='active', check_in=?, cards_issued=1, kind=? WHERE id=?",
                      (svc.fmt(now), "team" if stay["party_id"] else "walkin", stay_id))
            replace_previous_guest_cards(t, room["id"], stay_id)
            svc.insert_card(t, "guest", card, p, body.encoder_id, holder=guest, room_id=room["id"],
                            stay_id=stay_id, valid_from=now, valid_to=end)
    db.audit(p.actor, "reception.arrive", True, request={"stay_id": stay_id, "room": room["room_no"]})
    return svc.stay_detail(db, stay_id)


# ----------------------------------------------------------------------------- parties (teams, reservations)
def party_detail(db, party_id):
    party = db.one("SELECT * FROM parties WHERE id=?", (party_id,))
    if party is None:
        raise not_found("Group", party_id)
    party = dict(party)
    party["stays"] = db.query(
        "SELECT s.*, r.room_no, r.building_no, r.room_type FROM stays s JOIN rooms r ON r.id = s.room_id "
        "WHERE s.party_id=? ORDER BY r.building_no, r.room_no", (party_id,))
    statuses = {s["status"] for s in party["stays"]}
    party["open"] = bool(statuses & {"active", "reserved"})
    return party


@router.get("/parties")
async def list_parties(request: Request, kind: Optional[str] = None, open_only: bool = True,
                       q: Optional[str] = None, p: Principal = Depends(RECEPTION)):
    db = request.app.state.db
    sql, params = "SELECT id FROM parties WHERE 1=1", []
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    if q:
        sql += " AND (leader_name LIKE ? OR leader_id_no LIKE ? OR phone LIKE ?)"
        params += ["%" + q + "%"] * 3
    if open_only:
        sql += " AND id IN (SELECT party_id FROM stays WHERE status IN ('active','reserved'))"
    sql += " ORDER BY id DESC LIMIT 200"
    return [party_detail(db, r["id"]) for r in db.query(sql, tuple(params))]


@router.get("/parties/{party_id}")
async def get_party(party_id: int, request: Request, p: Principal = Depends(RECEPTION)):
    return party_detail(request.app.state.db, party_id)


@router.post("/reservations", status_code=201)
async def create_reservation(body: ReservationIn, request: Request, p: Principal = Depends(RECEPTION)):
    db = request.app.state.db
    ci, co = svc.to_local(body.check_in), svc.to_local(body.check_out)
    if co <= local_now():
        raise GatewayError(422, "validation_error", "The reservation must end in the future")
    rooms = [svc.room_or_404(db, rid) for rid in dict.fromkeys(body.room_ids)]
    for room in rooms:
        svc.ensure_room_free(db, room, ci, co)
    now = svc.fmt(local_now())
    with db.tx() as t:
        party_id = t.insert("INSERT INTO parties (kind, leader_name, leader_id_type, leader_id_no, phone, note, "
                            "created_at, created_by) VALUES ('reservation',?,?,?,?,?,?,?)",
                            (body.leader.name, body.leader.id_type, body.leader.id_no, body.leader.phone,
                             body.note, now, p.actor))
        for room in rooms:
            stay_id = t.insert(
                "INSERT INTO stays (room_id, party_id, kind, status, check_in, check_out, price, created_at, "
                "created_by) VALUES (?,?,?,?,?,?,?,?,?)",
                (room["id"], party_id, "walkin" if len(rooms) == 1 else "team", "reserved", svc.fmt(ci),
                 svc.fmt(co), room["price"], now, p.actor))
            add_guests(t, stay_id, body.leader)
    db.audit(p.actor, "reception.reserve", True,
             request={"party_id": party_id, "rooms": [r["room_no"] for r in rooms]})
    return party_detail(db, party_id)


@router.post("/parties/{party_id}/cancel")
async def cancel_reservation(party_id: int, body: CancelIn, request: Request, p: Principal = Depends(RECEPTION)):
    db = request.app.state.db
    party = party_detail(db, party_id)
    reserved = [s["id"] for s in party["stays"] if s["status"] == "reserved"]
    targets = reserved if body.stay_ids is None else [i for i in body.stay_ids if i in reserved]
    if not targets:
        raise conflict("Nothing to cancel - no matching reserved rooms", "nothing_to_cancel")
    with db.tx() as t:
        for sid in targets:
            t.execute("UPDATE stays SET status='cancelled' WHERE id=?", (sid,))
    db.audit(p.actor, "reception.cancel_reservation", True, request={"party_id": party_id, "stays": targets})
    return party_detail(db, party_id)


@router.post("/parties/{party_id}/checkout")
async def checkout_party(party_id: int, request: Request, p: Principal = Depends(RECEPTION)):
    db = request.app.state.db
    party = party_detail(db, party_id)
    active = [s for s in party["stays"] if s["status"] == "active"]
    if not active:
        raise conflict("No checked-in rooms in this group", "nothing_to_checkout")
    with db.tx() as t:
        for s in active:
            checkout_stay(t, db, s)
    db.audit(p.actor, "reception.team_check_out", True,
             request={"party_id": party_id, "rooms": [s["room_no"] for s in active]})
    return party_detail(db, party_id)


# ----------------------------------------------------------------------------- card on the reader
@router.post("/cards/inspect")
async def inspect_card(body: CardOnReaderIn, request: Request, p: Principal = Depends(RECEPTION)):
    """Card information: read the card on the encoder and show what it is."""
    return await read_card_on_reader(request.app.state, p, body.encoder_id)


@router.post("/cards/erase")
async def erase_card(body: CardOnReaderIn, request: Request, p: Principal = Depends(RECEPTION)):
    state = request.app.state
    svc.ensure_calibrated(state, "erase_card")
    info = await read_card_on_reader(state, p, body.encoder_id)
    if info["blank"]:
        raise conflict("The card on the encoder is already blank", "blank_card")
    card = info["card"]
    if card and card["kind"] != "guest" and not p.can("staff_cards"):
        raise GatewayError(403, "forbidden", "Only managers can erase staff cards")
    await run_template(state, p, body.encoder_id, "erase_card", {},
                       {"card_data": info["card_data"], "card_id": card and card["id"]})
    if card:
        state.db.execute("UPDATE cards SET status='erased' WHERE id=?", (card["id"],))
    info["erased"] = True
    if card:
        info["card"] = svc.card_view(state.db.one("SELECT * FROM cards WHERE id=?", (card["id"],)))
    return info


@router.post("/cards/checkout")
async def checkout_by_card(body: CheckoutByCardIn, request: Request, p: Principal = Depends(RECEPTION)):
    """Check-out with card: read the guest card, check its stay out, erase the card."""
    state = request.app.state
    db = state.db
    if body.erase:
        svc.ensure_calibrated(state, "erase_card")
    info = await read_card_on_reader(state, p, body.encoder_id)
    card, stay = info["card"], info["stay"]
    if not card or card["kind"] != "guest":
        raise conflict("This is not a guest card issued by this system", "not_guest_card")
    if not stay or stay["status"] != "active":
        raise conflict("This card's stay has already been checked out", "already_checked_out")
    if body.erase:
        await run_template(state, p, body.encoder_id, "erase_card", {},
                           {"card_data": info["card_data"], "stay_id": stay["id"]})
    with db.tx() as t:
        checkout_stay(t, db, stay, erased_card_data=info["card_data"] if body.erase else None)
    db.audit(p.actor, "reception.check_out", True,
             request={"stay_id": stay["id"], "with_card": True, "erased": body.erase})
    return svc.stay_detail(db, stay["id"])
