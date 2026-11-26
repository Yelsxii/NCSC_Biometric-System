"""Load a private, explicitly reviewed DTR reconciliation packet.

The packet lives beside the office's protected local DTR snapshot, not in Git.
No source rows, biometric punches or stored HR edits are modified.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from contextlib import closing
from pathlib import Path

from dotenv import load_dotenv
from app.manual_dtr import identity, local_source_path, parse_package, SLOT_KEYS


def reconciliation_path():
    try:
        folder = local_source_path().parent
    except ValueError:
        local = os.getenv("LOCALAPPDATA", "").strip()
        if not local:
            return None
        folder = Path(local).resolve() / "NCSC-K14-Pilot"
    return folder / "manual-dtr-reconciliation.json"


def _decode(raw):
    document = json.loads(raw.decode("utf-8-sig"))
    packet = parse_package(raw)
    if document.get("reconciliation_version") != 1:
        raise ValueError("Unsupported reconciliation version.")
    lookup = {g["key"]: g for g in packet["groups"]}
    output = {}
    for person in document["people"]:
        code = person["employee_code"]
        if not isinstance(code, str) or not code or len(code) > 64 or code in output:
            raise ValueError("Invalid or duplicate employee code.")
        group = lookup[person["key"]]
        decisions = person.get("decisions", {})
        entries = {}
        for row in group["rows"]:
            date = row["date"]
            plan = decisions.get(date, {})
            confirmed = plan.get("confirmed", {})
            ignored = plan.get("ignored", [])
            force_sheet = plan.get("force_sheet", [])
            require_bio = plan.get("require_bio", [])
            if (not set(confirmed).issubset(SLOT_KEYS) or
                not set(force_sheet).issubset(SLOT_KEYS) or
                not set(require_bio).issubset(SLOT_KEYS) or
                set(force_sheet) & (set(confirmed) | set(require_bio))):
                raise ValueError("Invalid reconciliation slot.")
            for event in [*confirmed.values(), *ignored]:
                if type(event.get("id")) is not int or event["id"] <= 0:
                    raise ValueError("Invalid scan ID.")
                dt.time.fromisoformat(event["time"])
            entries[date] = {"name": group["name"], "sheet": group["sheet"],
                             "row": row["source_row"], "data": row["data"],
                             "reconciliation": plan, "source_id": packet["id"]}
        if not set(decisions).issubset(entries):
            raise ValueError("Decision has no valid source row.")
        output[code] = (group["name"], entries)
    return output


def local_reconciliation(employee_code, display_name):
    path = reconciliation_path()
    if path is None or not path.is_file():
        return {}
    with path.open("rb") as file:
        raw = file.read(10 * 1024 * 1024 + 1)
    people = _decode(raw)
    if employee_code not in people:
        return {}
    name, entries = people[employee_code]
    if identity(name) != identity(display_name or ""):
        return {}
    return entries


def install(source):
    load_dotenv()
    from app.db import connect
    path = reconciliation_path()
    if path is None:
        raise ValueError("Configure the local DTR folder first.")
    raw = Path(source).read_bytes()
    people = _decode(raw)
    with closing(connect()) as con:
        for code, (name, entries) in people.items():
            row = con.execute("SELECT display_name FROM employees WHERE employee_code=?", (code,)).fetchone()
            if row is None or identity(row["display_name"]) != identity(name):
                raise ValueError("Employee identity mismatch; no file installed (code " + code + ").")
            for date, entry in entries.items():
                plan = entry["reconciliation"]
                for event in [*plan.get("confirmed", {}).values(), *plan.get("ignored", [])]:
                    punch = con.execute("SELECT employee_code,happened_at FROM punches WHERE id=?", (event["id"],)).fetchone()
                    if punch is None or punch["employee_code"] != code or punch["happened_at"] != date + " " + event["time"]:
                        raise ValueError("Scan evidence mismatch; no file installed (code " + code + ", " + date + ").")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() != raw:
        backup = path.with_name(path.name + "." + dt.datetime.now().strftime("%Y%m%d%H%M%S%f") + ".bak")
        backup.write_bytes(path.read_bytes())
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(raw)
    temporary.replace(path)
    return {"installed": True, "employees": len(people),
            "days": sum(len(entries) for _, entries in people.values()),
            "database_modified": False}


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "install":
        raise SystemExit("Usage: python -m app.dtr_reconciliation install PATH")
    try:
        print(json.dumps(install(sys.argv[2]), indent=2))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit("Reconciliation not installed: " + str(exc)) from exc
