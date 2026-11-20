# NCSC Biometric Attendance & DTR Monitoring

A records-first local web system designed for the National Commission of Senior Citizens office. **Development branch: `feat/ncsc-dtr-workflow`** (based on `feat/ncsc-theme`).

> **Internal pilot, not certified payroll/DTR software.** No live LAN synchronization yet. No approved work-hour or undertime rule has been programmed; only original scan evidence and documented office activity references are shown.

## Features and architecture

- **Overview:** compact staff, scan, activity and USB-import counts, plus connection readiness.
- **Employee Records:** searchable name/ID table with a month filter. Selecting an employee opens daily source scans, AJA/Travel Order references and an audit event list.
- **DTR Preview:** A4 browser-printable *review copy*, with date, AM/PM In/Out, undertime columns and remarks. **Time cells remain blank until raw K14 status meanings and HR attendance rules are verified**; the system does not manufacture in/out times. A whole-day Travel Order is shown as **OFFICIAL TRAVEL** in remarks with source reference. This is a provisional layout, **not a pixel-identical official Form 48 template**.
- **Official Activities:** records references to *already approved* office AJA and Travel Orders, without creating a second application or approval flow. AJA has actual documented start and end; full-day TO uses a coverage interval ending at 00:00 the following day.
- **Device & Imports:** prepared LAN settings, **opt-in TCP connectivity probe**, USB attendance fallback, staff roster import and raw device work code labels. Work-code 0 remains an unmodified raw event field; no codes are configured on the K14 by this software.
- **Staff metadata:** `user.dat` names + IDs using the verified 72-byte sample layout; alternatively .xls device report / UTF-8 CSV. **Never import `template.fp10` or other biometric templates.**
- **Backend:** FastAPI + SQLite. Existing scans are immutable; same event schema supports USB now and future approved read-only LAN retrieval. Imports are deduplicated; administrator actions have an audit record.

### Flow

```text
K14 biometric device
  |                            (future, not active)
  +-- original USB _attlog.dat       LAN read-only SDK connector
  |              |                         |
  |              +----> Validated attendance ingestion ----+
  |                                                        |
  +-- user.dat (names/IDs only) ---> Employee register      |
                                                           v
                                                   SQLite source events
                                                           |
        Existing approved AJA / Travel Order references ---+
                                                           |
                                             Employee monthly DTR review
                                                           |
                                           A4 preview / Print / Save PDF
```

## Windows + Cursor setup

Use PowerShell in the project directory:

```powershell
git fetch origin
git switch feat/ncsc-dtr-workflow
git pull --ff-only origin feat/ncsc-dtr-workflow
```

If the branch is not created locally yet, use:

```powershell
git switch -c feat/ncsc-dtr-workflow --track origin/feat/ncsc-dtr-workflow
```

**If Git reports an unfinished merge, do not run these switches yet.** Use `git status` and protect any conflict-resolution edits before deciding whether `git merge --abort` is safe. Do not run destructive resets.

First-time Python environment:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Generate a secret and replace the example `SECRET_KEY` inside the local `.env` file. Do not commit `.env`:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

Create an administrator account once:

```powershell
.\.venv\Scripts\python.exe -m app.cli create-admin
```

Run the application:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open **http://127.0.0.1:8000** and log in.

To test:

```powershell
.\.venv\Scripts\python.exe -m pip install pytest httpx
.\.venv\Scripts\python.exe -m pytest -q
```

## LAN readiness (not automatic sync yet)

Current device settings observed in the office: **K14 IP 192.168.1.201, TCP communication port 4370, DHCP off**. The PC's earlier Wi-Fi subnet was `192.168.254.0/24`, different from the device's `192.168.1.0/24`. The device had **no Ethernet cable connected**. These must be addressed by an authorized network setup before testing the connection.

Add the following to your private `.env` only if missing:

```dotenv
K14_HOST=192.168.1.201
K14_PORT=4370
K14_LAN_PROBE_ENABLED=false
```

The Device & Imports page shows the saved address. The **Test LAN connection** button performs no network activity while this flag is false. With explicit office permission and physical network preparation, set it true and restart the app to allow a single TCP handshake check from the admin button. A timeout is **inconclusive** because the device may use another supported transport.

**A successful TCP test is not automatic attendance synchronization.** A separate firmware-compatible **read-only ZKTeco SDK/protocol integration**, tested with no write/update/delete or template access, is still required for employee and attendance auto-sync. We will integrate that adapter into the existing validated source ingestion when the hardware is available.

## DTR and HR rules

1. K14 raw scan times, device status codes and work codes are retained without modification.
2. No AM/PM time slots, undertime or payable hours are inferred until device codes, time policies, and official NCSC procedures are verified.
3. AJA official start/end times come from existing approved activity records. They do not replace biometric scans.
4. For Travel Orders, blank device scan fields remain blank, and **OFFICIAL TRAVEL** appears as an activity remark when covered by an office reference. Any treatment of undertime/credited days is for HR verification and policy enforcement, not automatically set to zero.
5. If the office supplies the exact official DTR template, the print view can be aligned with it. The current view is a functional review-copy layout, not a certified or exact official export.

## Repository structure

```text
app/
  main.py         authenticated REST API and existing activity/roster/scan logic
  db.py           SQLite schema, immutable raw punch data and device ID registry
  parser.py       strict K14 six-field USB attendance log parser
  roster.py       safe 72-byte user.dat metadata extraction
  registry.py     CSV / device Excel / user.dat name import
  lan.py          read-only LAN readiness status and optional TCP probe
  reports.py      read-only Excel attendance report preview
  index.html      compact government records layout
  static/
    app.css       navy-blue / red layout and A4 print rules
    app.js        employee-first client workflows
tests/
  test_records_workflow.py
  browser_smoke.cjs
docs/
  monitor-workflow.md (if available)
```

## Security

This repository is **public**, so never commit real staff data, `.env`, the SQLite database, raw `*_attlog.dat`, `user.dat`, or fingerprint files. Work locally with authorized HR access. Production deployment also requires secure HTTPS, role separation, backups, data-retention rules, formal verification and security review.
