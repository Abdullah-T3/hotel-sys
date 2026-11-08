# Architecture

> The system has two layers: the **encoder gateway** (agents, hub, card templates — below) and the
> **hotel application** on top of it (rooms, stays, cards, reports, operators, web UI — see the end).

## Why it is shaped this way

Three facts about the vendor stack drive the design:

1. **`proRFL.dll` is 32‑bit Windows code** with global state. It must run in a
   32‑bit process on Windows, and calls into it must not overlap.
2. **`d12c.dll` opens the first matching HID encoder** (`IniUsbPro` takes no
   arguments: `SetupDiGetClassDevs` → `HidD_GetAttributes` → `CreateFile`). One
   process can therefore drive exactly **one** encoder.
3. Encoders sit on **front‑desk PCs**, which are usually behind NAT/firewalls
   and get rebooted.

So every encoder gets its own small **agent** process on its own PC, and a
central **gateway** owns everything else. Agents dial out; the gateway never
needs to reach into a front‑desk PC.

## Components

| Component | Runs on | Responsibility |
|---|---|---|
| `server/app/main.py` | gateway host | REST API, agent WebSocket endpoint, error mapping |
| `server/app/hub.py` | gateway | live agent connections; per‑encoder command queue; timeouts |
| `server/app/templates.py` + `card_templates.json` | gateway | card operations as DLL calls; calibration flags; validation |
| `server/app/db.py` | gateway | SQLite: encoder registry, template overrides, audit log |
| `server/app/security.py` | gateway | API keys (admin/client), agent token hashing |
| `agent/agent.py` | front‑desk PC | open encoder, keep WebSocket, execute commands one at a time |
| `agent/prorfl_rt.py` | front‑desk PC | load `proRFL.dll`; call any export with in/out buffers |
| `agent/mock_dll.py` | dev/tests | in‑memory encoder with the same contract |

**The agent knows nothing about card semantics.** It only runs
"call function F with these arguments". All business meaning (what a guest card
is, argument order, time formats) lives in the gateway's templates. Fixing a
calibration is a template edit, with no redeploy to front‑desk PCs.

## Agent protocol (WebSocket, JSON text frames)

```
agent → gateway   {"type":"hello","encoder_id":"front-desk-1","token":"…","port":1,
                   "dll_version":"proUSB-V9-20171130","host":"…","agent_version":"1.0.0",…}
gateway → agent   {"type":"welcome","server_version":"1.0.0"}        (or "error" + close 1008)
gateway → agent   {"type":"invoke","id":"<uuid>","fn":"ReadCard","args":[["i",1],["o",128]]}
agent → gateway   {"type":"result","id":"<uuid>","ret":0,"outs":["4438…"]}
                  {"type":"result","id":"<uuid>","error":"AttributeError: …"}
```

Argument descriptors: `["i", int]` input int, `["s", str]` input string,
`["o", size]` output buffer. Outputs come back as the **full buffer in hex**, so
embedded NULs never lose data. WebSocket pings (20 s) detect dead links, and
the agent reconnects with exponential backoff (max 30 s).

## Concurrency

- Commands for the **same** encoder are serialized (an `asyncio.Lock` per
  connection on the gateway, plus a single DLL worker thread in the agent).
- Commands for **different** encoders run in parallel.
- Each command has a timeout (`GATEWAY_INVOKE_TIMEOUT`). A disconnect fails
  every in‑flight command with `503` immediately.
- A second agent connecting with the same id replaces the first.

## Security model

- **Client keys** may list encoders and run card operations.
  **Admin keys** may also register/disable/delete encoders, rotate tokens, edit
  templates, call raw DLL functions, and read the audit log.
- Keys are compared in constant time. The audit log records a key
  *fingerprint* (`key:<sha256 prefix>`), never the key.
- Agent tokens are random 256‑bit values, stored only as SHA‑256 hashes, shown
  once at registration, and rotatable (rotation disconnects the agent).
  Disabling an encoder disconnects it and blocks reconnects.
- Raw invoke is limited to the 77 real `proRFL.dll` exports with bounded
  buffers. Template placeholders are plain names only (no attribute access).
- Operations that mint **master / emergency / building / floor** cards are
  deliberately **not** exposed as client endpoints. Those cards open many doors;
  issue them from the vendor software, or add admin‑only templates if you need
  them.
- Use HTTPS/`wss://` in front of the gateway when traffic leaves a trusted LAN.

## Audit log

Every card operation, admin action, and agent connect, disconnect, or rejection
is written with time, actor, encoder, request body, DLL return code, and
success flag (`GET /v1/audit`).

## Known limits / next steps

- **Calibration**: `issue_guest` and `erase_card` are inferred and blocked until
  verified ([CALIBRATION.md](CALIBRATION.md)).
- **Several encoders on one PC** is not possible with the stock `d12c.dll`
  (first‑match). It would need a replacement `d12c.dll` shim exporting
  `IniUsbPro/readPortPro/writePortPro/CloseHandles` that opens a specific HID
  device path chosen per agent process.
- SQLite fits a single gateway instance. For multiple gateway replicas, move
  storage to Postgres and the hub to a shared message bus.

## Hotel application layer

| Module (`server/app/hotel/`) | Responsibility |
|---|---|
| `service.py` | settings, the 8 room statuses, overlap/availability rules, shared lookups |
| `reception.py` | board, check-in (walk-in / hourly / team), reservations, extra card, extend, change room, check-out, card info/erase |
| `rooms.py` | buildings, rooms, bulk add, housekeeping |
| `staff.py` | staff cards and lock-setup cards |
| `reports.py` | card / guest / door-open records, CSV export, cleanup |
| `system.py` | first-run setup, login, operators, settings, metadata for the UI |

Rules every card flow follows:

- **Card first, database second.** The card is written on the encoder before
  anything is recorded; if writing fails nothing changes, so the operator just
  retries. The database write then re-checks for races in a transaction.
- **One operation per room at a time** (an in-process lock per room), so two
  front desks cannot sell the same room simultaneously.
- **Mirror the lock's own logic.** A new check-in card makes every older guest
  card of that lock invalid, so those records are marked *replaced*; a
  loss-report card marks the target card *lost*; cards past `valid_to` show as
  *expired*.
- Room status is computed, not stored: active stay → Occupied / Team / Hourly /
  Overdue; otherwise Out of order, Reserved (arrival before tomorrow), Dirty or Clean.

**Roles** (same idea as CardLock): *Front desk* — reception, housekeeping,
reports; *Manager* — + staff cards, report cleanup; *Admin* — + rooms, lock
setup, master/emergency cards, settings, operators, encoders, audit; *Super* —
+ calibration. Nobody can manage an operator ranked above them, and the last
super administrator cannot be removed. Integration API keys map to *Super*
(admin key) or *Front desk* (client key).

**Languages** (`web/src/i18n/`): flat dictionaries per language with CLDR
plural forms, rich-text placeholders and RTL. The server stays language-neutral:
errors carry a stable `error` code plus fields (`room_no`, `encoder`, `max`…),
and the UI turns them into sentences; labels (room states, card types, roles)
travel as codes. The operator's language is stored on their account
(`PUT /v1/auth/preferences`), the hotel default in settings.

**Web UI** (`web/`): React 19, TypeScript, Tailwind 4, TanStack Query (board
refreshes every 10 s, encoders every 5 s). Every card write goes through one
component (`CardStep`) that checks the encoder is selected, online and the card
type calibrated, then guides the operator ("Place a blank card on Front Desk 1")
and turns failures into plain-language messages with a retry.
