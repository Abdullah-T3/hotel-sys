"""Buildings and rooms (CardLock: Rooms definition) + housekeeping status."""
import sqlite3
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request, Response

from ..errors import GatewayError, conflict, not_found
from ..security import Principal, authenticate, require
from . import service as svc
from .models import BuildingIn, BuildingUpdate, HousekeepingIn, RoomBatchIn, RoomIn, RoomUpdate

router = APIRouter(prefix="/v1", tags=["rooms"])


def _room_out(r):
    r = dict(r)
    r["public_door"] = bool(r["public_door"])
    return r


# ----------------------------------------------------------------------------- buildings
@router.get("/buildings")
async def list_buildings(request: Request, p: Principal = Depends(authenticate)):
    return request.app.state.db.query(
        "SELECT b.no, b.name, COUNT(r.id) AS rooms FROM buildings b LEFT JOIN rooms r ON r.building_no = b.no "
        "GROUP BY b.no ORDER BY b.no")


@router.post("/buildings", status_code=201)
async def create_building(body: BuildingIn, request: Request, p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    try:
        db.execute("INSERT INTO buildings (no, name) VALUES (?,?)", (body.no, body.name))
    except sqlite3.IntegrityError:
        raise conflict("Building number %d already exists" % body.no, "building_exists", no=body.no)
    db.audit(p.actor, "building.create", True, request=body.model_dump())
    return {"no": body.no, "name": body.name, "rooms": 0}


@router.patch("/buildings/{no}")
async def rename_building(no: int, body: BuildingUpdate, request: Request,
                          p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    if db.execute("UPDATE buildings SET name=? WHERE no=?", (body.name, no)).rowcount == 0:
        raise not_found("Building", no)
    db.audit(p.actor, "building.update", True, request={"no": no, "name": body.name})
    return {"no": no, "name": body.name}


@router.delete("/buildings/{no}", status_code=204)
async def delete_building(no: int, request: Request, p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    if not db.one("SELECT no FROM buildings WHERE no=?", (no,)):
        raise not_found("Building", no)
    busy = db.one("SELECT COUNT(*) AS n FROM stays s JOIN rooms r ON r.id = s.room_id "
                  "WHERE r.building_no=? AND s.status IN ('active','reserved')", (no,))["n"]
    if busy:
        raise conflict("Building %d has %d occupied or reserved rooms" % (no, busy), "in_use")
    with db.tx() as t:
        _delete_rooms(t, "building_no=?", (no,))
        t.execute("DELETE FROM buildings WHERE no=?", (no,))
    db.audit(p.actor, "building.delete", True, request={"no": no})
    return Response(status_code=204)


def _delete_rooms(t, where, params):
    """Remove rooms plus their finished history (cards keep a copy of the data)."""
    ids = [r["id"] for r in t.query("SELECT id FROM rooms WHERE " + where, params)]
    for rid in ids:
        t.execute("UPDATE cards SET room_id=NULL, stay_id=NULL WHERE room_id=? OR stay_id IN "
                  "(SELECT id FROM stays WHERE room_id=?)", (rid, rid))
        t.execute("DELETE FROM guests WHERE stay_id IN (SELECT id FROM stays WHERE room_id=?)", (rid,))
        t.execute("DELETE FROM stays WHERE room_id=?", (rid,))
        t.execute("DELETE FROM rooms WHERE id=?", (rid,))
    return len(ids)


# ----------------------------------------------------------------------------- rooms
@router.get("/rooms")
async def list_rooms(request: Request, building_no: Optional[int] = None, q: Optional[str] = None,
                     p: Principal = Depends(authenticate)):
    sql = ("SELECT r.*, b.name AS building_name FROM rooms r JOIN buildings b ON b.no = r.building_no "
           "WHERE 1=1")
    params = []
    if building_no is not None:
        sql += " AND r.building_no=?"
        params.append(building_no)
    if q:
        sql += " AND (r.room_no LIKE ? OR r.room_type LIKE ?)"
        params += ["%" + q + "%"] * 2
    sql += " ORDER BY r.building_no, r.floor_no, r.room_no"
    return [_room_out(r) for r in request.app.state.db.query(sql, tuple(params))]


@router.get("/rooms/available")
async def available_rooms(request: Request, check_in: datetime = Query(...), check_out: datetime = Query(...),
                          p: Principal = Depends(authenticate)):
    """Rooms free for the whole period (used for reservations and team check-in)."""
    ci, co = svc.to_local(check_in), svc.to_local(check_out)
    if co <= ci:
        raise GatewayError(422, "validation_error", "check_out must be after check_in")
    db = request.app.state.db
    rooms = db.query("SELECT r.*, b.name AS building_name FROM rooms r JOIN buildings b ON b.no = r.building_no "
                     "WHERE r.housekeeping != 'maintenance' ORDER BY r.building_no, r.floor_no, r.room_no")
    return [_room_out(r) for r in rooms if not svc.overlapping(db, r["id"], ci, co)]


@router.post("/rooms", status_code=201)
async def create_room(body: RoomIn, request: Request, p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    if not db.one("SELECT no FROM buildings WHERE no=?", (body.building_no,)):
        raise not_found("Building", body.building_no)
    try:
        rid = db.insert(
            "INSERT INTO rooms (building_no, floor_no, lock_room, room_no, room_type, price, hour_start_price, "
            "hour_price, max_cards, public_door, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (body.building_no, body.floor_no, body.lock_room, body.room_no, body.room_type, body.price,
             body.hour_start_price, body.hour_price, body.max_cards, int(body.public_door), body.note))
    except sqlite3.IntegrityError:
        raise conflict("Room %s, or lock %d-%d, already exists in building %d"
                       % (body.room_no, body.floor_no, body.lock_room, body.building_no), "room_exists",
                       room_no=body.room_no, lock="%d-%d-%d" % (body.building_no, body.floor_no, body.lock_room))
    db.audit(p.actor, "room.create", True, request=body.model_dump())
    return _room_out(svc.room_or_404(db, rid))


@router.post("/rooms/batch", status_code=201)
async def create_rooms_batch(body: RoomBatchIn, request: Request, p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    if not db.one("SELECT no FROM buildings WHERE no=?", (body.building_no,)):
        raise not_found("Building", body.building_no)
    created, skipped = [], []
    with db.tx() as t:
        for floor, lock_room, room_no in body.expand():
            exists = t.one("SELECT id FROM rooms WHERE building_no=? AND (room_no=? OR (floor_no=? AND lock_room=?))",
                           (body.building_no, room_no, floor, lock_room))
            if exists:
                skipped.append(room_no)
                continue
            t.execute("INSERT INTO rooms (building_no, floor_no, lock_room, room_no, room_type, price, "
                      "hour_start_price, hour_price, max_cards, public_door, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (body.building_no, floor, lock_room, room_no, body.room_type, body.price,
                       body.hour_start_price, body.hour_price, body.max_cards, int(body.public_door), body.note))
            created.append(room_no)
    db.audit(p.actor, "room.batch_create", True, request={**body.model_dump(), "created": len(created)})
    return {"created": created, "skipped": skipped}


@router.patch("/rooms/{room_id}")
async def update_room(room_id: int, body: RoomUpdate, request: Request,
                      p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    room = svc.room_or_404(db, room_id)
    fields = body.model_dump(exclude_unset=True)
    if "public_door" in fields:
        fields["public_door"] = int(fields["public_door"])
    if fields:
        try:
            db.execute("UPDATE rooms SET %s WHERE id=?" % ",".join("%s=?" % k for k in fields),
                       tuple(fields.values()) + (room_id,))
        except sqlite3.IntegrityError:
            merged = {**room, **fields}
            raise conflict("Another room already uses that room number or lock number", "room_exists",
                           room_no=merged["room_no"],
                           lock="%d-%d-%d" % (merged["building_no"], merged["floor_no"], merged["lock_room"]))
    db.audit(p.actor, "room.update", True, request={"id": room_id, **fields})
    return _room_out(svc.room_or_404(db, room_id))


@router.delete("/rooms/{room_id}", status_code=204)
async def delete_room(room_id: int, request: Request, p: Principal = Depends(require("rooms_manage"))):
    db = request.app.state.db
    room = svc.room_or_404(db, room_id)
    if db.one("SELECT id FROM stays WHERE room_id=? AND status IN ('active','reserved')", (room_id,)):
        raise conflict("Room %s is occupied or reserved" % room["room_no"], "in_use")
    with db.tx() as t:
        _delete_rooms(t, "id=?", (room_id,))
    db.audit(p.actor, "room.delete", True, request={"id": room_id, "room_no": room["room_no"]})
    return Response(status_code=204)


@router.put("/rooms/{room_id}/housekeeping")
async def set_housekeeping(room_id: int, body: HousekeepingIn, request: Request,
                           p: Principal = Depends(require("room_status"))):
    db = request.app.state.db
    svc.room_or_404(db, room_id)
    if body.housekeeping == "maintenance" and svc.active_stay(db, room_id):
        raise conflict("Check the guest out before marking the room out of order", "room_occupied")
    db.execute("UPDATE rooms SET housekeeping=?, maintenance_note=? WHERE id=?",
               (body.housekeeping, body.note if body.housekeeping == "maintenance" else None, room_id))
    db.audit(p.actor, "room.housekeeping", True, request={"id": room_id, **body.model_dump()})
    return _room_out(svc.room_or_404(db, room_id))
