# DTR monitoring scope

The office monitors its existing DTR. This application is not a second AJA or travel-order application/approval system.

| Record | Source | Treatment in this revision |
| --- | --- | --- |
| Biometric scans | K14 USB export, or the local read-only connector database | Preserve exact timestamp, employee ID and raw device codes; group by day for checking |
| AJA / fieldwork / official business / travel order | Existing office record | Optional reference or short note, saved directly without another approval |
| Incorrect reference | Authorized administrator | Void with a reason; retain the original and audit event |
| Previous application entries | Old system table | Retain original pending/approved/rejected statuses as read-only history |
| DTR AM/PM entries and totals | Existing NCSC DTR | Reference for future verified filling/calculation/export; no replacement attendance rules in this revision |

## Daily monitoring

Choose a device employee ID and month. The view lists every calendar day, its day name, original scan times and any references covering that date. A reference can span several days. Its ending timestamp is exclusive, so an order ending at midnight is not displayed on the following day. Voided references stay in reference history and are excluded from daily monitoring.

The displayed coverage labels mean only **Device scans**, **Reference only**, or **No records**. They do not mean present, absent, on approved leave, complete hours, or undertime. Weekends are identified by their day name; holidays and work schedules are not inferred.

There is no additional lunch deduction, fixed workday assumption, travel-duration credit, overtime rule, or automatic classification of raw device codes. Fingerprint scans cannot supply an AJA purpose or document number that was never recorded in the device. A document reference does not create a physical scan.

## Existing approvals and data

Employees continue using the office's existing AJA and travel process. They do not reapply here. An administrator may add an existing reference only if it helps explain a DTR entry. Importing the existing register later should use the same reference model, without adding a new approval step.

Schema initialization only adds tables/indexes. It does not rewrite or approve old records. Previous activity write and decision APIs are retired (HTTP 410); existing history remains readable. Administrator-only writes, CSRF validation, duplicate prevention and audit events apply to new references and corrections.

## Remaining integration

Automatic AM/PM filling, undertime calculation and exact NCSC printable DTR export are not delivered by the monitoring screen. They require verified device code mapping and alignment with the existing DTR fields/formulas. The attendance connector copies raw punches only. It does not connect to the office AJA or travel-order register, and it does not decide time in, time out, undertime, or overtime.
