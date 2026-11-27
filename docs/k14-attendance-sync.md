# K14 attendance sync handover

The website imports attendance from the connector SQLite file. It does not open the K14, enroll users, clear logs, or copy fingerprint templates. The repository's `app.k14_poller` now performs collection using the existing SDK environment. It is based on the supplied working Desktop pilot and follows the website's administrator-managed authorization list. The Desktop script remains untouched. A physical network-interruption test is still required before claiming recovery has been verified on the device.

## What was verified

Connector file: `%LOCALAPPDATA%\NCSC-K14-Pilot\attendance.sqlite3`

Table `attendance_raw`:

| Column | Role |
| --- | --- |
| `device_ip` | Device address stored by the poller |
| `employee_id` | Original device user ID |
| `punch_time_local` | `YYYY-MM-DD HH:MM:SS` as stored |
| `device_status` | Raw connector value |
| `device_punch_type` | Raw connector value |
| `received_at_utc` | When the poller stored the row |

Primary key: `device_ip`, `employee_id`, `punch_time_local`, `device_status`, `device_punch_type`.

The connector database has no verification column and no work-code column. The website does not invent either value. A connector-only punch stores `device_status` in Status and `device_punch_type` in Verification, leaves Work code blank, and stores the device IP in Device. None of those values are time in, time out, undertime, or overtime.

The bootstrap authorization list is unchanged: IDs 1–12, 14 and 18. Other IDs remain excluded until an administrator explicitly registers and authorizes them in **Employee profiles**. Both the repository collector and website importer read current permissions from `k14_authorizations`. Pausing an employee never deletes existing attendance.

A connector event links to an existing employee/timestamp instead of adding another punch. Exact USB duplicates are skipped. If USB arrives after a connector row, its device, status, verification, and work-code fields enrich that placeholder; the connector's raw values stay in `k14_sync_events`. Different original USB codes at the same second are retained as distinct events. Original employee IDs and timestamps are retained.

## Local start

From the repository root, after the virtual environment and private `.env` exist:

```powershell
.\scripts\Start-NcscLocal.ps1
```

The script listens on `127.0.0.1:8000` only. Open http://127.0.0.1:8000 on this PC. It respects existing `.env` and process environment settings, does not force automatic imports on, and does not schedule a Windows task. Do not change the listening address without office authorization.

Sign in as an administrator, open **Users & Work Codes**, expand **Connection diagnostics**, and use **Read connector database**. The panel separately shows automatic imports, local file availability, total attendance records, last successful synchronization, new records from that success, and the latest result/error. A repeated successful import with zero new rows shows **Success — No new records**. Manual reads work while the automatic timer and TCP probe are disabled.

While **Users & Work Codes** is visible, the display checks status every **5 seconds** without reloading or starting an import. It leaves the work-code editor and focus intact. It pauses on hidden tabs, navigation away, and logout; returning to the tab refreshes immediately. Temporary UI request failures keep the last displayed result and retry. This display interval is separate from the **60-second** device and website import intervals.

**Available (local file)** proves file readability and the expected table schema only. A cache can remain readable while the K14 is offline. Neither a zero-new-record success nor a TCP handshake proves that device polling is running. A live device status needs an actual poller heartbeat/last-poll result; do not infer it from the most recent attendance timestamp.

USB import stays on **Employee Attendance** → **Import attendance**.

One-shot import without leaving the process running:

```powershell
.\.venv\Scripts\python.exe -m app.cli sync-k14
```

`K14_ATTENDANCE_SYNC_ENABLED` controls automatic file imports only; explicit administrator/CLI reads do not require it. The default connector path is `%LOCALAPPDATA%\NCSC-K14-Pilot\attendance.sqlite3`. An explicit `K14_CONNECTOR_DB` must be an absolute local path; environment placeholders are expanded. Use only an approved file outside OneDrive, Dropbox, Google Drive, or iCloud. Retain the existing website `DATABASE_PATH` and `SECRET_KEY`. Update only K14 entries in the existing `.env`, then restart. Existing process environment values take precedence over `.env`.

