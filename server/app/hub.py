"""
Agent hub: tracks connected encoder agents and routes commands to them.

- One live connection per encoder id (a reconnect replaces the old one).
- Commands to the SAME encoder are serialized (the vendor DLL is single-threaded
  and a card can only be on one reader anyway); different encoders run in parallel.
- Every command has a timeout; a disconnect fails all in-flight commands.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone


class EncoderOffline(Exception):
    pass


class EncoderTimeout(Exception):
    pass


class AgentError(Exception):
    """The agent raised while executing (e.g. DLL missing a function)."""


class AgentConnection:
    def __init__(self, encoder_id, websocket, info):
        self.encoder_id = encoder_id
        self.websocket = websocket
        self.info = info
        self.connected_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.pending = {}
        self.lock = asyncio.Lock()
        self.closed = False

    def fail_all(self, exc):
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self.pending.clear()


class Hub:
    def __init__(self):
        self._conns = {}

    def get(self, encoder_id):
        return self._conns.get(encoder_id)

    def is_online(self, encoder_id):
        return encoder_id in self._conns

    def online_ids(self):
        return set(self._conns)

    async def attach(self, conn):
        old = self._conns.get(conn.encoder_id)
        self._conns[conn.encoder_id] = conn
        if old is not None:
            await self._close(old, "replaced by a newer connection")

    async def detach(self, conn):
        if self._conns.get(conn.encoder_id) is conn:
            del self._conns[conn.encoder_id]
        conn.closed = True
        conn.fail_all(EncoderOffline("encoder %s disconnected" % conn.encoder_id))

    async def disconnect(self, encoder_id, reason="disconnected by admin"):
        conn = self._conns.pop(encoder_id, None)
        if conn is not None:
            await self._close(conn, reason)

    async def _close(self, conn, reason):
        conn.closed = True
        conn.fail_all(EncoderOffline("encoder %s: %s" % (conn.encoder_id, reason)))
        try:
            await conn.websocket.close(code=4000, reason=reason[:120])
        except Exception:
            pass

    def deliver(self, conn, msg):
        fut = conn.pending.get(msg.get("id"))
        if fut is not None and not fut.done():
            fut.set_result(msg)

    async def invoke(self, encoder_id, fn, args, timeout):
        """Run one DLL call on an encoder. Returns (ret, outs)."""
        conn = self._conns.get(encoder_id)
        if conn is None:
            raise EncoderOffline("encoder %s is offline" % encoder_id)
        async with conn.lock:
            if conn.closed:
                raise EncoderOffline("encoder %s is offline" % encoder_id)
            rid = uuid.uuid4().hex
            fut = asyncio.get_running_loop().create_future()
            conn.pending[rid] = fut
            try:
                await conn.websocket.send_text(json.dumps(
                    {"type": "invoke", "id": rid, "fn": fn, "args": args}))
                msg = await asyncio.wait_for(fut, timeout)
            except asyncio.TimeoutError:
                raise EncoderTimeout("encoder %s did not answer within %ss" % (encoder_id, timeout))
            finally:
                conn.pending.pop(rid, None)
        if "error" in msg:
            raise AgentError(msg["error"])
        return int(msg.get("ret", -1)), list(msg.get("outs") or [])
