# Employee Attendance: monthly DTR view

This update focuses on Employee Attendance. The approved login and original attendance source remain unchanged. Internal pages use the direct page title in the top bar, without repeated page banners or a Workspace breadcrumb.

## Directory and monthly table

The employee directory shows name, category, department, View attendance and an administrator profile-edit action. The registration button is inside the directory card. Device identifiers remain internal to this view; registration still requires the exact enrolled K14 ID.

View attendance opens one compact monthly table. The name is capitalized within the table card, with category, department and the month selector. An icon button returns to the directory. The two old scan tables, scan-count summary, generic export placeholder and monitoring-status column are removed from this UI. The authenticated raw attendance API is retained for existing integrations.

The office-supplied COS, Permanent and OJT forms share Date, AM In/Out, PM In/Out and Undertime Hours/Minutes. GIP adds Daily Total. The UI uses those fields; this phase does not alter the original Google Sheet or implement export generation. No spreadsheet employee data, names or attendance values are included in this repository.

## Editing without modifying source records

An administrator uses a day's Edit button to select real device entries for each of the four slots. Options retain the exact original time, status and available work code. A work code of `0` remains `0`; an unavailable connector work code remains unavailable. No status, punch type or work code is assigned an unverified AM/PM meaning.

When exactly four entries exist, **Place four entries** fills the popup in chronological order as a draft. The administrator must verify the selection and save. Extra entries stay available in the popup and appear as a small “to place” count. A newly synchronized entry never replaces a saved selection. Empty slots can remain empty; the editor cannot invent a device timestamp.

Undertime accepts an explicitly verified whole-minute value, displayed as separate hours and minutes. Blank means under review, not zero. The supplied working-sheet formulas currently count AM from 07:00, cap AM at noon, and start PM at 13:00, while an 08:00 AM office start was reported. Automatic undertime therefore remains disabled until the office confirms the applicable rule, rounding and activity credits. Missing punches, AJA and Travel Order references never grant assumed attendance time.

For GIP, Daily Total is elapsed AM plus elapsed PM only after four ordered original entries have been explicitly selected. Seconds stay intact in source records and in the calculated API duration; the UI displays hours and whole minutes. This display is not an overtime or payroll rule.

A daily activity reference/remark may be added as review metadata. Existing recorded references and activities from verified work-code mappings also remain visible. These labels do not create punches or credit hours.

## Colors and calendar

- Pink: no entry or an unassigned/incomplete slot on an elapsed weekday.
- Yellow: a selected entry; AJA uses a yellow badge.
- Blue: an office-labeled holiday.
- Purple: Travel Order.
- Neutral: weekends and upcoming dates without entries; these are not labeled absent.

Activity/holiday labels remain visible even when another color takes precedence. The administrator's Calendar popup applies a named holiday to all employees for that date. A blank holiday name clears the label. No national or local holiday calendar is guessed or fetched automatically.

## Storage and permissions

Two additive tables, `attendance_day_reviews` and `attendance_calendar`, store selections/annotations. They reference original punch IDs. Original punches, employee IDs, user accounts, connector data and import history are not rewritten. A populated pre-upgrade website database receives a consistent SQLite backup under its adjacent `backups/before-attendance-*.sqlite3` before the first attendance migration. Repeated startups do not repeat this migration backup.

Writes require an authenticated administrator and CSRF token. Reviewers may inspect selections. Version checks reject stale concurrent edits. Every saved review/calendar change is audited. The server rejects cross-employee/date selections, duplicate reuse, unknown punch IDs and invalid chronological order.

Attendance refreshes through authenticated GET requests every ten seconds while its page is visible. It pauses when a popup is open or the tab is hidden, preserves table scroll and retries after a temporary read failure. The existing diagnostics refresh and configured 60-second collector/import interval are retained.

## Cursor PowerShell update

Stop the website with Ctrl+C, then run from the existing project folder:

```powershell
git status --short --branch
git pull --ff-only origin feat/ncsc-dtr-workflow
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Keep the approved collector running in its separate terminal using `python -m app.cli poll-k14` through the project's `.venv`. No `.env` change, database replacement, OS task or deployment is required. Refresh the browser once to load the updated UI.
