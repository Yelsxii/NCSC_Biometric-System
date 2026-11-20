"""Staff metadata import. No passwords, cards or biometric templates are read."""
from __future__ import annotations

import csv
import io
import struct

import xlrd

from app.parser import CODE, MAX_BYTES
from app.roster import parse_user_dat


def clean(value: object, limit: int, title: str) -> str:
    text = str(value).strip()
    if len(text) > limit or any(ord(c) < 32 for c in text):
        raise ValueError(f"{title} has unsupported characters or exceeds {limit} characters.")
    return text


def staff_row(code: object, name: object, department: object = "") -> dict:
    # Preserve textual IDs exactly, including leading zeroes. Excel numeric IDs
    # are accepted only as nonnegative whole numbers.
    if isinstance(code, (float, int)):
        if not 0 <= code <= 999_999_999_999_999 or int(code) != code:
            raise ValueError("An employee ID is not a supported whole number.")
        code = str(int(code))
    code = str(code).strip()
    if not CODE.fullmatch(code):
        raise ValueError("A staff row has an invalid employee ID.")
    name = clean(name, 140, "Staff name")
    if not name:
        raise ValueError(f"Staff ID {code}: a name is required.")
    return {"employee_code": code, "display_name": name,
            "department": clean(department, 140, "Department")}


def parse_staff(raw: bytes, filename: str) -> list[dict]:
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Choose a nonempty staff file up to 2 MB.")
    items = []
    if filename.lower().endswith(".csv"):
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeError as exc:
            raise ValueError("Save the staff CSV using UTF-8 encoding.") from exc
        if "\0" in text:
            raise ValueError("Binary user backups are not a staff CSV. Use the K14 .xls report or a CSV roster.")
        try:
            reader = csv.DictReader(io.StringIO(text))
            if reader.fieldnames not in (["employee_code", "display_name"],
                                        ["employee_code", "display_name", "department"]):
                raise ValueError("CSV headers must be employee_code,display_name,department (department is optional).")
            for row in reader:
                if None in row or any(v is None for v in row.values()):
                    raise ValueError("A staff CSV row has a different number of columns than its header.")
                items.append(staff_row(row["employee_code"], row["display_name"], row.get("department", "")))
                if len(items) > 5000:
                    raise ValueError("Staff imports support up to 5,000 rows.")
        except csv.Error as exc:
            raise ValueError("Could not read the staff CSV.") from exc
    elif filename.lower().endswith(".xls"):
        if not raw.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
            raise ValueError("Choose an original K14 Excel .xls report.")
        book = None
        try:
            book = xlrd.open_workbook(file_contents=raw, on_demand=True)
            if not 1 <= book.nsheets <= 10:
                raise ValueError("Unsupported workbook structure.")
            matches = [s for s in book.sheets() if s.name.strip().lower() == "att.log report"]
            if len(matches) != 1:
                raise ValueError("Staff import needs the K14 Att.log report worksheet.")
            sheet = matches[0]
            if sheet.nrows * sheet.ncols > 250_000 or sheet.ncols > 128:
                raise ValueError("Staff report is too large.")
            for i in range(sheet.nrows):
                if str(sheet.cell_value(i, 0)).strip().lower() != "id:":
                    continue
                if sheet.ncols < 11 or str(sheet.cell_value(i, 8)).strip().lower() != "name:":
                    raise ValueError("Unsupported staff ID/name header in the device report.")
                department = sheet.cell_value(i, 20) if sheet.ncols > 20 and str(sheet.cell_value(i, 18)).strip().lower() == "dept.:" else ""
                items.append(staff_row(sheet.cell_value(i, 2), sheet.cell_value(i, 10), department))
                if len(items) > 5000:
                    raise ValueError("Staff imports support up to 5,000 rows.")
        except (xlrd.XLRDError, xlrd.compdoc.CompDocError, struct.error, IndexError, UnicodeError, TypeError) as exc:
            raise ValueError("Could not read staff names from this K14 report.") from exc
        finally:
            if book is not None:
                book.release_resources()
    elif filename.lower().replace("\\\\", "/").split("/")[-1] == "user.dat":
        # Firmware-specific verified layout. Import employee ID + name only.
        # No fingerprint templates, passwords, cards, privileges or PIN hashes
        # are copied to application storage.
        items = [staff_row(entry.employee_code, entry.device_name)
                 for entry in parse_user_dat(raw)]
    else:
        raise ValueError("Use the K14 user.dat, .xls report, or a staff .csv file. Never upload fingerprint templates.")
    if not items:
        raise ValueError("No staff names found in the selected file.")
    unique = {}
    for row in items:
        code = row["employee_code"]
        if code in unique and row != unique[code]:
            raise ValueError(f"Staff ID {code} has conflicting names or departments in the file.")
        unique[code] = row
    return list(unique.values())
