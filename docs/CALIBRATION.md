# Calibrating card issuing on real hardware

`GuestCard` (and `CardErase`) were decoded from the DLL without a working
encoder. What is **certain**: the calling convention (stdcall) and the number
of arguments. What is **inferred**: which integer is building / floor / room,
the time string format, and what argument 9 is. So the gateway refuses
`cards/guest` and `cards/erase` (HTTP 409) until you confirm them here. Plan on
about an hour with one encoder, a few blank cards, and one test lock.

## What you already know

Cards from this system are 16 bytes (32 hex chars). Example from your database:

```
D801 360F 3E 01 01 01 0166 170C06 1713 00
│    │    └ card type (3E = guest)
│    └ hotel code: low 16 bits of dlsCoID (System.ini: 79375 = 0x1360F)
└ system signature
```

The template's current best guess is:

```
GuestCard(port=1, co_id=79375, building, floor, room, card_index,
          start "yyMMddHHmm", end "yyMMddHHmm", lock_str "", OUT buffer)
```

## Procedure

Use an **admin** key. `$GW` is the gateway URL, `$AK` your admin key, and
`front-desk-1` your encoder.

1. **Make a reference card with the vendor software.** On the front‑desk PC,
   stop the agent, open `CardLock.exe`, and issue a guest card for a known room
   (e.g. building 1, floor 1, room 101) with known times. Close `CardLock.exe`
   and start the agent again.

2. **Read the reference card through the gateway.** Write down `card_data`.
   (`CardLock.mdb` → table `CardInfo`, column `CardData` holds the same value.)

   ```bash
   curl -s -X POST $GW/v1/encoders/front-desk-1/cards/read -H "X-API-Key: $AK"
   ```

3. **Issue a test card with raw invoke** on a blank card, using the same
   room/times as step 1:

   ```bash
   curl -s -X POST $GW/v1/encoders/front-desk-1/invoke -H "X-API-Key: $AK" -H "content-type: application/json" -d '{"fn":"GuestCard","args":[["i",1],["i",79375],["i",1],["i",1],["i",1],["i",0],["s","2611081400"],["s","2611091200"],["s",""],["o",128]]}'
   ```

   `ret` must be `0`. Then read the card back (step 2) and compare it with the
   reference.

4. **Change one thing at a time** until the two match byte for byte:
   - wrong building/floor/room bytes → swap the order of args 3–5;
   - wrong date bytes → try other formats in args 7–8 (`yyMMddHHmm`,
     `yyyyMMddHHmm`, `yyMMdd`), or try putting dates in arg 9;
   - hotel code ≠ `360F` → arg 2 is not `co_id`; try it in another int slot;
   - `ret` ≠ 0 → wrong types; compare with `agent/proRFL.py` and the
     disassembly notes in `D801_proRFL_SDK.md`.

5. **Test on a lock.** Swipe the card on the test room's lock. Beep codes (from
   the vendor UI strings): 6 = wrong room, 7 = expired/clock, 15 = not this
   hotel, 30 = not this system. If it opens, it's correct.

6. **Save the result and mark it calibrated.** Use placeholders
   (`{building}`, `{start:%y%m%d%H%M}`, …) for the parts that change per card:

   ```bash
   curl -s -X PATCH $GW/v1/templates/issue_guest -H "X-API-Key: $AK" -H "content-type: application/json" -d '{"args":[["i","{port}"],["i","{co_id}"],["i","{building}"],["i","{floor}"],["i","{room}"],["i","{card_index}"],["s","{start:%y%m%d%H%M}"],["s","{end:%y%m%d%H%M}"],["s","{lock_str}"],["o",128]],"calibrated":true}'
   ```

   The override is stored in the gateway database and applies to every encoder
   immediately; no agent changes are needed. `GET /v1/templates` shows the
   active version, and `GET /v1/audit` records who changed it.

Repeat the same steps for every other card type. The gateway refuses each one until it is marked calibrated:

| Template | DLL function | Args | How to verify |
|---|---|---|---|
| `issue_guest` | `GuestCard` | 10 | opens its room; 6 beeps = wrong room, 7 = wrong dates |
| `erase_card` | `CardErase` | 3 | card reads back blank |
| `issue_master` / `issue_emergency` | `MasterCard` / `EmergencyCard` | 11 | opens any lock (emergency leaves it open) |
| `issue_building` / `issue_floor` | `BuildingCard` / `FloorCard` | 12 | opens only that building / floor |
| `issue_group` | `GroupCard` | 12 | opens locks set to that group |
| `issue_checkout` | `CheckOutCard` | 6 | after swiping, the old guest card gets 8 beeps |
| `issue_record` + `read_record` | `RecordCard` / `ReadRecord` | 7 / 2 | lock beeps after ~20 s; upload shows entries |
| `issue_loss` | `LimitCard` | 7 | the lost card gets 9 beeps |
| `issue_authorization` | `ResetCard` | 8 | two beeps on a new lock |
| `issue_room_set` / `issue_clock_set` | `RoomSetCard` / `TimeSetCard` | 8 / 7 | lock accepts its room's guest card |
| `issue_group_set` | `GroupSetCard` | 8 | two beeps; group card then opens it |
| `issue_system` | `SpecialCard` | 3 | lock behaviour changes (e.g. music) |

You can do all of this from the web UI: **Settings → Calibration** has the raw
encoder console and the "Mark calibrated" buttons.

## If cards are rejected with 15 beeps ("not this hotel")

The hotel code may come from DLL state rather than an argument. Look at
`SetPassword` (4 args), which may need to be called once after
`initializeUSB`. Test it via raw invoke first. If it is needed, add it to the
agent's `open_encoder()` step.
