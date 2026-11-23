# K14 diagnostics fix from b3db63b

Base: `feat/ncsc-dtr-workflow`, commit `b3db63b98a9d89ab5700d4caf98e1a5a4ab02bac`.

## Confirmed code causes

| Symptom | Cause at the base commit | Change |
| --- | --- | --- |
| Old `192.168.1.201` address | `app/lan.py` has the old fallback; HTML also hardcodes it. A private `.env` or inherited environment can override the fallback. | Correct fallback; HTML waits for configured API values. Update any old local override and restart. |
| Manual read says sync is turned off | `run_sync()` checks `K14_ATTENDANCE_SYNC_ENABLED` for both manual reads and the timer. The flag defaults false. | Authenticated admin + CSRF and explicit CLI reads bypass only the timer flag. File/path/schema and ID restrictions still apply. |
| Last success alongside latest Error | A disabled attempt is saved as an error in `k14_sync_runs`, while `status_view()` retains the earlier successful run. | Separate automatic mode, local file availability, latest attempt, last success, and total attendance. A zero-insert success is successful. |
| Starting methods behave differently | `Start-NcscLocal.ps1` forcibly enables imports and overwrites host/port, while ordinary uvicorn/CLI startup uses `.env`/environment defaults. | Starter respects the existing local configuration; automatic imports are an explicit opt-in. |
| Literal `%LOCALAPPDATA%` path cannot be found | Explicit `K14_CONNECTOR_DB` previously only expanded `~`, not environment placeholders. | Expand environment placeholders and require an absolute local path; reject unresolved placeholders. |

The supplied error proves that the previous website process saw automatic imports as disabled. Its private `.env` and Windows process environment were not available for inspection, so the source of that effective value cannot be determined remotely. This error does not mean the earlier 4,986 attendance rows were lost or the K14 poller stopped.

`app/db.py` was inspected and is unchanged. No schema replacement, data reset, account change, timestamp conversion, or employee-ID remapping is part of this fix. Existing USB enrichment retains connector raw codes in `k14_sync_events`. The USB merge additionally preserves distinct raw work/status codes at the same second instead of discarding them.

## Local configuration

Edit only these entries in the **existing** private `.env`. Keep the existing `SECRET_KEY`, `DATABASE_PATH`, accounts, and other settings. Do not copy the example over an existing installation.

```dotenv
K14_HOST=192.168.254.201
K14_PORT=4370
K14_CONNECTOR_DB=%LOCALAPPDATA%\NCSC-K14-Pilot\attendance.sqlite3
K14_LAN_PROBE_ENABLED=false
K14_ATTENDANCE_SYNC_ENABLED=false
K14_SYNC_INTERVAL_SECONDS=300
```

Manual reads work with these settings. The website opens the connector with `mode=ro` and `query_only=ON`; the authenticated admin action writes only imported events/history to the existing website database. The source file must exist and have the verified `attendance_raw` schema. No missing connector file is created. The API cannot supply a different file path.

After office approval for automatic imports, change only `K14_ATTENDANCE_SYNC_ENABLED=true` and restart the website. This enables the website timer; it does not start the external K14 poller or create a scheduled task. Keep TCP probing disabled if it is not needed.

When a Windows service/task account differs from the interactive account, use an explicit approved absolute connector path. Environment variables inherited by the process take precedence over `.env`. Both the old host and disabled timer can therefore persist until those overrides are corrected and the website process is restarted.

## Windows PowerShell verification

These commands are for an administrator in the **existing project folder** after applying the reviewed code changes. They do not switch branches, reset data, or push anything.

