"""Hotel domain logic shared by the routers: settings, room status, stays, cards."""
import copy
from datetime import datetime, timedelta

from ..db import local_now
from ..errors import GatewayError, not_found

# ----------------------------------------------------------------------------- settings
DEFAULT_SETTINGS = {
    "hotel_name": "My Hotel",
    "checkout_time": "12:00",          # default check-out time
    "vip_checkout_time": "14:00",      # VIP / member check-out time
    "after_checkout": "dirty",         # room state after check-out: dirty | clean
    "guest_opens_deadbolt": True,      # guest card may open a door locked from inside
    "currency": "",
    "default_language": "en",          # UI language on the sign-in screen and for new operators
    "co_id": 79375,                    # hotel system code = dlsCoID in the vendor System.ini (0x1360F);
                                       # its low 16 bits (360F) appear in every card this hotel issues
    "lock_options": {                  # written to locks with a System options card
        "alarm": False,                # alarm when latch is tampered / door not closed
        "remind_close": True,          # 3 beeps if the door stays open 6 s after a guest card
        "no_disturb": True,            # LED flashes while deadbolted ("do not disturb")
        "release_handle_lock": False,  # motor relocks when the handle is released
        "music": False,                # play music instead of a beep on open
        "disable_cover": False,        # disable "new staff card revokes the previous one"
    },
}

ROOM_STATUSES = {
    "VC": "Vacant clean",
    "VD": "Vacant dirty",
    "OC": "Occupied",
    "TM": "Team",
    "OH": "Hourly",
    "OT": "Reserved",
    "TO": "Overdue",
    "OO": "Out of order",
}

CARD_KINDS = {
    "guest": "Guest card",
    "master": "Master card",
    "building": "Building card",
    "floor": "Floor card",
    "emergency": "Emergency card",
    "group": "Group card",
    "checkout": "Check-out card",
    "record": "Record card",
    "loss": "Loss-report card",
    "authorization": "Authorization card",
    "room_set": "Room-number setup card",
    "clock_set": "Clock setup card",
    "group_set": "Group setup card",
    "system": "System options card",
}

CARD_STATUSES = {
    "active": "Active",
    "expired": "Expired",
    "checked_out": "Checked out",
    "replaced": "Replaced",
    "erased": "Erased",
    "lost": "Reported lost",
}

ID_TYPES = ["ID card", "Passport", "Driving licence", "Military ID", "Phone number", "Other"]


def get_settings(db):
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    stored = db.get_settings()
    lock = stored.pop("lock_options", None) or {}
    merged.update(stored)
    merged["lock_options"].update(lock)
    return merged


# ----------------------------------------------------------------------------- time
def fmt(dt):
    return dt.isoformat(timespec="minutes") if dt else None


def parse(value):
    return datetime.fromisoformat(value) if value else None


