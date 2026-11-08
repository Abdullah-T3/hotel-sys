"""
End-to-end tests: real uvicorn gateway + real WebSocket agents driving mock encoders.

    .venv/bin/pytest -q
"""
import asyncio
import os
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import uvicorn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))
sys.path.insert(0, os.path.join(ROOT, "agent"))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from agent import Agent, MockExecutor  # noqa: E402
from mock_dll import SAMPLE_CARD, MockEncoder  # noqa: E402

ADMIN = "admin-key-0123456789abcdef"
CLIENT = "client-key-0123456789abcdef"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ServerThread:
    def __init__(self, settings):
        self.port = free_port()
        cfg = uvicorn.Config(create_app(settings), host="127.0.0.1", port=self.port,
                             log_level="warning", ws_ping_interval=None)
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            assert time.time() < deadline, "server did not start"
            time.sleep(0.05)
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)

    @property
    def http(self):
        return "http://127.0.0.1:%d" % self.port

    @property
    def ws(self):
        return "ws://127.0.0.1:%d/agent/ws" % self.port


class AgentThread:
    """Runs agent.Agent in its own thread + event loop, like a separate front-desk PC."""

    def __init__(self, ws_url, encoder_id, token, encoder=None):
        self.encoder = encoder or MockEncoder()
        self.agent = Agent(ws_url, encoder_id, token, MockExecutor(port=1, encoder=self.encoder))
        self.agent.max_backoff = 1.0
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.task = None

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.task = self.loop.create_task(self.agent.run_forever())
        try:
            self.loop.run_until_complete(self.task)
        except asyncio.CancelledError:
            pass
        finally:
            self.loop.close()

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        while self.task is None:
            time.sleep(0.01)
        self.loop.call_soon_threadsafe(self.task.cancel)
        self.thread.join(timeout=10)


@pytest.fixture
def gateway(tmp_path):
    settings = Settings(admin_keys=frozenset({ADMIN}), client_keys=frozenset({CLIENT}),
                        db_path=str(tmp_path / "gw.db"), invoke_timeout=3.0)
    with ServerThread(settings) as srv:
        yield srv


def admin(srv):
    return httpx.Client(base_url=srv.http, headers={"X-API-Key": ADMIN}, timeout=10)


def client(srv):
    return httpx.Client(base_url=srv.http, headers={"X-API-Key": CLIENT}, timeout=10)


