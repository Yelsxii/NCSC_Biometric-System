# Biometric times and manual DTR backfill

This update continues from the latest `feat/ncsc-dtr-workflow`, including its activity pairing, live device names and internal design. It does not switch branches, change the approved login, modify device settings or alter original punches.

## What the attendance table shows

One compact month table shows Date, AM In/Out, PM In/Out, Total hours, Undertime Hours/Minutes, Overtime earned, AJA/Travel Order times, Remarks and Edit. The employee name is top left; category and department are top right. The back button sits next to the month control. Time cells carry distinct source and missing colors, while holidays, AJA and travel retain their row cues. The manual Calendar and manual DTR upload buttons are removed. Legends use small glowing circles and actions use dark blue borderless hover states.

Every displayed time has a source label: **Bio**, **Sheet** or **HR**. Original seconds and work codes are retained in source data and tooltips; cells display hours/minutes. Biometric entries do not become reviewed HR selections merely by being displayed.

### Source priority

1. An existing explicit HR punch selection stays first.
2. A uniquely identifiable biometric entry is displayed ahead of the corresponding sheet slot.
3. The named AM/PM columns in an imported manual DTR fill remaining gaps.
4. Ambiguous slots stay empty and extra biometric entries remain available in Edit.

The resolver matches unique source punches to named sheet slots in the same minute. It also displays four distinct, chronologically coherent ordinary scans across AM and PM; two distinct scans spanning morning/afternoon may supply observed AM In and PM Out. These are observed placements, not inferred numeric K14 status meanings or certified attendance. Four morning scans, duplicate-minute scans, ambiguous extras and source disagreements require review. Configured AJA/TO/Fieldwork/Official Business scans are excluded from ordinary inference. No 08:00, noon, 13:00 or 17:00 punch is generated merely to complete a row.

Source differences remain visible. Saving a reviewed biometric selection can explicitly confirm that choice. The separate manual source row is retained and original punches are never overwritten.

## Hours, undertime and overtime

For complete, chronologically valid entries, the table can show elapsed AM + PM duration. This does not grant payroll credit or earned overtime.

The supplied manual DTR calculates Total hours, Hours left to render and Overtime earned. When the displayed four slots agree with the imported manual source at its minute precision, those source results are retained as **manual DTR results**. Explicit HR undertime entries retain precedence. The original source row and its precision remain available for audit.

A biometric/source conflict, unplaced extra ordinary punch, incomplete pair or future time withholds automatic source-based undertime and overtime. A blank template row whose formula says eight hours left does not create absence or a full-day deficit. Travel/leave/reference text is retained as a note, not parsed as a time. Today's source entry later than the local clock is flagged **Future entry**, with earned totals withheld.

Complete, conflict-free matching manual DTR rows and administrator-approved regular time adjustments use the existing template's 07:00 AM earliest credit, noon AM cap, 13:00 PM start, and eight-hour target. Approved adjustments use whole-minute clock precision; original punch seconds remain intact. The 07:00 rule mirrors the existing spreadsheet, not a new payroll or overtime-approval policy. An unchanged manual undertime override is cleared when regular times are edited so the new values can be recalculated; a newly entered explicit override remains authoritative. An adjustment reason is optional, and every saved edit retains actor, timestamp and before/after audit data. Unmatched, unreviewed biometric-only rows and unresolved conflicts still require review. No additional AJA deduction or travel credit is inferred. The interface distinguishes **Complete**, **Undertime**, **Overtime**, **Incomplete entries**, **Needs hour review** and **Source difference** based on available evidence.

## Automatic local source reconciliation

The website checks a protected local DTR source package at startup and every **60 seconds**, independently of K14 polling. View attendance refreshes automatically. The administrator no longer uploads the same package for each employee or month.

Place the prepared `NCSC_manual_DTR_all_available.json` snapshot outside Git in an approved local, access-controlled directory such as `%LOCALAPPDATA%\NCSC-K14-Pilot\manual-dtr.json`. Set `MANUAL_DTR_SOURCE_PATH=%LOCALAPPDATA%\NCSC-K14-Pilot\manual-dtr.json` in the private `.env` file and restart the website process. Changing this file later is reconciled on the next cycle without a second web import action. Keep the package out of cloud-synced folders. Its source tab dates include all available months through the date of the prepared snapshot.

The local app cannot reach the user's signed-in Google Sheets account just because this development environment can. Updating the original Sheet requires refreshing this protected snapshot through an office-approved data process; live Google authentication is **not configured**. The K14 polling loop only brings new biometric punches to the website, not manual Sheet rows. The UI reports source availability and matched/unmatched tab counts separately.

Exact normalized full employee names must uniquely match an existing website employee with an approved profile, roster name, or device name. Surname-only device labels are never matched, even if attendance timestamps agree. Refresh the K14 collector after updating the registered full names. Employees with the same surname remain distinct, and duplicate full names stay unmatched. Multiple archival tabs with that same name may match one employee; two employees with the same name or different names for the same source person do not match automatically. No employee ID is inferred from a sheet tab. Register or correct a verified employee name in the website registry for unmatched tabs, then the next 60-second pass retries. For automatic local reconciliation, a later version of the exact same source row may fill previously empty time slots if every previously recorded value remains unchanged; the prior row is retained in audit history. Conflicting revisions are held. Original punches and reviewed selections are never changed. The default Windows snapshot is discovered automatically if no explicit path is configured. Conventional surname-comma-given-name formatting is normalized without guessing initials or partial names. Existing manual import APIs remain available for controlled recovery, but the attendance page does not expose a manual fill button.

