"""Reports (CardLock: Reports): card records, guest records, door-open records. CSV export for Excel."""
import csv
import io
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from ..cardops import run_template
from ..db import local_now
from ..errors import GatewayError, decode_out
from ..security import Principal, require
from . import service as svc
from .models import EncoderRef

router = APIRouter(prefix="/v1/reports", tags=["reports"])


def _csv(rows, columns, filename):
    buf = io.StringIO()
    buf.write("﻿")  # BOM so Excel opens UTF-8 correctly
    w = csv.writer(buf)
    w.writerow([label for _, label in columns])
    for r in rows:
        w.writerow(["" if r.get(k) is None else r.get(k) for k, _ in columns])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="%s"' % filename})


def _require_export(p: Principal):
    if not p.can("reports_manage"):
        raise GatewayError(403, "forbidden", "Exporting reports requires the manager role")


def _range(sql, params, column, date_from, date_to):
    if date_from:
        sql += " AND %s >= ?" % column
        params.append(date_from.isoformat())
    if date_to:
        sql += " AND %s < date(?, '+1 day')" % column
        params.append(date_to.isoformat())
    return sql


# ----------------------------------------------------------------------------- cards
CARD_COLUMNS = [("id", "ID"), ("kind_label", "Type"), ("room_no", "Room"), ("holder", "Holder"),
                ("status_label", "Status"), ("valid_from", "Valid from"), ("valid_to", "Valid to"),
                ("issued_at", "Issued at"), ("issued_by", "Operator"), ("encoder_id", "Encoder"),
                ("card_data", "Card data"), ("note", "Note")]


@router.get("/cards")
async def card_report(request: Request, kind: Optional[str] = None, status: Optional[str] = None,
                      q: Optional[str] = None, date_from: Optional[date] = None, date_to: Optional[date] = None,
                      limit: int = Query(500, ge=1, le=5000), format: str = "json",
                      p: Principal = Depends(require("reports_view"))):
    sql = ("SELECT c.*, r.room_no FROM cards c LEFT JOIN rooms r ON r.id = c.room_id WHERE 1=1")
    params = []
    if kind:
        sql += " AND c.kind=?"
        params.append(kind)
    if q:
        sql += " AND (c.holder LIKE ? OR r.room_no LIKE ? OR c.card_data LIKE ? OR c.issued_by LIKE ?)"
        params += ["%" + q + "%"] * 4
    sql = _range(sql, params, "c.issued_at", date_from, date_to)
    if status:
        # Filter in SQL before LIMIT. "expired" / "active" are computed from valid_to (see card_view).
        now = svc.fmt(local_now())
        if status == "expired":
            sql += " AND c.status='active' AND c.valid_to IS NOT NULL AND c.valid_to < ?"
            params.append(now)
        elif status == "active":
            sql += " AND c.status='active' AND (c.valid_to IS NULL OR c.valid_to >= ?)"
            params.append(now)
        else:
            sql += " AND c.status=?"
            params.append(status)
    sql += " ORDER BY c.id DESC LIMIT ?"
    params.append(limit)
    rows = [svc.card_view(r) for r in request.app.state.db.query(sql, tuple(params))]
    if format == "csv":
        _require_export(p)
        return _csv(rows, CARD_COLUMNS, "card-records.csv")
    return rows


@router.post("/cards/cleanup")
async def cleanup_cards(request: Request, p: Principal = Depends(require("reports_manage"))):
    """Delete card records that can no longer open anything (expired, erased, checked out, replaced, lost)."""
    db = request.app.state.db
    now = svc.fmt(local_now())
    # Expired cards of guests who are still in the house (overdue) are kept: check-out with card needs them.
    n = db.execute("DELETE FROM cards WHERE status IN ('erased','checked_out','replaced','lost') "
                   "OR (valid_to IS NOT NULL AND valid_to < ? AND (stay_id IS NULL OR stay_id NOT IN "
                   "(SELECT id FROM stays WHERE status IN ('active','reserved'))))", (now,)).rowcount
    db.audit(p.actor, "reports.cleanup_cards", True, detail="%d deleted" % n)
    return {"deleted": n}


# ----------------------------------------------------------------------------- guests
GUEST_COLUMNS = [("stay_id", "Stay"), ("room_no", "Room"), ("name", "Guest"), ("sex", "Sex"),
                 ("id_type", "ID type"), ("id_no", "ID number"), ("phone", "Phone"), ("kind", "Type"),
                 ("status", "Status"), ("party_name", "Group"), ("check_in", "Check-in"),
                 ("check_out", "Check-out"), ("checked_out_at", "Checked out at"), ("price", "Price"),
                 ("deposit", "Deposit"), ("created_by", "Operator"), ("note", "Note")]


