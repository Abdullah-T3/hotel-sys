"""Staff cards (CardLock: Keys for staff) and lock setup cards (CardLock: Lock configuration)."""
from fastapi import APIRouter, Depends, Request

from ..cardops import run_template
from ..db import local_now
from ..errors import GatewayError, card_data_from, conflict, not_found
from ..security import Principal, authenticate
from . import service as svc
from .models import LockSetupIn, StaffCardIn

router = APIRouter(prefix="/v1", tags=["staff & lock cards"])

STAFF_OPS = {
    "master": "issue_master", "building": "issue_building", "floor": "issue_floor",
    "emergency": "issue_emergency", "group": "issue_group", "checkout": "issue_checkout",
    "record": "issue_record", "loss": "issue_loss",
}
LOCK_OPS = {
    "authorization": "issue_authorization", "room_set": "issue_room_set", "clock_set": "issue_clock_set",
    "group_set": "issue_group_set", "system": "issue_system",
}
GROUP_MODES = {"set_one": 1, "clear_one": 2, "set_all": 3, "clear_all": 4}
LOCK_OPTION_BITS = ["alarm", "remind_close", "no_disturb", "release_handle_lock", "music", "disable_cover"]


def _need(p: Principal, perm):
    if not p.can(perm):
        raise GatewayError(403, "forbidden", "Your role is not allowed to issue this card")


@router.post("/staff-cards", status_code=201)
async def issue_staff_card(body: StaffCardIn, request: Request, p: Principal = Depends(authenticate)):
    _need(p, "staff_cards_master" if body.kind in ("master", "emergency") else "staff_cards")
    state = request.app.state
    db = state.db
    now = local_now()
    valid_from = svc.to_local(body.valid_from) or now
    valid_to = svc.to_local(body.valid_to)
    if valid_to <= now:
        raise GatewayError(422, "validation_error", "The card must be valid until a future date")
    target = None
    if body.kind == "loss":
        target = db.one("SELECT * FROM cards WHERE id=?", (body.target_card_id,))
        if not target:
            raise not_found("Card", body.target_card_id)
        if target["status"] in ("lost", "erased"):
            raise conflict("That card is already %s" % svc.CARD_STATUSES[target["status"]].lower(), "already_done")
    if body.kind == "building" and not db.one("SELECT no FROM buildings WHERE no=?", (body.building_no,)):
        raise not_found("Building", body.building_no)
    index = db.one("SELECT COUNT(*) AS n FROM cards WHERE kind=?", (body.kind,))["n"]
    settings = svc.get_settings(db)
    params = {
        "holder": body.holder, "valid_from": valid_from, "valid_to": valid_to,
        "time_window": body.time_from.replace(":", "") + body.time_to.replace(":", ""),
        "card_index": index,
        "cover": 0 if settings["lock_options"]["disable_cover"] else int(body.cover),
        "building": body.building_no or 0, "floor": body.floor_no or 0, "group_no": body.group_no or 0,
        "target_card": (target or {}).get("card_data") or "",
    }
    _, outs, _ = await run_template(state, p, body.encoder_id, STAFF_OPS[body.kind], params,
                                    body.model_dump(mode="json"), action="card.issue_" + body.kind)
    card_data = card_data_from(outs[-1]) if outs else None
    with db.tx() as t:
        card_id = svc.insert_card(
            t, body.kind, card_data, p, body.encoder_id, holder=body.holder, building_no=body.building_no,
            floor_no=body.floor_no, group_no=body.group_no, target_card_id=body.target_card_id,
            valid_from=valid_from, valid_to=valid_to, time_from=body.time_from, time_to=body.time_to,
            note=body.note)
        if target:
            t.execute("UPDATE cards SET status='lost' WHERE id=?", (target["id"],))
    return svc.card_view(db.one("SELECT * FROM cards WHERE id=?", (card_id,)))


@router.post("/lock-setup", status_code=201)
async def issue_lock_setup_card(body: LockSetupIn, request: Request, p: Principal = Depends(authenticate)):
    _need(p, "lock_setup")
    state = request.app.state
    db = state.db
    now = local_now()
    settings = svc.get_settings(db)
    params = {"now": now, "clock": svc.to_local(body.clock) or now, "group_no": body.group_no or 0,
              "group_mode": GROUP_MODES.get(body.group_action, 0)}
    room = None
    if body.kind == "room_set":
        room = svc.room_or_404(db, body.room_id)
        params.update(building=room["building_no"], floor=room["floor_no"], room=room["lock_room"],
                      room_no=room["room_no"])
    if body.kind == "system":
        opts = settings["lock_options"]
        bits = sum(1 << i for i, k in enumerate(LOCK_OPTION_BITS) if opts.get(k))
        if settings["guest_opens_deadbolt"]:
            bits |= 1 << 6
        params["options"] = bits
    _, outs, _ = await run_template(state, p, body.encoder_id, LOCK_OPS[body.kind], params,
                                    body.model_dump(mode="json"), action="card.issue_" + body.kind)
    card_data = card_data_from(outs[-1]) if outs else None
    label = {"room_set": "Room %s" % (room or {}).get("room_no"),
             "group_set": "%s %s" % (body.group_action, "" if body.group_no is None else body.group_no),
             "clock_set": svc.fmt(params["clock"])}.get(body.kind)
    with db.tx() as t:
        card_id = svc.insert_card(t, body.kind, card_data, p, body.encoder_id, holder=p.actor,
                                  room_id=room and room["id"], group_no=body.group_no, valid_from=now,
                                  note=label)
    return svc.card_view(db.one("SELECT * FROM cards WHERE id=?", (card_id,)))
