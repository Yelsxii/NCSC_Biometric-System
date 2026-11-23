"""One local authorization registry shared by the website and read-only poller."""
from __future__ import annotations

import re
import sqlite3
from contextlib import closing
from pathlib import Path

LEGACY_ALLOWED_IDS = frozenset(str(x) for x in list(range(1, 13)) + [14, 18])
ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def authorized_ids(connection: sqlite3.Connection) -> frozenset[str]:
    values = connection.execute(
        "SELECT employee_code FROM k14_authorizations WHERE sync_authorized=1"
    ).fetchall()
    return frozenset(str(row[0]) for row in values if ID_PATTERN.fullmatch(str(row[0])))


def read_authorized_ids(path: Path) -> frozenset[str]:
    """Fail closed if the website registry is missing; never create that file."""
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError("Website registry not found. Start the updated website first.")
    try:
        with closing(sqlite3.connect(resolved.as_uri() + "?mode=ro", uri=True, timeout=30)) as con:
            con.execute("PRAGMA query_only=ON")
            return authorized_ids(con)
    except sqlite3.Error as exc:
        raise ValueError("Could not read approved employee IDs. Start the updated website and retry.") from exc
