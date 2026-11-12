"""SQLite storage: encoder registry, template overrides, audit log, and the hotel data."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS encoders (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    last_seen     TEXT,
    host          TEXT,
    port          INTEGER,
    dll_version   TEXT,
    agent_version TEXT,
    mock          INTEGER
);
CREATE TABLE IF NOT EXISTS template_overrides (
    name       TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
);
CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    encoder_id TEXT,
    action     TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    ret        INTEGER,
    request    TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS audit_encoder ON audit(encoder_id, id);

-- ---------------------------------------------------------------- hotel
CREATE TABLE IF NOT EXISTS operators (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    note          TEXT,
    created_at    TEXT NOT NULL,
    last_login    TEXT,
    language      TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS buildings (
    no   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    building_no      INTEGER NOT NULL REFERENCES buildings(no),
    floor_no         INTEGER NOT NULL,
    lock_room        INTEGER NOT NULL,
    room_no          TEXT NOT NULL,
    room_type        TEXT NOT NULL DEFAULT 'Standard',
    price            REAL NOT NULL DEFAULT 0,
    hour_start_price REAL NOT NULL DEFAULT 0,
    hour_price       REAL NOT NULL DEFAULT 0,
    max_cards        INTEGER NOT NULL DEFAULT 5,
    housekeeping     TEXT NOT NULL DEFAULT 'clean',
    maintenance_note TEXT,
    public_door      INTEGER NOT NULL DEFAULT 0,
    note             TEXT,
    UNIQUE (building_no, room_no),
    UNIQUE (building_no, floor_no, lock_room)
);
CREATE TABLE IF NOT EXISTS parties (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,
    leader_name    TEXT NOT NULL,
    leader_id_type TEXT,
    leader_id_no   TEXT,
    phone          TEXT,
    note           TEXT,
    created_at     TEXT NOT NULL,
    created_by     TEXT
);
CREATE TABLE IF NOT EXISTS stays (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id        INTEGER NOT NULL REFERENCES rooms(id),
    party_id       INTEGER REFERENCES parties(id),
    kind           TEXT NOT NULL,
    status         TEXT NOT NULL,
    check_in       TEXT NOT NULL,
    check_out      TEXT NOT NULL,
    checked_out_at TEXT,
    vip            INTEGER NOT NULL DEFAULT 0,
    price          REAL NOT NULL DEFAULT 0,
    deposit        REAL NOT NULL DEFAULT 0,
    cards_issued   INTEGER NOT NULL DEFAULT 0,
    note           TEXT,
    created_at     TEXT NOT NULL,
    created_by     TEXT
);
CREATE INDEX IF NOT EXISTS stays_room ON stays(room_id, status);
CREATE TABLE IF NOT EXISTS guests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stay_id    INTEGER NOT NULL REFERENCES stays(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    sex        TEXT,
    id_type    TEXT,
    id_no      TEXT,
    phone      TEXT,
    is_primary INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS guests_stay ON guests(stay_id);
CREATE TABLE IF NOT EXISTS cards (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,
    card_data      TEXT,
    holder         TEXT,
    room_id        INTEGER REFERENCES rooms(id),
    stay_id        INTEGER REFERENCES stays(id),
    building_no    INTEGER,
    floor_no       INTEGER,
    group_no       INTEGER,
    target_card_id INTEGER,
    valid_from     TEXT,
    valid_to       TEXT,
    time_from      TEXT,
    time_to        TEXT,
    status         TEXT NOT NULL,
    encoder_id     TEXT,
    issued_by      TEXT,
    issued_at      TEXT NOT NULL,
    note           TEXT
);
CREATE INDEX IF NOT EXISTS cards_data ON cards(card_data);
CREATE INDEX IF NOT EXISTS cards_stay ON cards(stay_id);
CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS open_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_label  TEXT,
    card_ref    TEXT,
    card_kind   TEXT,
    opened_at   TEXT,
    raw         TEXT,
    uploaded_at TEXT NOT NULL,
    encoder_id  TEXT
);
"""

ENCODER_COLUMNS = ("id", "name", "enabled", "created_at", "last_seen", "host", "port",
                   "dll_version", "agent_version", "mock")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_now():
    """Hotel-local wall-clock time, minute precision (what the locks use)."""
    return datetime.now().replace(second=0, microsecond=0)