@router.get("/guests")
async def guest_report(request: Request, status: Optional[str] = None, q: Optional[str] = None,
                       date_from: Optional[date] = None, date_to: Optional[date] = None,
                       limit: int = Query(500, ge=1, le=5000), format: str = "json",
                       p: Principal = Depends(require("reports_view"))):
    sql = ("SELECT s.id AS stay_id, s.kind, s.status, s.check_in, s.check_out, s.checked_out_at, s.price, "
           "s.deposit, s.vip, s.note, s.created_by, s.cards_issued, r.room_no, r.building_no, g.name, g.sex, "
           "g.id_type, g.id_no, g.phone, g.is_primary, p.leader_name AS party_name "
           "FROM stays s JOIN rooms r ON r.id = s.room_id JOIN guests g ON g.stay_id = s.id "
           "LEFT JOIN parties p ON p.id = s.party_id WHERE 1=1")
    params = []
    if status:
        sql += " AND s.status=?"
        params.append(status)
    if q:
        sql += " AND (g.name LIKE ? OR g.id_no LIKE ? OR g.phone LIKE ? OR r.room_no LIKE ?)"
        params += ["%" + q + "%"] * 4
    sql = _range(sql, params, "s.check_in", date_from, date_to)
    sql += " ORDER BY s.id DESC, g.is_primary DESC LIMIT ?"
    params.append(limit)
    rows = request.app.state.db.query(sql, tuple(params))
    for r in rows:
        r["vip"] = bool(r["vip"])
    if format == "csv":
        _require_export(p)
        return _csv(rows, GUEST_COLUMNS, "guest-records.csv")
    return rows


@router.post("/guests/cleanup")
async def cleanup_guests(request: Request, p: Principal = Depends(require("reports_manage"))):
    """Delete finished stays (checked out or cancelled) and their guest details."""
    db = request.app.state.db
    with db.tx() as t:
        ids = [r["id"] for r in t.query("SELECT id FROM stays WHERE status IN ('checked_out','cancelled')")]
        for sid in ids:
            t.execute("UPDATE cards SET stay_id=NULL WHERE stay_id=?", (sid,))
            t.execute("DELETE FROM guests WHERE stay_id=?", (sid,))
            t.execute("DELETE FROM stays WHERE id=?", (sid,))
        t.execute("DELETE FROM parties WHERE id NOT IN (SELECT party_id FROM stays WHERE party_id IS NOT NULL)")
    db.audit(p.actor, "reports.cleanup_guests", True, detail="%d deleted" % len(ids))
    return {"deleted": len(ids)}


# ----------------------------------------------------------------------------- door-open records
OPEN_COLUMNS = [("opened_at", "Opened at"), ("room_label", "Room"), ("card_kind", "Card"),
                ("card_ref", "Card ref"), ("uploaded_at", "Uploaded"), ("raw", "Raw")]


def _parse_records(text):
    """Records come back as lines "yymmddHHMM,room,card-kind,card-ref". Anything else is kept raw."""
    out = []
    for line in [x.strip() for x in text.replace(";", "\n").splitlines() if x.strip()]:
        parts = [x.strip() for x in line.split(",")]
        opened = None
        if parts and len(parts[0]) == 10 and parts[0].isdigit():
            s = parts[0]
            opened = "20%s-%s-%sT%s:%s" % (s[0:2], s[2:4], s[4:6], s[6:8], s[8:10])
        out.append({"opened_at": opened, "room_label": parts[1] if len(parts) > 1 else None,
                    "card_kind": parts[2] if len(parts) > 2 else None,
                    "card_ref": parts[3] if len(parts) > 3 else None, "raw": line})
    return out


@router.post("/open-records/upload")
async def upload_open_records(body: EncoderRef, request: Request, p: Principal = Depends(require("reports_view"))):
    """Read the door-open records from a Record card placed on the encoder."""
    state = request.app.state
    _, outs, _ = await run_template(state, p, body.encoder_id, "read_record", {})
    text = decode_out(outs[0])[0] if outs else ""
    records = _parse_records(text)
    now = svc.fmt(local_now())
    with state.db.tx() as t:
        for r in records:
            t.execute("INSERT INTO open_records (room_label, card_ref, card_kind, opened_at, raw, uploaded_at, "
                      "encoder_id) VALUES (?,?,?,?,?,?,?)",
                      (r["room_label"], r["card_ref"], r["card_kind"], r["opened_at"], r["raw"], now,
                       body.encoder_id))
    state.db.audit(p.actor, "reports.upload_open_records", True, encoder_id=body.encoder_id,
                   detail="%d records" % len(records))
    return {"uploaded": len(records)}


@router.get("/open-records")
async def open_record_report(request: Request, q: Optional[str] = None, date_from: Optional[date] = None,
                             date_to: Optional[date] = None, limit: int = Query(1000, ge=1, le=10000),
                             format: str = "json", p: Principal = Depends(require("reports_view"))):
    sql, params = "SELECT * FROM open_records WHERE 1=1", []
    if q:
        sql += " AND (room_label LIKE ? OR card_ref LIKE ? OR raw LIKE ?)"
        params += ["%" + q + "%"] * 3
    sql = _range(sql, params, "opened_at", date_from, date_to)
    sql += " ORDER BY opened_at DESC, id DESC LIMIT ?"
    params.append(limit)
    rows = request.app.state.db.query(sql, tuple(params))
    if format == "csv":
        _require_export(p)
        return _csv(rows, OPEN_COLUMNS, "door-open-records.csv")
    return rows


@router.post("/open-records/cleanup")
async def cleanup_open_records(request: Request, p: Principal = Depends(require("reports_manage"))):
    db = request.app.state.db
    n = db.execute("DELETE FROM open_records").rowcount
    db.audit(p.actor, "reports.cleanup_open_records", True, detail="%d deleted" % n)
    return {"deleted": n}
