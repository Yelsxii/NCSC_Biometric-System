# K14 attendance sync handover

The website imports attendance from the connector SQLite file. It does not open the K14, enroll users, clear logs, or copy fingerprint templates. The existing `k14_auto_sync.py` poller remains the only program that connects to the device.

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

Allowed device IDs copied into the website: 1–12, 14, and 18. IDs 13, 15, 16, and 17 are skipped.

The same employee ID and timestamp are one punch. A USB file of that moment does not create a second row. If the USB file arrives after the connector row, its device, status, verification, and work-code fields replace the placeholder on that row. The connector's raw values stay in `k14_sync_events`.

## Local start

From the repository root, after the virtual environment and private `.env` exist:

```powershell
.\scripts\Start-NcscLocal.ps1
```

The script listens on `127.0.0.1:8000` only. Open http://127.0.0.1:8000 on this PC. Do not add a firewall rule and do not change the host to `0.0.0.0`.

Sign in as an administrator, open **Users & Work Codes**, expand **Connection diagnostics**, and use **Read connector database**. The panel shows the last successful synchronization, the number of new records from that success, and the latest error when the most recent attempt failed.

USB import stays on **Employee Attendance** → **Import attendance**.

One-shot import without leaving the process running:

```powershell
.\.venv\Scripts\python.exe -m app.cli sync-k14
```

`K14_ATTENDANCE_SYNC_ENABLED=true` is required. The default connector path is `%LOCALAPPDATA%\NCSC-K14-Pilot\attendance.sqlite3`. Override it with `K14_CONNECTOR_DB` only for an office-approved file that is not in OneDrive, Dropbox, Google Drive, or iCloud.

## Device poller

Keep the poller and the website as two programs. Start the poller only with office authorization, from its own folder and virtual environment:

```powershell
python .\k14_auto_sync.py --host 192.168.254.201 --port 4370 --loop --interval 300 --db "$env:LOCALAPPDATA\NCSC-K14-Pilot\attendance.sqlite3"
```

That command is read-only attendance collection. Do not add flags or code that clear attendance, write users, or download templates. Do not point `--db` at a cloud-synced folder or at `data\ncsc.sqlite3`.

The website then rereads the connector file every 300 seconds. Restart the website after changing `.env`.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The tests build a fictional connector database. They do not read the office file.

## Backup

Before the first schema update, the website database was copied under `data\backups\`. That folder is gitignored. Restore by stopping the website and copying the backup back to `data\ncsc.sqlite3`.

## Do not commit

Do not commit `.env`, `data\`, connector databases, USB exports, user files, or fingerprint templates. The repository `.gitignore` already excludes SQLite databases and `data\`.

## Still needs office authorization

- Scheduling the device poller on an office PC or server.
- Any change to the physical K14, its IP, its users, or its stored logs.
- Opening the website beyond this PC, including a LAN hostname or public host.
- Turning on `K14_LAN_PROBE_ENABLED`.
- Treating `device_status` or `device_punch_type` as time in, time out, AJA, undertime, or overtime.
- Calling a DTR preview an official Civil Service Form 48.
