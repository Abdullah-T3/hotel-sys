# D801‑M1 Lock Encoder — `proRFL.dll` SDK (recovered)

Reverse‑engineered reference for the high‑level card library used by the
**D801 Smart Lock System** ("proUSB", version string `proUSB-V9-20171130`).
Produced by static analysis of `proRFL.dll` (PE32, x86). Companion file:
[`agent/proRFL.py`](../agent/proRFL.py) — ready‑to‑use `ctypes` bindings.
The gateway built on top of this is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Architecture

```
your app (hotel-sys)
   │   high-level, 1 call per card type        ← proRFL.dll   (THIS SDK)
   ▼
proRFL.dll   GuestCard() / ReadCard() / Get*ByCardDataStr() / a_hex()
   │   Mifare sector read/write + DES
   ▼
Mwic_32.dll
   │   USB transport
   ▼
d12c.dll (IniUsbPro/readPortPro/writePortPro) → D801-M1 USB encoder → Mifare 1K card
```

## How signatures were recovered (confidence)

- **Calling convention — DEFINITIVE.** Every export is `__stdcall` (WINAPI):
  each function ends in `ret N`, so the callee cleans the stack.
- **Argument count — DEFINITIVE.** `argc = N / 4` from that `ret N`.
- **Argument types — INFERRED.** `char*` vs `int` is deduced from whether each
  argument is dereferenced as a pointer. Functions in the **Verified** list were
  read instruction‑by‑instruction; the rest are auto‑classified. A trailing
  `c_int` on a `Read*`/`*Card` function may really be an **output `char*` buffer**
  the DLL fills via an internal call (the classifier can't see cross‑function
  dereferences). If a call rejects a buffer or returns garbage, switch that
  parameter to `c_char_p` and pass a `create_string_buffer(...)`.

## Runtime requirements

- `proRFL.dll` is **32‑bit** → load from **32‑bit Python on Windows**
  (`ctypes.WinDLL`). From 64‑bit code, run a small 32‑bit helper process.
- Ship `proRFL.dll`, `Mwic_32.dll`, `d12c.dll`, `d12.dll` together; the D801‑M1
  encoder must be plugged in (blue LED on).
- `System.ini` must have `EncoderType = M1`.

## Transport protocol (observed)

Commands are framed and sent to the encoder as:

```
AA  <len>  <cmd>  <payload...>  <xor>
```

- `AA` = start byte, `<len>` = payload length, `<cmd>` = opcode
  (e.g. `0x80` buzzer, `0xE4` read), `<xor>` = checksum (e.g. buzzer uses `code ^ 0x28`).
- `initializeUSB(mode)` → `d12c.dll!IniUsbPro`; low‑level I/O via
  `readPortPro`/`writePortPro`.

## The first argument is the encoder port

Almost every function takes the **port selector** first: it is forwarded to the internal send
routine, which uses `d12.dll` (`IniUsb`/`writePorta`, legacy PDIUSBD12 encoders) when it is `0`
and `d12c.dll` (`IniUsbPro`/`writePortPro`, HID "Pro" encoders such as the D801‑M1) otherwise.
**Use `1` for the D801‑M1.** `d12c.dll` opens the *first* matching HID device, so one process can
drive only one encoder.

## Verified functions