def to_local(dt):
    """Normalise incoming datetimes to naive hotel-local time, minute precision."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.replace(second=0, microsecond=0)


def at_time(day, hhmm):
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, h, m)


def default_checkout(db, nights=1, vip=False, base=None):
    s = get_settings(db)
    base = base or local_now()
    return at_time(base.date() + timedelta(days=nights),
                   s["vip_checkout_time"] if vip else s["checkout_time"])


# ----------------------------------------------------------------------------- lookups
def room_or_404(db, room_id):
    room = db.one("SELECT r.*, b.name AS building_name FROM rooms r JOIN buildings b ON b.no = r.building_no "
                  "WHERE r.id=?", (room_id,))
    if room is None:
        raise not_found("Room", room_id)
    return room


def stay_or_404(db, stay_id):
    stay = db.one("SELECT * FROM stays WHERE id=?", (stay_id,))
    if stay is None:
        raise not_found("Stay", stay_id)
    return stay


def active_stay(db, room_id):
    return db.one("SELECT * FROM stays WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1",
                  (room_id,))


def overlapping(db, room_id, check_in, check_out, exclude_stay_id=None):
    """Active or reserved stays of a room that overlap [check_in, check_out).

    An overdue guest (active, check-out already passed) still occupies the room until they are
    checked out, so their stay is treated as open-ended.
    """
    now = fmt(local_now())
    return db.query(
        "SELECT * FROM stays WHERE room_id=? AND status IN ('active','reserved') AND id != ? "
        "AND check_in < ? AND (check_out > ? OR (status='active' AND check_out <= ?))",
        (room_id, exclude_stay_id or -1, fmt(check_out), fmt(check_in), now))


def ensure_room_free(db, room, check_in, check_out, exclude_stay_id=None, allow_reserved=False):
    if room["housekeeping"] == "maintenance":
        raise GatewayError(409, "room_out_of_order",
                           "Room %s is out of order" % room["room_no"], room_id=room["id"], room_no=room["room_no"])
    for s in overlapping(db, room["id"], check_in, check_out, exclude_stay_id):
        if s["status"] == "active":
            raise GatewayError(409, "room_occupied", "Room %s is occupied" % room["room_no"],
                               room_id=room["id"], room_no=room["room_no"])
        if not allow_reserved:
            raise GatewayError(409, "room_reserved",
                               "Room %s is reserved from %s to %s" % (room["room_no"], s["check_in"],
                                                                      s["check_out"]),
                               room_id=room["id"], stay_id=s["id"], room_no=room["room_no"],
                               check_in=s["check_in"], check_out=s["check_out"])


def guests_of(db, stay_id):
    return db.query("SELECT * FROM guests WHERE stay_id=? ORDER BY is_primary DESC, id", (stay_id,))


def party_of(db, party_id):
    return db.one("SELECT * FROM parties WHERE id=?", (party_id,)) if party_id else None


def card_view(card, now=None):
    now = fmt(now or local_now())
    card = dict(card)
    if card["status"] == "active" and card.get("valid_to") and card["valid_to"] < now:
        card["status"] = "expired"
    card["kind_label"] = CARD_KINDS.get(card["kind"], card["kind"])
    card["status_label"] = CARD_STATUSES.get(card["status"], card["status"])
    return card


def cards_of_stay(db, stay_id):
    rows = db.query("SELECT * FROM cards WHERE stay_id=? ORDER BY id DESC", (stay_id,))
    return [card_view(c) for c in rows]


def stay_detail(db, stay_id):
    stay = stay_or_404(db, stay_id)
    room = room_or_404(db, stay["room_id"])
    stay = dict(stay)
    stay["vip"] = bool(stay["vip"])
    stay["room"] = room
    stay["guests"] = guests_of(db, stay_id)
    stay["party"] = party_of(db, stay["party_id"])
    stay["cards"] = cards_of_stay(db, stay_id)
    stay["overdue"] = stay["status"] == "active" and stay["check_out"] < fmt(local_now())
    return stay


def compute_status(room, active, reservation, now):
    if active:
        if active["check_out"] < now:
            return "TO"
        if active["kind"] == "hourly":
            return "OH"
        if active["kind"] == "team":
            return "TM"
        return "OC"
    if room["housekeeping"] == "maintenance":
        return "OO"
    if reservation:
        return "OT"
    return "VD" if room["housekeeping"] == "dirty" else "VC"


def board(db):
    """Every room with its live status, current stay and next reservation."""
    now_dt = local_now()
    now = fmt(now_dt)
    horizon = fmt(datetime(now_dt.year, now_dt.month, now_dt.day) + timedelta(days=1))
    rooms = db.query("SELECT r.*, b.name AS building_name FROM rooms r JOIN buildings b ON b.no = r.building_no "
                     "ORDER BY r.building_no, r.floor_no, r.room_no")
    active = {s["room_id"]: s for s in db.query(
        "SELECT s.*, g.name AS guest_name, g.phone AS guest_phone, p.leader_name AS party_name "
        "FROM stays s LEFT JOIN guests g ON g.stay_id = s.id AND g.is_primary = 1 "
        "LEFT JOIN parties p ON p.id = s.party_id WHERE s.status='active' ORDER BY s.id")}
    reserved = {}
    for s in db.query(
            "SELECT s.*, p.leader_name AS party_name FROM stays s LEFT JOIN parties p ON p.id = s.party_id "
            "WHERE s.status='reserved' AND s.check_out > ? ORDER BY s.check_in", (now,)):
        reserved.setdefault(s["room_id"], s)
    out = []
    counts = {k: 0 for k in ROOM_STATUSES}
    for r in rooms:
        a = active.get(r["id"])
        res = reserved.get(r["id"])
        res_now = res if res and res["check_in"] < horizon else None
        status = compute_status(r, a, res_now, now)
        counts[status] += 1
        item = dict(r)
        item["public_door"] = bool(item["public_door"])
        item["status"] = status
        item["stay"] = None if not a else {
            "id": a["id"], "kind": a["kind"], "guest_name": a["guest_name"], "guest_phone": a["guest_phone"],
            "party_id": a["party_id"], "party_name": a["party_name"], "check_in": a["check_in"],
            "check_out": a["check_out"], "vip": bool(a["vip"]), "cards_issued": a["cards_issued"],
        }
        item["reservation"] = None if not res else {
            "stay_id": res["id"], "party_id": res["party_id"], "party_name": res["party_name"],
            "check_in": res["check_in"], "check_out": res["check_out"],
        }
        out.append(item)
    today = now_dt.date().isoformat()
    arrivals = db.one("SELECT COUNT(*) AS n FROM stays WHERE status='reserved' AND substr(check_in,1,10)=?",
                      (today,))["n"]
    departures = db.one("SELECT COUNT(*) AS n FROM stays WHERE status='active' AND substr(check_out,1,10)<=?",
                        (today,))["n"]
    return {"now": now, "rooms": out, "counts": counts,
            "arrivals_today": arrivals, "departures_today": departures}


def insert_card(t, kind, card_data, principal, encoder_id, status="active", **fields):
    cols = {"kind": kind, "card_data": card_data or None, "status": status, "encoder_id": encoder_id,
            "issued_by": principal.actor, "issued_at": fmt(local_now())}
    cols.update({k: v for k, v in fields.items() if v is not None})
    for k in ("valid_from", "valid_to"):
        if isinstance(cols.get(k), datetime):
            cols[k] = fmt(cols[k])
    keys = list(cols)
    return t.insert("INSERT INTO cards (%s) VALUES (%s)" % (",".join(keys), ",".join("?" * len(keys))),
                    tuple(cols[k] for k in keys))


def next_card_index(db, kind):
    """Sequence number for a new staff card of this kind. Only ever goes up (survives report cleanup).

    A database from before counters existed starts after the cards it already holds.
    """
    name = "card_index." + kind
    with db.tx() as t:
        row = t.one("SELECT value FROM counters WHERE name=?", (name,))
        if row is None:
            index = t.one("SELECT COUNT(*) AS n FROM cards WHERE kind=?", (kind,))["n"]
            t.execute("INSERT INTO counters (name, value) VALUES (?,?)", (name, index + 1))
        else:
            index = row["value"]
            t.execute("UPDATE counters SET value = value + 1 WHERE name=?", (name,))
    return index


def mark_room_after_checkout(t, db, room_id):
    state = "clean" if get_settings(db)["after_checkout"] == "clean" else "dirty"
    t.execute("UPDATE rooms SET housekeeping=? WHERE id=? AND housekeeping != 'maintenance'", (state, room_id))


def ensure_calibrated(state, op):
    """Fail fast before a multi-step flow if one of its card operations is not calibrated yet."""
    from ..cardops import OP_LABELS
    try:
        tpl = state.templates.get(op)
    except KeyError:
        raise GatewayError(500, "template_missing", "No card template named %r" % op)
    if not tpl.get("calibrated") and not state.settings.allow_uncalibrated:
        raise GatewayError(
            409, "template_not_calibrated",
            "Issuing a %s has not been verified on a real encoder yet. An administrator must "
            "calibrate it first (Settings > Calibration)." % OP_LABELS.get(op, op), op=op)

