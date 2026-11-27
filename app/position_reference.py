"""Local-only position reference import; never overwrite a saved position."""
import json
import re
from collections import Counter
from contextlib import closing
from datetime import datetime
from pathlib import Path
import sqlite3
import unicodedata
from app.db import connect, database_path

def name_key(value):
    # Full-name equality only. No surname matching or fuzzy identity guessing.
    value = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    value = re.sub(r"^(?:atty|engr|dr)\.?\s+", "", value)
    value = value.replace(".", "")
    return " ".join(value.split())

def import_positions(path, apply=False):
    raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(raw, list):
        raise ValueError("Expected a list of name/position records.")
    reference = {}
    for item in raw:
        key = name_key(item["name"])
        position = str(item["position"]).strip()
        if not key or not position or len(position)>140 or any(ord(c)<32 for c in position):
            raise ValueError("Invalid reference name or position.")
        if key in reference:
            raise ValueError("Duplicate reference name; resolve before importing.")
        reference[key] = position
    with closing(connect()) as con:
        rows = con.execute("""SELECT e.employee_code,e.display_name,p.position,p.version
            FROM employees e LEFT JOIN employee_profiles p ON p.employee_code=e.employee_code
            WHERE NOT EXISTS (SELECT 1 FROM employee_directory_archive a WHERE a.employee_code=e.employee_code)""").fetchall()
        keys = Counter(name_key(row["display_name"]) for row in rows)
        matches = []
        matched = set()
        for row in rows:
            key = name_key(row["display_name"])
            if key not in reference:
                continue
            matched.add(key)
            if keys[key]!=1:
                print("Skipped ambiguous name:", row["display_name"])
            elif row["version"] is None:
                print("Complete employee profile first:", row["display_name"])
            elif str(row["position"] or "").strip():
                print("Retained existing position:", row["display_name"], "-", row["position"])
            else:
                matches.append((row["employee_code"], row["version"], reference[key]))
                print("Fill:", row["display_name"], "-", reference[key])
        for key in sorted(reference.keys()-matched):
            print("No exact active name match:", key)
        if not apply:
            print(f"Preview only: {len(matches)} blank positions eligible. Add --apply to save.")
            return
        if not matches:
            print("No positions to update.")
            return
        folder = database_path().parent / "backups"
        folder.mkdir(parents=True, exist_ok=True)
        backup = folder / ("before-position-import-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".sqlite3")
        with closing(sqlite3.connect(backup)) as dest:
            con.backup(dest)
        with con:
            con.execute("BEGIN IMMEDIATE")
            updated = 0
            for code, version, position in matches:
                updated += con.execute("""UPDATE employee_profiles SET position=?, version=version+1,
                    updated_at=CURRENT_TIMESTAMP WHERE employee_code=? AND version=?
                    AND trim(coalesce(position,''))='' AND NOT EXISTS
                    (SELECT 1 FROM employee_directory_archive a WHERE a.employee_code=employee_profiles.employee_code)""",
                    (position, code, version)).rowcount
        print(f"Saved {updated} positions. Backup: {backup}")