| Function | Signature | Notes |
|---|---|---|
| `initializeUSB` | `int initializeUSB(int port)` | open encoder: `0` → `d12.dll!IniUsb`, `1` → `d12c.dll!IniUsbPro`. Call once at start. |
| `CloseUSB` | `int CloseUSB(int unused)` | close; arg ignored, pass `0`. |
| `GetDLLVersion` | `int GetDLLVersion(char* out)` | writes `"proUSB-V9-20171130"`; `out` ≥ 20 bytes. |
| `Buzzer` | `int Buzzer(int port, int beepCode)` | beeps the encoder (frame `AA 02 80 code code^0x28`). |
| `ReadCard` | `int ReadCard(int port, char* outBuf)` | read card into `outBuf` (≥64). Returns 0 = OK. |
| `WriteCard` | `int WriteCard(int port, char* data)` | write raw card data. Returns 0 = OK. |
| `GetCardTypeByCardDataStr` | `int (char* cardStr, char* outType)` | `*outType` = card‑type code. 0=OK, 1=invalid. |
| `GetGuestLockNoByCardDataStr` | `int (int lockNo, char* cardStr, char* outRoom)` | parse room from a guest card. 0=OK, 2=mismatch. |
| `GetGuestSTimeByCardDataStr` | `int (int lockNo, char* cardStr, char* outStart)` | parse valid‑from time. |
| `GetGuestETimeByCardDataStr` | `int (int lockNo, char* cardStr, char* outEnd)` | parse expiry time. |
| `a_hex` | `int a_hex(char* srcAsciiHex, char* outBytes, int nHexChars)` | ASCII‑hex → binary. |
| `hex_a` | `int hex_a(char* srcBytes, char* outAsciiHex, int nBytes)` | binary → ASCII‑hex. |

> Return convention throughout: **0 = success, non‑zero = error code.**

### Issuing cards (arg count definitive; order partly inferred)

`GuestCard` takes **10** args: the port, then five `int`s (building / floor / room /
card index / flags — exact order to confirm with one test issue),
then **three `char*`** (room‑or‑lock string, start‑time, end‑time), then a final
param that is the **output card‑data buffer**. Siblings `MasterCard`(11),
`FloorCard`/`BuildingCard`/`GroupCard`(12), `EmergencyCard`(11),
`RoomSetCard`/`TimeSetCard`/`ResetCard`, `CheckOutCard`(6), `LimitCard`(7, loss
report) follow the same shape. The `*AnySector` variants add one extra `int`
(the Mifare sector number).

## Minimal usage (Windows, 32‑bit Python)

```python
import ctypes
from ctypes import create_string_buffer
import proRFL

assert proRFL.initializeUSB(1) == 0, "encoder not found"   # 1 = D801-M1 (HID)
try:
    ver = create_string_buffer(32)
    proRFL.GetDLLVersion(ver)
    print("DLL:", ver.value.decode())

    proRFL.Buzzer(1, 1)                      # chirp

    card = create_string_buffer(64)
    if proRFL.ReadCard(1, card) == 0:
        data = card.value                    # raw card bytes/hex
        ctype = create_string_buffer(2)
        proRFL.GetCardTypeByCardDataStr(data, ctype)
        room = create_string_buffer(16)
        proRFL.GetGuestLockNoByCardDataStr(0, data, room)
        print("type:", ctype.raw[0], "room:", room.value)
finally:
    proRFL.CloseUSB(0)
```

## Next step to finish the integration

The only remaining unknown is the **exact argument order of the multi‑arg
issue functions** (`GuestCard` et al.). The step‑by‑step procedure, using the
gateway's admin endpoints, is in [CALIBRATION.md](CALIBRATION.md).

---
*Generated from static analysis of `proRFL.dll`. No DLL code is reproduced here.*

## Full export table (all 77 functions)

