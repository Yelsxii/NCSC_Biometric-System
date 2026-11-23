# Live diagnostics and 60-second synchronization

The diagnostics previously fetched status only on page entry or a manual action. Automatic imports continued in the backend, but the open page kept showing the old timestamp. The page now checks `/api/device/status` every 5 seconds while **Users & Work Codes** is visible. It updates the timestamp, counts, result, errors, connector availability, and configured import interval without reloading the page.

These are authenticated GET status checks. They do not call the import endpoint or communicate with the K14. Work-code table rows, unsaved editor values, and focus are left alone. Only one status request runs at a time. Old page responses are ignored; navigation, logout, or a hidden tab stops polling. Returning to a visible tab refreshes immediately. Requests have a 15-second timeout; temporary failures retain the previous result, show a retry message, and retry automatically.

## Separate intervals

| Stage | Interval | Where configured |
| --- | --- | --- |
| K14 → connector SQLite | 60 seconds | Existing external poller command: `--loop --interval 60` |
| Connector SQLite → website SQLite | 60 seconds | Private `.env`: `K14_SYNC_INTERVAL_SECONDS=60` |
| Diagnostics display | 5 seconds | Frontend status check while the page is visible |

The website default and invalid-value fallback are now 60 seconds. Valid explicit overrides from 60 to 86,400 seconds are retained. The automatic timer remains an explicit opt-in. A private `.env` that still says 300 remains at 300 until changed; pulling source does not modify it. The external poller is outside Git and retains its own defaults; passing `--interval 60` changes its running interval without modifying that script.

Both import loops wait after completing their work, so elapsed cycle time includes processing. Two independent 60-second stages can take around two minutes plus processing and the next UI check to display a normal new scan. Existing records and duplicate handling are unchanged. Observe device responsiveness and collection duration during the shorter-interval pilot.

## Apply on the approved host using Cursor PowerShell terminals

1. Stop the running website and poller with **Ctrl+C in each of their own Cursor terminal tabs**. Keep the project on `feat/ncsc-dtr-workflow`.
2. In the project terminal, pull the published changes:

```powershell
git status --short --branch
git pull --ff-only origin feat/ncsc-dtr-workflow
git log -1 --oneline
```

3. In the existing private `.env`, keep the secret and website database path intact. Set only these interval/mode values, retain the correct connector file path, then save:

```dotenv
K14_ATTENDANCE_SYNC_ENABLED=true
K14_SYNC_INTERVAL_SECONDS=60
```

4. In the website terminal, clear any old interval override from that terminal and start the existing website:

```powershell
Remove-Item Env:K14_SYNC_INTERVAL_SECONDS -ErrorAction SilentlyContinue
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

5. In the other Cursor terminal, start the same existing poller and database at 60 seconds:

```powershell
& "$env:USERPROFILE\OneDrive\Desktop\.venv\Scripts\python.exe" "$env:USERPROFILE\OneDrive\Desktop\k14_auto_sync.py" --host 192.168.254.201 --port 4370 --loop --interval 60 --db "$env:LOCALAPPDATA\NCSC-K14-Pilot\attendance.sqlite3"
```

These are the confirmed pilot paths. Use the actual approved paths on another host. The database remains under Local AppData; the script and Python environment may be on Desktop. No credentials or attendance files are committed.

6. Refresh the browser once to load the newly published frontend. Open **Users & Work Codes → Connection diagnostics**. Expect **On · every 60 seconds** and **Status updates automatically every 5 seconds**. Keep the page open without refreshing or clicking **Read connector database**. The last-success timestamp should advance automatically after a successful import, including zero-new-record runs. Keep both processes running and the PC awake.

There is no database schema change, new device operation, Windows scheduled task, public listener, or automatic startup registration in this change. Actual network-interruption recovery and office-approved unattended startup remain separate checks.

## Validation

The Python suite passes 53 tests, including a 60-second retry cycle, valid interval overrides, invalid-value fallback, source preservation, and duplicate prevention. Nine dependency-free JavaScript behavior checks execute the actual frontend script and cover live changes without reload/import POSTs, editor preservation, visibility, navigation/logout, request serialization, stale responses, network recovery, session expiry, and timeouts. Run them with `node --test tests/device_live_refresh.cjs`.

The browser regression suite also performs a real synthetic import from another process while the diagnostics page and code editor stay open. It waits for the updated count and timestamp without a reload or manual import and checks that focus and the unsaved label remain intact. CI runs this along with the existing login, USB, DTR, and layout checks. Tests use only temporary fictional data.
