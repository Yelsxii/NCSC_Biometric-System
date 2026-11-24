"""NCSC Biometric Attendance System — local-only FastAPI application.

Attendance scans stay on this machine. Connector sync reads a local SQLite
file and does not open the K14.
"""
from __future__ import annotations

import datetime as dt
import calendar
import json
import os
import re
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator
from starlette.middleware.sessions import SessionMiddleware

from app.db import connect, initialize, register_scan_metadata
from app.parser import MAX_BYTES, digest, parse_attlog
from app.ingestion import insert_punches
from app.k14_sync import run_sync, safe_error, start_background_sync, status_view, stop_background_sync
from app.security import check_password
from app.reports import preview_k14_report
from app.registry import parse_staff, clean
from app.lan import status as lan_status, tcp_probe
from app.profiles import RegistrationInput, ProfileUpdateInput, get_profile, list_profiles, save_profile
from app.attendance import DayReviewInput, CalendarInput, decorate_days, save_day_review, save_calendar
from app.activity_mapping import activity_pairs, dtr_aja_periods
from app.dtr_sources import present_day
from app.bionet_roster import reconcile_workcodes
from app.manual_dtr import (MAX_MANUAL_BYTES, parse_package, preview_package, import_package,
                            mapping_hash, automatic_status, start_local_source_sync, stop_local_source_sync)

load_dotenv()
secret = os.environ.get("SECRET_KEY", "")
if len(secret) < 32 or secret == "CHANGE_ME_TO_A_LONG_RANDOM_VALUE":
    raise RuntimeError("Set a random SECRET_KEY (at least 32 characters) in your .env file.")

app = FastAPI(title="NCSC Biometric System", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    SessionMiddleware, secret_key=secret, session_cookie="ncsc_session",
    same_site="strict", https_only=os.getenv("COOKIE_HTTPS_ONLY", "false").lower() == "true",
    max_age=8 * 60 * 60,
)
ROOT = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
CODE_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


@app.on_event("startup")
def on_startup() -> None:
    initialize()
    start_background_sync()
    start_local_source_sync()


@app.on_event("shutdown")
def on_shutdown() -> None:
    stop_background_sync()
    stop_local_source_sync()


@app.middleware("http")
async def no_cache_sensitive(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


def current_user(request: Request) -> dict:
    uid = request.session.get("uid")
    if not isinstance(uid, int):
        raise HTTPException(401, "Sign in required.")
    with closing(connect()) as con:
        row = con.execute("SELECT id,username,role FROM users WHERE id=?", (uid,)).fetchone()
        if row is None:
            request.session.clear()
            raise HTTPException(401, "Session expired.")
        return dict(row)


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator access required.")
    return user


def require_csrf(request: Request) -> None:
    expected = request.session.get("csrf")
    received = request.headers.get("x-csrf-token")
    if not expected or not received or not secrets.compare_digest(expected, received):
        raise HTTPException(403, "Invalid session token. Refresh and try again.")


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=256)


