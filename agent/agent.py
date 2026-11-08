#!/usr/bin/env python3
"""
agent.py - D801 encoder agent.

Runs on each front-desk Windows PC that has ONE D801-M1 USB encoder attached.
It loads the vendor proRFL.dll (32-bit, so this must run under 32-bit Python),
opens the encoder, then connects OUT to the gateway server over WebSocket and
executes card commands the gateway sends it. Because the connection is
outbound, front-desk PCs need no open inbound ports.

    python agent.py --config agent.json
    python agent.py --mock --server ws://127.0.0.1:8080/agent/ws --id desk-1 --token ...

Keep this file Python 3.8 compatible.
"""
import argparse
import asyncio
import json
import logging
import os
import platform
import socket
import struct
import sys
from concurrent.futures import ThreadPoolExecutor

AGENT_VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

log = logging.getLogger("d801.agent")


# --------------------------------------------------------------------------
# Executors: the only thing that touches the encoder.
# --------------------------------------------------------------------------
class RealExecutor(object):
    """Drives the physical encoder through proRFL.dll."""

    mock = False

    def __init__(self, port, dll_dir=None):
        import prorfl_rt
        self._rt = prorfl_rt
        self._dll = prorfl_rt.load_dll(dll_dir)
        self.port = port

    def invoke(self, fn, descs):
        return self._rt.invoke(self._dll, fn, descs)


class MockExecutor(object):
    """In-memory encoder for development/tests (see mock_dll.py)."""

    mock = True

    def __init__(self, port=1, encoder=None):
        from mock_dll import MockEncoder
        self.encoder = encoder or MockEncoder()
        self.port = port

    def invoke(self, fn, descs):
        return self.encoder.invoke(fn, descs)


def decode_cstr(hex_out):
    raw = bytes.fromhex(hex_out)
    return raw.split(b"\x00", 1)[0].decode("latin1")


