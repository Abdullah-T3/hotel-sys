"""
prorfl_rt.py - shared low-level runtime for proRFL.dll.

One place that knows how to (a) load the 32-bit DLL and (b) invoke any export
with a declarative argument list that supports OUTPUT buffers. Used by both the
in-process backend (when hotel-sys itself runs as 32-bit Python on Windows) and
the 32-bit helper agent (prorfl_agent.py).

Argument descriptors (JSON-friendly, so they survive the stdio bridge):
    ["i", <int>]        input integer           -> ctypes.c_int
    ["s", <str|hex>]    input string/bytes      -> ctypes.c_char_p
    ["o", <size>]       output buffer of <size> -> ctypes.create_string_buffer

invoke() returns (ret:int, outs:list[str]) where each out is the FULL buffer as
a lowercase hex string (nothing is lost to embedded NULs; the caller decides how
to interpret it).
"""
import os
import ctypes
from ctypes import c_int, c_char_p, create_string_buffer

DLL_NAME = "proRFL.dll"
# proRFL.dll depends on these siblings; keep them in the same folder.
_SIBLINGS = ("Mwic_32.dll", "d12c.dll", "d12.dll")


def load_dll(dll_dir=None):
    """Load proRFL.dll (stdcall / WINAPI). dll_dir defaults to ./vendor next to this file."""
    here = dll_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
    path = os.path.join(here, DLL_NAME)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"{DLL_NAME} not found in {here!r}. Place proRFL.dll + "
            f"{', '.join(_SIBLINGS)} next to the code."
        )
    # Add the folder to the DLL search path so dependents resolve (Win 3.8+).
    if hasattr(os, "add_dll_directory") and os.name == "nt":
        try:
            os.add_dll_directory(here)
        except OSError:
            pass
    return ctypes.WinDLL(path)  # WINAPI == __stdcall


def invoke(dll, fn_name, descs):
    """Call dll.<fn_name> with argument descriptors; return (ret, [hex_out,...])."""
    fn = getattr(dll, fn_name)
    fn.restype = c_int
    argtypes, argvals, outs = [], [], []
    for d in descs:
        kind = d[0]
        if kind == "i":
            argtypes.append(c_int)
            argvals.append(int(d[1]))
        elif kind == "s":
            v = d[1]
            if isinstance(v, (bytes, bytearray)):
                b = bytes(v)
            else:
                b = str(v).encode("latin1", "replace")
            argtypes.append(c_char_p)
            argvals.append(b)
        elif kind == "o":
            size = int(d[1])
            buf = create_string_buffer(size)
            argtypes.append(c_char_p)
            argvals.append(buf)
            outs.append(buf)
        else:
            raise ValueError(f"unknown arg descriptor kind: {kind!r}")
    # Set argtypes per call so OUTPUT buffers always marshal correctly, even for
    # exports whose default proRFL.py type was auto-inferred as c_int.
    fn.argtypes = argtypes
    ret = fn(*argvals)
    return int(ret), [buf.raw.hex() for buf in outs]