Exact root causes, configuration values, and PowerShell verification: [Diagnostics fix](k14-diagnostics-fix.md).

## Device poller

Keep the collector and website as two foreground programs. Stop the previous Desktop-script collector, then from a second Cursor PowerShell terminal in the repository start the current collector:

```powershell
.\.venv\Scripts\python.exe -m app.cli poll-k14
```

The launcher uses local `.env` settings and the existing SDK Python at `%USERPROFILE%\OneDrive\Desktop\.venv\Scripts\python.exe`, unless `K14_POLLER_PYTHON` specifies another approved environment. The website database is opened read-only for authorization lookup, while attendance is written only to the separate existing connector file. See [registration and collector update](employee-registration.md). The old Desktop script still uses its old fixed ID list and must not remain running in parallel.

When explicitly enabled, the website imports on startup and then waits **60 seconds** between attempts by default. It retries source/database failures on the next cycle, retains existing attendance, and wakes the timer on shutdown. Run one website process/worker on the approved host. Restart after changing `.env`. An existing `K14_SYNC_INTERVAL_SECONDS=300` is an explicit override and remains 300 until edited. See [the 60-second update guide](k14-live-refresh.md) for the exact steps to update both running processes.

Both programs wait after completing a cycle, so transfer time adds to the configured interval. With two independent 60-second cycles, a normal new scan may take about two minutes plus processing and the next UI status check to appear. The device poller still reads the whole device history each time; observe its duration and normal scanning behavior during this shorter-interval pilot.

The collector reconnects/retries after read failures, disconnects in `finally`, and retains already collected rows. Synthetic tests verify failure/recovery and permissions changing between cycles. Before unattended operation, validate a temporary network interruption on the approved host, restore connectivity, and confirm that new scans reach both databases exactly once.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The tests build a fictional connector database. They do not read the office file.

## Backup

The registration migration adds two tables and creates a consistent local backup before migrating a populated website database. Existing punches and IDs are retained. Preserve existing backups and follow the office's approved backup/restore procedure; see [migration details](employee-registration.md).

## Do not commit

Do not commit `.env`, `data\`, connector databases, USB exports, user files, or fingerprint templates. The repository `.gitignore` already excludes SQLite databases and `data\`.

## Still needs office authorization

- Scheduling the device poller on an office PC or server.
- Any change to the physical K14, its IP, its users, or its stored logs.
- Opening the website beyond this PC, including a LAN hostname or public host.
- Turning on `K14_LAN_PROBE_ENABLED`.
- Treating `device_status` or `device_punch_type` as time in, time out, AJA, undertime, or overtime.
- Calling a DTR preview an official Civil Service Form 48.

## Approved automatic startup and staff handover

No deployment or Windows scheduled task has been created by this change. After office authorization, the administrator should:

1. Install the website and the reviewed poller under fixed office-managed local paths with their Python environments already prepared. Retain accounts, secrets, and the existing databases. Restrict file permissions to the approved account and administrators.
2. Point both processes at the same absolute connector path. A service/task account can have a different `LOCALAPPDATA`; do not assume it resolves to the interactive user's file. Allow the website to read the connector and write its own database.
3. Configure two separate startup tasks/services under the approved account, with explicit working directories, restart after failure, and one instance each. Avoid credentials in command arguments. No task-registration command is run by this repository.
4. Use the website virtual environment's `python.exe` with arguments `-m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1`, and set **Start in** to the repository root. Enable `K14_ATTENDANCE_SYNC_ENABLED=true` and `K14_SYNC_INTERVAL_SECONDS=60` locally for this approved process. Configure the reviewed external poller separately at 60 seconds.
5. Test boot/login startup, recovery, newly scanned attendance, duplicates, and approved backup/restore procedures. Protect and retain operational logs according to office policy. Access from other PCs needs a separate authorized hosting/authentication/HTTPS configuration.
6. Give staff a desktop shortcut to `http://127.0.0.1:8000` on the approved host and a named administrator to contact if scans are missing. Staff use their website account, Employee Attendance, View attendance, and DTR preview; they do not need Git, Cursor, Python, or Node.js commands. Administrators can use diagnostics or USB backup when needed.
