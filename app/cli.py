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
    if result["outcome"] != "success":
        print(result["error_message"] or "Connector sync failed.")
        raise SystemExit(1)


def main() -> None:
    load_dotenv()
    command = sys.argv[1:]
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
    if command != ["create-admin"]:
        raise SystemExit("Usage: python -m app.cli create-admin | sync-k14 | k14-status | poll-k14")
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
