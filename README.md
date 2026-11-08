# D801 Lock Manager

A modern replacement for the vendor's **CardLock.exe** hotel lock software for
**D801‑M1** RFID locks, with the same features and flows. It runs in a web
browser, supports **any number of card encoders** (one per front‑desk PC), and
has a REST API for integrating your PMS.

```
 Browsers (front desk, manager, admin) ─┐
 Your PMS / integrations (API key) ─────┤ HTTPS
                                        ▼
                     D801 Lock Manager server (FastAPI + web UI)
                     rooms · stays · cards · reports · audit · SQLite
                                        ▲ outbound WebSocket
          ┌─────────────────────────────┼────────────────────────┐
   Front desk PC 1                Front desk PC 2               …
   agent.py (32-bit Python)       agent.py
   vendor proRFL.dll → D801-M1    proRFL.dll → D801-M1
```

## What it does (CardLock → here)

| CardLock module | D801 Lock Manager |
|---|---|
| Logon, operators, permissions | Sign-in, first-run setup, roles **Super / Admin / Manager / Front desk**, login lock-out |
| Reception | Live **room board** (Vacant clean/dirty, Occupied, Team, Hourly, Reserved, Overdue, Out of order) · walk-in & hourly check-in · team check-in · reservations & arrivals · extra card · extend · change room · check-out with/without card · card info · card erase · housekeeping |
| Rooms definition | Buildings, rooms, **bulk add** (`1-5` floors × `101-518` rooms) with preview |
| Keys for staff | Floor, building, master, emergency, group, check-out, record, loss-report cards |
| Lock configuration | Authorization, room-number, clock, group-setup (set/clear one/all) and system-options cards |
| System maintenance | Hotel options, check-out times, lock behaviour options, encoders, calibration, audit log |
| Reports | Card / guest / door-open records · filters · Excel (CSV) export · print · cleanup |

Plus things CardLock didn't have: multiple encoders, a browser UI on any PC or
tablet, dark mode, a full audit trail, and an API.

**Languages:** English, العربية (Arabic, full right-to-left layout), 简体中文, Русский,
Türkçe, Tiếng Việt. Each operator picks a language from the account menu and it
follows them to any PC; the hotel's default (Settings → General) is used on the
sign-in screen. Card types and room states reuse CardLock's own wording where it
was good, so staff see familiar terms. Excel exports use the operator's language.

## Try it now (no hardware)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

```bash
.venv/bin/python scripts/demo.py
```

Open <http://localhost:8080> and sign in as **admin / admin1234**
(also `frontdesk` and `manager`, same password). The demo starts a sample hotel
and a **mock encoder**, so every flow works end to end.

## Status — read this before using real locks

The vendor's card format is written by its own `proRFL.dll`, which we call
directly. Argument counts and types were recovered from the DLL; the **argument
order for each card type still has to be confirmed on a real encoder and lock**.
Until an administrator confirms a card type (Settings → Calibration), the
system **refuses to write it** rather than guess. Reading cards works now.
→ [docs/CALIBRATION.md](docs/CALIBRATION.md) (about an hour with one encoder and one test lock).

## Deploying

**Server** — any always-on machine the front desks can reach (Windows, Linux, macOS):

```bash
cd server && GATEWAY_ADMIN_KEYS=<long-random-secret> ../.venv/bin/uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8080
```

Open it in a browser; the first visit asks you to create the super administrator.
Put HTTPS in front (Caddy / nginx / IIS) if it is reachable beyond the hotel LAN.

| Variable | Meaning |
|---|---|
| `GATEWAY_ADMIN_KEYS` | **required** — API keys with full access (≥16 chars, comma-separated) |
| `GATEWAY_CLIENT_KEYS` | API keys for integrations with front-desk rights |
| `GATEWAY_DB` | SQLite file (default `gateway.db`) — back it up |
| `GATEWAY_INVOKE_TIMEOUT` | seconds to wait for an encoder (default 15) |

**Encoder agent** — on each front-desk PC with a D801‑M1 encoder:

1. Install **32-bit (x86)** Python 3.8+ (the vendor DLL is 32-bit).
2. Copy `agent/`, put the vendor DLLs in `agent/vendor/` (see its README).
3. `py -3-32 -m pip install -r requirements.txt`
4. In the web UI: **Settings → Encoders → Register encoder**; save the shown
   config as `agent/agent.json`.
5. Close `CardLock.exe` and run `run_agent.bat` (or install it as a service).

**Web UI** — prebuilt into `server/app/static`. To change it: `cd web && npm install && npm run dev`
(proxies the API on :8080), then `npm run build`.

## Integration API

Interactive docs at `/docs`. Integrations send `X-API-Key`; operators use
`Authorization: Bearer <token>` from `POST /v1/auth/login`. Main endpoints:

| | |
|---|---|
| `GET /v1/reception/board` | all rooms with live status |
| `POST /v1/reception/check-in` | check in + write card on an encoder |
| `POST /v1/stays/{id}/cards` · `/extend` · `/move` · `/checkout` · `/arrive` | stay actions |
| `POST /v1/reservations` · `/v1/reception/team` · `/v1/parties/{id}/cancel` | groups |
| `POST /v1/cards/inspect` · `/v1/cards/erase` · `/v1/cards/checkout` | card on the reader |
| `POST /v1/staff-cards` · `/v1/lock-setup` | staff and lock cards |
| `GET /v1/reports/cards` · `/guests` · `/open-records` (`?format=csv`) | reports |
| `GET/POST /v1/encoders` · `GET /v1/audit` | encoders, audit |

Errors are JSON: `{"error": "room_occupied", "message": "Room 101 is occupied"}`.

## Project layout

```
server/app/          FastAPI: main.py, hub.py (agents), cardops.py, security.py, db.py
server/app/hotel/    rooms, reception, staff & lock cards, reports, operators/settings
server/card_templates.json   every card type as a proRFL.dll call + calibration flag
web/                 React + TypeScript + Tailwind UI (built into server/app/static)
agent/               encoder agent, DLL runtime, ctypes bindings, mock encoder
scripts/demo.py      local demo with sample data
tests/               end-to-end tests (real server + agents + mock encoders)
docs/                architecture, calibration, decoded vendor SDK
```

Tests: `.venv/bin/pytest -q` · translations: `cd web && npm run i18n:check`

### Adding or changing UI text

All UI text lives in `web/src/i18n/en.ts` (English is the source; missing keys
fall back to it). Add the key there, use it with `t("key")`, add it to each
language file, then run `npm run i18n:check` — it fails on missing or unknown
keys, changed `{placeholders}` and missing plural forms (Arabic needs
zero/one/two/few/many/other, Russian one/few/many/other, Turkish one/other,
Chinese and Vietnamese other).
