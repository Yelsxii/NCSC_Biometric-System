# NCSC Biometric Attendance & DTR Monitoring

NCSC records-oriented prototype using **FastAPI + SQLite**, with a restrained **navy-blue/red** layout. Development branch: `feat/ncsc-dtr-workflow`, based on `feat/ncsc-theme`.

> **Pilot only.** The system does **not** yet automatically synchronize with the K14, certify an official DTR, interpret unverified time-in/time-out codes, or credit undertime for official travel.

## Three main sections

### 1. Employee Attendance (default page)

- Search employees by name or biometric device ID, choose the month, and open an employee's daily records.
- The employee detail shows every raw device event, related AJA/Travel Order references, and **Preview DTR / Print or Save PDF** controls.
- A compact **Import attendance log** control opens the backup USB importer **on this same page**. Use original `.dat` or `.txt` attendance exports and preview first; the same file cannot be imported twice, and raw scans duplicated in overlapping exports are deduplicated through the database's unique source-event key. New nonduplicate scans are appended; existing scans are never overwritten.
- Excel `.xls` attendance reports can be previewed but are not substitutes for raw source events.

### 2. AJA / Travel Orders (read-only monitoring)

- Filter by month, AJA versus Travel Order, and staff name or ID.
- Shows **existing office activity references** plus **raw biometric events whose recorded work codes have been locally mapped to AJA/Travel Order**.
- A work code is only a *classified device event*, **not** a declaration of approved official travel or a guaranteed departure/return pair.
- No new AJA / Travel Order **filing** or approval UI. The existing office's approvals remain authoritative. Past activity references remain in the database.
- Full-day travel may have **no office fingerprint scans at all**. Those travel dates can appear only if an existing approved office record is linked/imported through an authorized source; the K14 alone cannot infer their duration or approval. That official-records integration remains a deployment task.

### 3. Staff Management

- Search staff roster and edit basic names/departments, with manual entry when syncing is unavailable. Manual entry **does not enroll a fingerprint on the device**.
- **Staff data recovery** uploads a K14 `user.dat` (from the specific sample-tested firmware), a K14 `.xls` report, or a UTF-8 roster CSV. Only name + employee ID are extracted from binary user exports. Conflict handling avoids silently overwriting verified names.
- Locally label the actual numeric work codes present in raw attendance events (including unmodified `0`). Configuring new codes on the K14 requires direct device setup and an authorized verification test.
- A collapsed **LAN connection readiness** area shows configured device IP/port and has a disabled-by-default opt-in connectivity probe. There is **no live sync** until a validated read-only K14 connector is added.

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
