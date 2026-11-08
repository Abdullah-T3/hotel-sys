"""Run a card-operation template on an encoder - the single path to the hardware."""
from .errors import GatewayError
from .hub import AgentError, EncoderOffline, EncoderTimeout
from .hotel.service import get_settings
from .templates import TemplateError

# Human-friendly names used in error messages and the UI.
OP_LABELS = {
    "read_card": "read card", "card_type": "decode card", "beep": "beep", "version": "version",
    "issue_guest": "guest card", "erase_card": "erase card",
    "issue_master": "master card", "issue_building": "building card", "issue_floor": "floor card",
    "issue_emergency": "emergency card", "issue_group": "group card", "issue_checkout": "check-out card",
    "issue_record": "record card", "issue_loss": "loss-report card",
    "issue_authorization": "authorization card", "issue_room_set": "room-number setup card",
    "issue_clock_set": "clock setup card", "issue_group_set": "group setup card",
    "issue_system": "system options card", "read_record": "read door-open records",
}


async def run_template(state, principal, encoder_id, op, params, audit_req=None, check_ret=True,
                       action=None):
    """Render template `op`, run it on `encoder_id`, audit it. Returns (ret, outs, calibrated)."""
    if not encoder_id:
        raise GatewayError(400, "no_encoder", "Select a card encoder first")
    rec = state.db.get_encoder(encoder_id)
    if rec is None:
        raise GatewayError(404, "not_found", "Encoder %s was not found" % encoder_id)
    action = action or ("card." + op)

    def audit(ok, ret=None, detail=None):
        state.db.audit(principal.actor, action, ok, encoder_id=encoder_id, ret=ret,
                       request=audit_req, detail=detail)

    if not rec["enabled"]:
        audit(False, detail="encoder disabled")
        raise GatewayError(409, "encoder_disabled", "Encoder %s is disabled" % rec["name"], encoder=rec["name"])
    port = rec["port"] if rec["port"] is not None else 1
    values = {"port": port, "co_id": get_settings(state.db)["co_id"]}
    values.update(params)
    try:
        fn, descs, calibrated = state.templates.render(op, values)
    except KeyError:
        raise GatewayError(500, "template_missing", "No card template named %r" % op)
    except TemplateError as e:
        raise GatewayError(422, "template_error", str(e))
    if not calibrated and not state.settings.allow_uncalibrated:
        audit(False, detail="template not calibrated")
        raise GatewayError(
            409, "template_not_calibrated",
            "Issuing a %s has not been verified on a real encoder yet. An administrator must "
            "calibrate it first (Settings > Calibration, see docs/CALIBRATION.md)."
            % OP_LABELS.get(op, op), op=op)
    try:
        ret, outs = await state.hub.invoke(encoder_id, fn, descs, state.settings.invoke_timeout)
    except EncoderOffline as e:
        audit(False, detail=str(e))
        raise GatewayError(503, "encoder_offline",
                           "Encoder %s is offline. Check that its agent is running." % rec["name"], encoder=rec["name"])
    except EncoderTimeout as e:
        audit(False, detail=str(e))
        raise GatewayError(504, "encoder_timeout", "Encoder %s did not respond in time" % rec["name"],
                           encoder=rec["name"])
    except AgentError as e:
        audit(False, detail=str(e))
        raise GatewayError(502, "agent_error", str(e))
    audit(ret == 0, ret=ret)
    if check_ret and ret != 0:
        raise GatewayError(502, "encoder_error",
                           "The encoder could not %s (code %d). Is a card placed on the encoder?"
                           % (OP_LABELS.get(op, op), ret), code=ret, op=op)
    return ret, outs, calibrated
