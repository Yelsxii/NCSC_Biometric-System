# Employee registration and workspace update

This phase registers verified employee profiles and modernizes internal pages. It does not alter the approved login, enroll fingerprints, create staff login accounts, infer attendance rules or connect Google Sheets templates yet.

## Registration workflow

1. An authorized operator enrolls the employee on the K14 and confirms the unique device ID.
2. An administrator opens **Employee profiles → Register employee**, or the registration button on Employee Attendance.
3. Enter the same K14 ID, complete name components, COS/Permanent/GIP/OJT category, department and designation. Confirm the ID is enrolled and the name matches office records.
4. Choose whether to enable attendance collection and save. The ID is immutable after registration. Existing device records can use **Complete profile** to enrich metadata without duplicating the employee or scans.
5. The collector reads current authorized IDs each cycle. The website also checks authorization on import. Pausing collection retains all already-stored history. Re-enabling never changes original timestamps.

Structured names are entered explicitly; device nicknames are never automatically split into assumed legal-name components. An existing unverified name is displayed as context. Device roster imports cannot overwrite verified profile metadata. Profile updates are audited and use a version check to reject stale edits from another session. Only administrators may register/update; reviewers retain read access.

COS/Permanent/GIP/OJT selects the future template category. The actual Google Sheets masters and PDF output are deferred until those templates are supplied and validated. The old generic browser-print view is removed.

## Existing data and migration

Two tables are added: `employee_profiles` and `k14_authorizations`. Existing users, employee IDs, names, raw punches, connector source, import batches and history are retained. Only an explicit profile save updates that employee's display name/department metadata.

The initial approved IDs are still **1–12, 14 and 18**. Initialization seeds only missing authorization rows; it never re-enables a paused ID. IDs 13, 15, 16 and 17 remain excluded unless an administrator explicitly registers and authorizes them. Existing staff are not assigned guessed categories or parsed names.

Before the first registration migration of a populated website database, SQLite's backup API saves a consistent snapshot under that database's adjacent `backups/` directory, named `before-profiles-*.sqlite3`. That folder remains excluded from Git for the normal `data/` location. No database is replaced or cleared. Follow the approved office restore procedure if a restore is required.

## Pull and start from Cursor terminals

Stop the website and old poller with Ctrl+C in each terminal. In the existing repository, staying on `feat/ncsc-dtr-workflow`:

```powershell
git status --short --branch
git pull --ff-only origin feat/ncsc-dtr-workflow
git log -1 --oneline
```

Keep the existing `.env`, `SECRET_KEY`, database paths and 60-second settings. Start the website:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

In the other Cursor terminal, from the same repository folder, start the updated collector:

```powershell
.\.venv\Scripts\python.exe -m app.cli poll-k14
```

The launcher reads `.env`, uses the existing connector file, and starts the repository's `app.k14_poller` using the existing SDK environment. Its Windows default is `%USERPROFILE%\OneDrive\Desktop\.venv\Scripts\python.exe`, which was confirmed in the pilot. Override only `K14_POLLER_PYTHON` in the private `.env` if the approved environment differs. That environment needs the existing `pyzk` dependency; the website itself does not import the SDK. Existing transport stays TCP unless `K14_USE_UDP=true` is explicitly configured.

Run one collector, using this new command in place of the old Desktop script command. The old script is left untouched but still has its old hard-coded list, so it does not support registration/pausing from the website. No enrollment, user-name retrieval, template retrieval, clearing, time-setting or write-back device methods are used by the new collector.

The approved ID list is read from the existing website SQLite with `mode=ro` and `query_only=ON`, on every cycle and again before storing fetched data. Missing/unreadable registries fail closed. The collector writes only attendance to its separate connector database. Both databases keep their original locations and purposes. Single-read failures return a nonzero exit status; loop failures retry after the configured interval and retain history.

Keep both foreground processes running and refresh the browser once for the new UI. Diagnostics continue to refresh every 5 seconds while visible. No Windows task, service, network exposure or public hosting is installed by this update.

## Verification

Automated checks use fictional names, simulated SDK calls and temporary databases. They cover registration on existing IDs, duplicates, exact leading-zero IDs, profile permissions/CSRF, version conflicts, immutable scans/accounts, migration backup, protected metadata, dynamic authorization and revocation, retry after a connection failure, and the launcher configuration.

Browser checks cover the unchanged login, redesigned tables, registration/completion modals, duplicate errors, category filters, pagination, hidden scrollbars, mobile popup/footer fit, attendance review, USB recovery and live status. Device enrollment, actual new staff classification, network interruption testing and approved unattended startup remain administrator responsibilities on the office host.
