# NCSC Biometric Attendance & DTR Monitoring

NCSC records-oriented prototype using **FastAPI + SQLite**, with a restrained **navy-blue/red** layout. Development branch: `feat/ncsc-dtr-workflow`, based on `feat/ncsc-theme`.

> **Pilot only.** The system does **not** yet automatically synchronize with the K14, certify an official DTR, interpret unverified time-in/time-out codes, or credit undertime for official travel.

## Records-first interface

- **Employee Attendance (default):** Search by employee ID or name, filter month, and open detailed daily scans / DTR preview. The register table deliberately shows employee ID, name, department and **View attendance** only; scan-count and last-scan columns were removed as nonessential.
- **Import attendance:** A compact **Import attendance** button sits next to **View records** and opens an accessible modal. Admins preview the original K14 `.dat`/`.txt` USB export, then merge it. Existing scan records are never overwritten; duplicate events are skipped while new source events are appended. File import remains a fallback if LAN sync is unavailable.
- **AJA / Travel Orders:** Read-only **device-classified scan event list**, filterable by employee and month/type. Columns show employee, activity, exact recorded date/time and numeric work code. **No office reference column, no new TO/AJA filing form.** The list uses existing local labels for codes found on K14 scans; code 0 is untouched. A work-code scan alone is not evidence of approved activity, start/end interval, or DTR time credit.
- **Users & Work Codes:** No staff directory listing or manual-add form. Existing user-data recovery is available via a small **Import device users** modal for K14 `user.dat`, `.xls` or `.csv`. Work-code mappings remain accessible, with device network diagnostics hidden under an expandable section.
- **Login:** The original **split-panel NCSC login** from `feat/ncsc-theme` has been restored, including its photo, seal and fingerprint sign-in panel. Only redundant help affordances were removed.

## K14 data limitations

The application currently has a tested USB import path, not live LAN synchronization. An authorized K14 network connection and verified **read-only SDK connector** are needed to automatically fetch user profiles, attendance and supported work-code metadata.

**Official Travel without a fingerprint scan cannot show up in the device-only activity log.** Existing approved office TO records are still necessary to mark days as Official Travel in DTR review. The absence of a device scan must never create fake 8 AM / 5 PM times or automatically justify attendance credit.

## DTR rules

AJA must be matched to its documented start/end times. Official Travel references are displayed as **OFFICIAL TRAVEL** in the DTR remarks on covered days, without inventing AM/PM punch times. Missing device scans are not automatically treated as absence or undertime; final government DTR, payroll, undertime, work-hour credit, and supporting-document rules must be confirmed by NCSC HR.

The current print view is labeled **REVIEW COPY**. It uses an A4 printable review table but **is not yet an exact official Civil Service Form 48 layout**. Obtain and verify the actual office template before claiming official format compliance.

## Set up in Cursor / Windows PowerShell

If you currently have an unfinished Git merge or local edits, run `git status` **before switching**. Don't discard conflict-resolution work with a destructive reset.

After your repository is in a safe, clean state:

```powershell
git fetch origin
git switch -c feat/ncsc-dtr-workflow --track origin/feat/ncsc-dtr-workflow
```

If the branch already exists locally, use `git switch feat/ncsc-dtr-workflow` and `git pull --ff-only origin feat/ncsc-dtr-workflow`.

The existing `.env`, SQLite database, administrator account and virtual environment are kept locally when switching branches. New machine:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Generate a strong random secret for `SECRET_KEY` in the local `.env` and create a private administrator account via `python -m app.cli create-admin` (virtual environment's Python). Never commit the secret or actual HR data.

Start:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Visit http://127.0.0.1:8000.

### Future authorized K14 LAN setup

The device was observed at IP `192.168.1.201`, port `4370`, DHCP OFF, but there was no Ethernet cable, and the development PC was on `192.168.254.0/24`. Configure cabling and subnet **with office authorization** before any probe. The optional check needs settings in the local `.env`:

```dotenv
K14_HOST=192.168.1.201
K14_PORT=4370
K14_LAN_PROBE_ENABLED=false
```

Never enable live data access just because TCP port 4370 is open. Firmware-compatible, audited, read-only device retrieval must be tested, and it must not read fingerprint templates or issue device write/delete commands. See `app/lan.py` and `app/ingestion.py`.

### Tests

```powershell
.\.venv\Scripts\python.exe -m pip install pytest httpx
.\.venv\Scripts\python.exe -m pytest -q
```

The automated browser test is in `tests/browser_smoke.cjs` and requires Node + Playwright; CI publishes screenshots of fictional data.

**Privacy:** This repository is public. Do not commit `.env`, employee `user.dat`, `template.fp10`, attendance `_attlog.dat`, SQLite databases or actual office HR files.
