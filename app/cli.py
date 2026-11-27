"""Use: python -m app.cli create-admin"""
from __future__ import annotations
import getpass
import json
import re
import os
import subprocess
import sys
from pathlib import Path
from dotenv import load_dotenv
from app.db import connect, initialize
from app.security import hash_password


def sync_k14() -> None:
    from app.k14_sync import run_sync
    result = run_sync(None, manual=True)
    print(
        "Outcome: {outcome}; read {records_read}; new {records_inserted}; "
        "already present {records_already_present}; skipped {records_skipped}".format(**result)
    )
    if result["outcome"] == "success":
        print(f"Device names updated: {result.get('names_updated', 0)}")
    if result["outcome"] != "success":
        print(result["error_message"] or "Connector sync failed.")
        raise SystemExit(1)


def main() -> None:
    load_dotenv()
    command = sys.argv[1:]
    if len(command)==2 and command[0]=="inspect-bionet":
        import sqlite3
        from app.bionet_roster import inspect_schema
        try:
            print(json.dumps(inspect_schema(command[1]), indent=2))
        except (OSError,ValueError,sqlite3.Error):
            raise SystemExit("Could not read SQLite schema. Verify the source path and authorized access; no data was changed.")
        return
    if command == ["inspect-bionet-attendance"]:
        import sqlite3
        from app.bionet_roster import attendance_source_diagnostics
        initialize()
        try:
            print(json.dumps(attendance_source_diagnostics(), indent=2))
        except (OSError,ValueError,sqlite3.Error):
            raise SystemExit("Could not compare ZKBio attendance fields. Verify source path and schema.")
        return
    if command == ["inspect-bionet-workcodes"]:
        import sqlite3
        from app.bionet_roster import workcode_diagnostics
        initialize()
        try:
            print(json.dumps(workcode_diagnostics(), indent=2))
        except (OSError,ValueError,sqlite3.Error):
            raise SystemExit("Could not inspect ZKBio work-code counts. Check the database configuration.")
        return
    if command == ["sync-bionet"]:
        import sqlite3
        from app.bionet_roster import sync_roster
        initialize()
        try:
            print(json.dumps(sync_roster(), indent=2))
        except (OSError,ValueError,sqlite3.Error):
            raise SystemExit("ZKBio roster sync failed; check the configured source and column names.")
        return
    if command == ["poll-k14"]:
        from app.k14_sync import connector_path, sync_interval
        from app.db import database_path
        from app.lan import settings
        initialize()
        configured = os.getenv("K14_POLLER_PYTHON", "").strip()
        default = Path(os.getenv("USERPROFILE", str(Path.home()))) / "OneDrive/Desktop/.venv/Scripts/python.exe"
        python = Path(os.path.expandvars(configured)).expanduser() if configured else default
        if not python.is_file():
            raise SystemExit("Set K14_POLLER_PYTHON to the existing Python executable with pyzk installed.")
        cfg = settings()
        args = [str(python), "-m", "app.k14_poller", "--host", cfg.host, "--port", str(cfg.port),
                "--loop", "--interval", str(sync_interval()), "--db", str(connector_path().resolve()),
                "--registry-db", str(database_path().resolve())]
        if os.getenv("K14_USE_UDP", "false").lower() == "true":
            args.append("--udp")
        try:
            result = subprocess.call(args, cwd=Path(__file__).resolve().parents[1])
        except KeyboardInterrupt:
            return
        raise SystemExit(result)
    if command == ["sync-k14"]:
        sync_k14()
        return
    if command == ["k14-status"]:
        from app.k14_sync import safe_error, status_view
        from app.lan import status
        try:
            info = status()
        except ValueError as exc:
            raise SystemExit(safe_error(str(exc))) from exc
        info["attendance_sync"] = status_view(include_errors=True)
        info["sync_enabled"] = info["attendance_sync"]["enabled"]
        print(json.dumps(info, indent=2, ensure_ascii=False))
        return
    if command and command[0]=="import-positions":
        if len(command) not in (2,3) or (len(command)==3 and command[2]!="--apply"):
            raise SystemExit("Usage: python -m app.cli import-positions <reference.json> [--apply]")
        from app.position_reference import import_positions
        try:
            import_positions(command[1], apply=len(command)==3)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise SystemExit(f"Position import failed: {exc}") from exc
        return
    if command in (["create-employee-account"], ["disable-employee-account"]):
        initialize()
        code = input("Employee biometric ID: ").strip()
        with connect() as con:
            if command == ["disable-employee-account"]:
                changed = con.execute("UPDATE employee_portal_accounts SET enabled=0 WHERE employee_code=?", (code,)).rowcount
                print("Employee account disabled." if changed else "No employee account found.")
                return
            employee = con.execute("""SELECT e.display_name,e.department,p.position,
                p.employee_code AS profile_code,
                EXISTS(SELECT 1 FROM employee_directory_archive a WHERE a.employee_code=e.employee_code) AS archived
                FROM employees e LEFT JOIN employee_profiles p ON p.employee_code=e.employee_code
                WHERE e.employee_code=?""", (code,)).fetchone()
            if not employee:
                print("Biometric ID not found in this database:", code)
                print("Available active biometric IDs (not directory row numbers):")
                for row in con.execute("""SELECT e.employee_code,e.display_name FROM employees e
                    WHERE NOT EXISTS (SELECT 1 FROM employee_directory_archive a WHERE a.employee_code=e.employee_code)
                    ORDER BY e.employee_code"""):
                    print(f"  {row['employee_code']} - {row['display_name'] or '(No name)'}")
                raise SystemExit("Use the exact biometric ID shown above.")
            print("Matched employee:", employee["display_name"] or "(No name)")
            if employee["archived"]:
                raise SystemExit("This employee is archived. Restore the profile only if authorized.")
            missing = [label for key,label in (("display_name","Name"),("department","Department"),("position","Position"))
                       if not str(employee[key] or "").strip()]
            if missing:
                if employee["profile_code"] is None:
                    print("No saved employee profile exists for this biometric ID.")
                raise SystemExit("Missing saved information: " + ", ".join(missing) +
                    ". Complete and save the profile in Employees, then retry.")
            print("Employee:", employee["display_name"])
            username = input("Employee portal username: ").strip().lower()
            if not re.fullmatch(r"[a-z0-9._-]{3,40}", username):
                raise SystemExit("Username must be 3–40 lowercase letters, digits or ._-")
            password = getpass.getpass("Employee password (12+ characters): ")
            if password != getpass.getpass("Confirm password: "):
                raise SystemExit("Passwords did not match.")
            try:
                con.execute("""INSERT INTO employee_portal_accounts(employee_code,username,password_hash)
                    VALUES(?,?,?) ON CONFLICT(employee_code) DO UPDATE SET
                    username=excluded.username,password_hash=excluded.password_hash,enabled=1""",
                    (code,username,hash_password(password)))
            except Exception as exc:
                raise SystemExit(f"Could not create employee account: {exc}") from exc
        print("Employee portal account ready. Provide credentials privately.")
        return
    if command != ["create-admin"]:
        raise SystemExit("Usage: python -m app.cli create-admin | create-employee-account | disable-employee-account | import-positions <reference.json> [--apply] | sync-k14 | k14-status | poll-k14 | inspect-bionet <path> | sync-bionet | inspect-bionet-workcodes | inspect-bionet-attendance")
    initialize()
    username = input("Admin username: ").strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,40}", username):
        raise SystemExit("Username must be 3–40 lowercase letters, digits or ._-")
    password = getpass.getpass("New password (12+ characters): ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise SystemExit("Passwords did not match.")
    with connect() as con:
        try:
            con.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')", (username, hash_password(password)))
        except Exception as exc:
            raise SystemExit(f"Could not create administrator: {exc}") from exc
    print("Admin account created. Keep credentials private.")


if __name__ == "__main__":
    main()
