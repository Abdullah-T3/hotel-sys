#!/usr/bin/env python3
"""
Run the whole system locally with a MOCK encoder and a sample hotel - no hardware needed.

    .venv/bin/python scripts/demo.py            # http://localhost:8080   (admin / admin1234)
    .venv/bin/python scripts/demo.py --keep     # keep the demo database from the last run

Card templates are allowed uncalibrated here (mock encoder only). Never use this mode with real locks.
"""
import argparse
import asyncio
import os
import sys
import threading
import time
from datetime import datetime, timedelta

import httpx
import uvicorn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(ROOT, "server"), os.path.join(ROOT, "agent")]

from agent import Agent, MockExecutor  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

ADMIN_KEY = "demo-admin-key-not-for-production"
USER, PASSWORD = "admin", "admin1234"


def at(dt):
    return dt.replace(second=0, microsecond=0).isoformat(timespec="minutes")


def seed(base):
    c = httpx.Client(base_url=base, timeout=15)
    if c.get("/v1/setup").json()["needs_setup"]:
        token = c.post("/v1/setup", json={"hotel_name": "Smart Zoom Hotel", "username": USER, "name": "Demo Admin",
                                          "password": PASSWORD}).json()["token"]
    else:
        token = c.post("/v1/auth/login", json={"username": USER, "password": PASSWORD}).json()["token"]
    c.headers["Authorization"] = "Bearer " + token
    token = None
    if c.get("/v1/encoders/front-desk-1").status_code == 404:
        token = c.post("/v1/encoders", json={"id": "front-desk-1", "name": "Front Desk 1"}).json()["token"]
    if c.get("/v1/buildings").json():
        return c, token  # already seeded
    c.put("/v1/settings", json={"currency": "EGP"})
    c.post("/v1/buildings", json={"no": 1, "name": "Main building"})
    c.post("/v1/buildings", json={"no": 2, "name": "Garden wing"})
    c.post("/v1/rooms/batch", json={"building_no": 1, "floors": "1-3", "rooms": "101-310", "room_type": "Double",
                                    "price": 1200, "hour_start_price": 300, "hour_price": 100, "max_cards": 3})
    c.post("/v1/rooms/batch", json={"building_no": 2, "floors": "1-1", "rooms": "101-106", "room_type": "Suite",
                                    "price": 2500, "max_cards": 4})
    for name, role in (("frontdesk", "operator"), ("manager", "manager")):
        c.post("/v1/operators", json={"username": name, "name": name.title(), "role": role, "password": PASSWORD})
    return c, token


def populate(c):
    rooms = {(r["building_no"], r["room_no"]): r["id"] for r in c.get("/v1/rooms").json()}
    now = datetime.now()
    noon = lambda d: at((now + timedelta(days=d)).replace(hour=12, minute=0))  # noqa: E731
    guests = [("101", "Ahmed Mostafa", 2, True), ("102", "Sara Ibrahim", 1, False), ("105", "John Smith", 4, False),
              ("203", "Fatma Ali", 3, False), ("207", "Omar Khaled", 1, False), ("301", "Laila Hassan", 7, True)]
    for room, name, nights, vip in guests:
        c.post("/v1/reception/check-in", json={"encoder_id": "front-desk-1", "room_id": rooms[(1, room)],
                                               "guest": {"name": name, "phone": "+20 10 %04d %04d" % (len(name) * 37, nights * 911),
                                                         "id_type": "ID card", "id_no": "2%013d" % (len(name) * 7919)},
                                               "check_out": noon(nights), "vip": vip, "deposit": 500})
    c.post("/v1/reception/check-in", json={"encoder_id": "front-desk-1", "room_id": rooms[(1, "108")], "kind": "hourly",
                                           "hours": 3, "guest": {"name": "Walk-in (hourly)"}})
    team = c.post("/v1/reception/team", json={"leader": {"name": "Nile Tours", "phone": "+20 2 2345 6789"},
                                              "room_ids": [rooms[(2, "101")], rooms[(2, "102")], rooms[(2, "103")]],
                                              "check_out": noon(2)}).json()
    for s in team["stays"][:2]:
        c.post("/v1/stays/%d/cards" % s["id"], json={"encoder_id": "front-desk-1"})
    c.post("/v1/reservations", json={"leader": {"name": "Mariam Youssef", "phone": "+20 11 5555 0101"},
                                     "room_ids": [rooms[(1, "205")], rooms[(1, "206")]],
                                     "check_in": at(now.replace(hour=15, minute=0)), "check_out": noon(3)})
    c.post("/v1/reservations", json={"leader": {"name": "Karim Adel"}, "room_ids": [rooms[(2, "105")]],
                                     "check_in": at((now + timedelta(days=2)).replace(hour=14, minute=0)), "check_out": noon(5)})
    c.put("/v1/rooms/%d/housekeeping" % rooms[(1, "103")], json={"housekeeping": "dirty"})
    c.put("/v1/rooms/%d/housekeeping" % rooms[(1, "209")], json={"housekeeping": "dirty"})
    c.put("/v1/rooms/%d/housekeeping" % rooms[(1, "310")], json={"housekeeping": "maintenance", "note": "AC repair"})
    c.post("/v1/staff-cards", json={"encoder_id": "front-desk-1", "kind": "floor", "holder": "Housekeeping — Mona",
                                    "building_no": 1, "floor_no": 1, "valid_to": noon(30), "time_from": "08:00", "time_to": "18:00"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--keep", action="store_true", help="keep the existing demo.db")
    a = ap.parse_args()
    db = os.path.join(ROOT, "demo.db")
    fresh = not (a.keep and os.path.exists(db))
    if fresh:
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(db + ext):
                os.remove(db + ext)
    settings = Settings(admin_keys=frozenset({ADMIN_KEY}), db_path=db, allow_uncalibrated=True, invoke_timeout=5)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=a.port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    base = "http://127.0.0.1:%d" % a.port
    client, token = seed(base)
    if token:
        with open(os.path.join(ROOT, ".demo-agent-token"), "w") as f:
            f.write(token)
    token = token or open(os.path.join(ROOT, ".demo-agent-token")).read().strip()

    agent = Agent("ws://127.0.0.1:%d/agent/ws" % a.port, "front-desk-1", token, MockExecutor(port=1), name="Front Desk 1")
    loop = asyncio.new_event_loop()
    threading.Thread(target=lambda: loop.run_until_complete(agent.run_forever()), daemon=True).start()
    for _ in range(100):
        if client.get("/v1/encoders/front-desk-1").json().get("online"):
            break
        time.sleep(0.05)
    if fresh:
        populate(client)

    print("\n  D801 Lock Manager demo  →  %s\n  Sign in: %s / %s   (also: frontdesk, manager — same password)\n"
          "  Mock encoder 'Front Desk 1' is online. Ctrl+C to stop.\n" % (base, USER, PASSWORD), flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.should_exit = True


if __name__ == "__main__":
    main()
