"""Use: python -m app.cli create-admin"""
from __future__ import annotations
import getpass
import re
import sys
from dotenv import load_dotenv
from app.db import connect, initialize
from app.security import hash_password


def main() -> None:
    load_dotenv()
    if sys.argv[1:] != ["create-admin"]:
        raise SystemExit("Usage: python -m app.cli create-admin")
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
