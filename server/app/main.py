"""
D801 Lock Manager - hotel key-card system on top of a multi-encoder gateway.

  * Web UI for the front desk (served from /, built from ../web)
  * REST API for integrations (/v1, docs at /docs)
  * One agent per front-desk PC keeps an outbound WebSocket to /agent/ws and
    drives that PC's D801-M1 encoder.

Run:  GATEWAY_ADMIN_KEYS=... uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8080   (from ./server)
"""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import Depends, FastAPI, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db as dbmod
from . import errors
from .cardops import run_template
from .config import Settings, load_settings
from .errors import GatewayError, card_data_from, decode_out
from .exports import PRORFL_EXPORTS
from .hotel import reception, reports, rooms, staff, system
from .hub import AgentConnection, AgentError, EncoderOffline, EncoderTimeout, Hub
from .models import (AuditOut, BeepIn, CardOpOut, EncoderCreate, EncoderCreated, EncoderOut,
                     EncoderUpdate, GuestCardIn, InvokeIn, InvokeOut, ReadIn, ReadOut,
                     TemplatePatch, TokenOut, VersionOut)
from .security import (LoginThrottle, Principal, authenticate, hash_token, new_token, require,
                       verify_token)
from .templates import KINDS, MAX_OUT, TemplateError, TemplateStore