# --------------------------------------------------------------------------
# Agent loop
# --------------------------------------------------------------------------
class Agent(object):
    def __init__(self, server_url, encoder_id, token, executor, name=None,
                 max_backoff=30.0):
        self.server_url = server_url
        self.encoder_id = encoder_id
        self.token = token
        self.name = name or encoder_id
        self.executor = executor
        self.max_backoff = max_backoff
        # The vendor DLL keeps global state and is not thread-safe:
        # every DLL call goes through this single worker thread.
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dll")
        self.dll_version = None
        self.connected = asyncio.Event() if sys.version_info >= (3, 10) else None

    async def _call(self, fn, descs):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, self.executor.invoke, fn, descs)

    async def open_encoder(self):
        ret, _ = await self._call("initializeUSB", [["i", self.executor.port]])
        if ret != 0:
            log.warning("initializeUSB(port=%s) returned %s - is the encoder plugged in?",
                        self.executor.port, ret)
        ret, outs = await self._call("GetDLLVersion", [["o", 32]])
        self.dll_version = decode_cstr(outs[0]) if ret == 0 and outs else None
        log.info("encoder opened (port=%s, dll=%s, mock=%s)",
                 self.executor.port, self.dll_version, self.executor.mock)

    async def close_encoder(self):
        try:
            await self._call("CloseUSB", [["i", 0]])
        except Exception:  # pragma: no cover - best effort on shutdown
            pass
        self._pool.shutdown(wait=False)

    def _hello(self):
        return {
            "type": "hello",
            "encoder_id": self.encoder_id,
            "token": self.token,
            "name": self.name,
            "host": socket.gethostname(),
            "port": self.executor.port,
            "dll_version": self.dll_version,
            "agent_version": AGENT_VERSION,
            "platform": platform.platform(),
            "python_bits": struct.calcsize("P") * 8,
            "mock": self.executor.mock,
        }

    async def _handle(self, ws, msg):
        if msg.get("type") != "invoke":
            return
        rid = msg.get("id")
        try:
            ret, outs = await self._call(msg["fn"], msg.get("args", []))
            resp = {"type": "result", "id": rid, "ret": ret, "outs": outs}
        except Exception as e:
            log.exception("invoke %s failed", msg.get("fn"))
            resp = {"type": "result", "id": rid, "error": "%s: %s" % (type(e).__name__, e)}
        await ws.send(json.dumps(resp))

    async def run_forever(self):
        import websockets

        await self.open_encoder()
        backoff = 1.0
        try:
            while True:
                try:
                    async with websockets.connect(self.server_url, ping_interval=20,
                                                  ping_timeout=20, max_size=1 << 20) as ws:
                        await ws.send(json.dumps(self._hello()))
                        reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
                        if reply.get("type") != "welcome":
                            raise PermissionError(reply.get("error", "rejected by gateway"))
                        log.info("connected to %s as %r", self.server_url, self.encoder_id)
                        if self.connected is not None:
                            self.connected.set()
                        backoff = 1.0
                        async for raw in ws:
                            # Commands are executed strictly one at a time.
                            await self._handle(ws, json.loads(raw))
                except PermissionError as e:
                    log.error("gateway refused this agent: %s (check encoder id/token)", e)
                except (OSError, asyncio.TimeoutError, ValueError) as e:
                    log.warning("connection problem: %s", e)
                except Exception as e:  # websockets.* closed/handshake errors
                    log.warning("disconnected: %s: %s", type(e).__name__, e)
                if self.connected is not None:
                    self.connected.clear()
                log.info("reconnecting in %.0fs", backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.max_backoff)
        finally:
            await self.close_encoder()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def load_config(argv=None):
    p = argparse.ArgumentParser(description="D801 encoder agent")
    p.add_argument("--config", help="JSON config file (see agent.example.json)")
    p.add_argument("--server", help="gateway WebSocket URL, e.g. ws://gateway:8080/agent/ws")
    p.add_argument("--id", dest="encoder_id", help="encoder id registered on the gateway")
    p.add_argument("--token", help="agent token issued by the gateway")
    p.add_argument("--name", help="display name")
    p.add_argument("--port", type=int, help="encoder port: 1=Pro HID (D801-M1, default), 0=legacy")
    p.add_argument("--dll-dir", help="folder containing proRFL.dll + Mwic_32/d12c/d12 (default ./vendor)")
    p.add_argument("--mock", action="store_true", help="use the in-memory mock encoder")
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)

    cfg = {"port": 1}
    if a.config:
        with open(a.config) as f:
            cfg.update(json.load(f))
    env = {"server_url": "D801_SERVER", "encoder_id": "D801_ENCODER_ID",
           "token": "D801_TOKEN", "name": "D801_NAME"}
    for key, var in env.items():
        if os.environ.get(var):
            cfg[key] = os.environ[var]
    for key, val in (("server_url", a.server), ("encoder_id", a.encoder_id), ("token", a.token),
                     ("name", a.name), ("port", a.port), ("dll_dir", a.dll_dir)):
        if val is not None:
            cfg[key] = val
    if a.mock:
        cfg["mock"] = True
    cfg["verbose"] = a.verbose
    missing = [k for k in ("server_url", "encoder_id", "token") if not cfg.get(k)]
    if missing:
        p.error("missing required setting(s): %s" % ", ".join(missing))
    return cfg


def main(argv=None):
    cfg = load_config(argv)
    logging.basicConfig(level=logging.DEBUG if cfg.get("verbose") else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if cfg.get("mock"):
        executor = MockExecutor(port=int(cfg["port"]))
    else:
        if os.name != "nt":
            sys.exit("The real encoder agent only runs on Windows (use --mock elsewhere).")
        if struct.calcsize("P") != 4:
            sys.exit("proRFL.dll is 32-bit: run this agent with 32-bit (x86) Python. "
                     "Current interpreter is %d-bit." % (struct.calcsize("P") * 8))
        executor = RealExecutor(port=int(cfg["port"]), dll_dir=cfg.get("dll_dir"))
    agent = Agent(cfg["server_url"], cfg["encoder_id"], cfg["token"], executor, name=cfg.get("name"))
    try:
        asyncio.run(agent.run_forever())
    except KeyboardInterrupt:
        log.info("stopped")


if __name__ == "__main__":
    main()
