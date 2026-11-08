"""Request models for the hotel API."""
import re
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
LANGUAGES = ("en", "ar", "zh", "ru", "tr", "vi")
Language = Literal["en", "ar", "zh", "ru", "tr", "vi"]
RANGE = r"^\s*\d{1,4}\s*(-\s*\d{1,4}\s*)?$"


def _range(text):
    a, _, b = text.partition("-")
    a = int(a)
    b = int(b) if b.strip() else a
    if b < a:
        raise ValueError("range end is before its start")
    return a, b


# ----------------------------------------------------------------------------- auth / setup
class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(max_length=200)


class SetupIn(BaseModel):
    hotel_name: str = Field(min_length=1, max_length=100)
    username: str = Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=200)
    language: Optional[Language] = None


class PreferencesIn(BaseModel):
    language: Language


class PasswordChangeIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class OperatorIn(BaseModel):
    username: str = Field(min_length=2, max_length=50, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=100)
    role: Literal["operator", "manager", "admin", "super"]
    password: str = Field(min_length=8, max_length=200)
    note: Optional[str] = Field(default=None, max_length=200)


class OperatorUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    role: Optional[Literal["operator", "manager", "admin", "super"]] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=8, max_length=200)
    note: Optional[str] = Field(default=None, max_length=200)


# ----------------------------------------------------------------------------- settings
class LockOptions(BaseModel):
    alarm: bool = False
    remind_close: bool = True
    no_disturb: bool = True
    release_handle_lock: bool = False
    music: bool = False
    disable_cover: bool = False


class SettingsIn(BaseModel):
    hotel_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    checkout_time: Optional[str] = Field(default=None, pattern=HHMM)
    vip_checkout_time: Optional[str] = Field(default=None, pattern=HHMM)
    after_checkout: Optional[Literal["dirty", "clean"]] = None
    guest_opens_deadbolt: Optional[bool] = None
    currency: Optional[str] = Field(default=None, max_length=8)
    default_language: Optional[Language] = None
    co_id: Optional[int] = Field(default=None, ge=0, le=0xFFFFFFF)
    lock_options: Optional[LockOptions] = None


# ----------------------------------------------------------------------------- rooms
class BuildingIn(BaseModel):
    no: int = Field(ge=0, le=15)
    name: str = Field(min_length=1, max_length=100)


class BuildingUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class RoomFields(BaseModel):
    room_type: str = Field(default="Standard", min_length=1, max_length=50)
    price: float = Field(default=0, ge=0)
    hour_start_price: float = Field(default=0, ge=0)
    hour_price: float = Field(default=0, ge=0)
    max_cards: int = Field(default=5, ge=1, le=255)
    public_door: bool = False
    note: Optional[str] = Field(default=None, max_length=200)


class RoomIn(RoomFields):
    building_no: int = Field(ge=0, le=15)
    floor_no: int = Field(ge=0, le=98)
    lock_room: int = Field(ge=0, le=98, description="Room id inside the floor, written to the lock")
    room_no: str = Field(min_length=1, max_length=20)


class RoomUpdate(BaseModel):
    floor_no: Optional[int] = Field(default=None, ge=0, le=98)
    lock_room: Optional[int] = Field(default=None, ge=0, le=98)
    room_no: Optional[str] = Field(default=None, min_length=1, max_length=20)
    room_type: Optional[str] = Field(default=None, min_length=1, max_length=50)
    price: Optional[float] = Field(default=None, ge=0)
    hour_start_price: Optional[float] = Field(default=None, ge=0)
    hour_price: Optional[float] = Field(default=None, ge=0)
    max_cards: Optional[int] = Field(default=None, ge=1, le=255)
    public_door: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=200)


class RoomBatchIn(RoomFields):
    """Same rules as CardLock: floors "1-5" and rooms "101-518" -> x01..x18 on floors 1..5."""
    building_no: int = Field(ge=0, le=15)
    floors: str = Field(pattern=RANGE, examples=["1-5"])
    rooms: str = Field(pattern=RANGE, examples=["101-518"])

    def expand(self):
        f1, f2 = _range(self.floors)
        r1, r2 = _range(self.rooms)
        first, last = r1 % 100, r2 % 100
        if f1 > 98 or f2 > 98:
            raise ValueError("floors must be 0-98")
        if not (0 <= first <= last <= 98):
            raise ValueError("room numbers must end in 00-98, first <= last (e.g. 101-518)")
        out = []
        for f in range(f1, f2 + 1):
            for i in range(first, last + 1):
                out.append((f, i, "%d%02d" % (f, i)))
        if len(out) > 2000:
            raise ValueError("that would create %d rooms; add at most 2000 at a time" % len(out))
        return out

    @model_validator(mode="after")
    def _check(self):
        self.expand()
        return self