def register(srv, encoder_id, name=None):
    r = admin(srv).post("/v1/encoders", json={"id": encoder_id, "name": name or encoder_id})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def wait_online(srv, encoder_id, online=True, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if admin(srv).get("/v1/encoders/%s" % encoder_id).json()["online"] == online:
            return
        time.sleep(0.05)
    raise AssertionError("%s never became online=%s" % (encoder_id, online))


# ---------------------------------------------------------------------------
def test_health_and_auth(gateway):
    assert httpx.get(gateway.http + "/health").json()["status"] == "ok"
    assert httpx.get(gateway.http + "/v1/encoders").status_code == 401
    assert httpx.get(gateway.http + "/v1/encoders", headers={"X-API-Key": "wrong-key-xxxxxxxxxx"}).status_code == 401
    assert client(gateway).get("/v1/encoders").status_code == 200
    # client keys cannot manage encoders, call raw functions, or read the audit log
    assert client(gateway).post("/v1/encoders", json={"id": "x", "name": "x"}).status_code == 403
    assert client(gateway).get("/v1/audit").status_code == 403
    assert client(gateway).get("/v1/templates").status_code == 403
    assert admin(gateway).get("/v1/encoders/nope").status_code == 404


def test_settings_require_strong_admin_key():
    with pytest.raises(RuntimeError):
        Settings().validate()
    with pytest.raises(RuntimeError):
        Settings(admin_keys=frozenset({"short"})).validate()


def test_two_encoders_route_independently(gateway):
    t1, t2 = register(gateway, "desk-1"), register(gateway, "desk-2")
    a1 = AgentThread(gateway.ws, "desk-1", t1).start()
    a2 = AgentThread(gateway.ws, "desk-2", t2, encoder=MockEncoder(card=None)).start()
    try:
        wait_online(gateway, "desk-1")
        wait_online(gateway, "desk-2")
        c = client(gateway)

        listed = {e["id"]: e for e in c.get("/v1/encoders").json()}
        assert listed["desk-1"]["online"] and listed["desk-2"]["online"]
        assert listed["desk-1"]["dll_version"] == "proUSB-V9-20171130"
        assert listed["desk-1"]["port"] == 1 and listed["desk-1"]["mock"] is True

        assert c.get("/v1/encoders/desk-1/version").json() == {"dll_version": "proUSB-V9-20171130"}

        # beep goes ONLY to the encoder addressed
        assert c.post("/v1/encoders/desk-1/beep", json={"code": 2}).status_code == 200
        assert (a1.encoder.beeps, a2.encoder.beeps) == (1, 0)
        assert a1.encoder.calls[-1] == ("Buzzer", [["i", 1], ["i", 2]])

        # read: desk-1 has a card, desk-2's reader is empty
        r = c.post("/v1/encoders/desk-1/cards/read")
        assert r.status_code == 200, r.text
        assert r.json()["card_data"] == SAMPLE_CARD
        assert r.json()["card_type"] == 0x3E
        r = c.post("/v1/encoders/desk-2/cards/read", json={"parse": False})
        assert r.status_code == 502
        assert r.json()["error"] == "encoder_error" and r.json()["code"] == 1

        # many concurrent requests across both encoders: all succeed, none lost
        def hit(i):
            return client(gateway).post("/v1/encoders/desk-%d/beep" % (1 + i % 2), json={}).status_code
        with ThreadPoolExecutor(8) as pool:
            codes = list(pool.map(hit, range(20)))
        assert codes == [200] * 20
        assert (a1.encoder.beeps, a2.encoder.beeps) == (11, 10)
    finally:
        a1.stop()
        a2.stop()


def test_uncalibrated_operations_are_blocked_until_admin_calibrates(gateway):
    a = AgentThread(gateway.ws, "desk-1", register(gateway, "desk-1")).start()
    try:
        wait_online(gateway, "desk-1")
        c = client(gateway)
        guest = {"building": 1, "floor": 2, "room": 3,
                 "start": "2026-11-08T14:00:00", "end": "2026-11-09T12:00:00"}

        r = c.post("/v1/encoders/desk-1/cards/guest", json=guest)
        assert r.status_code == 409 and r.json()["error"] == "template_not_calibrated"
        assert not any(fn == "GuestCard" for fn, _ in a.encoder.calls), "nothing may reach the encoder"
        assert c.post("/v1/encoders/desk-1/cards/erase").status_code == 409

        # validation
        bad = dict(guest, end="2026-11-07T12:00:00")
        assert c.post("/v1/encoders/desk-1/cards/guest", json=bad).status_code == 422
        assert c.post("/v1/encoders/desk-1/cards/guest", json=dict(guest, building=16)).status_code == 422

        # admin verifies on hardware, then marks the template calibrated
        tpl = admin(gateway).get("/v1/templates").json()["issue_guest"]
        assert tpl["calibrated"] is False
        r = admin(gateway).patch("/v1/templates/issue_guest", json={"calibrated": True})
        assert r.status_code == 200 and r.json()["calibrated"] is True

        r = c.post("/v1/encoders/desk-1/cards/guest", json=dict(guest, options={"card_index": 2}))
        assert r.status_code == 200, r.text
        assert r.json()["calibrated"] is True
        fn, args = a.encoder.calls[-1]
        assert fn == "GuestCard"
        assert args[:7] == [["i", 1], ["i", 79375], ["i", 1], ["i", 2], ["i", 3], ["i", 2], ["s", "2611081400"]]
        assert args[7] == ["s", "2611091200"]

        # the card now on the reader encodes building 1 / floor 2 / room 3
        assert c.post("/v1/encoders/desk-1/cards/read").json()["card_data"].startswith("D801360F3E010203")

        # templates are validated: only real DLL exports, no attribute access in placeholders
        assert admin(gateway).patch("/v1/templates/beep", json={"fn": "system"}).status_code == 422
        assert admin(gateway).patch("/v1/templates/beep",
                                    json={"args": [["i", "{port.__class__}"]]}).status_code == 422
    finally:
        a.stop()


def test_admin_raw_invoke_and_audit(gateway):
    a = AgentThread(gateway.ws, "desk-1", register(gateway, "desk-1")).start()
    try:
        wait_online(gateway, "desk-1")
        r = admin(gateway).post("/v1/encoders/desk-1/invoke",
                                json={"fn": "ReadCard", "args": [["i", 1], ["o", 64]]})
        assert r.status_code == 200, r.text
        assert r.json()["ret"] == 0 and r.json()["outs_text"] == [SAMPLE_CARD]
        assert client(gateway).post("/v1/encoders/desk-1/invoke",
                                    json={"fn": "ReadCard", "args": []}).status_code == 403
        assert admin(gateway).post("/v1/encoders/desk-1/invoke",
                                   json={"fn": "LoadLibraryA", "args": []}).status_code == 422
        assert admin(gateway).post("/v1/encoders/desk-1/invoke",
                                   json={"fn": "ReadCard", "args": [["o", 999999]]}).status_code == 422

        client(gateway).post("/v1/encoders/desk-1/cards/read")
        actions = [e["action"] for e in admin(gateway).get("/v1/audit?encoder_id=desk-1").json()]
        for expected in ("encoder.create", "agent.connected", "admin.invoke", "card.read_card", "card.card_type"):
            assert expected in actions, (expected, actions)
        # secrets never end up in the audit log
        assert ADMIN not in str(admin(gateway).get("/v1/audit").json())
    finally:
        a.stop()


def test_offline_bad_token_disable_and_rotate(gateway):
    token = register(gateway, "desk-1")

    # wrong token: rejected, stays offline, rejection is audited
    bad = AgentThread(gateway.ws, "desk-1", "not-the-token").start()
    time.sleep(1.0)
    assert admin(gateway).get("/v1/encoders/desk-1").json()["online"] is False
    bad.stop()
    assert "agent.rejected" in [e["action"] for e in admin(gateway).get("/v1/audit").json()]

    # offline encoder -> 503
    assert client(gateway).post("/v1/encoders/desk-1/beep", json={}).status_code == 503

    a = AgentThread(gateway.ws, "desk-1", token).start()
    wait_online(gateway, "desk-1")
    assert client(gateway).post("/v1/encoders/desk-1/beep", json={}).status_code == 200

    # disabling kicks the agent and blocks card operations
    admin(gateway).patch("/v1/encoders/desk-1", json={"enabled": False})
    wait_online(gateway, "desk-1", online=False)
    assert client(gateway).post("/v1/encoders/desk-1/beep", json={}).status_code == 409
    admin(gateway).patch("/v1/encoders/desk-1", json={"enabled": True})
    wait_online(gateway, "desk-1")  # agent reconnects by itself

    # rotating the token disconnects the agent, and the old token no longer works
    new = admin(gateway).post("/v1/encoders/desk-1/rotate-token").json()["token"]
    assert new != token
    wait_online(gateway, "desk-1", online=False)
    time.sleep(1.5)
    assert admin(gateway).get("/v1/encoders/desk-1").json()["online"] is False
    a.stop()

    b = AgentThread(gateway.ws, "desk-1", new).start()
    wait_online(gateway, "desk-1")
    b.stop()
    wait_online(gateway, "desk-1", online=False)

    # delete
    assert admin(gateway).delete("/v1/encoders/desk-1").status_code == 204
    assert admin(gateway).get("/v1/encoders/desk-1").status_code == 404
