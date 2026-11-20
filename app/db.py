"""SQLite schema and connections. Device records remain immutable after import."""
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
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(employee_code,happened_at,device_id,status_code,verification_code,work_code)
);
CREATE INDEX IF NOT EXISTS idx_punch_date ON punches(happened_at);
CREATE INDEX IF NOT EXISTS idx_punch_employee ON punches(employee_code,happened_at);
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