class HousekeepingIn(BaseModel):
    housekeeping: Literal["clean", "dirty", "maintenance"]
    note: Optional[str] = Field(default=None, max_length=200)


# ----------------------------------------------------------------------------- reception
class GuestIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    sex: Optional[Literal["M", "F"]] = None
    id_type: Optional[str] = Field(default=None, max_length=30)
    id_no: Optional[str] = Field(default=None, max_length=50)
    phone: Optional[str] = Field(default=None, max_length=30)


class EncoderRef(BaseModel):
    encoder_id: str = Field(min_length=1, max_length=64)


class CheckInIn(EncoderRef):
    room_id: int
    kind: Literal["walkin", "hourly"] = "walkin"
    guest: GuestIn
    companions: List[GuestIn] = Field(default_factory=list, max_length=10)
    check_out: Optional[datetime] = None
    hours: Optional[int] = Field(default=None, ge=1, le=24)
    vip: bool = False
    price: Optional[float] = Field(default=None, ge=0)
    deposit: float = Field(default=0, ge=0)
    note: Optional[str] = Field(default=None, max_length=300)
    allow_reserved: bool = Field(default=False, description="Check in even if the room has a reservation")

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "hourly" and not self.hours:
            raise ValueError("hours is required for an hourly stay")
        if self.kind == "walkin" and not self.check_out:
            raise ValueError("check_out is required")
        return self


class PartyIn(BaseModel):
    leader: GuestIn
    note: Optional[str] = Field(default=None, max_length=300)


class TeamCheckInIn(PartyIn):
    room_ids: List[int] = Field(min_length=1, max_length=200)
    check_out: datetime
    price: Optional[float] = Field(default=None, ge=0, description="Per room; default = room price")
    deposit: float = Field(default=0, ge=0)


class ReservationIn(PartyIn):
    room_ids: List[int] = Field(min_length=1, max_length=200)
    check_in: datetime
    check_out: datetime

    @model_validator(mode="after")
    def _times(self):
        if self.check_out <= self.check_in:
            raise ValueError("check_out must be after check_in")
        return self


class CancelIn(BaseModel):
    stay_ids: Optional[List[int]] = Field(default=None, description="Default: every reserved room")


class ExtendIn(BaseModel):
    check_out: datetime
    encoder_id: Optional[str] = Field(default=None, description="Rewrite the card on this encoder too")


class MoveIn(EncoderRef):
    room_id: int


class CardOnReaderIn(EncoderRef):
    pass


class CheckoutByCardIn(EncoderRef):
    erase: bool = True


# ----------------------------------------------------------------------------- staff & lock cards
StaffKind = Literal["master", "building", "floor", "emergency", "group", "checkout", "record", "loss"]


class StaffCardIn(EncoderRef):
    kind: StaffKind
    holder: str = Field(min_length=1, max_length=100)
    valid_from: Optional[datetime] = None
    valid_to: datetime
    time_from: str = Field(default="00:00", pattern=HHMM)
    time_to: str = Field(default="23:59", pattern=HHMM)
    building_no: Optional[int] = Field(default=None, ge=0, le=15)
    floor_no: Optional[int] = Field(default=None, ge=0, le=98)
    group_no: Optional[int] = Field(default=None, ge=0, le=255)
    target_card_id: Optional[int] = None
    cover: bool = Field(default=True, description="Revoke earlier cards of this type when first used")
    note: Optional[str] = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check(self):
        need = {"building": ["building_no"], "floor": ["building_no", "floor_no"],
                "group": ["group_no"], "loss": ["target_card_id"]}.get(self.kind, [])
        missing = [f for f in need if getattr(self, f) is None]
        if missing:
            raise ValueError("%s card needs %s" % (self.kind, ", ".join(missing)))
        if self.valid_from and self.valid_to <= self.valid_from:
            raise ValueError("valid_to must be after valid_from")
        return self


class LockSetupIn(EncoderRef):
    kind: Literal["authorization", "room_set", "clock_set", "group_set", "system"]
    room_id: Optional[int] = None
    clock: Optional[datetime] = Field(default=None, description="Time to write; default = now")
    group_action: Optional[Literal["set_one", "clear_one", "set_all", "clear_all"]] = None
    group_no: Optional[int] = Field(default=None, ge=0, le=255)

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "room_set" and self.room_id is None:
            raise ValueError("choose the room to write into the lock")
        if self.kind == "group_set":
            if not self.group_action:
                raise ValueError("group_action is required")
            if self.group_action in ("set_one", "clear_one") and self.group_no is None:
                raise ValueError("group_no is required")
        return self
