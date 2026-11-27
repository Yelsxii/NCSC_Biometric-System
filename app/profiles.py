"""Verified employee metadata. A profile is not a website login or enrollment."""
from __future__ import annotations

import json
from contextlib import closing
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.db import connect
from app.device_access import ID_PATTERN
from app.registry import clean

EMPLOYMENT_TYPES = ("COS", "Permanent", "GIP", "OJT")


class ProfileFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_name: str = Field(min_length=1, max_length=70)
    middle_name: str = Field(default="", max_length=60)
    last_name: str = Field(min_length=1, max_length=70)
    suffix: str = Field(default="", max_length=20)
    employment_type: Literal["COS", "Permanent", "GIP", "OJT"]
    department: str = Field(min_length=1, max_length=140)
    position: str = Field(default="", max_length=140)
    sync_authorized: bool = True
    device_enrollment_confirmed: Literal[True]

    @field_validator("first_name", "middle_name", "last_name", "suffix", "department", "position", mode="before")
    @classmethod
    def normalized_text(cls, value):
        return " ".join(clean(value, 140, "Employee profile").split()) if isinstance(value, str) else value

    @property
    def display_name(self) -> str:
        return " ".join(x for x in (self.first_name, self.middle_name, self.last_name, self.suffix) if x)

    @model_validator(mode="after")
    def name_length(self):
        if len(self.display_name) > 140:
            raise ValueError("The complete name must be at most 140 characters.")
        return self


class RegistrationInput(ProfileFields):
    employee_code: str = Field(min_length=1, max_length=64)

    @field_validator("employee_code", mode="before")
    @classmethod
    def exact_device_id(cls, value):
        if not isinstance(value, str) or not ID_PATTERN.fullmatch(value.strip()):
            raise ValueError("Enter the existing K14 ID exactly, including any leading zeroes.")
        return value.strip()


class ProfileUpdateInput(ProfileFields):
    version: int = Field(ge=1)


PROFILE_SELECT = """
SELECT e.employee_code,e.display_name,e.department,e.name_source,
       p.first_name,p.middle_name,p.last_name,p.suffix,p.employment_type,p.position,
       p.version,p.registered_at,p.updated_at,
       COALESCE(a.sync_authorized,0) AS sync_authorized
FROM employees e LEFT JOIN employee_profiles p ON p.employee_code=e.employee_code
LEFT JOIN k14_authorizations a ON a.employee_code=e.employee_code
"""


def suggest_name_parts(name: str) -> dict:
    """Suggest editable fields; never overwrite the stored device display name."""
    parts = [" ".join(p.split()) for p in (name or "").split(",")]
    if 2 <= len(parts) <= 4 and parts[0] and parts[1]:
        padded = parts + [""] * (4 - len(parts))
        return dict(last_name=padded[0], first_name=padded[1], middle_name=padded[2],
                    suffix=padded[3], needs_review=False)
    words = " ".join((name or "").split()).split()
    suffix = ""
    if len(words) > 2 and words[-1].rstrip(".").upper() in {"JR", "SR", "II", "III", "IV", "V"}:
        suffix = words.pop()
    last = words.pop() if len(words) > 1 else ""
    middle = ""
    if len(words) > 1 and len(words[-1].rstrip(".")) == 1:
        middle = words.pop()
    return dict(first_name=" ".join(words), middle_name=middle, last_name=last,
                suffix=suffix, needs_review=True)


def get_profile(code: str) -> dict:
    with closing(connect()) as con:
        row = con.execute(PROFILE_SELECT + " WHERE e.employee_code=?", (code,)).fetchone()
        parts = con.execute(
            "SELECT display_name,first_name,last_name FROM discovered_name_parts WHERE employee_code=?",
            (code,)).fetchone() if row is not None and row["version"] is None else None
    if row is None:
        raise HTTPException(404, "Employee record not found.")
    result = dict(row)
    result["profile_complete"] = row["version"] is not None
    result["sync_authorized"] = bool(result["sync_authorized"])
    if not result["profile_complete"]:
        suggested = suggest_name_parts(result["display_name"])
        # Keep explicit vendor first/last columns intact, including compound
        # surnames. Comma-delimited full names take precedence. Unclear middle
        # names and suffixes remain editable rather than silently inferred.
        if (parts and parts["display_name"] == result["display_name"]
                and parts["first_name"] and parts["last_name"]
                and "," not in result["display_name"]):
            first, last = parts["first_name"].split(), parts["last_name"].split()
            suffix = last.pop() if len(last) > 1 and last[-1].rstrip(".").upper() in {"JR", "SR", "II", "III", "IV", "V"} else ""
            middle = first.pop() if len(first) > 1 and len(first[-1].rstrip(".")) == 1 else ""
            suggested = dict(first_name=" ".join(first), middle_name=middle, last_name=" ".join(last),
                             suffix=suffix, needs_review=True)
        result["suggested_name"] = suggested
    return result


