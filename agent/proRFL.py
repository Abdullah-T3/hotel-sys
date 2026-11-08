"""
proRFL.py - ctypes bindings for proRFL.dll (D801-M1 hotel lock encoder, proUSB-V9).

Signatures recovered by static disassembly (calling convention + arg count are
DEFINITIVE from each function's `ret N`; pointer-vs-int types are inferred from
how each argument is used). 'char*' args that are OUTPUT buffers must be passed a
ctypes.create_string_buffer(...) of adequate size. 32-bit DLL => run under 32-bit
Python on Windows (or a 32-bit host process).

First argument of almost every function is the encoder PORT selector:
0 = legacy encoder via d12.dll, 1 = Pro HID encoder via d12c.dll (D801-M1).
"""
import ctypes, os
from ctypes import c_int, c_char_p, c_void_p, create_string_buffer

_dll = ctypes.WinDLL(os.path.join(os.path.dirname(__file__), 'vendor', 'proRFL.dll'))  # WINAPI/stdcall

def _bind(name, restype, *argtypes):
    fn = getattr(_dll, name)
    fn.restype = restype
    fn.argtypes = list(argtypes)
    return fn

# --- VERIFIED signatures (confirmed by direct disassembly) ---
Buzzer = _bind('Buzzer', c_int, c_int, c_int)  # (port, beepCode) -> frame AA 02 80 code code^0x28
CloseUSB = _bind('CloseUSB', c_int, c_int)  # arg ignored; pass 0
GetCardTypeByCardDataStr = _bind('GetCardTypeByCardDataStr', c_int, c_char_p, c_char_p)  # (cardStr, OUT type[1]); 0=ok,1=bad
GetDLLVersion = _bind('GetDLLVersion', c_int, c_char_p)  # OUT buf>=20; writes "proUSB-V9-20171130"
GetGuestETimeByCardDataStr = _bind('GetGuestETimeByCardDataStr', c_int, c_int, c_char_p, c_char_p)  # (lockNo, cardStr, OUT end-time)
GetGuestLockNoByCardDataStr = _bind('GetGuestLockNoByCardDataStr', c_int, c_int, c_char_p, c_char_p)  # (lockNo, cardStr, OUT room); 0=ok,2=mismatch
GetGuestSTimeByCardDataStr = _bind('GetGuestSTimeByCardDataStr', c_int, c_int, c_char_p, c_char_p)  # (lockNo, cardStr, OUT start-time)
ReadCard = _bind('ReadCard', c_int, c_int, c_char_p)  # (port, OUT buf>=64) frame AA 01 E4 ..; 0=ok
WriteCard = _bind('WriteCard', c_int, c_int, c_char_p)  # (port, data) ; 0=ok
a_hex = _bind('a_hex', c_int, c_char_p, c_char_p, c_int)  # ASCII hex -> bytes (src, OUT dst, nHexChars)
hex_a = _bind('hex_a', c_int, c_char_p, c_char_p, c_int)  # bytes -> ASCII hex (src, OUT dst, nBytes)
initializeUSB = _bind('initializeUSB', c_int, c_int)  # port: 0=legacy d12.dll encoder, 1=Pro HID encoder (d12c.dll, D801-M1)

