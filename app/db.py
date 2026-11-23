"""SQLite schema and connections.

Imported attendance timestamps and employee IDs stay as first recorded.
A connector-created row may receive USB export fields once for that same
timestamp; the connector's raw values remain in k14_sync_events.
"""
from __future__ import annotations
import os
import sqlite3
from pathlib import Path


def database_path() -> Path:
    return Path(os.getenv("DATABASE_PATH", "data/ncsc.sqlite3")).expanduser()


def connect() -> sqlite3.Connection:
    p = database_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=30000")
    return con


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','reviewer')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS import_batches (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 file_sha256 TEXT NOT NULL UNIQUE,
 original_name TEXT NOT NULL,
 total_records INTEGER NOT NULL,
 inserted_records INTEGER NOT NULL,
 imported_by INTEGER NOT NULL REFERENCES users(id),
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS punches (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_code TEXT NOT NULL,
 happened_at TEXT NOT NULL,
 device_id TEXT NOT NULL,
 status_code TEXT NOT NULL,
 verification_code TEXT NOT NULL,
 work_code TEXT NOT NULL,
 imported_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
 source TEXT NOT NULL DEFAULT 'usb',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(employee_code,happened_at,device_id,status_code,verification_code,work_code)
);
CREATE INDEX IF NOT EXISTS idx_punch_date ON punches(happened_at);
CREATE INDEX IF NOT EXISTS idx_punch_employee ON punches(employee_code,happened_at);
CREATE INDEX IF NOT EXISTS idx_punch_work_code ON punches(device_id,work_code);
CREATE TABLE IF NOT EXISTS k14_sync_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 device_ip TEXT NOT NULL,
 employee_id TEXT NOT NULL,
 punch_time_local TEXT NOT NULL,
 device_status TEXT NOT NULL,
 device_punch_type TEXT NOT NULL,
 received_at_utc TEXT NOT NULL,
 punch_id INTEGER REFERENCES punches(id),
 link_reason TEXT NOT NULL CHECK(link_reason IN ('inserted','matched_existing_timestamp')),
 synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(device_ip, employee_id, punch_time_local, device_status, device_punch_type)
);
CREATE INDEX IF NOT EXISTS idx_k14_sync_employee ON k14_sync_events(employee_id, punch_time_local);
CREATE TABLE IF NOT EXISTS k14_sync_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('success','error')),
 source_name TEXT NOT NULL DEFAULT '',
 records_read INTEGER NOT NULL DEFAULT 0,
 records_inserted INTEGER NOT NULL DEFAULT 0,
 records_already_present INTEGER NOT NULL DEFAULT 0,
 records_skipped INTEGER NOT NULL DEFAULT 0,
 error_message TEXT NOT NULL DEFAULT '',
 actor_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS employees (
 employee_code TEXT PRIMARY KEY,
 display_name TEXT NOT NULL DEFAULT '',
 department TEXT NOT NULL DEFAULT '',
 name_source TEXT NOT NULL DEFAULT 'scan',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS work_codes (
 device_id TEXT NOT NULL,
 work_code TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '',
 activity_type TEXT NOT NULL DEFAULT 'Unclassified',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(device_id,work_code)
);
CREATE TABLE IF NOT EXISTS fieldwork (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_code TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('AJA','Fieldwork','Official Business')),
 location TEXT NOT NULL,
 reason TEXT NOT NULL,
 start_at TEXT NOT NULL,
 end_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_by INTEGER NOT NULL REFERENCES users(id),
 reviewed_by INTEGER REFERENCES users(id),
 reviewed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_fieldwork_status ON fieldwork(status, start_at);
CREATE TABLE IF NOT EXISTS activity_records (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_code TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('AJA','Fieldwork','Official Business','Travel Order')),
 reference TEXT NOT NULL DEFAULT '',
 purpose TEXT NOT NULL DEFAULT '',
 start_at TEXT NOT NULL,
 end_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','voided')),
 recorded_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 voided_by INTEGER REFERENCES users(id),
 voided_at TEXT,
 void_reason TEXT NOT NULL DEFAULT '',
 CHECK(end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_activity_employee ON activity_records(employee_code,start_at,end_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_duplicate ON activity_records
 (employee_code,category,start_at,end_at,reference,purpose) WHERE status='recorded';
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_id INTEGER NOT NULL REFERENCES users(id),
 action TEXT NOT NULL,
 entity TEXT NOT NULL,
 entity_id INTEGER NOT NULL,
 details TEXT NOT NULL DEFAULT '',
 at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def initialize() -> None:
    with connect() as con:
        con.executescript(SCHEMA)
        migrate(con)
        register_scan_metadata(con)


def migrate(con: sqlite3.Connection) -> None:
    """Add columns and sync tables without rewriting existing attendance rows."""
    columns = {row[1] for row in con.execute("PRAGMA table_info(punches)")}
    if "source" not in columns:
        con.execute("ALTER TABLE punches ADD COLUMN source TEXT NOT NULL DEFAULT 'usb'")


def register_scan_metadata(con: sqlite3.Connection) -> None:
    """Register IDs/codes seen in logs without inventing names or code meanings."""
    con.execute("INSERT OR IGNORE INTO employees(employee_code) SELECT DISTINCT employee_code FROM punches")
    con.execute("INSERT OR IGNORE INTO employees(employee_code) SELECT DISTINCT employee_code FROM activity_records WHERE status='recorded'")
    con.execute(
        "INSERT OR IGNORE INTO work_codes(device_id,work_code) "
        "SELECT DISTINCT device_id,work_code FROM punches WHERE work_code<>''"
    )
