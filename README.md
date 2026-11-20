# NCSC Biometric Attendance System

Local-first, security-conscious **Phase 1 MVP** for importing ZKTeco K14 attendance data and recording separate **AJA / Fieldwork / Official Business** entries.

> **Internal pilot only.** No real employee records, fingerprint templates, credentials, or database files are included in this public repository. Do not expose the local server to the public internet or use it as an official payroll/DTR source without review and authorization.

## What's included

- Modern responsive web UI (Overview, Attendance Logs, USB Imports, AJA / Fieldwork)
- FastAPI backend and local SQLite database
- Admin sign-in with scrypt password hashing, signed session cookie, and CSRF protection
- USB attendance log **preview** and import
- Duplicate-safe original scan events and recorded import batches
- **Staff Directory**: automatically discover unknown employee IDs from attendance logs, then attach device names by importing a safe subset of `user.dat`
- **Department Directory**: import labels from `department.dat` (employee-to-department assignments are not yet verified)
- **Numeric Work Codes**: view raw work-code values from attendance exports and maintain labels in the HRIS **without changing the device**
- Separate fieldwork entries with pending/approved/rejected decisions and an audit trail
- Raw K14 device status/verification/work codes preserved **without guessing IN or OUT**
- A future LAN-sync adapter can be added without changing the database's record model

## Tech stack

- **Python 3.11+**, FastAPI, Uvicorn, SQLite (no separate database server needed)
- Plain HTML, CSS and JavaScript (no Node.js build needed)
- Cursor or VS Code, Windows-friendly

## Quick start in Cursor (Windows PowerShell)

### 1. Clone and open the project

```powershell
cd "$HOME\Documents"
git clone https://github.com/Yelsxii/NCSC_Biometric-System.git
cd NCSC_Biometric-System
git checkout feat/phase1-usb-attendance
cursor .
```

> If Cursor is already open, use **File → Open Folder** and select `NCSC_Biometric-System`. If the `cursor` terminal command is unavailable, use that menu instead.

### 2. Create a virtual environment and install dependencies

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 3. Configure your local secret

```powershell
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
notepad .env
```

Replace `CHANGE_ME_TO_A_LONG_RANDOM_VALUE` with the freshly generated random string. Keep `.env` out of GitHub.

### 4. Create a local admin account

```powershell
.\.venv\Scripts\python.exe -m app.cli create-admin
```

Choose a private username and a strong password of 12+ characters. These are stored only as a salted password hash.

### 5. Run the web application

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open **http://127.0.0.1:8000** in your browser and sign in.

Press **Ctrl+C** to stop. The SQLite database is created at `data/ncsc.sqlite3`, which is ignored by Git.

## USB import workflow

1. On an authorized ZKTeco K14: **USB Manager / Download → Attendance Data → This Month** (menu labels vary).
2. Keep the original `*_attlog.dat` file in a secure office folder. **Do not upload it to GitHub.**
3. Inside the application: **USB Imports → Choose file → Preview file**.
4. Review the count, date range, unique employee IDs, and raw status codes.
5. Select **Import records**. The system stores the source events separately and skips duplicate events.
6. Visit **Attendance Logs** to review records.

### Supported K14 six-field log format

```text
EMP001<TAB>2026-11-03 07:21:07<TAB>1<TAB>0<TAB>1<TAB>0
```

Fields: employee ID, scan timestamp, device ID, **raw status code**, **raw verification code**, raw work code. Field meaning should be confirmed with the exact firmware/device configuration before classifying any scan as IN/OUT. The example uses a **fictional** ID.

## Phase 2 USB staff directory and department sync

The K14 has a separate binary `user.dat` export. The supplied sample matches **72-byte user records**, containing name + personnel number in specific fields, while `department.dat` matches **49-byte department records**. These details are firmware-specific; incompatible exports must be rejected instead of guessed.

1. With office authorization, download **User Data** from the K14 to a private USB drive. This may also produce **fingerprint template files** named `template.fp10` or similar. Those files are highly sensitive and are **not required by this app**. Do not upload them to the app, GitHub, or public services.
2. In the app, open **Staff Directory → Choose user.dat → Preview directory → Sync directory**. Only name and staff ID are extracted; other user-export bytes are not stored.
3. If available, select `department.dat` using the same importer. It adds department names but **does not assign staff to departments**.
4. A new employee appearing in an imported **attendance** file will automatically appear as an ID-only staff record. The next `user.dat` snapshot can fill in their name.
5. The USB workflow is **not live**: new users enrolled on the device won't appear immediately. Future authorized LAN sync may update staff automatically without USB.

