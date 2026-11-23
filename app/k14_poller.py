"""Foreground read-only K14 collector, using the website's approved ID registry.

Based on the existing working pilot. No enrollment, clock change, deletion,
user-profile retrieval, or template retrieval operations are performed.
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
                    print(f"[{stamp}] Connection OK; {total} device logs; {len(rows)} approved records; added {added} new records.", flush=True)
            except Exception:
                print(f"[{stamp}] Collection failed. Check device connectivity, registry access and local storage. Retrying next cycle.", flush=True)
                if not args.loop:
                    return 1
            if not args.loop:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("Polling stopped. Original device records are unchanged.", flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