# --- AUTO-INFERRED signatures (argc+stdcall definitive; a trailing c_int may
#     actually be an OUTPUT char* buffer the DLL writes via an internal call) ---
BuildingCard = _bind('BuildingCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)
BuildingCard255 = _bind('BuildingCard255', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)
BuildingCardAnySector = _bind('BuildingCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)
CardErase = _bind('CardErase', c_int, c_int, c_int, c_int)
CardEraseAnySector = _bind('CardEraseAnySector', c_int, c_int, c_int, c_int, c_int)
CheckOutCard = _bind('CheckOutCard', c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
CheckOutCardAnySector = _bind('CheckOutCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
CloseCard = _bind('CloseCard', c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
CloseCardAnySector = _bind('CloseCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
DirectReadUSB = _bind('DirectReadUSB', c_int, c_int, c_int)
DirectWriteUSB = _bind('DirectWriteUSB', c_int, c_int, c_int, c_int)
EmergencyCard = _bind('EmergencyCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
EmergencyCardAnySector = _bind('EmergencyCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
FloorCard = _bind('FloorCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)
FloorCard255 = _bind('FloorCard255', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)
FloorCardAnySector = _bind('FloorCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_char_p, c_int)
GetOpenRecordByDataStr = _bind('GetOpenRecordByDataStr', c_int, c_char_p, c_char_p)
GroupCard = _bind('GroupCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int, c_int)
GroupCardAnySector = _bind('GroupCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int, c_int)
GroupSetCard = _bind('GroupSetCard', c_int, c_int, c_int, c_int, c_int, c_char_p, c_int, c_int, c_int)
GroupSetCardAnySector = _bind('GroupSetCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int, c_int, c_int)
GuestCard = _bind('GuestCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
GuestCard1 = _bind('GuestCard1', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
GuestCard2 = _bind('GuestCard2', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
GuestCard255 = _bind('GuestCard255', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
GuestCardAnySector = _bind('GuestCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int, c_int)
IniCard = _bind('IniCard', c_int, c_int, c_int, c_int)
IniCard1 = _bind('IniCard1', c_int, c_int, c_int, c_int, c_int)
IniCard2 = _bind('IniCard2', c_int, c_int, c_int, c_int, c_int)
IniCard255 = _bind('IniCard255', c_int, c_int, c_int)
InitCardAnySector = _bind('InitCardAnySector', c_int, c_int, c_int, c_int)
LimitCard = _bind('LimitCard', c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)
LimitCardAnySector = _bind('LimitCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)
LockCard = _bind('LockCard', c_int, c_int, c_int)
MasterCard = _bind('MasterCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
MasterCardAnySector = _bind('MasterCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_char_p, c_int)
ReadBlock = _bind('ReadBlock', c_int, c_int, c_int, c_int)
ReadCID = _bind('ReadCID', c_int, c_int, c_int)
ReadCXor = _bind('ReadCXor', c_int, c_int, c_int)
ReadCardE5 = _bind('ReadCardE5', c_int, c_int, c_int)
ReadCardID_T5557 = _bind('ReadCardID_T5557', c_int, c_int, c_int)
ReadE2 = _bind('ReadE2', c_int, c_int, c_int, c_int)
ReadGusetCard = _bind('ReadGusetCard', c_int, c_int, c_int, c_int)
ReadRID = _bind('ReadRID', c_int, c_int, c_int)
ReadRecord = _bind('ReadRecord', c_int, c_int, c_int)
ReadWriteCardFlag = _bind('ReadWriteCardFlag', c_int, c_int, c_int, c_int)
RecordCard = _bind('RecordCard', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
RecordCardAnySector = _bind('RecordCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
ResetCard = _bind('ResetCard', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
ResetCardAnySector = _bind('ResetCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
RoomSetCard = _bind('RoomSetCard', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)
RoomSetCard255 = _bind('RoomSetCard255', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)
RoomSetCardAnySector = _bind('RoomSetCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_char_p, c_int)
SetPassword = _bind('SetPassword', c_int, c_int, c_int, c_int, c_int)
SetReaderMode = _bind('SetReaderMode', c_int, c_int, c_int, c_int)
SpecialCard = _bind('SpecialCard', c_int, c_int, c_int, c_int)
TimeSetCard = _bind('TimeSetCard', c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
TimeSetCardAnySector = _bind('TimeSetCardAnySector', c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_char_p, c_int)
UnIniCard255 = _bind('UnIniCard255', c_int, c_int, c_int)
WriteAndCheckCard = _bind('WriteAndCheckCard', c_int, c_int, c_char_p)
WriteBlock = _bind('WriteBlock', c_int, c_int, c_int, c_int)
WriteE2 = _bind('WriteE2', c_int, c_int, c_int, c_int, c_char_p)
WriteReadAllSector = _bind('WriteReadAllSector', c_int, c_int, c_int, c_int, c_int, c_int, c_int)
WriteReadAllSectorA = _bind('WriteReadAllSectorA', c_int, c_int, c_int, c_int, c_int, c_int)
proTest = _bind('proTest', c_int)
