"""
Authentication and permissions.

Two ways in, one permission model:
  * Operators (front desk staff) log in with username/password and get a session
    token -> `Authorization: Bearer <token>`.
  * Integrations use API keys -> `X-API-Key: <key>`. An admin key acts as the
    `super` role, a client key as the `operator` role.

Roles mirror the original CardLock software (Super / Admin / Manager / Operator).
"""
import base64
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer

from .db import now

# ----------------------------------------------------------------------------- roles
PERMISSIONS = {
    "reception": "Check-in/out, reservations, guest cards, card info and erase",
    "room_status": "Change housekeeping status (clean / dirty / out of order)",
    "rooms_manage": "Define buildings and rooms",
    "staff_cards": "Issue floor, building, group, check-out, record and loss-report cards",
    "staff_cards_master": "Issue master and emergency cards",
    "lock_setup": "Issue lock setup cards (authorization, room number, clock, group)",
    "reports_view": "View reports",
    "reports_manage": "Export and delete report records",
    "settings": "Change system options",
    "operators": "Manage operators",
    "encoders": "Register and manage encoders",
    "audit": "View the audit log",
    "calibration": "Edit card templates and call raw encoder functions",
}

_OPERATOR = {"reception", "room_status", "reports_view"}
_MANAGER = _OPERATOR | {"staff_cards", "reports_manage"}
_ADMIN = _MANAGER | {"rooms_manage", "lock_setup", "staff_cards_master", "settings",
                     "operators", "encoders", "audit"}
_SUPER = _ADMIN | {"calibration"}

ROLE_PERMS = {"operator": _OPERATOR, "manager": _MANAGER, "admin": _ADMIN, "super": _SUPER}
ROLE_RANK = {"operator": 0, "manager": 1, "admin": 2, "super": 3}
ROLE_LABELS = {"super": "Super administrator", "admin": "Administrator",
               "manager": "Manager", "operator": "Front desk operator"}

SESSION_HOURS = 12

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False,
                               description="Integration API key")
_bearer = HTTPBearer(auto_error=False, description="Operator session token")


# ----------------------------------------------------------------------------- tokens
def new_token():
    return secrets.token_urlsafe(32)


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_token(token, token_hash):
    if not token or not token_hash:
        return False
    return hmac.compare_digest(hash_token(token), token_hash)


def fingerprint(key):
    """Stable, non-reversible id for a key, used as the audit 'actor'."""
    return "key:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:10]


# ----------------------------------------------------------------------------- passwords
_N, _R, _P = 2 ** 14, 8, 1


def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return "scrypt$%d$%d$%d$%s$%s" % (_N, _R, _P, base64.b64encode(salt).decode(),
                                      base64.b64encode(dk).decode())


def check_password(password, stored):
    try:
        _, n, r, p, salt, dk = stored.split("$")
        got = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt),
                             n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(dk))
    except Exception:
        return False


# ----------------------------------------------------------------------------- principal
class Principal:
    def __init__(self, role, actor, operator=None):
        self.role = role
        self.actor = actor
        self.operator = operator
        self.perms = ROLE_PERMS[role]

    @property
    def is_admin(self):
        return "encoders" in self.perms

    def can(self, perm):
        return perm in self.perms

    def outranks_or_equals(self, role):
        return ROLE_RANK[self.role] >= ROLE_RANK[role]


def _match(key, keys):
    return any(hmac.compare_digest(key, k) for k in keys)


def session_principal(db, token):
    row = db.one(
        "SELECT o.id, o.username, o.name, o.role, o.active, o.language, s.expires_at FROM sessions s "
        "JOIN operators o ON o.id = s.operator_id WHERE s.token_hash=?", (hash_token(token),))
    if not row or not row["active"] or row["expires_at"] < now():
        return None
    operator = {k: row[k] for k in ("id", "username", "name", "role", "language")}
    return Principal(row["role"], "op:" + row["username"], operator)


def create_session(db, operator_id):
    token = new_token()
    expires = (datetime.fromisoformat(now()) + timedelta(hours=SESSION_HOURS)).isoformat(timespec="seconds")
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    db.execute("INSERT INTO sessions (token_hash, operator_id, created_at, expires_at) VALUES (?,?,?,?)",
               (hash_token(token), operator_id, now(), expires))
    return token, expires


def authenticate(request: Request,
                 key: str = Depends(_api_key_header),
                 bearer: HTTPAuthorizationCredentials = Depends(_bearer)) -> Principal:
    state = request.app.state
    settings = state.settings
    if bearer and bearer.credentials:
        p = session_principal(state.db, bearer.credentials)
        if p:
            return p
    if key:
        if _match(key, settings.admin_keys):
            return Principal("super", fingerprint(key))
        if _match(key, settings.client_keys):
            return Principal("operator", fingerprint(key))
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in, or the session has expired",
                        headers={"WWW-Authenticate": "Bearer"})


def require(perm):
    def dep(principal: Principal = Depends(authenticate)) -> Principal:
        if not principal.can(perm):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "Your role does not allow this (%s)" % PERMISSIONS.get(perm, perm))
        return principal
    dep.__name__ = "require_" + perm
    return dep


def require_admin(principal: Principal = Depends(authenticate)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return principal


# ----------------------------------------------------------------------------- login throttling
class LoginThrottle:
    """Lock a username for a while after repeated failed logins."""

    def __init__(self, max_failures=5, lock_seconds=300):
        self.max_failures = max_failures
        self.lock_seconds = lock_seconds
        self._fail = {}

    def locked_for(self, username):
        n, until = self._fail.get(username.lower(), (0, 0))
        return max(0, int(until - time.time())) if n >= self.max_failures else 0

    def failed(self, username):
        n, _ = self._fail.get(username.lower(), (0, 0))
        n += 1
        self._fail[username.lower()] = (n, time.time() + self.lock_seconds)

    def succeeded(self, username):
        self._fail.pop(username.lower(), None)
