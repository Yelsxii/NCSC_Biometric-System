"""Read-only summaries of K14 Excel reports, kept separate from source scans.

Only workbook structure, the reporting period, and unique device IDs are read.
Names, calculated attendance totals and inferred IN/OUT events are not imported.
"""
from __future__ import annotations

import datetime as dt
import re
import struct

import xlrd

from app.parser import MAX_BYTES


def preview_k14_report(raw: bytes) -> dict:
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Report must be nonempty and no larger than 2 MB.")
    if not raw.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        raise ValueError("Choose an original Excel .xls device report.")
    workbook = None
    try:
        workbook = xlrd.open_workbook(file_contents=raw, on_demand=True)
        if not 1 <= workbook.nsheets <= 10:
            raise ValueError("Unsupported report structure.")
        sheets = []
        period = None
        employees = set()
        for sheet in workbook.sheets():
            if sheet.nrows * sheet.ncols > 250_000 or sheet.ncols > 128:
                raise ValueError("Report exceeds the supported preview size.")
            sheets.append({"name": sheet.name, "rows": sheet.nrows})
            for row in range(min(5, sheet.nrows)):
                for cell in sheet.row_values(row):
                    match = re.search(r"(20\d{2}-\d{2}-\d{2})\s*~\s*(20\d{2}-\d{2}-\d{2})", str(cell))
                    if match:
                        start, end = (dt.date.fromisoformat(x) for x in match.groups())
                        if start > end:
                            raise ValueError("Report has an invalid date range.")
                        period = f"{start.isoformat()} to {end.isoformat()}"
            if sheet.name.strip().lower() == "att.log report" and sheet.ncols >= 3:
                for row in range(sheet.nrows):
                    if str(sheet.cell_value(row, 0)).strip().lower() == "id:":
                        code = str(sheet.cell_value(row, 2)).strip()
                        if code:
                            employees.add(code)
        if not employees or not period:
            raise ValueError("Not a recognized K14 attendance report. Use the original device export.")
        return {"format": "report", "employees": len(employees), "period": period,
                "sheets": sheets, "message": "Report preview only. Nothing was stored."}
    except (xlrd.XLRDError, xlrd.compdoc.CompDocError, struct.error,
            IndexError, TypeError, ValueError, UnicodeError) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError("Could not read this .xls report. Choose an original K14 export.") from exc
    finally:
        if workbook is not None:
            workbook.release_resources()
