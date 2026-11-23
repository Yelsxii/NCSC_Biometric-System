"""Read-only import from the local K14 connector SQLite database.

The connector (k14_auto_sync.py) is the only process that talks to the device.
This module opens that database with mode=ro, copies new punches into the
website database, and never writes back to the connector or the K14.

Verified connector table attendance_raw:
  device_ip, employee_id, punch_time_local, device_status, device_punch_type,
  received_at_utc
  PRIMARY KEY (device_ip, employee_id, punch_time_local, device_status, device_punch_type)

The connector does not store a USB device number, a separate verification
mode, or a work code. Those USB fields are left blank until a USB export of
the same employee and timestamp arrives. device_status and device_punch_type
are stored raw and are not treated as time in, time out, undertime, or overtime.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
import re
import sqlite3
import sys
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from app.db import connect, database_path, initialize, register_scan_metadata
from app.lan import settings

ALLOWED_IDS = frozenset(str(number) for number in list(range(1, 13)) + [14, 18])
DEFAULT_INTERVAL_SECONDS = 60
REQUIRED_COLUMNS = (
    "device_ip",
    "employee_id",
    "punch_time_local",
    "device_status",
    "device_punch_type",
    "received_at_utc",
)
PRIMARY_KEY = (
    "device_ip",
    "employee_id",
    "punch_time_local",
    "device_status",
    "device_punch_type",
)
CODE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
_LOCK = threading.Lock()
_WORKER_LOCK = threading.Lock()
_STOP = threading.Event()
_THREAD: threading.Thread | None = None

# Only application-authored messages may reach the UI or the sync history.
_SAFE_ERRORS = frozenset({
    "Automatic connector imports are turned off.",
    "Attendance connector sync is turned off.",  # Older saved attempts.
    "Set K14_CONNECTOR_DB to the connector SQLite file.",
    "K14_CONNECTOR_DB must be an absolute local file path with defined environment variables.",
    "Connector database was not found.",
    "Connector database must not be read from a personal cloud-synced folder.",
    "The connector database must stay separate from the website database.",
    "Could not open the connector database read-only.",
    "Could not read the connector attendance table.",
    "Connector database has no attendance_raw table.",
    "Connector attendance_raw primary key does not match the verified K14 pilot schema.",
    "No administrator account is available to attribute new attendance records.",
    "K14_HOST must be a literal private IPv4 address.",
    "K14_HOST must be a private, non-loopback IPv4 address.",
    "K14_PORT must be a valid TCP port.",
    "Could not read the connector database or update the website database.",
})


def safe_error(message: str) -> str:
    if message in _SAFE_ERRORS:
        return message
    prefix = "Connector attendance_raw is missing columns: "
    if message.startswith(prefix):
        missing = message[len(prefix):].split(", ")
        if missing and all(column in REQUIRED_COLUMNS for column in missing):
            return message
    return "Synchronization failed. Review the local connector settings and try again."


def enabled() -> bool:
    """Enable the automatic timer; explicit administrator reads are separate."""
    return os.getenv("K14_ATTENDANCE_SYNC_ENABLED", "false").lower() == "true"


def sync_interval() -> int:
    try:
        value = int(os.getenv("K14_SYNC_INTERVAL_SECONDS", str(DEFAULT_INTERVAL_SECONDS)))
    except ValueError:
        return DEFAULT_INTERVAL_SECONDS
    return value if 60 <= value <= 86400 else DEFAULT_INTERVAL_SECONDS


def connector_path() -> Path:
    raw = os.getenv("K14_CONNECTOR_DB", "").strip()
    if raw:
        raw = re.sub(r"%([A-Za-z_][A-Za-z0-9_]*)%", lambda match: os.getenv(match[1], match[0]), raw)
        path = Path(os.path.expandvars(raw)).expanduser()
        if not path.is_absolute() or "%" in str(path) or "$" in str(path) or str(path).startswith(("\\\\", "//")):
            raise ValueError("K14_CONNECTOR_DB must be an absolute local file path with defined environment variables.")
        return path
    local = os.getenv("LOCALAPPDATA", "").strip()
    if not local:
        raise ValueError("Set K14_CONNECTOR_DB to the connector SQLite file.")
    return Path(local) / "NCSC-K14-Pilot" / "attendance.sqlite3"


def _stamp() -> str:
    return dt.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def _cloud_synced(path: Path) -> bool:
    text = str(path).lower()
    return any(name in text for name in ("onedrive", "dropbox", "google drive", "icloud"))


@contextmanager
def _open_connector(path: Path):
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError("Connector database was not found.")
    if _cloud_synced(resolved):
        raise ValueError("Connector database must not be read from a personal cloud-synced folder.")
    website = database_path().expanduser().resolve()
    if resolved == website or (website.exists() and resolved.samefile(website)):
        raise ValueError("The connector database must stay separate from the website database.")
    uri = resolved.as_uri() + "?mode=ro"
    try:
        source = sqlite3.connect(uri, uri=True, timeout=30)
    except sqlite3.Error as exc:
        raise ValueError("Could not open the connector database read-only.") from exc
    source.row_factory = sqlite3.Row
    try:
        source.execute("PRAGMA query_only=ON")
        verify_schema(source)
        yield source
    except sqlite3.Error as exc:
        raise ValueError("Could not read the connector attendance table.") from exc
    finally:
        source.close()


def read_connector(path: Path) -> list[sqlite3.Row]:
    with _open_connector(path) as source:
        return list(source.execute(
            """SELECT device_ip, employee_id, punch_time_local, device_status,
                      device_punch_type, received_at_utc FROM attendance_raw"""
        ))


def connector_availability() -> dict:
    """Check local readability/schema only. This cannot prove the K14 is online."""
    try:
        with _open_connector(connector_path()):
            pass
        return {"connector_available": True, "connector_message": "Available (local file)"}
    except ValueError as exc:
        message = safe_error(str(exc))
    except (sqlite3.Error, OSError, RuntimeError):
        message = "Could not open the connector database read-only."
    return {"connector_available": False, "connector_message": message}


def verify_schema(source: sqlite3.Connection) -> None:
    info = list(source.execute("PRAGMA table_info(attendance_raw)"))
    if not info:
        raise ValueError("Connector database has no attendance_raw table.")
    names = [row[1] for row in info]
    missing = [column for column in REQUIRED_COLUMNS if column not in names]
    if missing:
        raise ValueError("Connector attendance_raw is missing columns: " + ", ".join(missing))
    primary = tuple(row[1] for row in sorted(info, key=lambda row: row[5]) if row[5])
    if primary != PRIMARY_KEY:
        raise ValueError("Connector attendance_raw primary key does not match the verified K14 pilot schema.")


def _acceptable(device_ip: str, employee_id: str, happened: str, status: str, punch_type: str, received: str, host: str) -> bool:
    if device_ip != host or employee_id not in ALLOWED_IDS:
        return False
    if not all(CODE.fullmatch(value) for value in (device_ip, employee_id, status, punch_type)):
        return False
    if not received or len(received) > 32:
        return False
    if not TIMESTAMP.fullmatch(happened):
        return False
    try:
        moment = dt.datetime.strptime(happened, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    return 2000 <= moment.year <= 2100


def _record_run(con: sqlite3.Connection, started: str, outcome: str, source_name: str,
                records_read: int, inserted: int, already: int, skipped: int,
                error_message: str, actor_id: int | None) -> str:
    finished = _stamp()
    con.execute(
        """INSERT INTO k14_sync_runs
           (started_at,finished_at,outcome,source_name,records_read,records_inserted,
            records_already_present,records_skipped,error_message,actor_id)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (started, finished, outcome, source_name, records_read, inserted, already, skipped,
         error_message[:500], actor_id),
    )
    return finished


