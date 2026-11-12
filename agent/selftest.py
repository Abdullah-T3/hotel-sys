#!/usr/bin/env python3
"""
selftest.py - check the encoder on THIS PC, with no server involved. Read-only: it never writes a card.

    py -3-32 selftest.py              # real encoder (32-bit Python on Windows)
    py -3-32 selftest.py --no-beep    # skip the beep
    python selftest.py --mock         # try it without hardware

Steps: 32-bit Python -> vendor DLLs present -> load proRFL.dll -> open encoder -> DLL version
-> beep -> read the card on the encoder. Stops at the first failure and says what to check.

Keep this file Python 3.8 compatible.
"""
import argparse
import os
import platform
import string
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

REQUIRED = ("proRFL.dll", "Mwic_32.dll", "d12c.dll", "d12.dll", "MFC42D.DLL", "MSVCRTD.DLL")
OK, FAIL, INFO = "  [ OK ]", "  [FAIL]", "  [ .. ]"


def say(tag, msg):
    print("%s %s" % (tag, msg), flush=True)


def stop(msg, hint):
    say(FAIL, msg)
    print("\n  What to check: %s\n" % hint)
    sys.exit(1)


def cstr(hex_out):
    return bytes.fromhex(hex_out).split(b"\x00", 1)[0].decode("latin1")


def card_text(hex_out):
    text = cstr(hex_out)
    if len(text) >= 8 and all(c in string.hexdigits for c in text):
        return text.upper()
    return bytes.fromhex(hex_out).rstrip(b"\x00").hex().upper()


def main(argv=None):
    p = argparse.ArgumentParser(description="Read-only self-test of the D801 encoder on this PC")
    p.add_argument("--port", type=int, default=1, help="1 = Pro HID encoder (D801-M1, default), 0 = legacy")
    p.add_argument("--dll-dir", default=os.path.join(HERE, "vendor"), help="folder with the vendor DLLs")
    p.add_argument("--mock", action="store_true", help="use the in-memory mock encoder (no hardware)")
    p.add_argument("--no-beep", action="store_true", help="skip the beep test")
    p.add_argument("--no-wait", action="store_true", help="read the card immediately, without waiting for Enter")
    a = p.parse_args(argv)

    print("\nD801 encoder self-test (read-only)  ·  %s  ·  Python %s %d-bit\n"
          % (platform.platform(), platform.python_version(), struct.calcsize("P") * 8))

    if a.mock:
        from agent import MockExecutor
        ex = MockExecutor(port=a.port)
        say(INFO, "mock mode: no hardware is used")
    else:
        if os.name != "nt":
            stop("this is not Windows", "the vendor DLLs only run on Windows. Use --mock to try the test elsewhere.")
        if struct.calcsize("P") != 4:
            stop("this Python is %d-bit" % (struct.calcsize("P") * 8),
                 "install 32-bit (x86) Python from python.org and run:  py -3-32 selftest.py")
        say(OK, "Windows, 32-bit Python")
        missing = [f for f in REQUIRED if not os.path.exists(os.path.join(a.dll_dir, f))]
        if missing:
            stop("missing in %s: %s" % (a.dll_dir, ", ".join(missing)),
                 "copy them from the D801 install folder. proRFL.dll comes from the 2019 installer "
                 "(【M1中性】D801智能门锁管理系统.exe); the others are also in your CardLock folder.")
        say(OK, "vendor DLLs present in %s" % a.dll_dir)
        try:
            from agent import RealExecutor
            ex = RealExecutor(port=a.port, dll_dir=a.dll_dir)
        except OSError as e:
            stop("could not load proRFL.dll: %s" % e,
                 "all six DLLs must be in the same folder, and must be the 32-bit vendor files.")
        say(OK, "proRFL.dll loaded")

    ret, _ = ex.invoke("initializeUSB", [["i", a.port]])
    if ret != 0:
        stop("opening the encoder returned code %s" % ret,
             "is the encoder plugged in (blue/green light)? Close CardLock.exe — only one program can use "
             "the encoder. Try another USB port. For an older encoder try --port 0.")
    say(OK, "encoder opened (port %d)" % a.port)

    ret, outs = ex.invoke("GetDLLVersion", [["o", 32]])
    say(OK if ret == 0 else FAIL, "DLL version: %s" % (cstr(outs[0]) if outs else "?"))

    if not a.no_beep:
        ret, _ = ex.invoke("Buzzer", [["i", a.port], ["i", 1]])
        say(OK if ret == 0 else FAIL, "beep sent (code %s) — you should have heard the encoder beep" % ret)

    if not a.no_wait:
        try:
            input("\n  Place a card on the encoder (any card: blank, guest or staff), then press Enter… ")
        except EOFError:
            pass
    ret, outs = ex.invoke("ReadCard", [["i", a.port], ["o", 128]])
    if ret != 0:
        stop("reading the card returned code %s" % ret,
             "is a Mifare card lying flat on the encoder? Try another card.")
    data = card_text(outs[0])
    say(OK, "card read: %s" % (data or "(empty)"))
    if not data or set(data) <= {"0"} or set(data) <= {"F"}:
        say(INFO, "the card is blank")
    elif data.startswith("D801"):
        ret, touts = ex.invoke("GetCardTypeByCardDataStr", [["s", data], ["o", 4]])
        code = bytes.fromhex(touts[0])[0] if ret == 0 and touts else None
        known = {0x3E: "guest card", 0xBE: "master card", 0xC9: "system card"}
        say(OK, "D801 card, hotel code %s, type 0x%s%s" % (data[4:8], "%02X" % code if code is not None else "??",
                                                         " (%s)" % known[code] if code in known else ""))
    else:
        say(INFO, "not a D801-format card (another system's card or blank with factory data)")

    ex.invoke("CloseUSB", [["i", 0]])
    print("\n  All checks passed. Next: connect this encoder to the server (docs/HARDWARE_TEST.md, step 2).\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
