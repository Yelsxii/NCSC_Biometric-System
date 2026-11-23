# AJA / Travel Order scan direction mapping (pilot)

This layer **does not change the K14 device**. It labels source biometric
events so the monitoring screen can show observed AJA/Travel Order IN and OUT
separately from ordinary AM/PM slots. Existing approved documents remain
references, not another approval workflow.

## Scope and safe defaults

- A work code identifies a type of activity; **it does not inherently mean
  IN or OUT**. A configured, device-verified code is required for each role.
- In **Users & Work Codes > Work-code classification**, select an *observed*
  device code. Assign **Activity type** (AJA or Travel Order) and **Scan
  direction** (IN, OUT, or Unspecified).
- Leave existing and uncertain code roles as **Unspecified**. Existing
  mappings migrate with this default. No historic punch is silently paired.
- One explicit IN and one later explicit OUT of the **same activity on the
  same date** produce a *code-matched* interval. This is only scan evidence,
  not HR approval, attendance credit, or undertime calculation.
- Missing, repeated, incorrectly ordered, or unconfigured scans show
  **Needs review** and the individual source timestamps. No automatic
  first/last scan pairing; multi-session and overnight activity remain
  under review.
- AJA and Travel Order device evidence, ordinary AM/PM entries, and recorded
  official-document time windows remain separate on **View Attendance**.

## Illustrative codes only — not preconfigured K14 values

| Activity | Example code | Explicit classification |
| --- | --- | --- |
| AJA | 11 | AJA / IN |
| AJA | 12 | AJA / OUT |
| Travel Order | 21 | Travel Order / IN |
| Travel Order | 22 | Travel Order / OUT |

Do not assume these numeric values are already on the device; choose real
codes based on an authorized export and confirmed office/device settings.
A work-code mapping is keyed by both exported **device ID** and numeric code.

## Live LAN sync limitation

The current standard K14 poller uses pyzk's `get_attendance()` objects,
which expose `status` and `punch` but do **not** expose a separate verified
work-code field in this integration. The connector's
`attendance_raw` database has no work-code column. The website therefore
stores those imported records with a blank work code and **must not
interpret status or punch type as a substitute work code**.

A raw USB `_attlog.dat` file uses six fields and can contain work codes,
so those codes can be mapped today. The existing USB merge can enrich a
matching connector placeholder without fabricating a time.

For fully automatic AJA/TO classification, first confirm on the K14 and
the selected firmware/SDK that the work-code value can actually be retrieved,
then implement a validated, backward-compatible extension to the poller
and website connector. Do not guess this from numerical `status` or
`punch` values. Any hardware or SDK configuration should be approved and
tested without deleting existing attendance records.

## Checking the flow without real employee data

1. Import a fictional or authorized *redacted* six-column device export,
   check that codes appear in **Users & Work Codes**, and leave uncertain
   codes unmapped.
2. Configure two verified codes as AJA IN and AJA OUT (or TO IN and TO OUT).
   Open the same employee and month in **View Attendance**.
3. With a single IN and later OUT on the same date, see both timestamps
   displayed with **Code-matched · not credited**.
4. Check a date with a single or duplicate scan: it must say **Review**
   and show the original source scans without inventing a missing time.
5. Confirm regular AM/PM slots and undertime have not changed. Reset a
   code to **Unspecified** to verify that pairing is reversible.
6. Do **not** export these code-matched times as final government DTR
   entries until HR's documentation, time-credit, and DTR placement rules
   are approved.

Run `python -m pytest -q tests/test_activity_mapping.py` with the project
virtual environment. Do not commit actual attendance logs or personnel data.
