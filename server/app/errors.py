"""Uniform JSON errors: {"error": <code>, "message": <human text>, ...}."""
import string

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

_HTTP_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
               405: "method_not_allowed", 409: "conflict", 422: "validation_error",
               429: "too_many_requests"}


class GatewayError(Exception):
    def __init__(self, status_code, error, message, **extra):
        super().__init__(message)
        self.status_code = status_code
        self.body = {"error": error, "message": message}
        self.body.update(extra)


def not_found(what, ident):
    return GatewayError(404, "not_found", "%s %s was not found" % (what, ident))


def conflict(message, error="conflict", **extra):
    return GatewayError(409, error, message, **extra)


def decode_out(hex_out):
    """Output buffer -> (text up to first NUL, full hex)."""
    raw = bytes.fromhex(hex_out)
    return raw.split(b"\x00", 1)[0].decode("latin1"), hex_out


def card_data_from(hex_out):
    """Cards come back either as an ASCII hex string or as raw bytes - normalise to hex text."""
    text, _ = decode_out(hex_out)
    if len(text) >= 8 and all(c in string.hexdigits for c in text):
        return text.upper()
    return bytes.fromhex(hex_out).rstrip(b"\x00").hex().upper()


def _field(loc):
    parts = [str(p) for p in loc if p not in ("body", "query", "path")]
    return ".".join(parts) or "request"


def install(app):
    @app.exception_handler(GatewayError)
    async def _gateway(request, exc: GatewayError):
        return JSONResponse(exc.body, status_code=exc.status_code)

    @app.exception_handler(HTTPException)
    async def _http(request, exc: HTTPException):
        msg = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JSONResponse({"error": _HTTP_CODES.get(exc.status_code, "error"), "message": msg,
                             "detail": exc.detail},
                            status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation(request, exc: RequestValidationError):
        errors = [{"field": _field(e.get("loc", ())), "message": e.get("msg", "invalid")}
                  for e in exc.errors()]
        first = errors[0] if errors else {"field": "request", "message": "invalid"}
        msg = first["message"].removeprefix("Value error, ")
        return JSONResponse({"error": "validation_error",
                             "message": "%s: %s" % (first["field"], msg),
                             "errors": errors}, status_code=422)
