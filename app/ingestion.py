"""Shared ingestion for raw device events.

USB imports and the K14 connector adapter both land in punches.
The same employee and timestamp are one attendance event: a later USB export
can fill codes on a connector-created row, and a later connector read links
to the existing row instead of inserting another punch.
"""
from __future__ import annotations
import sqlite3
from collections.abc import Iterable
from app.db import register_scan_metadata
from app.parser import Punch


def insert_punches(con: sqlite3.Connection, records: Iterable[Punch], batch_id: int) -> int:
    inserted = 0
    for punch in records:
        existing = con.execute(
            """SELECT id,source,device_id,status_code,verification_code,work_code
               FROM punches WHERE employee_code=? AND happened_at=? ORDER BY id""",
            (punch.employee_code, punch.happened_at),
        ).fetchall()
        identical = any(
            row["device_id"] == punch.device_id
            and row["status_code"] == punch.status_code
            and row["verification_code"] == punch.verification_code
            and row["work_code"] == punch.work_code
            for row in existing
        )
        if identical:
            continue
        if len(existing) == 1 and existing[0]["source"] == "k14":
            try:
                con.execute(
                    """UPDATE punches
                       SET device_id=?,status_code=?,verification_code=?,work_code=?,source='usb+k14'
                       WHERE id=? AND source='k14'""",
                    (punch.device_id, punch.status_code, punch.verification_code,
                     punch.work_code, existing[0]["id"]),
                )
            except sqlite3.IntegrityError:
                pass
            continue
        # Distinct USB codes at the same timestamp are still original events.
        # Only the connector placeholder above may be enriched; exact USB
        # duplicates are handled by the comparison/unique constraint.
        cur = con.execute(
            """INSERT OR IGNORE INTO punches
               (employee_code,happened_at,device_id,status_code,verification_code,work_code,imported_batch_id,source)
               VALUES(?,?,?,?,?,?,?,'usb')""",
            (punch.employee_code, punch.happened_at, punch.device_id, punch.status_code,
             punch.verification_code, punch.work_code, batch_id),
        )
        inserted += cur.rowcount
    register_scan_metadata(con)
    return inserted