**Existing installations:** Pull the latest feature branch and restart Uvicorn. SQLite creates the new tables without deleting prior attendance imports. The Staff Directory will backfill from any existing stored scan IDs.

## Work codes versus shifts

The K14 screens labeled **Select Shift**, **Schedule Type**, and **Default Shift** are scheduling settings, **not** work-code configuration. Do not rename or change shifts to represent AJA / Fieldwork.

- In **Work Codes**, you can define a **numeric value → local display label**, such as `101` → `Official Business`. This mapping is *only inside the HRIS*.
- The original exported attendance file contained work-code `0` on every observed record; the app cannot infer AJA/Fieldwork statuses from those scans.
- To enable work codes **on the device itself**, its exact firmware's Work Code settings must be confirmed and tested with the office's approval. A work-code drop-down on the K14 may be a valid device input method; a local HRIS field cannot force the firmware to use a number keypad.
- A working USB *work-code list download* is not a prerequisite for the HRIS. We only interpret actual recorded code values after confirming them.

## Data and safety rules

- Never alter the biometric device's historical attendance records. This application has **no K14 write functions**.
- **No fingerprint templates or biometric images are imported or stored**. If a USB export includes template files, keep them out of this application and handle them under your office's data-protection procedures.
- Never commit `.env`, `data/`, `uploads/`, or attendance `.dat` exports.
- Only authorized HR personnel should access real employee data, even during testing.
- Uploads are validated (up to 2 MB, 50,000 lines) and the parser reads data as text, not code.
- Date/time fields represent **office local time (Asia/Manila)**; no timezone conversion is applied to K14 local device timestamps.
- Scan status codes `0`, `1`, `4` **are not automatically treated as time-in or time-out**.
- Fieldwork entries are independent of biometric events and cannot overwrite scans.
- Same-file reimport is blocked; duplicate attendance event keys are ignored.
- SQLite backups should be encrypted and access-controlled. Avoid saving unencrypted exports in shared folders.

## Pilot limitations and next development stages

1. **Employee identity verification:** the pilot now imports staff IDs and names from the device; verify official HR employee mapping before using it for DTR/payroll.
2. **Separate requester/reviewer roles:** the pilot is admin-entered; a production approval flow must enforce distinct approver and requester identities and explicit policy.
3. **Validated DTR interpretation:** confirm actual firmware status codes, shift rules, breaks, exceptions, and audit requirements with HR before computing time-in/out or payable hours.
4. **Network sync adapter:** when authorized, verify actual Ethernet connectivity, K14 SDK/protocol, and a **read-only** pull path. The existing import/punch schema is designed for both USB and future LAN sources.
5. **Operational hardening:** HTTPS, secrets management, account management, rate-limiting/login lockout, roles and permissions, automated backups, retention policy, and security review before office-wide rollout.

This is deliberately **not** a certified payroll or official biometric attendance platform yet.

## Project structure

```text
NCSC_Biometric-System/
├── app/
│   ├── __init__.py
│   ├── cli.py              # create-admin command
│   ├── db.py               # SQLite schema and persistence
│   ├── security.py         # salted password hashing
│   ├── parser.py           # validated raw K14 attendance file parsing
│   ├── roster.py           # metadata-only user.dat / department.dat parsing
│   ├── main.py             # authenticated API and application
│   ├── index.html          # responsive dashboard layout
│   └── static/
│       ├── app.css         # design system, layout and responsiveness
│       └── app.js          # API-driven UI interactions
├── tests/
│   └── test_app.py
├── .github/workflows/
│   └── test.yml
├── .env.example
├── .gitignore
├── requirements.txt
└── README.md
```

## Run tests

```powershell
.\.venv\Scripts\python.exe -m pip install pytest httpx
.\.venv\Scripts\python.exe -m pytest -q
```

## Working with GitHub

This starter implementation lives in `feat/phase1-usb-attendance` for review before merging to `main`. Open a pull request, review/test it, then merge after verification.

If you merge the PR first, clone `main` without checking out the feature branch.

---
**Maintained for the NCSC biometric integration pilot.**
