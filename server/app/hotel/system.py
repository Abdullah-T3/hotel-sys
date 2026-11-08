"""Setup, login, operators, settings, metadata."""
from typing import List

from fastapi import APIRouter, Depends, Request, Response

from ..db import now
from ..errors import GatewayError, conflict, not_found
from ..security import (PERMISSIONS, ROLE_LABELS, ROLE_PERMS, Principal, authenticate,
                        check_password, create_session, hash_password, hash_token, require)
from . import service as svc
from .models import (LANGUAGES, LoginIn, OperatorIn, OperatorUpdate, PasswordChangeIn, PreferencesIn, SettingsIn,
                     SetupIn)

router = APIRouter(prefix="/v1")

OPERATOR_COLS = "id, username, name, role, active, note, created_at, last_login"


def _op_out(row):
    row = dict(row)
    row["active"] = bool(row["active"])
    row["role_label"] = ROLE_LABELS[row["role"]]
    return row


def _me(principal: Principal):
    return {
        "operator": principal.operator,
        "actor": principal.actor,
        "role": principal.role,
        "role_label": ROLE_LABELS[principal.role],
        "permissions": sorted(principal.perms),
    }


# ----------------------------------------------------------------------------- setup
@router.get("/setup", tags=["auth"])
async def setup_status(request: Request):
    db = request.app.state.db
    n = db.one("SELECT COUNT(*) AS n FROM operators")["n"]
    s = svc.get_settings(db)
    return {"needs_setup": n == 0, "hotel_name": s["hotel_name"], "default_language": s["default_language"],
            "languages": list(LANGUAGES)}


@router.post("/setup", tags=["auth"])
async def setup(body: SetupIn, request: Request):
    """First run only: create the super administrator and name the hotel."""
    db = request.app.state.db
    with db.tx() as t:
        if t.one("SELECT COUNT(*) AS n FROM operators")["n"]:
            raise conflict("The system is already set up", "already_setup")
        op_id = t.insert("INSERT INTO operators (username, name, role, password_hash, created_at) "
                         "VALUES (?,?,?,?,?)", (body.username, body.name, "super",
                                                hash_password(body.password), now()))
    db.set_settings({"hotel_name": body.hotel_name, **({"default_language": body.language} if body.language else {})})
    if body.language:
        db.execute("UPDATE operators SET language=? WHERE id=?", (body.language, op_id))
    token, expires = create_session(db, op_id)
    db.audit("op:" + body.username, "system.setup", True, request={"hotel_name": body.hotel_name})
    return {"token": token, "expires_at": expires}


