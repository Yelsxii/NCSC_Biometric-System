# K14 approved employee names and real-time DTR scan visibility

## Why attendance used to look empty

- The LAN collector stores **employee ID**, **raw scan timestamp**, and device
  status/punch values. Raw scans were already in the website database, but
  the AM/PM cells displayed only manually reviewed slot assignments.
- Device user names were not previously read; the `employees.display_name`
  placeholders were empty. The ID list therefore showed `Name not verified`.
- Some months truly have no imported scans for a given ID; the employee
  detail now explicitly shows its source scan count for the selected month.

## What changed

- **Read-only approved names**: the repository K14 poller now periodically
  requests `get_users()`, retaining **only employee ID and display name**
  for employees already authorized in the local website registry.
  It does not fetch fingerprint templates, cards, passwords, or other user
  properties, and does not enroll or configure device users.
- The poller stores these in a separate, additive connector SQLite table
  `device_user_names`. The website imports only authorized IDs and never
  overwrites verified HR profiles, roster names, or manually entered names.
  Device-provided names remain marked **unverified** until confirmed by HR.
- **DTR raw-time preview**: with exactly four distinct ordinary device scans
  for an employee/date, the four times appear in chronological AM/PM columns
  as **Preview** (not approved). These do not become reviewed assignments,
  produce undertime, or affect official exports.
- With fewer/more/ambiguous scans, the original timestamps are shown under
  Activity/remarks as **Biometric scans** until an administrator selects the
  verified AM/PM slots. AJA/Travel Order scans remain separate.
- After a reviewer saves assignments, they appear as **reviewed** rather
  than provisional. Month banner tells whether any source punches exist.

## Deployment on Windows

1. Keep backups of the local website and connector SQLite files. Preserve
   .env and installed SDK environments; never reset imported biometric data.
2. Pull the updated **feat/ncsc-dtr-workflow** branch (only with a clean
   working tree). Restart the FastAPI website.
3. Stop the **separate existing K14 poller** first to avoid two parallel
   readers; run the repository's `python -m app.cli poll-k14` command from
   the approved poller Python environment. If the other poller is intentionally
   kept instead, it will continue importing attendance but won't collect
   `device_user_names`.
4. Sync connector database from Users & Work Codes (or wait for the enabled
   60-second importer). A changed name can appear even if zero new attendance
   rows are imported. Imported name strings are not validated HR profiles.
5. In Employee Attendance open an employee/month that has scans. Look for
   the source count banner and blue **Preview** (four scans) or explicit
   **Biometric scans** list (other cases).

### Limitations

- This requires the installed K14 SDK's `get_users()` method to be
  available to the approved poller; it has not been tested on live office
  hardware. Failure of name retrieval does not interrupt attendance polling.
- Some device firmware may supply nicknames or incomplete names; verify
  them with the office before official use. Employee category/department
  still need an HR profile or authorized staff-roster import.
- Numeric K14 `status`/`punch` values **are not** interpreted as AM/PM
  direction. Four raw scans are shown as a *source preview* only.
  AJA/Travel Order work-code IN/OUT mapping requires an independently
  verified source work code. The current LAN poller still does not carry it.
- When an employee shows 0 scans for the selected month, try another month
  and verify the K14 device ID is included in the authorized collector list.
