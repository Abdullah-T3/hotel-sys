# First test with a real D801-M1 encoder

Three steps, each one adding a single new piece, so a failure points at one cause:

1. **Encoder self-test**: the Windows PC, the vendor DLLs and the USB encoder. Read-only.
2. **Server + agent**: the encoder appears in the web app and reads cards.
3. **Calibration**: guest card writing confirmed on a test lock ([CALIBRATION.md](CALIBRATION.md)).

## Before you start: safety

- **Back up** `CardLock.mdb` and `System.ini` from the CardLock folder.
- **Close CardLock.exe** while testing. Only one program can use the encoder at a time.
- Use **blank Mifare 1K cards** and **one test lock**: a spare lock, or the door of a room that is not sold.
- **Never swipe lock-setup cards on locks in use.** Authorization, room-number, clock, group-setup and
  system-options cards reconfigure the lock they touch. Try them only on the test lock.
- Master and emergency cards open every door. Erase test cards when you're done.

## What you need

| | |
|---|---|
| Windows PC with the D801-M1 encoder plugged in | this is the "front desk PC" |
| **32-bit** Python 3.8+ | python.org → Windows → "Windows installer (32-bit)"; keep "py launcher" ticked |
| This project | `git clone https://github.com/Abdullah-T3/hotel-sys` (or copy the folder) |
| Vendor DLLs in `agent\vendor\` | `proRFL.dll` comes only from the 2019 installer `【M1中性】D801智能门锁管理系统.exe` (install it, or copy from its folder). `Mwic_32.dll`, `d12c.dll`, `d12.dll`, `MFC42D.DLL`, `MSVCRTD.DLL` are also in your CardLock folder (identical files) |

## Step 1: encoder self-test (about 5 minutes, writes nothing)

Open a Command Prompt in the project folder:

```bat
cd agent
py -3-32 selftest.py
```

When it asks, put a **guest card made by CardLock** on the encoder and press Enter. Expected:

```
  [ OK ] Windows, 32-bit Python
  [ OK ] vendor DLLs present in ...\agent\vendor
  [ OK ] proRFL.dll loaded
  [ OK ] encoder opened (port 1)
  [ OK ] DLL version: proUSB-V9-20171130
  [ OK ] beep sent (code 0) — you should have heard the encoder beep
  [ OK ] card read: D801360F3E...
  [ OK ] D801 card, hotel code 360F, type 0x3E (guest card)
```

| If it says | Do this |
|---|---|
| `this Python is 64-bit` | install 32-bit Python and use `py -3-32` |
| `missing in ...: proRFL.dll` | copy it from the 2019 installer (see above) |
| `could not load proRFL.dll` | all six DLLs must be together in `agent\vendor` |
| `opening the encoder returned code …` | close CardLock.exe, unplug/replug the encoder, try another USB port; older encoder → `--port 0` |
| `reading the card returned code …` | lay the card flat on the encoder; try another card |
| hotel code is **not** `360F` | tell me. Your hotel code differs from the one decoded from your database |

**Send me the full output.** If anything fails, the message names the cause.

## Step 2: server and agent

The server can run on the same Windows PC or on any computer on the hotel network.
It needs a normal (64-bit is fine) Python 3.10+, separate from the 32-bit one used by the agent.

```bat
py -3 -m venv .venv
.venv\Scripts\pip install -r server\requirements.txt
py -3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Use the printed value as the admin key, then start the server:

```bat
set GATEWAY_ADMIN_KEYS=<the printed value>
cd server
..\.venv\Scripts\uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8080
```

1. Open <http://localhost:8080> and create the super administrator.
2. **Settings → Encoders → Register encoder** (e.g. id `front-desk-1`). Save the shown configuration as
   `agent\agent.json`.
3. In a second Command Prompt: `cd agent`, `py -3-32 -m pip install -r requirements.txt`, then `run_agent.bat`.
4. In the web app pick the encoder in the top bar. It shows a green dot when online.
5. **Settings → Encoders → test beep** (bell icon). The encoder beeps.
6. **Read card** (top bar) with the CardLock guest card. It shows a guest card type (0x3E) marked
   "Not issued by this system". That's correct: this system hasn't issued it.

This is a real installation, not the demo: issuing cards is **refused until calibrated**. That's expected.
If the server runs on another computer, allow port 8080 in its firewall and use its address in `agent.json`.

## Step 3: calibration

Follow [CALIBRATION.md](CALIBRATION.md) starting with the guest card, on the test lock.
Everything can be done in the web app: **Settings → Calibration** has the raw encoder console and the
"Mark calibrated" buttons.

**What to send me:** the self-test output, a reference guest card from CardLock (its card data, room and
dates), and the results of your raw `GuestCard` attempts (`ret` and the card data read back). From those I
can set the exact argument order for you.