The website saves a successful local import with the existing audit trail. If nothing new is available, no repeat audit/import batch is written. The manual source path and parse errors are sanitized in the status response. The first deployment of the additive schema still creates a consistent backup before migration.

### Cursor setup on the approved Windows host

After pulling the commit and **stopping the old Uvicorn process**, copy the downloaded private snapshot once. These commands do not replace an existing source file:

```powershell
$source = Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" -Filter 'NCSC_manual_DTR_all_available*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $source) { throw 'Download the prepared private DTR package to Downloads first.' }
$folder = Join-Path $env:LOCALAPPDATA 'NCSC-K14-Pilot'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$target = Join-Path $folder 'manual-dtr.json'
if (Test-Path -LiteralPath $target) { throw 'A local DTR source already exists. Review it before replacing anything.' }
Copy-Item -LiteralPath $source.FullName -Destination $target
if (-not (Select-String -LiteralPath .env -Pattern '^\s*MANUAL_DTR_SOURCE_PATH\s*=' -Quiet)) {
    Add-Content -LiteralPath .env -Value 'MANUAL_DTR_SOURCE_PATH=%LOCALAPPDATA%\NCSC-K14-Pilot\manual-dtr.json'
}
```

Check `.env` first if that setting was already added. Then start the website with one worker, sign in, and open **Employee Attendance → View attendance**. The month status shows matched source tabs or a sanitized configuration error. It can take up to 60 seconds after registering a matching employee name to fill those source days. The page refreshes while open.

## Legacy administrator import API (recovery only)

The prepared private package contains only relevant DTR columns and source identities; it excludes account numbers, credentials and biometric templates. Keep attendance packages outside the repository and Git.

The authenticated `/api/manual-dtr/preview` and `/api/manual-dtr/import` endpoints remain for controlled troubleshooting when exact names cannot match. The visible daily page uses automatic local reconciliation instead. Archived tabs for the same exact normalized employee name can be mapped together; differing source values on the same date are all flagged, rather than choosing the first tab.

The preview token is signed, expires after 15 minutes and is bound to the file, mapping and administrator. Altering the file/mapping requires a new preview. Reviewers cannot upload or import. A repeat import adds zero duplicates. A different manual source for an already stored employee/date is reported as a conflict and does not replace the old source. A source row already assigned to another employee cannot be silently reassigned.

Empty unverified website names can be filled from the explicitly mapped sheet; existing names and verified profiles are protected. No employee ID, device authorization, login account or original punch changes. Source imports and mappings are audited. New source data is stored in additive `manual_dtr_imports` and `manual_dtr_entries` tables; a populated pre-upgrade database receives a consistent `backups/before-manual-dtr-*.sqlite3` snapshot before this migration.

The import is a source snapshot, not unattended live access to Google Sheets. It does not store Google credentials or publish the sheet. Later source revisions require another preview. Official editable Google Sheets/PDF export remains a separate phase.

## Package format

Use `ncsc-manual-dtr-v1` with `source.id`, `source.title` and `people`. Each person supplies a stable `key`, `name`, `sheet`, and `rows`; each row contains its original `row` number and `values` from source columns A:O:

Date, Day, AM In, AM Out, PM In, PM Out, AM total, PM total, Daily total, Hours left, Overtime, Status, AJA start, AJA purpose, AJA end.

Google Sheets serial dates/time fractions, ISO dates and unambiguous clock text are supported. PM context resolves a bare `1:00` in a named PM column to 13:00; original raw values are preserved. Duplicate identical rows are skipped. Conflicting duplicate dates, invalid times or chronology require review. Future template dates are excluded. File size is limited to 10 MB; no spreadsheet formulas are executed by this importer.

## Automatic holiday labels

Verified Philippine national non-working dates for **2025 and 2026** are bundled locally. They include the annual proclamations and separately proclaimed Eid dates and the 2025 national election holiday. Special **working** days, such as EDSA on February 25 in these years, are not treated as non-working holidays. Existing office overrides take precedence; explicit manual-sheet holiday notes are preserved. Regional holidays and work suspensions are not guessed, and unverified years are marked internally as unverified.

Sources, verified November 24, 2026:

- [2025 annual calendar, Proclamation 727](https://pco.gov.ph/news_releases/pbbm-issues-proclamation-declaring-regular-holidays-special-non-working-days-for-2025/)
- [2026 annual calendar, Proclamation 1006](https://pco.gov.ph/wp-content/uploads/2025/09/20250903-PROC-1006-FRM.pdf.pdf)
- [2025 Eid'l Fitr](https://pco.gov.ph/news_releases/pbbm-declares-april-1-a-regular-holiday-to-mark-eidl-fitr/) and [Eid'l Adha](https://pco.gov.ph/news_releases/pbbm-declares-june-6-regular-holiday-for-eidl-adha-observance/)
- [2025 election holiday](https://pco.gov.ph/news_releases/proclamation-no-878-declaring-monday-12-may-2025-a-special-non-working-holiday-throughout-the-country/)
- [2026 Eid'l Fitr](https://pco.gov.ph/news_releases/palace-declares-march-20-regular-holiday-nationwide-for-eidl-fitr/) and [Eid'l Adha](https://pco.gov.ph/news_releases/palace-declares-may-27-as-a-regular-holiday-for-eidl-adha-observance/)

## Cursor / Windows update

Stop only the website terminal with Ctrl+C, then:

```powershell
git status --short --branch
git branch --show-current
git pull --ff-only origin feat/ncsc-dtr-workflow
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Keep the existing `.env` and databases. Refresh the browser once for new assets. The separate approved `python -m app.cli poll-k14` collector and existing 60-second automatic import continue unchanged. No scheduled task, public deployment or Google Sheet write is performed.
