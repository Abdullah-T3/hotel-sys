"""
mock_dll.py - in-memory stand-in for proRFL.dll + a D801-M1 encoder.

Used for development and automated tests on machines without the hardware
(or without Windows). It speaks the same invoke(fn, descs) -> (ret, outs)
contract as prorfl_rt.invoke, so the agent and gateway can't tell the
difference. Card writes are kept in memory, so issue -> read round-trips work.

Keep this file Python 3.8 compatible (the real agent runs on 32-bit 3.8+).
"""
import threading

DLL_VERSION = b"proUSB-V9-20171130"
# A real guest-card payload taken from the vendor database (CardInfo table).
SAMPLE_CARD = "D801360F3E0101010166170C06171300"
NO_CARD = 1  # non-zero return code used when no card is on the reader


def _out(data, size):
    """Render bytes into a fixed-size output buffer, returned as hex."""
    buf = bytes(data)[:size]
    return (buf + b"\x00" * (size - len(buf))).hex()


def _zero_outs(descs):
    return [_out(b"", int(d[1])) for d in descs if d[0] == "o"]


class MockEncoder(object):
    def __init__(self, card=SAMPLE_CARD):
        self._lock = threading.Lock()
        self.card = card          # card currently on the reader; None = empty
        self.beeps = 0
        self.initialized = False
        self.calls = []           # (fn, descs) history, handy in tests

    # Card-type byte written by the mock for each issuing function (guest 3E, master BE and
    # system C9 are real values seen in the vendor database; the rest are placeholders).
    TYPE_CODES = {"MasterCard": 0xBE, "EmergencyCard": 0xB3, "BuildingCard": 0xB1, "FloorCard": 0xB2,
                  "GroupCard": 0xB4, "CheckOutCard": 0xB5, "RecordCard": 0xB6, "LimitCard": 0xB7,
                  "ResetCard": 0xC1, "RoomSetCard": 0xC2, "TimeSetCard": 0xC3, "GroupSetCard": 0xC4,
                  "SpecialCard": 0xC9}

    def invoke(self, fn, descs):
        with self._lock:
            self.calls.append((fn, descs))
            handler = getattr(self, "_" + fn, None)
            if handler is None and fn in self.TYPE_CODES:
                return self._issue_generic(fn, descs)
            if handler is None:
                # Any other export: succeed and return zeroed output buffers.
                return 0, _zero_outs(descs)
            return handler(descs)

    def _issue_generic(self, fn, descs):
        if self.card is None:
            return NO_CARD, _zero_outs(descs)
        self.serial = getattr(self, "serial", 0) + 1
        self.card = ("D801360F%02X%06X" % (self.TYPE_CODES[fn], self.serial)).ljust(32, "0")
        return 0, [_out(self.card.encode("ascii"), int(d[1])) for d in descs if d[0] == "o"]

    def _ReadRecord(self, descs):
        if self.card is None:
            return NO_CARD, _zero_outs(descs)
        lines = ["2611080915,101,guest,G-1042", "2611080931,101,floor,F-3",
                 "2611081402,102,master,M-1", "2611081733,101,guest,G-1042"]
        return 0, [_out(";".join(lines).encode("ascii"), int(descs[-1][1]))]

    # --- device -----------------------------------------------------------
    def _initializeUSB(self, descs):
        self.initialized = True
        return 0, []

    def _CloseUSB(self, descs):
        self.initialized = False
        return 0, []

    def _GetDLLVersion(self, descs):
        return 0, [_out(DLL_VERSION, int(descs[0][1]))]

    def _Buzzer(self, descs):
        self.beeps += 1
        return 0, []

    # --- card I/O ---------------------------------------------------------
    def _ReadCard(self, descs):
        size = int(descs[1][1])
        if self.card is None:
            return NO_CARD, [_out(b"", size)]
        return 0, [_out(self.card.encode("ascii"), size)]

    def _WriteCard(self, descs):
        if self.card is None:
            return NO_CARD, []
        self.card = str(descs[1][1]).upper()
        return 0, []

    def _GuestCard(self, descs):
        # Fake but deterministic payload: D801 + hotel 360F + type 3E + bld/flr/room.
        if self.card is None:
            return NO_CARD, _zero_outs(descs)
        ints = [int(d[1]) for d in descs if d[0] == "i"]
        bld, flr, room = (ints + [0, 0, 0, 0, 0])[2:5]
        self.card = ("D801360F3E%02X%02X%02X" % (bld, flr, room)).ljust(32, "0")
        return 0, [_out(self.card.encode("ascii"), int(d[1])) for d in descs if d[0] == "o"]

    def _CardErase(self, descs):
        if self.card is None:
            return NO_CARD, _zero_outs(descs)
        self.card = "0" * 32
        return 0, _zero_outs(descs)

    # --- parsers ----------------------------------------------------------
    def _GetCardTypeByCardDataStr(self, descs):
        card = str(descs[0][1])
        if not card.startswith("D801") or len(card) < 10:
            return 1, _zero_outs(descs)
        return 0, [_out(bytes([int(card[8:10], 16)]), int(descs[1][1]))]
