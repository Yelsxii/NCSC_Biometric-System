"""NCSC Biometric Attendance System — local-only FastAPI application.

Attendance scans are immutable source events. No LAN/device access in Phase 1.
"""
from __future__ import annotations

import datetime as dt
import calendar
import os
import re
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator
from starlette.middleware.sessions import SessionMiddleware

from app.db import connect, initialize, register_scan_metadata
from app.parser import MAX_BYTES, digest, parse_attlog
from app.security import check_password
from app.reports import preview_k14_report
from app.registry import parse_staff, clean

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

    @field_validator("label", mode="before")
    @classmethod
    def valid_label(cls, value):
        return clean(value, 100, "Work code label") if isinstance(value, str) else value


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
            "phase": "USB / Local Pilot"}


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
                before = con.total_changes
                con.executemany(
                    "INSERT OR IGNORE INTO punches(employee_code,happened_at,device_id,status_code,verification_code,work_code,imported_batch_id) "
                    "VALUES(?,?,?,?,?,?,?)",
                    [(p.employee_code,p.happened_at,p.device_id,p.status_code,p.verification_code,p.work_code,batch_id) for p in records],
                )
                inserted = con.total_changes - before
                register_scan_metadata(con)
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
    result = []
    for row in rows:
        old = existing.get(row["employee_code"])
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
        con.execute(
            "INSERT INTO work_codes(device_id,work_code,label,activity_type) VALUES(?,?,?,?) "
            "ON CONFLICT(device_id,work_code) DO UPDATE SET label=excluded.label,activity_type=excluded.activity_type,updated_at=CURRENT_TIMESTAMP",
            (device_id,work_code,payload.label,payload.activity_type),
        )
        con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
                    (user["id"],"mapped","work_code",device_id + ":" + work_code))
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
            "SELECT p.id,p.happened_at,p.device_id,p.status_code,p.verification_code,p.work_code,w.label AS work_label,w.activity_type "
            "FROM punches p LEFT JOIN work_codes w ON w.device_id=p.device_id AND w.work_code=p.work_code "
            "WHERE p.employee_code=? AND p.happened_at>=? AND p.happened_at<? ORDER BY p.happened_at,p.id LIMIT 10001",
            (employee_code,start.isoformat(),end.isoformat()),
        )]
        employee = con.execute("SELECT display_name FROM employees WHERE employee_code=?", (employee_code,)).fetchone()
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
                     "coverage": "scans" if day_scans else "reference_only" if support else "no_records"})
    return {"employee_code": employee_code, "display_name": employee[0] if employee else "", "month": month, "days": rows,
            "summary": {"scans": len(scans), "days_with_scans": sum(bool(r["scans"]) for r in rows),
                        "activity_records": len(activities)},
            "calculation_status": "not_calculated"}