class ActivityInput(BaseModel):
    employee_code: str = Field(min_length=1, max_length=64)
    category: Literal["AJA", "Fieldwork", "Official Business", "Travel Order"]
    reference: str = Field(default="", max_length=140)
    purpose: str = Field(default="", max_length=600)
    start_at: dt.datetime
    end_at: dt.datetime

    @field_validator("employee_code", "reference", "purpose", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("employee_code")
    @classmethod
    def valid_code(cls, value: str) -> str:
        if not CODE_RE.fullmatch(value):
            raise ValueError("Employee code contains unsupported characters.")
        return value

    @model_validator(mode="after")
    def valid_times(self):
        if self.start_at.tzinfo is not None or self.end_at.tzinfo is not None:
            raise ValueError("Use local timestamps without timezone offsets (Asia/Manila).")
        if self.end_at <= self.start_at:
            raise ValueError("End must be later than start.")
        if not all(2000 <= value.year <= 2100 for value in (self.start_at, self.end_at)):
            raise ValueError("Dates must be between 2000 and 2100.")
        if self.end_at - self.start_at > dt.timedelta(days=366):
            raise ValueError("A single record cannot exceed 366 days.")
        if not self.reference and not self.purpose:
            raise ValueError("Enter an existing document reference or a short purpose.")
        return self


class VoidInput(BaseModel):
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("reason", mode="before")
    @classmethod
    def trim_reason(cls, value):
        return value.strip() if isinstance(value, str) else value


class EmployeeInput(BaseModel):
    display_name: str = Field(min_length=1, max_length=140)
    department: str = Field(default="", max_length=140)

    @field_validator("display_name", "department", mode="before")
    @classmethod
    def valid_text(cls, value):
        return clean(value, 140, "Staff metadata") if isinstance(value, str) else value


class WorkCodeInput(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    activity_type: Literal["Unclassified", "Regular", "AJA", "Fieldwork", "Official Business", "Travel Order"]
    direction: Literal["Unspecified", "IN", "OUT"] = "Unspecified"

    @model_validator(mode="after")
    def direction_matches_activity(self):
        if self.activity_type not in ("AJA", "Travel Order") and self.direction != "Unspecified":
            raise ValueError("IN/OUT mapping is only for AJA or Travel Order.")
        return self

    @field_validator("label", mode="before")
    @classmethod
    def valid_label(cls, value):
        return clean(value, 100, "Work code label") if isinstance(value, str) else value


@app.get("/api/employee-profiles")
def employee_profiles(q: str = "", category: str = "All", status: str = "All", page: int = 1,
                      limit: int = 15, user: dict = Depends(current_user)):
    return list_profiles(q.strip(), category, status, page, limit)


@app.get("/api/employee-profiles/{employee_code}")
def employee_profile(employee_code: str, user: dict = Depends(current_user)):
    return get_profile(employee_code)


@app.post("/api/employee-profiles", status_code=201)
def register_employee_profile(payload: RegistrationInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    return save_profile(payload.employee_code, payload, user["id"], creating=True)


@app.put("/api/employee-profiles/{employee_code}")
def update_employee_profile(employee_code: str, payload: ProfileUpdateInput, request: Request,
                            user: dict = Depends(require_admin)):
    require_csrf(request)
    return save_profile(employee_code, payload, user["id"], creating=False)


@app.get("/")
def home():
    return FileResponse(ROOT / "index.html")


@app.post("/api/login")
def login(payload: LoginInput, request: Request):
    with closing(connect()) as con:
        row = con.execute(
            "SELECT id,username,role,password_hash FROM users WHERE username=?",
            (payload.username.strip().lower(),),
        ).fetchone()
    if not row or not check_password(payload.password, row["password_hash"]):
        raise HTTPException(401, "Invalid username or password.")
    request.session.clear()
    request.session["uid"] = row["id"]
    request.session["csrf"] = secrets.token_urlsafe(32)
    return {"username": row["username"], "role": row["role"], "csrf": request.session["csrf"]}


@app.post("/api/logout")
def logout(request: Request, _user: dict = Depends(current_user)):
    require_csrf(request)
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(request: Request, user: dict = Depends(current_user)):
    return {**user, "csrf": request.session.get("csrf")}


@app.get("/api/overview")
def overview(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        totals = {
            "scans": con.execute("SELECT COUNT(*) FROM punches").fetchone()[0],
            "employees": con.execute("SELECT COUNT(*) FROM employees").fetchone()[0],
            "imports": con.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0],
            "activities": con.execute("SELECT COUNT(*) FROM activity_records WHERE status='recorded'").fetchone()[0],
        }
        recent = [dict(x) for x in con.execute(
            "SELECT id,original_name,total_records,inserted_records,imported_at "
            "FROM import_batches ORDER BY id DESC LIMIT 6"
        ).fetchall()]
        latest = con.execute("SELECT MAX(happened_at) FROM punches").fetchone()[0]
        daily = []
        if latest:
            end = dt.date.fromisoformat(latest[:10])
            start = end - dt.timedelta(days=6)
            counts = dict(con.execute(
                "SELECT substr(happened_at,1,10),COUNT(*) FROM punches "
                "WHERE happened_at>=? GROUP BY substr(happened_at,1,10)",
                (start.isoformat(),),
            ).fetchall())
            daily = [{"date": (start + dt.timedelta(days=i)).isoformat(),
                      "scans": counts.get((start + dt.timedelta(days=i)).isoformat(), 0)}
                     for i in range(7)]
    return {"totals": totals, "recent_imports": recent, "daily_scans": daily,
            "phase": "Attendance monitoring", "connection": _device_payload(user),
            "attendance_sync": status_view(include_errors=user["role"] == "admin")}


@app.get("/api/punches")
def punches(limit: int = 100, employee_code: str = "", offset: int = 0,
            date_from: dt.date | None = None, date_to: dt.date | None = None,
            user: dict = Depends(current_user)):
    if not 1 <= limit <= 250:
        raise HTTPException(400, "Limit must be between 1 and 250.")
    if employee_code and not CODE_RE.fullmatch(employee_code):
        raise HTTPException(400, "Invalid employee code.")
    if not 0 <= offset <= 1_000_000:
        raise HTTPException(400, "Invalid page offset.")
    if any(d and not 2000 <= d.year <= 2100 for d in (date_from, date_to)):
        raise HTTPException(400, "Dates must be between 2000 and 2100.")
    if date_from and date_to and date_to < date_from:
        raise HTTPException(400, "End date must be on or after the start date.")
    sql = ("SELECT p.id,p.employee_code,e.display_name,p.happened_at,p.device_id,p.status_code,p.verification_code,p.work_code, "
           "w.label AS work_label,w.activity_type FROM punches p LEFT JOIN employees e ON e.employee_code=p.employee_code "
           "LEFT JOIN work_codes w ON w.device_id=p.device_id AND w.work_code=p.work_code ")
    args: list = []
    filters = []
    if employee_code:
        filters.append("p.employee_code=?")
        args.append(employee_code)
    if date_from:
        filters.append("p.happened_at>=?")
        args.append(date_from.isoformat())
    if date_to:
        filters.append("p.happened_at<?")
        args.append((date_to + dt.timedelta(days=1)).isoformat())
    where = "WHERE " + " AND ".join(filters) + " " if filters else ""
    sql += where + "ORDER BY p.happened_at DESC, p.id DESC LIMIT ? OFFSET ?"
    with closing(connect()) as con:
        total = con.execute("SELECT COUNT(*) FROM punches p " + where, args).fetchone()[0]
        rows = [dict(x) for x in con.execute(sql, [*args, limit, offset]).fetchall()]
    return {"items": rows, "total": total,
            "note": "Raw codes are not yet verified as clock-IN or clock-OUT."}


@app.post("/api/imports/preview")
async def preview(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    raw = await file.read(MAX_BYTES + 1)
    try:
        filename = (file.filename or "").lower()
        if filename.endswith(".xls"):
            return preview_k14_report(raw)
        if not filename.endswith((".dat", ".txt")):
            raise ValueError("Choose a .dat/.txt source log or a .xls device report.")
        records = parse_attlog(raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    fingerprint = digest(raw)
    with closing(connect()) as con:
        exists = con.execute("SELECT id FROM import_batches WHERE file_sha256=?", (fingerprint,)).fetchone()
    return {
        "format": "source", "rows": len(records), "employees": len({r.employee_code for r in records}),
        "earliest": min(r.happened_at for r in records),
        "latest": max(r.happened_at for r in records),
        "sha256": fingerprint, "already_imported": bool(exists),
        "codes": sorted({r.status_code for r in records}),
        "message": "Preview only. No data was stored.",
    }


@app.post("/api/imports")
async def import_file(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    if (file.filename or "").lower().endswith(".xls"):
        raise HTTPException(400, "Excel reports cannot supply raw scans. Use Import staff names for the roster, or select the _attlog.dat file for attendance.")
    raw = await file.read(MAX_BYTES + 1)
    try:
        records = parse_attlog(raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    filename = (file.filename or "attlog.dat").replace("\\", "/").split("/")[-1]
    if not re.fullmatch(r"[A-Za-z0-9._() -]{1,140}", filename) or not filename.lower().endswith((".dat", ".txt")):
        raise HTTPException(400, "Please upload a .dat or .txt attendance log.")
    with closing(connect()) as con:
        try:
            with con:
                cur = con.execute(
                    "INSERT INTO import_batches(file_sha256,original_name,total_records,inserted_records,imported_by) "
                    "VALUES(?,?,?,?,?)", (digest(raw), filename, len(records), 0, user["id"]),
                )
                batch_id = cur.lastrowid
                inserted = insert_punches(con, records, batch_id)
                con.execute("UPDATE import_batches SET inserted_records=? WHERE id=?", (inserted,batch_id))
                con.execute(
                    "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                    (user["id"],"import","import_batch",batch_id,f"{inserted} new records"),
                )
        except sqlite3.IntegrityError as exc:
            if "file_sha256" in str(exc):
                raise HTTPException(409, "This exact file has already been imported.") from exc
            raise HTTPException(409, "Could not import this file.") from exc
    return {"batch_id": batch_id, "total": len(records), "inserted": inserted, "duplicates": len(records)-inserted}


@app.get("/api/fieldwork")
def list_fieldwork(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        rows = [dict(x) for x in con.execute(
            "SELECT id,employee_code,category,location,reason,start_at,end_at,status,created_at,reviewed_at "
            "FROM fieldwork ORDER BY id DESC LIMIT 250"
        ).fetchall()]
    return {"items": rows}


@app.post("/api/fieldwork")
@app.post("/api/fieldwork/{item_id}/decision")
def retired_approval_flow(request: Request, user: dict = Depends(require_admin)):
    """Keep old records readable; an outdated client must not create new requests."""
    require_csrf(request)
    raise HTTPException(410, "Activity approvals have been retired. Record an existing office reference in /api/activities.")


@app.get("/api/activities")
def list_activities(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        rows = [dict(x) for x in con.execute(
            "SELECT id,employee_code,category,reference,purpose,start_at,end_at,status,created_at,void_reason "
            "FROM activity_records ORDER BY id DESC LIMIT 250"
        )]
        legacy = [dict(x) for x in con.execute(
            "SELECT id,employee_code,category,location,reason,start_at,end_at,status "
            "FROM fieldwork ORDER BY id DESC LIMIT 250"
        )]
    return {"items": rows, "legacy_items": legacy}


@app.post("/api/activities", status_code=201)
def record_activity(payload: ActivityInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    with closing(connect()) as con:
        try:
            with con:
                cur = con.execute(
                    "INSERT INTO activity_records(employee_code,category,reference,purpose,start_at,end_at,recorded_by) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (payload.employee_code,payload.category,payload.reference,payload.purpose,
                     payload.start_at.isoformat(sep=" "),payload.end_at.isoformat(sep=" "),user["id"]),
                )
                aid = cur.lastrowid
                # Approved-office references may cover staff without any office scans.
                # Keep those employee IDs in the attendance register as unscanned IDs.
                con.execute("INSERT OR IGNORE INTO employees(employee_code) VALUES(?)",
                            (payload.employee_code,))
                con.execute(
                    "INSERT INTO audit_events(actor_id,action,entity,entity_id) VALUES(?,?,?,?)",
                    (user["id"],"recorded","activity_record",aid),
                )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "This activity reference has already been recorded.") from exc
    return {"id": aid, "status": "recorded"}


@app.post("/api/activities/{item_id}/void")
def void_activity(item_id: int, payload: VoidInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    with closing(connect()) as con:
        with con:
            cur = con.execute(
                "UPDATE activity_records SET status='voided',voided_by=?,voided_at=CURRENT_TIMESTAMP,void_reason=? "
                "WHERE id=? AND status='recorded'", (user["id"],payload.reason,item_id),
            )
            if cur.rowcount != 1:
                raise HTTPException(409, "Record not found or already voided.")
            con.execute(
                "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                (user["id"],"voided","activity_record",item_id,payload.reason),
            )
    return {"ok": True, "status": "voided"}


@app.get("/api/employees")
def employee_ids(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        codes = [r[0] for r in con.execute(
            "SELECT employee_code FROM punches UNION SELECT employee_code FROM activity_records "
            "UNION SELECT employee_code FROM fieldwork UNION SELECT employee_code FROM employees ORDER BY employee_code"
        )]
        names = {r["employee_code"]: dict(r) for r in con.execute("SELECT * FROM employees")}
    return {"items": codes, "staff": [names.get(code, {"employee_code": code, "display_name": "", "department": "", "name_source": "reference"}) for code in codes]}


@app.put("/api/employees/{employee_code}")
def save_employee(employee_code: str, payload: EmployeeInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    if not CODE_RE.fullmatch(employee_code):
        raise HTTPException(400, "Invalid employee ID.")
    with closing(connect()) as con, con:
        if con.execute("SELECT 1 FROM employee_profiles WHERE employee_code=?", (employee_code,)).fetchone():
            raise HTTPException(409, "Use Edit profile to update this employee's verified name and department.")
        con.execute(
            "INSERT INTO employees(employee_code,display_name,department,name_source) VALUES(?,?,?,'manual') "
            "ON CONFLICT(employee_code) DO UPDATE SET display_name=excluded.display_name,department=excluded.department,"
            "name_source='manual',updated_at=CURRENT_TIMESTAMP",
            (employee_code,payload.display_name,payload.department),
        )
        con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
                    (user["id"],"saved","employee",employee_code))
    return {"ok": True}


def roster_changes(con, rows: list[dict]) -> list[dict]:
    existing = {r["employee_code"]: dict(r) for r in con.execute("SELECT * FROM employees")}
    verified = {r[0] for r in con.execute("SELECT employee_code FROM employee_profiles")}
    result = []
    for row in rows:
        old = existing.get(row["employee_code"])
        if row["employee_code"] in verified:
            same = row["display_name"] == old["display_name"] and (not row["department"] or row["department"] == old["department"])
            result.append({**row, "change": "unchanged" if same else "conflict", "existing_name": old["display_name"]})
            continue
        change = "new"
        if old:
            conflict = any(old[key] and row[key] and old[key] != row[key] for key in ("display_name", "department"))
            fills = any(not old[key] and row[key] for key in ("display_name", "department"))
            change = "conflict" if conflict else "fill" if fills else "unchanged"
        result.append({**row, "change": change, "existing_name": old["display_name"] if old else ""})
    return result


async def read_roster(file: UploadFile) -> list[dict]:
    raw = await file.read(MAX_BYTES + 1)
    try:
        return parse_staff(raw, file.filename or "")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/employees/import/preview")
async def preview_employees(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    rows = await read_roster(file)
    with closing(connect()) as con:
        changes = roster_changes(con, rows)
    counts = {kind: sum(row["change"] == kind for row in changes) for kind in ("new", "fill", "unchanged", "conflict")}
    return {"total": len(changes), "counts": counts, "items": changes[:100], "preview_limit": 100}


@app.post("/api/employees/import")
async def import_employees(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    rows = await read_roster(file)
    with closing(connect()) as con, con:
        # Acquire the write transaction before comparing names to avoid a stale
        # preview overwriting a concurrently edited staff record.
        con.execute("BEGIN IMMEDIATE")
        changes = roster_changes(con, rows)
        for row in changes:
            if row["change"] == "new":
                con.execute("INSERT INTO employees(employee_code,display_name,department,name_source) VALUES(?,?,?,'roster')",
                            (row["employee_code"],row["display_name"],row["department"]))
            elif row["change"] == "fill":
                con.execute(
                    "UPDATE employees SET display_name=CASE WHEN display_name='' THEN ? ELSE display_name END,"
                    "department=CASE WHEN department='' THEN ? ELSE department END,name_source='roster',updated_at=CURRENT_TIMESTAMP "
                    "WHERE employee_code=?", (row["display_name"],row["department"],row["employee_code"]),
                )
        counts = {kind: sum(row["change"] == kind for row in changes) for kind in ("new", "fill", "unchanged", "conflict")}
        con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
                    (user["id"],"imported","employee_roster",str(counts)))
    return {"total": len(changes), "counts": counts}


@app.get("/api/work-codes")
def work_code_list(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        items = [dict(r) for r in con.execute(
            "SELECT w.*,COUNT(p.id) AS scan_count FROM work_codes w LEFT JOIN punches p "
            "ON p.device_id=w.device_id AND p.work_code=w.work_code GROUP BY w.device_id,w.work_code ORDER BY w.device_id,w.work_code"
        )]
    return {"items": items}


@app.put("/api/work-codes/{device_id}/{work_code}")
def save_work_code(device_id: str, work_code: str, payload: WorkCodeInput, request: Request,
                   user: dict = Depends(require_admin)):
    require_csrf(request)
    if not CODE_RE.fullmatch(device_id) or not CODE_RE.fullmatch(work_code):
        raise HTTPException(400, "Invalid device or work code.")
    with closing(connect()) as con, con:
        previous = con.execute(
            "SELECT label,activity_type,direction FROM work_codes WHERE device_id=? AND work_code=?",
            (device_id, work_code),
        ).fetchone()
        con.execute(
            "INSERT INTO work_codes(device_id,work_code,label,activity_type,direction) VALUES(?,?,?,?,?) "
            "ON CONFLICT(device_id,work_code) DO UPDATE SET label=excluded.label,activity_type=excluded.activity_type,"
            "direction=excluded.direction,updated_at=CURRENT_TIMESTAMP",
            (device_id,work_code,payload.label,payload.activity_type,payload.direction),
        )
        con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
                    (user["id"],"mapped","work_code",json.dumps({
                        "device_id": device_id, "work_code": work_code,
                        "before": dict(previous) if previous else None,
                        "after": payload.model_dump(),
                    })))
    return {"ok": True}


@app.get("/api/dtr/monitor")
def monitor_dtr(employee_code: str, month: str, user: dict = Depends(current_user)):
    """Daily evidence for checking the office DTR, without attendance/payroll rules.

    A source event is not assigned an AM/PM slot based on an unverified code.
    Activity coverage is a reference, never an automatic credit of elapsed hours.
    """
    if not CODE_RE.fullmatch(employee_code):
        raise HTTPException(400, "Choose a valid employee ID.")
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(400, "Use a month in YYYY-MM format.")
    try:
        start = dt.date.fromisoformat(month + "-01")
    except ValueError as exc:
        raise HTTPException(400, "Invalid month.") from exc
    if not 2000 <= start.year <= 2100:
        raise HTTPException(400, "Dates must be between 2000 and 2100.")
    day_count = calendar.monthrange(start.year, start.month)[1]
    end = start + dt.timedelta(days=day_count)
    with closing(connect()) as con:
        scans = [dict(x) for x in con.execute(
            "SELECT p.id,p.employee_code,p.happened_at,p.device_id,p.status_code,p.verification_code,p.work_code,w.label AS work_label,w.activity_type,w.direction AS work_direction "
            "FROM punches p LEFT JOIN work_codes w ON w.device_id=p.device_id AND w.work_code=p.work_code "
            "WHERE p.employee_code=? AND p.happened_at>=? AND p.happened_at<? ORDER BY p.happened_at,p.id LIMIT 10001",
            (employee_code,start.isoformat(),end.isoformat()),
        )]
        # Only the office device's verified configuration from the test date.
        # Preserve raw connector fields separately from USB verification/work codes.
        links = {row["punch_id"]: dict(row) for row in con.execute(
            """SELECT punch_id, MIN(device_punch_type) AS state_min,
                      MAX(device_punch_type) AS state_max
               FROM k14_sync_events
               WHERE employee_id=? AND device_ip='192.168.254.201'
                 AND punch_time_local>=? AND punch_time_local<?
                 AND punch_time_local>='2026-11-24'
               GROUP BY punch_id""",
            (employee_code,start.isoformat(),end.isoformat()))}
        for scan in scans:
            link = links.get(scan["id"])
            if link:
                scan["k14_state_pending"] = True
                scan["k14_punch_type"] = link["state_min"] if link["state_min"]==link["state_max"] else None
                scan["verified_slot"] = {"0":"am_in", "1":"am_out", "4":"pm_out", "5":"pm_in"}.get(scan["k14_punch_type"])
        reconcile_workcodes(con, scans)
        employee = con.execute(
            "SELECT e.display_name,e.name_source,e.department,ep.employment_type,ep.position FROM employees e "
            "LEFT JOIN employee_profiles ep ON ep.employee_code=e.employee_code WHERE e.employee_code=?",
            (employee_code,),
        ).fetchone()
        activities = [dict(x) for x in con.execute(
            "SELECT id,category,reference,purpose,start_at,end_at FROM activity_records "
            "WHERE employee_code=? AND status='recorded' AND start_at<? AND end_at>? ORDER BY start_at,id LIMIT 1001",
            (employee_code,end.isoformat(),start.isoformat() + " 00:00:00"),
        )]
    if len(scans) > 10000 or len(activities) > 1000:
        raise HTTPException(400, "Too many records for one employee/month. Check the source records.")
    rows = []
    for i in range(day_count):
        date = start + dt.timedelta(days=i)
        after = (date + dt.timedelta(days=1)).isoformat() + " 00:00:00"
        before = date.isoformat() + " 00:00:00"
        day_scans = [s for s in scans if s["happened_at"][:10] == date.isoformat()]
        support = [a for a in activities if a["start_at"] < after and a["end_at"] > before]
        rows.append({"date": date.isoformat(), "day": date.strftime("%a"),
                     "scans": day_scans, "activities": support,
                     "coverage": "scans" if day_scans else "reference_only" if support else "no_records",
                     "travel_order": any(a["category"]=="Travel Order" for a in support),
                     "travel_remark": "OFFICIAL TRAVEL" if any(a["category"]=="Travel Order" for a in support) else "",
                     "undertime_review": "TO coverage for HR verification" if any(a["category"]=="Travel Order" for a in support) else "Not calculated"})
    decorate_days(employee_code, rows)
    for day in rows:
        day["activity_mappings"] = activity_pairs(day["scans"])
        day["aja_periods"] = dtr_aja_periods(day)
        # AJA-only notes or missing endpoints are review evidence, not complete intervals.
        if not day["travel_order"] and day["aja_periods"]:
            if day["tone"] != "holiday":
                day["tone"] = "aja" if (any(p["out"] or p["in"] for p in day["aja_periods"]) or any(s["activity_type"]=="AJA" for s in day["scans"])) else "entry" if any(day["display_slots"].values()) else "future" if day["is_future"] else "weekend" if day["is_weekend"] else "missing"
            if any(p["review"] for p in day["aja_periods"]):
                day["monitoring"]["aja_review"] = True
        present_day(day)
    return {"employee_code": employee_code, "display_name": employee[0] if employee else "",
            "name_source": employee["name_source"] if employee else "scan",
            "department": employee["department"] if employee else "",
            "employment_type": employee["employment_type"] if employee else None,
            "position": employee["position"] if employee else "", "month": month, "days": rows,
            "summary": {"scans": len(scans), "days_with_scans": sum(bool(r["scans"]) for r in rows),
                        "activity_records": len(activities)},
            "calculation_status": "not_calculated", "manual_source_status": automatic_status()}


@app.put("/api/attendance/{employee_code}/{date}")
def review_attendance_day(employee_code: str, date: str, payload: DayReviewInput, request: Request,
                          user: dict = Depends(require_admin)):
    require_csrf(request)
    if not CODE_RE.fullmatch(employee_code):
        raise HTTPException(400, "Choose a valid employee.")
    return save_day_review(employee_code, date, payload, user["id"])


@app.put("/api/attendance-calendar/{date}")
def update_attendance_calendar(date: str, payload: CalendarInput, request: Request,
                               user: dict = Depends(require_admin)):
    require_csrf(request)
    return save_calendar(date, payload, user["id"])


# ── Streamlined employee records ─────────────────────────────────────────────

@app.get('/api/manual-dtr/status')
def manual_dtr_status(user: dict = Depends(current_user)):
    return automatic_status()

async def manual_dtr_request(file: UploadFile, mapping: str):
    raw = await file.read(MAX_MANUAL_BYTES + 1)
    try:
        packet = parse_package(raw)
        mapped = json.loads(mapping)
        if not isinstance(mapped, dict):
            raise ValueError("Invalid employee mapping.")
        return raw, packet, mapped
    except (ValueError, TypeError, RecursionError) as exc:
        raise HTTPException(400, "Invalid manual DTR package or employee mapping. Check the file and try again.") from exc


@app.post("/api/manual-dtr/preview")
async def preview_manual_dtr(request: Request, file: UploadFile = File(...), mapping: str = Form("{}"),
                             user: dict = Depends(require_admin)):
    require_csrf(request)
    raw, packet, mapped = await manual_dtr_request(file, mapping)
    try:
        result = preview_package(packet, mapped)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    result["preview_token"] = URLSafeTimedSerializer(secret, salt="manual-dtr-preview").dumps(
        {"file": digest(raw), "mapping": mapping_hash(mapped), "actor": user["id"]})
    return result


@app.post("/api/manual-dtr/import")
async def import_manual_dtr(request: Request, file: UploadFile = File(...), mapping: str = Form(...),
                            preview_token: str = Form(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    raw, packet, mapped = await manual_dtr_request(file, mapping)
    try:
        expected = {"file": digest(raw), "mapping": mapping_hash(mapped), "actor": user["id"]}
        observed = URLSafeTimedSerializer(secret, salt="manual-dtr-preview").loads(preview_token, max_age=900)
        if observed != expected or not mapped:
            raise ValueError("Preview the chosen employee matches before importing.")
        return {"counts": import_package(packet, mapped, digest(raw), user["id"])}
    except (BadSignature, SignatureExpired, ValueError) as exc:
        raise HTTPException(400, "Preview the current file and employee matches before importing.") from exc

@app.get("/api/employee-register")
def employee_register(month: str, q: str = "", user: dict = Depends(current_user)):
    """Directory-first list for one chosen calendar month, including unscanned staff.

    No scan is interpreted as time-in/out here. The same personnel registry
    powers offline USB and the future LAN connector.
    """
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(400, "Month must be YYYY-MM.")
    try:
        start = dt.date.fromisoformat(month + "-01")
    except ValueError as exc:
        raise HTTPException(400, "Invalid month.") from exc
    if not 2000 <= start.year <= 2100:
        raise HTTPException(400, "Unsupported year.")
    end = start + dt.timedelta(days=calendar.monthrange(start.year, start.month)[1])
    search = q.strip()
    if len(search) > 80 or any(ord(c) < 32 for c in search):
        raise HTTPException(400, "Invalid search term.")
    with closing(connect()) as con:
        rows = [dict(row) for row in con.execute(
            """SELECT e.employee_code, e.display_name, e.name_source, e.department, ep.employment_type, ep.position,
                      COUNT(p.id) AS scan_count,
                      COUNT(DISTINCT substr(p.happened_at,1,10)) AS days_with_scans,
                      MAX(p.happened_at) AS last_scan
               FROM employees e
               LEFT JOIN employee_profiles ep ON ep.employee_code=e.employee_code
               LEFT JOIN punches p ON p.employee_code=e.employee_code
                    AND p.happened_at>=? AND p.happened_at<?
               WHERE (?='' OR instr(lower(e.employee_code),lower(?))>0
                       OR instr(lower(e.display_name),lower(?))>0)
               GROUP BY e.employee_code,e.display_name,e.name_source,e.department
               ORDER BY CASE WHEN e.display_name='' THEN 1 ELSE 0 END,
                        lower(e.display_name), e.employee_code LIMIT 1000""",
            (start.isoformat(), end.isoformat(), search, search, search),
        ).fetchall()]
    return {"items": rows, "month": month, "search": search,
            "note": "Scan counts only; no automatic absence or undertime calculation."}


# ── LAN configuration without unauthorized reads/writes ────────────────────

def _device_payload(user: dict) -> dict:
    try:
        payload = lan_status()
    except ValueError as exc:
        payload = {"host": "Invalid configuration", "port": None, "probe_enabled": False,
                   "configuration_error": safe_error(str(exc))}
    sync = status_view(include_errors=user["role"] == "admin")
    payload["sync_enabled"] = sync["enabled"]
    payload["attendance_sync"] = sync
    payload["mode"] = "Local connector database + USB backup"
    payload["message"] = (
        "Administrators can read the local connector file with automatic imports off. "
        "The optional TCP test does not control imports or confirm that device polling is running. "
        "Restart the website after changing local settings."
    )
    return payload


@app.get("/api/device/status")
def device_status(user: dict = Depends(current_user)):
    return _device_payload(user)


@app.post("/api/device/sync")
def device_sync(request: Request, user: dict = Depends(require_admin)):
    """Copy new rows from the connector SQLite file. Does not open the K14."""
    require_csrf(request)
    result = run_sync(actor_id=user["id"], manual=True)
    if result["outcome"] != "success":
        raise HTTPException(409, result["error_message"] or "Connector sync failed.")
    return result


@app.post("/api/device/probe")
def device_probe(request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    try:
        return tcp_probe()
    except ValueError as exc:
        raise HTTPException(409, safe_error(str(exc))) from exc


@app.get("/api/activities/monitor")
def monitor_official_activities(
    month: str,
    q: str = "",
    category: Literal["All", "AJA", "Travel Order"] = "All",
    user: dict = Depends(current_user),
):
    """Read-only listing of K14 scans whose work codes have been classified.

    A device work-code event identifies an observed scan, NOT a validated
    approval or a complete start/end interval. Even for TO references, work-hour
    credit is not calculated by this query.
    """
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(400, "Month must be YYYY-MM.")
    try:
        start = dt.date.fromisoformat(month + "-01")
    except ValueError as exc:
        raise HTTPException(400, "Invalid month.") from exc
    if not 2000 <= start.year <= 2100:
        raise HTTPException(400, "Unsupported year.")
    end = start + dt.timedelta(days=calendar.monthrange(start.year, start.month)[1])
    search = q.strip()
    if len(search) > 80 or any(ord(c) < 32 for c in search):
        raise HTTPException(400, "Invalid search term.")
    with closing(connect()) as con:
        signals = [dict(r) for r in con.execute(
            """SELECT p.id,p.employee_code,COALESCE(e.display_name,'') AS display_name,
                      w.activity_type AS category,p.happened_at,p.device_id,p.work_code,w.label,w.direction
               FROM punches p
               JOIN work_codes w ON w.device_id=p.device_id AND w.work_code=p.work_code
               LEFT JOIN employees e ON e.employee_code=p.employee_code
               WHERE w.activity_type IN ('AJA','Travel Order')
                 AND p.happened_at >= ? AND p.happened_at < ?
                 AND (?='All' OR w.activity_type=?)
                 AND (?='' OR instr(lower(p.employee_code),lower(?))>0
                            OR instr(lower(COALESCE(e.display_name,'')),lower(?))>0)
               ORDER BY p.happened_at DESC,p.id DESC LIMIT 500""",
            (start.isoformat(), end.isoformat(), category, category, search, search, search),
        ).fetchall()]
        # Enrich existing linked K14 punches without inserting more attendance rows.
        candidates = [dict(r) for r in con.execute(
            """SELECT p.id,p.employee_code,COALESCE(e.display_name,'') AS display_name,
                      p.happened_at,p.device_id,p.work_code,w.label AS work_label,
                      w.activity_type,w.direction AS work_direction,1 AS k14_state_pending
               FROM punches p LEFT JOIN employees e ON e.employee_code=p.employee_code
               LEFT JOIN work_codes w ON w.device_id=p.device_id AND w.work_code=p.work_code
               WHERE p.happened_at>=? AND p.happened_at<? AND p.happened_at>='2026-11-24'
                 AND EXISTS(SELECT 1 FROM k14_sync_events k WHERE k.punch_id=p.id
                     AND k.device_ip='192.168.254.201')
                 AND (?='' OR instr(lower(p.employee_code),lower(?))>0
                            OR instr(lower(COALESCE(e.display_name,'')),lower(?))>0)
               ORDER BY p.happened_at DESC,p.id DESC LIMIT 10001""",
            (start.isoformat(),end.isoformat(),search,search,search))]
        if len(candidates)<=10000:
            reconcile_workcodes(con,candidates)
            by_id = {r["id"]:r for r in signals}
            for scan in candidates:
                if scan.get("work_code_conflict"):
                    by_id.pop(scan["id"],None)
                elif scan.get("work_code_origin")=="bionet":
                    by_id.pop(scan["id"],None)
                    if scan["activity_type"] in ("AJA","Travel Order") and category in ("All",scan["activity_type"]):
                        by_id[scan["id"]] = {**scan,"category":scan["activity_type"],
                            "label":scan["work_label"],"direction":scan["work_direction"]}
            signals = sorted(by_id.values(), key=lambda x:(x["happened_at"],x["id"]), reverse=True)[:500]
    items = [{
        "id": r["id"],
        "employee_code": r["employee_code"],
        "display_name": r["display_name"],
        "category": r["category"],
        "happened_at": r["happened_at"],
        "device_id": r["device_id"],
        "work_code": r["work_code"],
        "label": r["label"],
        "direction": r["direction"],
        "verified_by_hr": False,
        "note": "Device event only; classification does not prove approval, departure/return, or TO coverage.",
    } for r in signals]
    items.sort(key=lambda r: (r["happened_at"], r["id"]), reverse=True)
    return {
        "month": month, "items": items[:800],
        "summary": {
            "employees": len({r["employee_code"] for r in items}),
            "aja": sum(r["category"] == "AJA" for r in items),
            "travel_orders": sum(r["category"] == "Travel Order" for r in items),
            "device_signals": len(signals),
        },
        "note": "These are actual K14 scan events classified using locally labeled work codes; "
                "codes must be verified against device configuration. "
                "Travel Orders without office scans are NOT detectable from this list; "
                "official TO coverage requires approved office records for DTR treatment.",
    }