class Tx:
    """Statements run inside Database.tx(): committed together or not at all."""

    def __init__(self, conn):
        self._c = conn

    def execute(self, sql, params=()):
        return self._c.execute(sql, params)

    def insert(self, sql, params=()):
        return self._c.execute(sql, params).lastrowid

    def query(self, sql, params=()):
        return [dict(r) for r in self._c.execute(sql, params).fetchall()]

    def one(self, sql, params=()):
        rows = self.query(sql, params)
        return rows[0] if rows else None


class Database:
    def __init__(self, path):
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.executescript(SCHEMA)
            self._migrate()

    def _migrate(self):
        """Add columns introduced after a database was created."""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(operators)").fetchall()}
        if "language" not in cols:
            self._conn.execute("ALTER TABLE operators ADD COLUMN language TEXT")

    def close(self):
        with self._lock:
            self._conn.close()

    # --- generic helpers ----------------------------------------------------
    def execute(self, sql, params=()):
        with self._lock:
            return self._conn.execute(sql, params)

    def insert(self, sql, params=()):
        with self._lock:
            return self._conn.execute(sql, params).lastrowid

    def query(self, sql, params=()):
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def one(self, sql, params=()):
        rows = self.query(sql, params)
        return rows[0] if rows else None

    @contextmanager
    def tx(self):
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield Tx(self._conn)
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    # back-compat names used by the encoder layer
    _exec = execute
    _query = query

    # --- encoders ---------------------------------------------------------
    def create_encoder(self, encoder_id, name, token_hash):
        try:
            self.execute("INSERT INTO encoders (id, name, token_hash, created_at) VALUES (?,?,?,?)",
                         (encoder_id, name, token_hash, now()))
        except sqlite3.IntegrityError:
            return False
        return True

    def get_encoder(self, encoder_id, with_secret=False):
        cols = ENCODER_COLUMNS + (("token_hash",) if with_secret else ())
        return self.one("SELECT %s FROM encoders WHERE id=?" % ",".join(cols), (encoder_id,))

    def list_encoders(self):
        return self.query("SELECT %s FROM encoders ORDER BY id" % ",".join(ENCODER_COLUMNS))

    def update_encoder(self, encoder_id, **fields):
        allowed = {"name", "enabled", "token_hash", "last_seen", "host", "port",
                   "dll_version", "agent_version", "mock"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return
        sets = ",".join("%s=?" % k for k in fields)
        self.execute("UPDATE encoders SET %s WHERE id=?" % sets, tuple(fields.values()) + (encoder_id,))

    def delete_encoder(self, encoder_id):
        return self.execute("DELETE FROM encoders WHERE id=?", (encoder_id,)).rowcount > 0

    # --- template overrides -------------------------------------------------
    def get_template_overrides(self):
        return {r["name"]: json.loads(r["body"])
                for r in self.query("SELECT name, body FROM template_overrides")}

    def set_template_override(self, name, body, actor):
        self.execute("INSERT INTO template_overrides (name, body, updated_at, updated_by) VALUES (?,?,?,?) "
                     "ON CONFLICT(name) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at, "
                     "updated_by=excluded.updated_by", (name, json.dumps(body), now(), actor))

    # --- settings -----------------------------------------------------------
    def get_settings(self):
        return {r["key"]: json.loads(r["value"]) for r in self.query("SELECT key, value FROM settings")}

    def set_settings(self, values):
        with self.tx() as t:
            for k, v in values.items():
                t.execute("INSERT INTO settings (key, value) VALUES (?,?) "
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, json.dumps(v)))

    # --- audit --------------------------------------------------------------
    def audit(self, actor, action, ok, encoder_id=None, ret=None, request=None, detail=None):
        self.execute("INSERT INTO audit (ts, actor, encoder_id, action, ok, ret, request, detail) "
                     "VALUES (?,?,?,?,?,?,?,?)",
                     (now(), actor, encoder_id, action, 1 if ok else 0, ret,
                      json.dumps(request, default=str) if request is not None else None, detail))

    def list_audit(self, limit=100, encoder_id=None, before_id=None, actor=None):
        sql, params = "SELECT * FROM audit WHERE 1=1", []
        if encoder_id:
            sql += " AND encoder_id=?"
            params.append(encoder_id)
        if actor:
            sql += " AND actor=?"
            params.append(actor)
        if before_id:
            sql += " AND id<?"
            params.append(before_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        rows = self.query(sql, tuple(params))
        for r in rows:
            r["ok"] = bool(r["ok"])
            r["request"] = json.loads(r["request"]) if r["request"] else None
        return rows