def list_profiles(q: str, category: str, status: str, page: int, limit: int, archived: bool = False) -> dict:
    if len(q) > 80 or any(ord(x) < 32 for x in q):
        raise HTTPException(400, "Invalid employee search.")
    if category not in ("All", *EMPLOYMENT_TYPES) or status not in ("All", "Registered", "Needs details"):
        raise HTTPException(400, "Choose a valid employee filter.")
    if page < 1 or page > 100000 or not 1 <= limit <= 50:
        raise HTTPException(400, "Invalid employee page.")
    with closing(connect()) as con:
        archive_filter = "EXISTS" if archived else "NOT EXISTS"
        scope = f"{archive_filter} (SELECT 1 FROM employee_directory_archive ar WHERE ar.employee_code=e.employee_code)"
        total = con.execute("SELECT COUNT(*) FROM employees e WHERE " + scope).fetchone()[0]
        complete = con.execute("SELECT COUNT(*) FROM employee_profiles e WHERE " + scope).fetchone()[0]
        category_counts = {kind: 0 for kind in EMPLOYMENT_TYPES}
        category_counts.update(dict(con.execute("SELECT employment_type,COUNT(*) FROM employee_profiles e WHERE " + scope + " GROUP BY employment_type")))
        args = (q, q, q, q, category, category, status, status, status)
        filtered = PROFILE_SELECT + " WHERE " + scope + """
          AND (?='' OR instr(lower(e.employee_code),lower(?))>0
               OR instr(lower(e.display_name),lower(?))>0 OR instr(lower(e.department),lower(?))>0)
          AND (?='All' OR p.employment_type=?)
          AND (?='All' OR (?='Registered' AND p.employee_code IS NOT NULL)
                        OR (?='Needs details' AND p.employee_code IS NULL))
        """
        matches = con.execute("SELECT COUNT(*) FROM (" + filtered + ")", args).fetchone()[0]
        rows = con.execute(filtered + " ORDER BY CASE WHEN e.display_name='' THEN 1 ELSE 0 END,lower(e.display_name),e.employee_code LIMIT ? OFFSET ?",
                           (*args, limit, (page - 1) * limit)).fetchall()
    items = [{**dict(row), "profile_complete": row["version"] is not None,
              "sync_authorized": bool(row["sync_authorized"])} for row in rows]
    return {"items": items, "total": matches, "page": page, "limit": limit,
            "summary": {"total": total, "registered": complete, "needs_details": total - complete,
                        "categories": category_counts}}


def save_profile(code: str, payload: ProfileFields, actor: int, creating: bool) -> dict:
    if not ID_PATTERN.fullmatch(code):
        raise HTTPException(400, "Invalid K14 ID.")
    with closing(connect()) as con, con:
        con.execute("BEGIN IMMEDIATE")
        previous = con.execute(PROFILE_SELECT + " WHERE e.employee_code=?", (code,)).fetchone()
        exists = previous is not None and previous["version"] is not None
        if creating and exists:
            raise HTTPException(409, "This K14 ID already has a profile. Open Edit profile instead.")
        if not creating and not exists:
            raise HTTPException(404, "Registered employee profile not found.")
        if not creating and previous["version"] != payload.version:
            raise HTTPException(409, "This profile changed in another session. Reopen it before saving.")
        con.execute(
            "INSERT INTO employees(employee_code,display_name,department,name_source) VALUES(?,?,?,'profile') "
            "ON CONFLICT(employee_code) DO UPDATE SET display_name=excluded.display_name,department=excluded.department,"
            "name_source='profile',updated_at=CURRENT_TIMESTAMP",
            (code, payload.display_name, payload.department),
        )
        values = (payload.first_name, payload.middle_name, payload.last_name, payload.suffix,
                  payload.employment_type, payload.position)
        if creating:
            con.execute(
                "INSERT INTO employee_profiles(employee_code,first_name,middle_name,last_name,suffix,employment_type,position,registered_by) "
                "VALUES(?,?,?,?,?,?,?,?)", (code, *values, actor),
            )
        else:
            con.execute(
                "UPDATE employee_profiles SET first_name=?,middle_name=?,last_name=?,suffix=?,employment_type=?,position=?,"
                "version=version+1,updated_at=CURRENT_TIMESTAMP WHERE employee_code=?", (*values, code),
            )
        con.execute(
            "INSERT INTO k14_authorizations(employee_code,sync_authorized,updated_by) VALUES(?,?,?) "
            "ON CONFLICT(employee_code) DO UPDATE SET sync_authorized=excluded.sync_authorized,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP",
            (code, int(payload.sync_authorized), actor),
        )
        details = {"employee_code": code, "before": None if previous is None else dict(previous),
                   "after": {**payload.model_dump(exclude={"device_enrollment_confirmed"}), "display_name": payload.display_name}}
        con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
                    (actor, "registered" if creating else "updated", "employee_profile", json.dumps(details, ensure_ascii=False)))
    return get_profile(code)



def set_directory_archived(code: str, archived: bool, actor: int) -> dict:
    """Hide or restore a directory entry without deleting employee or attendance data."""
    if not ID_PATTERN.fullmatch(code):
        raise HTTPException(400, "Invalid K14 ID.")
    with closing(connect()) as con, con:
        con.execute("BEGIN IMMEDIATE")
        if not con.execute("SELECT 1 FROM employees WHERE employee_code=?", (code,)).fetchone():
            raise HTTPException(404, "Employee record not found.")
        if archived:
            changed = con.execute("INSERT OR IGNORE INTO employee_directory_archive(employee_code,archived_by) VALUES(?,?)", (code,actor)).rowcount
        else:
            changed = con.execute("DELETE FROM employee_directory_archive WHERE employee_code=?", (code,)).rowcount
        if changed:
            con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
                        (actor,"archived" if archived else "restored","employee_directory",json.dumps({"employee_code":code})))
    return {"ok": True, "archived": archived}
