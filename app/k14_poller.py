"""Foreground read-only K14 collector, using the website's approved ID registry.

Based on the existing working pilot. No enrollment, clock change, deletion,
fingerprint/template retrieval operations are performed. The optional name reader
reads only user IDs and visible display names for approved staff.
"""
from __future__ import annotations

import argparse
import ipaddress
import sqlite3
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path

from app.device_access import read_authorized_ids


def read_attendance(host: str, port: int, use_udp: bool, allowed: frozenset[str]):
    from zk import ZK  # The existing connector environment supplies pyzk.
    zk = ZK(host, port=port, timeout=20, password=0, force_udp=use_udp, ommit_ping=False)
    conn = None
    try:
        conn = zk.connect()
        logs = conn.get_attendance() or []
        selected = []
        for log in logs:
            code = str(log.user_id).strip()
            if code in allowed:
                selected.append((code, log.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                                 str(getattr(log, "status", "")), str(getattr(log, "punch", ""))))
        return len(logs), selected
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:
                pass


def read_device_names(host: str, port: int, use_udp: bool,
                      allowed: frozenset[str]) -> list[tuple[str, str]]:
    """Read K14 user ID and display name only; do not retain cards, passwords or templates.

    An office-authorized read is filtered to the approved staff IDs before
    names leave the collector process. The device is never modified.
    """
    from zk import ZK

    device = ZK(host, port=port, timeout=20, password=0,
                force_udp=use_udp, ommit_ping=False)
    conn = None
    try:
        conn = device.connect()
        users = conn.get_users() or []
        # The separate pyzk environment need not have website Excel dependencies.
        names: dict[str, str] = {}
        conflicts: set[str] = set()
        for user in users:
            code = str(getattr(user, "user_id", "")).strip()
            if code not in allowed:
                continue
            raw_name = getattr(user, "name", None)
            if not isinstance(raw_name, str):
                continue
            name = raw_name.strip()
            if not name or len(name) > 140 or any(ord(c) < 32 for c in name):
                continue
            if code in names and names[code] != name:
                conflicts.add(code)
            names[code] = name
        return [(code, name) for code, name in names.items() if code not in conflicts]
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:
                pass


def save_device_names(path: Path, host: str, rows: list[tuple[str, str]]) -> int:
    """Additive connector metadata; never changes device attendance rows."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=30)) as con, con:
        con.execute("""CREATE TABLE IF NOT EXISTS device_user_names (
            device_ip TEXT NOT NULL,
            employee_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            received_at_utc TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(device_ip, employee_id)
        )""")
        changed = 0
        for code, name in rows:
            old = con.execute("SELECT display_name FROM device_user_names "
                              "WHERE device_ip=? AND employee_id=?", (host, code)).fetchone()
            if old and old[0] == name:
                continue
            con.execute("""INSERT INTO device_user_names(device_ip,employee_id,display_name)
                VALUES(?,?,?) ON CONFLICT(device_ip,employee_id) DO UPDATE SET
                display_name=excluded.display_name,received_at_utc=CURRENT_TIMESTAMP""",
                (host, code, name))
            changed += 1
        return changed


def save_new(path: Path, host: str, records: list) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=30)) as con, con:
        con.execute("""CREATE TABLE IF NOT EXISTS attendance_raw (
            device_ip TEXT NOT NULL, employee_id TEXT NOT NULL,
            punch_time_local TEXT NOT NULL, device_status TEXT NOT NULL,
            device_punch_type TEXT NOT NULL,
            received_at_utc TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(device_ip,employee_id,punch_time_local,device_status,device_punch_type)
        )""")
        before = con.total_changes
        con.executemany("""INSERT OR IGNORE INTO attendance_raw
            (device_ip,employee_id,punch_time_local,device_status,device_punch_type)
            VALUES(?,?,?,?,?)""", [(host, *row) for row in records])
        return con.total_changes - before


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="K14 attendance collector using administrator-approved employee IDs")
    parser.add_argument("--host", default="192.168.254.201")
    parser.add_argument("--port", type=int, default=4370)
    parser.add_argument("--udp", action="store_true")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--registry-db", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        address = ipaddress.ip_address(args.host)
        if address.version != 4 or not address.is_private or address.is_loopback or address.is_link_local:
            raise ValueError()
    except ValueError:
        parser.error("--host must be a private non-loopback IPv4 address")
    if not 1 <= args.port <= 65535 or not 60 <= args.interval <= 86400:
        parser.error("Use a valid port and an interval from 60 to 86400 seconds")
    path = args.db.expanduser().resolve()
    registry = args.registry_db.expanduser().resolve()
    if path == registry or (path.exists() and registry.exists() and path.samefile(registry)):
        parser.error("Keep connector storage separate from the website registry")
    if any(value in str(path).lower() for value in ("onedrive", "dropbox", "google drive", "icloud")):
        parser.error("Use protected local attendance storage outside personal cloud-sync folders")
    if path.suffix.lower() not in (".db", ".sqlite3"):
        parser.error("--db must have a .db or .sqlite3 extension")
    print("K14 read-only collector; employee IDs are approved through the website. Ctrl+C stops collection.", flush=True)
    cycle = 0
    try:
        while True:
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            try:
                allowed = read_authorized_ids(registry)
                if not allowed:
                    print(f"[{stamp}] Collection paused: no employee IDs are authorized.", flush=True)
                else:
                    total, rows = read_attendance(args.host, args.port, args.udp, allowed)
                    # Recheck before storing: a revoked ID must not gain new
                    # records from an already-running device request.
                    current = read_authorized_ids(registry)
                    rows = [row for row in rows if row[0] in current]
                    added = save_new(path, args.host, rows)
                    # Refresh approved employee names on startup and every 2 polling cycles.
                    # A name-reader failure never blocks attendance collection.
                    if cycle % 2 == 0:
                        try:
                            names = read_device_names(args.host, args.port, args.udp, current)
                            current_again = read_authorized_ids(registry)
                            names = [(code, name) for code, name in names if code in current_again]
                            changed = save_device_names(path, args.host, names)
                            print(f"[{stamp}] K14 name sync: {len(names)} approved names read; "
                                  f"{changed} new or changed; {len(current_again) - len(names)} approved IDs without a usable name.", flush=True)
                        except Exception as exc:
                            print(f"[{stamp}] Device name sync unavailable ({type(exc).__name__}); attendance preserved.", flush=True)
                    print(f"[{stamp}] Connection OK; {total} device logs; {len(rows)} approved records; added {added} new records.", flush=True)
            except Exception:
                print(f"[{stamp}] Collection failed. Check device connectivity, registry access and local storage. Retrying next cycle.", flush=True)
                if not args.loop:
                    return 1
            if not args.loop:
                return 0
            cycle += 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("Polling stopped. Original device records are unchanged.", flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