def _empty(outcome: str, error_message: str, started: str, records_read: int = 0) -> dict:
    return {
        "outcome": outcome,
        "records_read": records_read,
        "records_inserted": 0,
        "records_already_present": 0,
        "records_skipped": 0,
        "error_message": error_message,
        "finished_at": _stamp() if outcome == "error" else started,
    }


def write_website(rows: list[sqlite3.Row], actor_id: int | None, started: str, source_name: str) -> dict:
    host = settings().host
    inserted = already = skipped = 0
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        batch_id = None
        admin_id = actor_id
        for row in rows:
            device_ip = "" if row["device_ip"] is None else str(row["device_ip"]).strip()
            employee_id = "" if row["employee_id"] is None else str(row["employee_id"]).strip()
            happened = "" if row["punch_time_local"] is None else str(row["punch_time_local"]).strip()
            status = "" if row["device_status"] is None else str(row["device_status"]).strip()
            punch_type = "" if row["device_punch_type"] is None else str(row["device_punch_type"]).strip()
            received = "" if row["received_at_utc"] is None else str(row["received_at_utc"]).strip()
            if not _acceptable(device_ip, employee_id, happened, status, punch_type, received, host):
                skipped += 1
                continue
            linked = con.execute(
                """SELECT id FROM k14_sync_events
                   WHERE device_ip=? AND employee_id=? AND punch_time_local=?
                     AND device_status=? AND device_punch_type=?""",
                (device_ip, employee_id, happened, status, punch_type),
            ).fetchone()
            if linked:
                already += 1
                continue
            existing = con.execute(
                "SELECT id FROM punches WHERE employee_code=? AND happened_at=? ORDER BY id LIMIT 1",
                (employee_id, happened),
            ).fetchone()
            if existing:
                con.execute(
                    """INSERT INTO k14_sync_events
                       (device_ip,employee_id,punch_time_local,device_status,device_punch_type,
                        received_at_utc,punch_id,link_reason)
                       VALUES(?,?,?,?,?,?,?, 'matched_existing_timestamp')""",
                    (device_ip, employee_id, happened, status, punch_type, received, existing["id"]),
                )
                already += 1
                continue
            if batch_id is None:
                if admin_id is None:
                    admin_id = con.execute(
                        "SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1"
                    ).fetchone()
                    admin_id = None if admin_id is None else admin_id["id"]
                if admin_id is None:
                    raise ValueError("No administrator account is available to attribute new attendance records.")
                token = f"k14-sync|{started}|{uuid.uuid4().hex}"
                cur = con.execute(
                    """INSERT INTO import_batches
                       (file_sha256,original_name,total_records,inserted_records,imported_by)
                       VALUES(?,?,?,?,?)""",
                    (hashlib.sha256(token.encode()).hexdigest(), "K14 connector sync", 0, 0, admin_id),
                )
                batch_id = cur.lastrowid
            cur = con.execute(
                """INSERT OR IGNORE INTO punches
                   (employee_code,happened_at,device_id,status_code,verification_code,work_code,
                    imported_batch_id,source)
                   VALUES(?,?,?,?,?, '', ?,'k14')""",
                (employee_id, happened, device_ip, status, punch_type, batch_id),
            )
            if cur.rowcount != 1:
                found = con.execute(
                    "SELECT id FROM punches WHERE employee_code=? AND happened_at=? ORDER BY id LIMIT 1",
                    (employee_id, happened),
                ).fetchone()
                if found is None:
                    skipped += 1
                    continue
                punch_id = found["id"]
                reason = "matched_existing_timestamp"
                already += 1
            else:
                punch_id = cur.lastrowid
                reason = "inserted"
                inserted += 1
            con.execute(
                """INSERT INTO k14_sync_events
                   (device_ip,employee_id,punch_time_local,device_status,device_punch_type,
                    received_at_utc,punch_id,link_reason)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (device_ip, employee_id, happened, status, punch_type, received, punch_id, reason),
            )
        if batch_id is not None:
            con.execute(
                "UPDATE import_batches SET total_records=?, inserted_records=? WHERE id=?",
                (inserted, inserted, batch_id),
            )
            if actor_id is not None:
                con.execute(
                    "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                    (actor_id, "import", "k14_sync", batch_id, f"{inserted} new connector records"),
                )
        register_scan_metadata(con)
        finished = _record_run(
            con, started, "success", source_name, len(rows), inserted, already, skipped, "", actor_id,
        )
    return {
        "outcome": "success",
        "records_read": len(rows),
        "records_inserted": inserted,
        "records_already_present": already,
        "records_skipped": skipped,
        "error_message": "",
        "finished_at": finished,
    }


def _remember_error(started: str, message: str, actor_id: int | None, records_read: int = 0) -> dict:
    message = safe_error(message)
    initialize()
    finished = _stamp()
    with connect() as con:
        con.execute(
            """INSERT INTO k14_sync_runs
               (started_at,finished_at,outcome,records_read,error_message,actor_id)
               VALUES(?,?, 'error', ?,?,?)""",
            (started, finished, records_read, message[:500], actor_id),
        )
    result = _empty("error", message, started, records_read)
    result["finished_at"] = finished
    return result


def run_sync(actor_id: int | None = None, *, manual: bool = False) -> dict:
    """Import locally, on an explicit admin/CLI request or an enabled timer."""
    with _LOCK:
        started = _stamp()
        try:
            initialize()
            if not manual and not enabled():
                raise ValueError("Automatic connector imports are turned off.")
            path = connector_path()
            rows = read_connector(path)
            return write_website(rows, actor_id, started, path.name)
        except ValueError as exc:
            return _remember_error(started, str(exc), actor_id)
        except (sqlite3.Error, OSError, RuntimeError):
            return _remember_error(
                started,
                "Could not read the connector database or update the website database.",
                actor_id,
            )


def status_view(include_errors: bool) -> dict:
    initialize()
    with connect() as con:
        success = con.execute(
            """SELECT finished_at,records_inserted,records_already_present,records_skipped
               FROM k14_sync_runs WHERE outcome='success' ORDER BY id DESC LIMIT 1"""
        ).fetchone()
        latest = con.execute(
            "SELECT outcome,finished_at,error_message,records_inserted FROM k14_sync_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        total = con.execute("SELECT COUNT(*) FROM punches").fetchone()[0]
        connector_total = con.execute("SELECT COUNT(DISTINCT punch_id) FROM k14_sync_events").fetchone()[0]
    error_text = ""
    error_at = None
    if latest and latest["outcome"] == "error":
        error_at = latest["finished_at"]
        if include_errors:
            error_text = safe_error(latest["error_message"])
        elif latest["error_message"]:
            error_text = "An administrator can review the synchronization error."
    result_label = "Not yet synchronized"
    if latest:
        if latest["outcome"] == "error":
            result_label = "Error"
        elif latest["records_inserted"] == 0:
            result_label = "Success — No new records"
        else:
            count = latest["records_inserted"]
            result_label = f"Success — {count} new record{'s' if count != 1 else ''}"
    availability = connector_availability()
    if not include_errors and not availability["connector_available"]:
        availability["connector_message"] = "An administrator can review the connector configuration."
    return {
        "enabled": enabled(),
        "interval_seconds": sync_interval(),
        "in_progress": _LOCK.locked(),
        **availability,
        "total_imported": total,
        "total_connector_imported": connector_total,
        "latest_outcome": None if latest is None else latest["outcome"],
        "latest_result": result_label,
        "latest_finished_at": None if latest is None else latest["finished_at"],
        "last_success_at": None if success is None else success["finished_at"],
        "last_inserted": None if success is None else success["records_inserted"],
        "last_already_present": None if success is None else success["records_already_present"],
        "last_skipped": None if success is None else success["records_skipped"],
        "last_error": error_text,
        "last_error_at": error_at,
    }


def autostart_allowed() -> bool:
    if not enabled():
        return False
    if "pytest" in sys.modules or os.getenv("PYTEST_CURRENT_TEST"):
        return False
    if os.getenv("QA_PORT") or os.getenv("NCSC_DISABLE_K14_AUTOSTART", "").lower() == "true":
        return False
    return True


def _loop() -> None:
    while not _STOP.is_set():
        try:
            run_sync(None)
        except (sqlite3.Error, OSError, ValueError, RuntimeError):
            # Even if the website database cannot save the error, retry next cycle.
            logging.getLogger(__name__).error("Connector import could not run; it will retry on the next cycle.")
        _STOP.wait(sync_interval())


def start_background_sync() -> None:
    global _THREAD
    if not autostart_allowed():
        return
    with _WORKER_LOCK:
        if _THREAD is not None and _THREAD.is_alive():
            return
        _STOP.clear()
        _THREAD = threading.Thread(target=_loop, name="k14-attendance-sync", daemon=True)
        _THREAD.start()


def stop_background_sync() -> None:
    with _WORKER_LOCK:
        _STOP.set()
        if _THREAD is not None:
            _THREAD.join(timeout=5)