API_VERSION = "2.0.0"
HELLO_TIMEOUT = 10
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = (settings or load_settings()).validate()

    @asynccontextmanager
    async def lifespan(app):
        app.state.settings = settings
        app.state.db = dbmod.Database(settings.db_path)
        app.state.templates = TemplateStore(settings.templates_path, app.state.db)
        app.state.hub = Hub()
        app.state.room_locks = {}
        app.state.login_throttle = LoginThrottle()
        yield
        for eid in list(app.state.hub.online_ids()):
            await app.state.hub.disconnect(eid, "server shutting down")
        app.state.db.close()

    app = FastAPI(
        title="D801 Lock Manager",
        version=API_VERSION,
        description="Hotel key-card management for D801-M1 locks, with any number of card encoders. "
                    "Operators sign in with `POST /v1/auth/login` (Bearer token); integrations use `X-API-Key`.",
        lifespan=lifespan,
    )
    errors.install(app)

    def st(request):
        return request.app.state

    def encoder_out(state, rec):
        rec = dict(rec)
        rec["enabled"] = bool(rec["enabled"])
        rec["mock"] = None if rec.get("mock") is None else bool(rec["mock"])
        rec["online"] = state.hub.is_online(rec["id"])
        return EncoderOut(**rec)

    def get_encoder_or_404(state, encoder_id):
        rec = state.db.get_encoder(encoder_id)
        if rec is None:
            raise GatewayError(404, "not_found", "Encoder %s was not found" % encoder_id)
        return rec

    # ------------------------------------------------------------------ health
    @app.get("/health", tags=["system"])
    async def health(request: Request):
        return {"status": "ok", "version": API_VERSION, "encoders_online": len(st(request).hub.online_ids())}

    # ------------------------------------------------------------------ encoders
    @app.get("/v1/encoders", response_model=List[EncoderOut], tags=["encoders"])
    async def list_encoders(request: Request, online: Optional[bool] = None,
                            _: Principal = Depends(authenticate)):
        state = st(request)
        items = [encoder_out(state, r) for r in state.db.list_encoders()]
        return [e for e in items if online is None or e.online == online]

    @app.post("/v1/encoders", response_model=EncoderCreated, status_code=201, tags=["encoders"])
    async def create_encoder(body: EncoderCreate, request: Request, p: Principal = Depends(require("encoders"))):
        state = st(request)
        token = new_token()
        if not state.db.create_encoder(body.id, body.name, hash_token(token)):
            raise GatewayError(409, "exists", "Encoder %r already exists" % body.id)
        state.db.audit(p.actor, "encoder.create", True, encoder_id=body.id, request=body.model_dump())
        return EncoderCreated(token=token, **encoder_out(state, state.db.get_encoder(body.id)).model_dump())

    @app.get("/v1/encoders/{encoder_id}", response_model=EncoderOut, tags=["encoders"])
    async def get_encoder(encoder_id: str, request: Request, _: Principal = Depends(authenticate)):
        state = st(request)
        return encoder_out(state, get_encoder_or_404(state, encoder_id))

    @app.patch("/v1/encoders/{encoder_id}", response_model=EncoderOut, tags=["encoders"])
    async def update_encoder(encoder_id: str, body: EncoderUpdate, request: Request,
                             p: Principal = Depends(require("encoders"))):
        state = st(request)
        get_encoder_or_404(state, encoder_id)
        fields = body.model_dump(exclude_none=True)
        if "enabled" in fields:
            fields["enabled"] = 1 if fields["enabled"] else 0
        state.db.update_encoder(encoder_id, **fields)
        if fields.get("enabled") == 0:
            await state.hub.disconnect(encoder_id, "encoder disabled")
        state.db.audit(p.actor, "encoder.update", True, encoder_id=encoder_id, request=body.model_dump())
        return encoder_out(state, state.db.get_encoder(encoder_id))

    @app.post("/v1/encoders/{encoder_id}/rotate-token", response_model=TokenOut, tags=["encoders"])
    async def rotate_token(encoder_id: str, request: Request, p: Principal = Depends(require("encoders"))):
        state = st(request)
        get_encoder_or_404(state, encoder_id)
        token = new_token()
        state.db.update_encoder(encoder_id, token_hash=hash_token(token))
        await state.hub.disconnect(encoder_id, "token rotated")
        state.db.audit(p.actor, "encoder.rotate_token", True, encoder_id=encoder_id)
        return TokenOut(id=encoder_id, token=token)

    @app.delete("/v1/encoders/{encoder_id}", status_code=204, tags=["encoders"])
    async def delete_encoder(encoder_id: str, request: Request, p: Principal = Depends(require("encoders"))):
        state = st(request)
        get_encoder_or_404(state, encoder_id)
        await state.hub.disconnect(encoder_id, "encoder deleted")
        state.db.delete_encoder(encoder_id)
        state.db.audit(p.actor, "encoder.delete", True, encoder_id=encoder_id)

    # ------------------------------------------------------------------ low-level card operations
    @app.get("/v1/encoders/{encoder_id}/version", response_model=VersionOut, tags=["encoders"])
    async def version(encoder_id: str, request: Request, p: Principal = Depends(authenticate)):
        _, outs, _ = await run_template(st(request), p, encoder_id, "version", {})
        return VersionOut(dll_version=decode_out(outs[0])[0])

    @app.post("/v1/encoders/{encoder_id}/beep", response_model=CardOpOut, tags=["encoders"])
    async def beep(encoder_id: str, body: BeepIn, request: Request, p: Principal = Depends(authenticate)):
        _, _, cal = await run_template(st(request), p, encoder_id, "beep", {"code": body.code}, body.model_dump())
        return CardOpOut(calibrated=cal)

    @app.post("/v1/encoders/{encoder_id}/cards/read", response_model=ReadOut, tags=["encoders"])
    async def read_card(encoder_id: str, request: Request, body: Optional[ReadIn] = None,
                        p: Principal = Depends(require("reception"))):
        body = body or ReadIn()
        state = st(request)
        _, outs, _ = await run_template(state, p, encoder_id, "read_card", {}, body.model_dump())
        card = card_data_from(outs[0])
        card_type = None
        if body.parse:
            ret, touts, _ = await run_template(state, p, encoder_id, "card_type", {"card": card},
                                               {"card": card}, check_ret=False)
            if ret == 0 and touts:
                card_type = bytes.fromhex(touts[0])[0]
        return ReadOut(card_data=card, raw_hex=outs[0], card_type=card_type)

    @app.post("/v1/encoders/{encoder_id}/cards/guest", response_model=CardOpOut, tags=["encoders"])
    async def issue_guest(encoder_id: str, body: GuestCardIn, request: Request,
                          p: Principal = Depends(require("reception"))):
        """Low-level guest card (no stay is recorded). The hotel flow is POST /v1/reception/check-in."""
        params = dict(body.options)
        params.update(building=body.building, floor=body.floor, room=body.room, start=body.start, end=body.end)
        _, outs, cal = await run_template(st(request), p, encoder_id, "issue_guest", params,
                                          body.model_dump(mode="json"))
        card = card_data_from(outs[-1]) if outs else None
        return CardOpOut(card_data=card or None, calibrated=cal)

    @app.post("/v1/encoders/{encoder_id}/cards/erase", response_model=CardOpOut, tags=["encoders"])
    async def erase_card(encoder_id: str, request: Request, p: Principal = Depends(require("reception"))):
        _, _, cal = await run_template(st(request), p, encoder_id, "erase_card", {})
        return CardOpOut(calibrated=cal)

    # ------------------------------------------------------------------ admin: raw + templates + audit
    @app.post("/v1/encoders/{encoder_id}/invoke", response_model=InvokeOut, tags=["calibration"])
    async def raw_invoke(encoder_id: str, body: InvokeIn, request: Request,
                         p: Principal = Depends(require("calibration"))):
        """Call any proRFL.dll export directly. Used to calibrate templates on real hardware."""
        state = st(request)
        get_encoder_or_404(state, encoder_id)
        if body.fn not in PRORFL_EXPORTS:
            raise GatewayError(422, "unknown_function", "%r is not a proRFL.dll export" % body.fn)
        for a in body.args:
            ok = (len(a) == 2 and a[0] in KINDS and
                  (isinstance(a[1], int) if a[0] != "s" else isinstance(a[1], str)) and
                  (a[0] != "o" or 1 <= a[1] <= MAX_OUT))
            if not ok:
                raise GatewayError(422, "bad_args", "Bad argument descriptor %r" % (a,))
        try:
            ret, outs = await state.hub.invoke(encoder_id, body.fn, body.args, state.settings.invoke_timeout)
        except EncoderOffline as e:
            state.db.audit(p.actor, "admin.invoke", False, encoder_id=encoder_id,
                           request=body.model_dump(), detail=str(e))
            raise GatewayError(503, "encoder_offline", str(e))
        except EncoderTimeout as e:
            raise GatewayError(504, "encoder_timeout", str(e))
        except AgentError as e:
            raise GatewayError(502, "agent_error", str(e))
        state.db.audit(p.actor, "admin.invoke", ret == 0, encoder_id=encoder_id, ret=ret,
                       request=body.model_dump())
        return InvokeOut(ret=ret, outs=outs, outs_text=[decode_out(o)[0] for o in outs])

    @app.get("/v1/templates", tags=["calibration"])
    async def list_templates(request: Request, _: Principal = Depends(require("encoders"))):
        return st(request).templates.all()

    @app.patch("/v1/templates/{name}", tags=["calibration"])
    async def patch_template(name: str, body: TemplatePatch, request: Request,
                             p: Principal = Depends(require("calibration"))):
        state = st(request)
        patch = body.model_dump(exclude_none=True)
        try:
            result = state.templates.update(name, patch, p.actor)
        except TemplateError as e:
            raise GatewayError(422, "template_error", str(e))
        state.db.audit(p.actor, "template.update", True, request={"name": name, **patch})
        return result

    @app.get("/v1/audit", response_model=List[AuditOut], tags=["system"])
    async def audit_log(request: Request, limit: int = Query(100, ge=1, le=1000),
                        encoder_id: Optional[str] = None, actor: Optional[str] = None,
                        before_id: Optional[int] = None, _: Principal = Depends(require("audit"))):
        return st(request).db.list_audit(limit=limit, encoder_id=encoder_id, actor=actor, before_id=before_id)

    # ------------------------------------------------------------------ hotel
    for module in (system, rooms, reception, staff, reports):
        app.include_router(module.router)

    # ------------------------------------------------------------------ agent WebSocket
    @app.websocket("/agent/ws")
    async def agent_ws(ws: WebSocket):
        state = ws.app.state
        await ws.accept()
        try:
            hello = json.loads(await asyncio.wait_for(ws.receive_text(), HELLO_TIMEOUT))
        except Exception:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        eid = str(hello.get("encoder_id") or "")
        rec = state.db.get_encoder(eid, with_secret=True) if hello.get("type") == "hello" else None
        if rec is None or not rec["enabled"] or not verify_token(hello.get("token"), rec["token_hash"]):
            state.db.audit("agent:" + (eid or "?"), "agent.rejected", False, encoder_id=eid or None,
                           detail="unknown encoder, disabled, or bad token")
            await ws.send_text(json.dumps({"type": "error", "error": "unauthorized"}))
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        info = {k: hello.get(k) for k in ("host", "port", "dll_version", "agent_version", "mock",
                                         "platform", "python_bits", "name")}
        state.db.update_encoder(eid, last_seen=dbmod.now(), host=info["host"],
                                port=int(info["port"]) if info["port"] is not None else None,
                                dll_version=info["dll_version"], agent_version=info["agent_version"],
                                mock=1 if info["mock"] else 0)
        conn = AgentConnection(eid, ws, info)
        await ws.send_text(json.dumps({"type": "welcome", "server_version": API_VERSION}))
        await state.hub.attach(conn)
        state.db.audit("agent:" + eid, "agent.connected", True, encoder_id=eid, request=info)
        try:
            while True:
                msg = json.loads(await ws.receive_text())
                if msg.get("type") == "result":
                    state.hub.deliver(conn, msg)
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            await state.hub.detach(conn)
            state.db.update_encoder(eid, last_seen=dbmod.now())
            state.db.audit("agent:" + eid, "agent.disconnected", True, encoder_id=eid)

    # ------------------------------------------------------------------ web UI (single-page app)
    index_html = os.path.join(STATIC_DIR, "index.html")
    if os.path.isdir(os.path.join(STATIC_DIR, "assets")):
        app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("v1/", "agent/")) or path in ("v1", "agent"):
            return JSONResponse({"error": "not_found", "message": "No such endpoint"}, status_code=404)
        candidate = os.path.normpath(os.path.join(STATIC_DIR, path))
        if path and candidate.startswith(STATIC_DIR + os.sep) and os.path.isfile(candidate):
            return FileResponse(candidate)
        if os.path.isfile(index_html):
            return FileResponse(index_html, headers={"Cache-Control": "no-cache"})
        return JSONResponse({"error": "ui_not_built",
                             "message": "Web UI not built. Run `npm run build` in ./web, or use /docs."},
                            status_code=404)

    return app