```powershell
git status --short --branch
git branch --show-current
git log -1 --oneline
# The working branch must remain feat/ncsc-dtr-workflow.

Test-Path -LiteralPath "$env:LOCALAPPDATA\NCSC-K14-Pilot\attendance.sqlite3"

# Inspect K14 overrides only; do not print SECRET_KEY or the full .env.
Get-Item Env:K14_HOST,Env:K14_PORT,Env:K14_CONNECTOR_DB,Env:K14_ATTENDANCE_SYNC_ENABLED -ErrorAction SilentlyContinue
Select-String -Path .env -Pattern '^K14_(HOST|PORT|CONNECTOR_DB|LAN_PROBE_ENABLED|ATTENDANCE_SYNC_ENABLED|SYNC_INTERVAL_SECONDS)='

# After correcting stale overrides and the K14 entries in the existing .env:
.\.venv\Scripts\python.exe -m app.cli k14-status
.\.venv\Scripts\python.exe -m app.cli sync-k14
.\.venv\Scripts\python.exe -m app.cli sync-k14
.\.venv\Scripts\python.exe -m app.cli k14-status
```

The repeated import should report `Outcome: success` and `new 0` if no scans arrived in between. Total attendance should remain at the existing count (4,986 for the reported installation if it contains no additional USB/new records). If all rows are skipped, check the configured device IP and source IDs/timestamps; skipped rows are not newly imported rows.

```powershell
# Start locally using the existing virtual environment and .env:
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Open `http://127.0.0.1:8000`, sign in as an administrator, and check **Users & Work Codes → Connection diagnostics**. Expect the configured IP, **Off · Manual reads available**, **Available (local file)**, the total attendance count, and **Success — No new records** after a repeat manual read. TCP probing should show **Disabled**. Automatic imports are permitted only after enabling them locally on the approved host.

In the prepared test environment:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
# Optional browser regression suite if Playwright is already installed:
$env:TEST_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
node .\tests\browser_smoke.cjs
```

Tests use temporary synthetic databases, not office data. Do not test outages by deleting, moving, or editing live databases. Actual K14 polling, office-host startup approval, and employee handover steps are in [the handover guide](k14-attendance-sync.md).

## Files changed and validation

| File | Change |
| --- | --- |
| `app/k14_sync.py` | Separate manual/timer reads, local path expansion, sanitized errors, file availability/counts, retry and worker shutdown |
| `app/lan.py` | Correct IP fallback, safe port validation, independent TCP diagnostics |
| `app/main.py` | Admin manual read, diagnostic payload, safe configuration errors, worker shutdown |
| `app/cli.py` | Explicit manual import and `k14-status` command |
| `app/ingestion.py` | Preserve distinct original USB codes sharing a timestamp |
| `app/index.html` | Separate connector/timer/TCP/result/count fields within the existing panel |
| `app/static/app.js` | Render these states, zero-new-record success, and prevent repeated clicks during a read |
| `.env.example` | Explicit local connector path and separate timer/probe settings |
| `scripts/Start-NcscLocal.ps1` | Honor local configuration instead of forcing settings |
| `tests/test_k14_sync.py` | Manual reads, outage recovery, worker lifecycle/retry, safe errors, CLI, raw USB codes, synthetic pilot volume |
| `tests/browser_smoke.cjs` | Add synthetic connector diagnostics, manual import, missing file and recovery checks |
| `README.md` | Correct configuration and startup guidance |
| `docs/k14-attendance-sync.md` | Approved host startup, external poller limitations and staff handover |
| `docs/k14-diagnostics-fix.md` | Root causes, settings, verification commands and validation record |

Validation in the editing environment: baseline **37 tests passed**; after changes **46 tests passed**. JavaScript syntax checks and `git diff --check` passed. Synthetic volume testing read **5,736** rows, inserted **4,986** eligible rows, skipped **750**, and inserted **0** on repeat; connector file bytes stayed unchanged. API tests also verify admin/CSRF restrictions, preserved raw codes, retained success history through an outage, recovery, and the five-minute retry timer.

The browser suite was attempted but Chromium could not launch: the environment rejected its process-singleton socket with `Operation not permitted`. Its new browser assertions remain unexecuted here. PowerShell was unavailable in this Linux environment, so Windows command execution and actual K14/network tests remain for the approved host. No live office files or device connection were used.

`app/db.py`, the database schema, and the website CSS remain unchanged. No actual `.env`, credentials, SQLite files, or attendance exports are part of the change. Publishing these source changes does not deploy the website or configure scheduled tasks.
