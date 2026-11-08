"""Request / response schemas (these drive the OpenAPI docs at /docs)."""
from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator

ENCODER_ID = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$"


class EncoderCreate(BaseModel):
    id: str = Field(pattern=ENCODER_ID, examples=["front-desk-1"])
    name: str = Field(min_length=1, max_length=100, examples=["Front Desk 1"])


class EncoderUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    enabled: Optional[bool] = None


class EncoderOut(BaseModel):
    id: str
    name: str
    enabled: bool
    online: bool
    created_at: str
    last_seen: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    dll_version: Optional[str] = None
    agent_version: Optional[str] = None
    mock: Optional[bool] = None


class EncoderCreated(EncoderOut):
    token: str = Field(description="Agent token. Shown only once - put it in the agent's config.")


class TokenOut(BaseModel):
    id: str
    token: str


class BeepIn(BaseModel):
    code: int = Field(default=1, ge=0, le=255, description="Beep pattern sent to the encoder")


class ReadIn(BaseModel):
    parse: bool = Field(default=True, description="Also decode the card type")


class ReadOut(BaseModel):
    card_data: str
    raw_hex: str
    card_type: Optional[int] = None


class GuestCardIn(BaseModel):
    building: int = Field(ge=0, le=15)
    floor: int = Field(ge=0, le=98)
    room: int = Field(ge=0, le=98, description="Room id within the floor (lock RomID)")
    start: datetime
    end: datetime
    options: Dict[str, Union[int, str]] = Field(
        default_factory=dict,
        description="Extra template parameters (e.g. card_index, flags) - see GET /v1/templates")

    @model_validator(mode="after")
    def _check_times(self):
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self

    @field_validator("options")
    @classmethod
    def _option_names(cls, v):
        reserved = {"port", "building", "floor", "room", "start", "end"}
        bad = [k for k in v if not k.isidentifier() or k in reserved]
        if bad:
            raise ValueError("invalid option names: %s" % ", ".join(bad))
        return v


class CardOpOut(BaseModel):
    ok: bool = True
    card_data: Optional[str] = None
    calibrated: bool


class VersionOut(BaseModel):
    dll_version: str


class InvokeIn(BaseModel):
    fn: str = Field(examples=["ReadCard"])
    args: List[List[Any]] = Field(default_factory=list, examples=[[["i", 1], ["o", 128]]])


class InvokeOut(BaseModel):
    ret: int
    outs: List[str]
    outs_text: List[str]


class TemplatePatch(BaseModel):
    fn: Optional[str] = None
    args: Optional[List[List[Any]]] = None
    defaults: Optional[Dict[str, Union[int, str]]] = None
    calibrated: Optional[bool] = None
    note: Optional[str] = None


class AuditOut(BaseModel):
    id: int
    ts: str
    actor: str
    encoder_id: Optional[str] = None
    action: str
    ok: bool
    ret: Optional[int] = None
    request: Optional[Any] = None
    detail: Optional[str] = None
