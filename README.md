# NCSC Biometric Attendance & DTR Monitoring

NCSC records-oriented prototype using **FastAPI + SQLite**, with a restrained **navy-blue/red** layout. Development branch: `feat/ncsc-dtr-workflow`, based on `feat/ncsc-theme`.

> **Pilot only.** Attendance can be imported automatically from the existing local K14 connector file when explicitly enabled. Device polling remains a separate program. The system does not certify an official DTR, interpret unverified time-in/time-out codes, or credit undertime for official travel.

## Records-first interface

- **Employee Attendance (default):** Search by employee ID or name, filter month, and open detailed daily scans / DTR preview. The register table deliberately shows employee ID, name, department and **View attendance** only; scan-count and last-scan columns were removed as nonessential.
- **Import attendance:** A compact **Import attendance** button sits next to **View records** and opens an accessible modal. Admins preview the original K14 `.dat`/`.txt` USB export, then merge it. Existing scan records are never overwritten; duplicate events are skipped while new source events are appended. File import remains a fallback if LAN sync is unavailable.
- **AJA / Travel Orders:** Read-only **device-classified scan event list**, filterable by employee and month/type. Columns show employee, activity, exact recorded date/time and numeric work code. **No office reference column, no new TO/AJA filing form.** The list uses existing local labels for codes found on K14 scans; code 0 is untouched. A work-code scan alone is not evidence of approved activity, start/end interval, or DTR time credit.
- **Users & Work Codes:** No staff directory listing or manual-add form. Existing user-data recovery is available via a small **Import device users** modal for K14 `user.dat`, `.xls` or `.csv`. Work-code mappings remain accessible, with device network diagnostics hidden under an expandable section.
- **Login:** The original **split-panel NCSC login** from `feat/ncsc-theme` has been restored, including its photo, seal and fingerprint sign-in panel. Only redundant help affordances were removed.

## K14 data limitations

USB import remains the backup. Automatic attendance import reads the local connector SQLite file produced by the existing read-only poller. The website does not open the K14, does not copy fingerprint templates, and does not replace either database. See `docs/k14-attendance-sync.md`.

**Official Travel without a fingerprint scan cannot show up in the device-only activity log.** Existing approved office TO records are still necessary to mark days as Official Travel in DTR review. The absence of a device scan must never create fake 8 AM / 5 PM times or automatically justify attendance credit.

## DTR rules

AJA must be matched to its documented start/end times. Official Travel references are displayed as **OFFICIAL TRAVEL** in the DTR remarks on covered days, without inventing AM/PM punch times. Missing device scans are not automatically treated as absence or undertime; final government DTR, payroll, undertime, work-hour credit, and supporting-document rules must be confirmed by NCSC HR.

The current print view is labeled **REVIEW COPY**. It uses an A4 printable review table but **is not yet an exact official Civil Service Form 48 layout**. Obtain and verify the actual office template before claiming official format compliance.

## Set up in Cursor / Windows PowerShell

Continue on the existing `feat/ncsc-dtr-workflow` branch. Verify the checkout before editing; do not discard local work or change branches:

```powershell
git status --short --branch
git branch --show-current
git log -1 --oneline
```

Retain the existing `.env`, SQLite database, administrator account and virtual environment during updates. For a new machine only:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Generate a strong random secret for `SECRET_KEY` in the local `.env` and create a private administrator account via `python -m app.cli create-admin` (virtual environment's Python). Never commit the secret or actual HR data.

Start:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Visit http://127.0.0.1:8000.

### Local K14 connector sync

The working poller stores punches in `%LOCALAPPDATA%\NCSC-K14-Pilot\attendance.sqlite3`. The website reads that file on a timer when sync is enabled. It does not bind a public interface and it does not send commands to `192.168.254.201`.

```powershell
.\scripts\Start-NcscLocal.ps1
```

Update the K14 values in the **existing** private `.env`; retain the existing database path, secret, and other settings. `K14_ATTENDANCE_SYNC_ENABLED=false` leaves the timer off but permits authenticated administrator reads. Set it true only for an authorized automatic file-import process. The starter respects `.env` and existing process environment variables.

Development start:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

One manual read, without starting the website:

```powershell
.\.venv\Scripts\python.exe -m app.cli sync-k14
```

Keep `K14_LAN_PROBE_ENABLED=false` unless the office authorizes a TCP probe. The probe still does not collect attendance. Handover steps and the separate device poller are in `docs/k14-attendance-sync.md`.

Diagnosis of the disabled-import issue, exact local settings, and verification commands: `docs/k14-diagnostics-fix.md`.

### Tests

```powershell
.\.venv\Scripts\python.exe -m pip install pytest httpx
.\.venv\Scripts\python.exe -m pytest -q
```

The automated browser test is in `tests/browser_smoke.cjs` and requires Node + Playwright; CI publishes screenshots of fictional data.

**Privacy:** This repository is public. Do not commit `.env`, employee `user.dat`, `template.fp10`, attendance `_attlog.dat`, SQLite databases or actual office HR files.