| Function | Conv | Args | Inferred types |
|---|---|---|---|
| `BuildingCard` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)` |
| `BuildingCard255` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)` |
| `BuildingCardAnySector` | stdcall | 13 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)` |
| `Buzzer` | stdcall | 2 | `(c_int, c_int)` |
| `CardErase` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `CardEraseAnySector` | stdcall | 4 | `(c_int, c_int, c_int, c_int)` |
| `CheckOutCard` | stdcall | 6 | `(c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `CheckOutCardAnySector` | stdcall | 7 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `CloseCard` | stdcall | 6 | `(c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `CloseCardAnySector` | stdcall | 7 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `CloseUSB` | stdcall | 1 | `(c_int)` |
| `DirectReadUSB` | stdcall | 2 | `(c_int, c_int)` |
| `DirectWriteUSB` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `EmergencyCard` | stdcall | 11 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `EmergencyCardAnySector` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `FloorCard` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)` |
| `FloorCard255` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)` |
| `FloorCardAnySector` | stdcall | 13 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)` |
| `GetCardTypeByCardDataStr` | stdcall | 2 | `(c_char_p, c_char_p)` |
| `GetDLLVersion` | stdcall | 1 | `(c_char_p)` |
| `GetGuestETimeByCardDataStr` | stdcall | 3 | `(c_int, c_char_p, c_char_p)` |
| `GetGuestLockNoByCardDataStr` | stdcall | 3 | `(c_int, c_char_p, c_char_p)` |
| `GetGuestSTimeByCardDataStr` | stdcall | 3 | `(c_int, c_char_p, c_char_p)` |
| `GetOpenRecordByDataStr` | stdcall | 2 | `(c_char_p, c_char_p)` |
| `GroupCard` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int, c_int)` |
| `GroupCardAnySector` | stdcall | 13 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int, c_int)` |
| `GroupSetCard` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_char_p, c_int, c_int, c_int)` |
| `GroupSetCardAnySector` | stdcall | 9 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_int, c_int, c_int)` |
| `GuestCard` | stdcall | 10 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `GuestCard1` | stdcall | 10 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `GuestCard2` | stdcall | 10 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `GuestCard255` | stdcall | 10 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `GuestCardAnySector` | stdcall | 11 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int, c_int)` |
| `IniCard` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `IniCard1` | stdcall | 4 | `(c_int, c_int, c_int, c_int)` |
| `IniCard2` | stdcall | 4 | `(c_int, c_int, c_int, c_int)` |
| `IniCard255` | stdcall | 2 | `(c_int, c_int)` |
| `InitCardAnySector` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `LimitCard` | stdcall | 7 | `(c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)` |
| `LimitCardAnySector` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)` |
| `LockCard` | stdcall | 2 | `(c_int, c_int)` |
| `MasterCard` | stdcall | 11 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `MasterCardAnySector` | stdcall | 12 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)` |
| `ReadBlock` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `ReadCID` | stdcall | 2 | `(c_int, c_int)` |
| `ReadCXor` | stdcall | 2 | `(c_int, c_int)` |
| `ReadCard` | stdcall | 2 | `(c_int, c_int)` |
| `ReadCardE5` | stdcall | 2 | `(c_int, c_int)` |
| `ReadCardID_T5557` | stdcall | 2 | `(c_int, c_int)` |
| `ReadE2` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `ReadGusetCard` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `ReadRID` | stdcall | 2 | `(c_int, c_int)` |
| `ReadRecord` | stdcall | 2 | `(c_int, c_int)` |
| `ReadWriteCardFlag` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `RecordCard` | stdcall | 7 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `RecordCardAnySector` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `ResetCard` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `ResetCardAnySector` | stdcall | 9 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `RoomSetCard` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)` |
| `RoomSetCard255` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)` |
| `RoomSetCardAnySector` | stdcall | 9 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)` |
| `SetPassword` | stdcall | 4 | `(c_int, c_int, c_int, c_int)` |
| `SetReaderMode` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `SpecialCard` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `TimeSetCard` | stdcall | 7 | `(c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `TimeSetCardAnySector` | stdcall | 8 | `(c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)` |
| `UnIniCard255` | stdcall | 2 | `(c_int, c_int)` |
| `WriteAndCheckCard` | stdcall | 2 | `(c_int, c_char_p)` |
| `WriteBlock` | stdcall | 3 | `(c_int, c_int, c_int)` |
| `WriteCard` | stdcall | 2 | `(c_int, c_char_p)` |
| `WriteE2` | stdcall | 4 | `(c_int, c_int, c_int, c_char_p)` |
| `WriteReadAllSector` | stdcall | 6 | `(c_int, c_int, c_int, c_int, c_int, c_int)` |
| `WriteReadAllSectorA` | stdcall | 5 | `(c_int, c_int, c_int, c_int, c_int)` |
| `a_hex` | stdcall | 3 | `(c_char_p, c_char_p, c_int)` |
| `hex_a` | stdcall | 3 | `(c_char_p, c_char_p, c_int)` |
| `initializeUSB` | stdcall | 1 | `(c_int)` |
| `proTest` | cdecl(void) | 0 | `()` |
