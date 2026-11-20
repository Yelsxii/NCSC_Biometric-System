"""Shared, immutable ingestion for raw device events.

USB and future read-only LAN adapters must both yield normalized Punch records
and use this function. Source scans are append-only and duplicate-safe.
"""
from __future__ import annotations
import sqlite3
from collections.abc import Iterable
from app.db import register_scan_metadata
from app.parser import Punch


def insert_punches(con: sqlite3.Connection, records: Iterable[Punch], batch_id: int) -> int:
    before = con.total_changes
    con.executemany(
        """INSERT OR IGNORE INTO punches
           (employee_code,happened_at,device_id,status_code,verification_code,work_code,imported_batch_id)
           VALUES(?,?,?,?,?,?,?)""",
        [(p.employee_code,p.happened_at,p.device_id,p.status_code,
          p.verification_code,p.work_code,batch_id) for p in records],
    )
    inserted = con.total_changes - before
    register_scan_metadata(con)
    return inserted
