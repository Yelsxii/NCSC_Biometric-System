"""Local, preview-first classification of existing employee records.

The office roster is supplied separately, never committed to the public repository.
No employee IDs, attendance, biometric authorizations or login accounts are created.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
import unicodedata
from contextlib import closing
from pathlib import Path

from dotenv import load_dotenv
from app.db import connect, initialize
from app.profiles import EMPLOYMENT_TYPES

DEPARTMENTS = {
    "OPS": "Operations Division (OPS)",
    "AFS": "Administrative and Finance Section (AFS)",
    "ORD": "Office of the Regional Director (ORD)",
}


def words(value):
    text = unicodedata.normalize("NFKD", value.casefold())
    return re.findall(r"[a-z0-9]+", "".join(c for c in text if not unicodedata.combining(c)))


def name_key(value):
    tokens = words(value)
    while tokens and tokens[0] in {"dr", "engr", "atty"}:
        tokens.pop(0)
    while tokens and tokens[-1] in {"phd", "rn", "rpm", "lpt"}:
        tokens.pop()
    return tuple(tokens)


def department_key(value):
    key = " ".join(words(value))
    for code, label in DEPARTMENTS.items():
        if key in (code.lower(), " ".join(words(label)), " ".join(words(label.rsplit(" (", 1)[0]))):
            return code
    return None


def matches_name(display_name, entry):
    local = name_key(display_name)
    alternatives = [entry["name"], *entry.get("aliases", "").split("|")]
    if local and any(local == name_key(x) for x in alternatives if x.strip()):
        return True
    # Match full given name and full surname, and a compatible middle initial.
    # Never match by surname alone or use fuzzy spelling similarity.
    first, last, middle = (name_key(entry.get(k, "")) for k in ("first_name", "last_name", "middle_name"))
    if not first or not last or not middle or len(local) <= len(first) + len(last):
        return False
    if local[:len(first)] != first or local[-len(last):] != last:
        return False
    actual = local[len(first):-len(last)]
    return len(middle) == 1 and len(actual) == 1 and (
        actual == middle or ((len(actual[0]) == 1 or len(middle[0]) == 1) and actual[0][0] == middle[0][0])
    )


def read_rows(path):
    with open(path, encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"name", "first_name", "middle_name", "last_name", "department", "category"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Roster is missing required CSV headers.")
        rows = [{k: (v or "").strip() for k, v in row.items() if k} for row in reader]
    if not rows or len(rows) > 1000:
        raise ValueError("Roster must have 1 to 1000 rows.")
    seen = set()
    for row in rows:
        key = name_key(row["name"])
        if not key or key in seen or any(len(v) > 500 for v in row.values()):
            raise ValueError("Invalid or duplicated roster name.")
        seen.add(key)
        if row["department"] not in DEPARTMENTS:
            raise ValueError("Use OPS, AFS or ORD as department.")
        if row["category"] not in ("", *EMPLOYMENT_TYPES):
            raise ValueError("Unknown employment category.")
        if row["category"] and (not row["first_name"] or not row["last_name"]):
            raise ValueError("Confirmed categories require given and family names.")
    return rows


def classify(path, apply=False, admin=None):
    rows = read_rows(path)
    with closing(connect()) as con, con:
        if apply:
            con.execute("BEGIN IMMEDIATE")
        staff = [dict(r) for r in con.execute(
            "SELECT e.employee_code,e.display_name,e.department,p.employment_type,p.version "
            "FROM employees e LEFT JOIN employee_profiles p ON p.employee_code=e.employee_code"
        )]
        planned = []
        result = {"mode": "apply" if apply else "preview", "updated": [], "unchanged": [], "review": []}
        for entry in rows:
            candidates = [r for r in staff if matches_name(r["display_name"], entry)]
            if len(candidates) != 1:
                result["review"].append({"name": entry["name"], "reason": "no unique local full-name match", "matches": len(candidates)})
                continue
            planned.append((entry, candidates[0]))
        counts = {}
        for _, row in planned:
            counts[row["employee_code"]] = counts.get(row["employee_code"], 0) + 1
        actor = None
        if apply:
            admins = con.execute("SELECT id,username FROM users WHERE role='admin' AND (? IS NULL OR username=?)", (admin, admin)).fetchall()
            if len(admins) != 1:
                raise ValueError("Specify the authorized local administrator with --admin USERNAME.")
            actor = admins[0]["id"]
        for entry, row in planned:
            code = row["employee_code"]
            dept = DEPARTMENTS[entry["department"]]
            category = entry["category"]
            item = {"name": row["display_name"], "employee_code": code, "department": dept,
                    "category": category or row["employment_type"] or "Needs HR verification"}
            if counts[code] != 1:
                result["review"].append({**item, "reason": "multiple roster rows matched this employee"})
                continue
            if row["department"] and department_key(row["department"]) != entry["department"]:
                result["review"].append({**item, "reason": "existing department differs; verify before changing"})
                continue
            if category and row["employment_type"] and row["employment_type"] != category:
                result["review"].append({**item, "reason": "existing category differs; verify before changing"})
                continue
            new_profile = bool(category and row["version"] is None)
            changed = row["department"] != dept or new_profile
            if not changed:
                result["unchanged"].append(item)
                continue
            if apply:
                con.execute("UPDATE employees SET department=?,updated_at=CURRENT_TIMESTAMP WHERE employee_code=?", (dept, code))
                if new_profile:
                    con.execute(
                        "INSERT INTO employee_profiles(employee_code,first_name,middle_name,last_name,employment_type,registered_by) "
                        "VALUES(?,?,?,?,?,?)", (code, entry["first_name"], entry["middle_name"], entry["last_name"], category, actor))
                elif row["version"] is not None:
                    con.execute("UPDATE employee_profiles SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE employee_code=?", (code,))
                con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                            (actor, "classified", "employee_profile", 0, json.dumps({
                                "employee_code": code, "before_department": row["department"],
                                "before_category": row["employment_type"], "department": dept, "category": category or row["employment_type"]
                            }, ensure_ascii=False)))
            result["updated"].append(item)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roster", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--admin", help="Local authorized administrator username (if multiple)")
    args = parser.parse_args()
    load_dotenv()
    initialize()
    try:
        print(json.dumps(classify(args.roster, args.apply, args.admin), indent=2, ensure_ascii=False))
    except (ValueError, OSError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