# ----------------------------------------------------------------------------- session
@router.post("/auth/login", tags=["auth"])
async def login(body: LoginIn, request: Request):
    db = request.app.state.db
    throttle = request.app.state.login_throttle
    wait = throttle.locked_for(body.username)
    if wait:
        minutes = max(1, (wait + 59) // 60)
        raise GatewayError(429, "locked", "Too many failed attempts. Try again in %d minutes." % minutes,
                           minutes=minutes)
    op = db.one("SELECT * FROM operators WHERE username=?", (body.username,))
    if not op or not op["active"] or not check_password(body.password, op["password_hash"]):
        throttle.failed(body.username)
        db.audit("op:" + body.username, "auth.login", False, detail="bad credentials or inactive")
        raise GatewayError(401, "bad_credentials", "Wrong username or password")
    throttle.succeeded(body.username)
    token, expires = create_session(db, op["id"])
    db.execute("UPDATE operators SET last_login=? WHERE id=?", (now(), op["id"]))
    db.audit("op:" + op["username"], "auth.login", True)
    return {"token": token, "expires_at": expires}


@router.post("/auth/logout", status_code=204, tags=["auth"])
async def logout(request: Request, p: Principal = Depends(authenticate)):
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        request.app.state.db.execute("DELETE FROM sessions WHERE token_hash=?", (hash_token(auth[7:].strip()),))
    return Response(status_code=204)


@router.get("/auth/me", tags=["auth"])
async def me(p: Principal = Depends(authenticate)):
    return _me(p)


@router.post("/auth/password", status_code=204, tags=["auth"])
async def change_password(body: PasswordChangeIn, request: Request, p: Principal = Depends(authenticate)):
    if not p.operator:
        raise GatewayError(400, "not_an_operator", "API keys have no password")
    db = request.app.state.db
    op = db.one("SELECT * FROM operators WHERE id=?", (p.operator["id"],))
    if not check_password(body.current_password, op["password_hash"]):
        raise GatewayError(400, "bad_password", "Current password is wrong")
    db.execute("UPDATE operators SET password_hash=? WHERE id=?", (hash_password(body.new_password), op["id"]))
    db.audit(p.actor, "auth.password_changed", True)
    return Response(status_code=204)


@router.put("/auth/preferences", tags=["auth"])
async def set_preferences(body: PreferencesIn, request: Request, p: Principal = Depends(authenticate)):
    """Save the signed-in operator's UI language."""
    if not p.operator:
        raise GatewayError(400, "not_an_operator", "API keys have no preferences")
    request.app.state.db.execute("UPDATE operators SET language=? WHERE id=?", (body.language, p.operator["id"]))
    return {"language": body.language}


# ----------------------------------------------------------------------------- metadata
@router.get("/meta", tags=["system"])
async def meta(request: Request, p: Principal = Depends(authenticate)):
    state = request.app.state
    settings = svc.get_settings(state.db)
    templates = state.templates.all()
    return {
        "hotel_name": settings["hotel_name"],
        "currency": settings["currency"],
        "default_language": settings["default_language"],
        "checkout_time": settings["checkout_time"],
        "vip_checkout_time": settings["vip_checkout_time"],
        "room_statuses": svc.ROOM_STATUSES,
        "card_kinds": svc.CARD_KINDS,
        "card_statuses": svc.CARD_STATUSES,
        "id_types": svc.ID_TYPES,
        "roles": ROLE_LABELS,
        "role_permissions": {r: sorted(v) for r, v in ROLE_PERMS.items()},
        "permissions": PERMISSIONS,
        "calibrated": {k: bool(v.get("calibrated")) or state.settings.allow_uncalibrated
                       for k, v in templates.items()},
        "allow_uncalibrated": state.settings.allow_uncalibrated,
        "me": _me(p),
    }


# ----------------------------------------------------------------------------- settings
@router.get("/settings", tags=["system"])
async def get_settings(request: Request, p: Principal = Depends(authenticate)):
    return svc.get_settings(request.app.state.db)


@router.put("/settings", tags=["system"])
async def put_settings(body: SettingsIn, request: Request, p: Principal = Depends(require("settings"))):
    db = request.app.state.db
    values = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    db.set_settings(values)
    db.audit(p.actor, "settings.update", True, request=values)
    return svc.get_settings(db)


# ----------------------------------------------------------------------------- operators
def _can_manage(p: Principal, role):
    if not p.outranks_or_equals(role):
        raise GatewayError(403, "forbidden", "You cannot manage operators with a higher role than yours")
    if role == "super" and p.role != "super":
        raise GatewayError(403, "forbidden", "Only a super administrator can manage super administrators")


@router.get("/operators", tags=["operators"])
async def list_operators(request: Request, p: Principal = Depends(require("operators"))) -> List[dict]:
    rows = request.app.state.db.query("SELECT %s FROM operators ORDER BY username" % OPERATOR_COLS)
    return [_op_out(r) for r in rows]


@router.post("/operators", status_code=201, tags=["operators"])
async def create_operator(body: OperatorIn, request: Request, p: Principal = Depends(require("operators"))):
    _can_manage(p, body.role)
    db = request.app.state.db
    if db.one("SELECT id FROM operators WHERE username=?", (body.username,)):
        raise conflict("Username %s is already taken" % body.username, "username_taken", username=body.username)
    op_id = db.insert("INSERT INTO operators (username, name, role, password_hash, note, created_at) "
                      "VALUES (?,?,?,?,?,?)", (body.username, body.name, body.role,
                                               hash_password(body.password), body.note, now()))
    db.audit(p.actor, "operator.create", True, request=body.model_dump(exclude={"password"}))
    return _op_out(db.one("SELECT %s FROM operators WHERE id=?" % OPERATOR_COLS, (op_id,)))


def _supers_left(db, excluding_id):
    return db.one("SELECT COUNT(*) AS n FROM operators WHERE role='super' AND active=1 AND id != ?",
                  (excluding_id,))["n"]


@router.patch("/operators/{op_id}", tags=["operators"])
async def update_operator(op_id: int, body: OperatorUpdate, request: Request,
                          p: Principal = Depends(require("operators"))):
    db = request.app.state.db
    op = db.one("SELECT * FROM operators WHERE id=?", (op_id,))
    if not op:
        raise not_found("Operator", op_id)
    _can_manage(p, op["role"])
    if body.role:
        _can_manage(p, body.role)
    is_self = p.operator and p.operator["id"] == op_id
    if is_self and (body.active is False or (body.role and body.role != op["role"])):
        raise GatewayError(400, "self_change", "You cannot deactivate yourself or change your own role")
    demoting_super = op["role"] == "super" and ((body.role and body.role != "super") or body.active is False)
    if demoting_super and _supers_left(db, op_id) == 0:
        raise conflict("At least one active super administrator must remain", "last_super")
    fields = body.model_dump(exclude_unset=True, exclude={"password"})
    if "active" in fields:
        fields["active"] = 1 if fields["active"] else 0
    if body.password:
        fields["password_hash"] = hash_password(body.password)
    if fields:
        db.execute("UPDATE operators SET %s WHERE id=?" % ",".join("%s=?" % k for k in fields),
                   tuple(fields.values()) + (op_id,))
    if body.active is False or body.password or body.role:
        db.execute("DELETE FROM sessions WHERE operator_id=?", (op_id,))
    db.audit(p.actor, "operator.update", True, request={"id": op_id, **body.model_dump(exclude={"password"},
                                                                                     exclude_unset=True)})
    return _op_out(db.one("SELECT %s FROM operators WHERE id=?" % OPERATOR_COLS, (op_id,)))


@router.delete("/operators/{op_id}", status_code=204, tags=["operators"])
async def delete_operator(op_id: int, request: Request, p: Principal = Depends(require("operators"))):
    db = request.app.state.db
    op = db.one("SELECT * FROM operators WHERE id=?", (op_id,))
    if not op:
        raise not_found("Operator", op_id)
    _can_manage(p, op["role"])
    if p.operator and p.operator["id"] == op_id:
        raise GatewayError(400, "self_change", "You cannot delete yourself")
    if op["role"] == "super" and _supers_left(db, op_id) == 0:
        raise conflict("At least one active super administrator must remain", "last_super")
    db.execute("DELETE FROM operators WHERE id=?", (op_id,))
    db.audit(p.actor, "operator.delete", True, request={"id": op_id, "username": op["username"]})
    return Response(status_code=204)
