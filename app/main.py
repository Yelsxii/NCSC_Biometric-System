"""NCSC Biometric Attendance System — local-only FastAPI application.

Attendance scans are immutable source events. No LAN/device access in Phase 1.
"""
from __future__ import annotations

import datetime as dt
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

from app.db import connect, initialize
from app.parser import MAX_BYTES, digest, parse_attlog
from app.roster import MAX_ROSTER_BYTES, parse_user_dat, parse_department_dat
from app.security import check_password

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


class FieldworkInput(BaseModel):
    employee_code: str = Field(min_length=1, max_length=64)
    category: Literal["AJA", "Fieldwork", "Official Business"]
    location: str = Field(min_length=3, max_length=140)
    reason: str = Field(min_length=5, max_length=600)
    start_at: dt.datetime
    end_at: dt.datetime

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
        if self.end_at - self.start_at > dt.timedelta(days=7):
            raise ValueError("A single entry cannot exceed seven days.")
        return self


class WorkCodeInput(BaseModel):
    numeric_code: str = Field(pattern=r"^[0-9]{1,10}$")
    label: str = Field(min_length=2, max_length=80)


class DecisionInput(BaseModel):
    decision: Literal["approved", "rejected"]


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
            "employees": con.execute("SELECT COUNT(DISTINCT employee_code) FROM punches").fetchone()[0],
            "imports": con.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0],
            "pending": con.execute("SELECT COUNT(*) FROM fieldwork WHERE status='pending'").fetchone()[0],
            "staff": con.execute("SELECT COUNT(*) FROM staff").fetchone()[0],
            "named_staff": con.execute("SELECT COUNT(*) FROM staff WHERE device_name != ''").fetchone()[0],
        }
        recent = [dict(x) for x in con.execute(
            "SELECT id,original_name,total_records,inserted_records,imported_at "
            "FROM import_batches ORDER BY id DESC LIMIT 6"
        ).fetchall()]
    return {"totals": totals, "recent_imports": recent, "phase": "USB / Local Pilot"}


@app.get("/api/punches")
def punches(limit: int = 100, employee_code: str = "", user: dict = Depends(current_user)):
    if not 1 <= limit <= 250:
        raise HTTPException(400, "Limit must be between 1 and 250.")
    if employee_code and not CODE_RE.fullmatch(employee_code):
        raise HTTPException(400, "Invalid employee code.")
    sql = ("SELECT p.id,p.employee_code,p.happened_at,p.device_id,p.status_code,p.verification_code,p.work_code, "
           "COALESCE(w.label, '') AS work_code_label FROM punches p "
           "LEFT JOIN work_code_mappings w ON w.numeric_code=p.work_code ")
    args: list = []
    if employee_code:
        sql += "WHERE p.employee_code=? "
        args.append(employee_code)
    sql += "ORDER BY p.happened_at DESC, p.id DESC LIMIT ?"
    args.append(limit)
    with closing(connect()) as con:
        rows = [dict(x) for x in con.execute(sql, args).fetchall()]
    return {"items": rows, "note": "Raw codes are not yet verified as clock-IN or clock-OUT."}


@app.post("/api/imports/preview")
async def preview(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    raw = await file.read(MAX_BYTES + 1)
    try:
        records = parse_attlog(raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    fingerprint = digest(raw)
    with closing(connect()) as con:
        exists = con.execute("SELECT id FROM import_batches WHERE file_sha256=?", (fingerprint,)).fetchone()
    return {
        "rows": len(records), "employees": len({r.employee_code for r in records}),
        "earliest": min(r.happened_at for r in records),
        "latest": max(r.happened_at for r in records),
        "sha256": fingerprint, "already_imported": bool(exists),
        "codes": sorted({r.status_code for r in records}),
        "message": "Preview only. No data was stored.",
    }


@app.post("/api/imports")
async def import_file(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
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
                # Device enrollment and scan history are separate. Each unknown
                # employee ID appearing in a log creates a placeholder staff row.
                # A later user.dat import fills in the device-registered name.
                limits = {}
                for p in records:
                    earliest, latest = limits.get(p.employee_code, (p.happened_at, p.happened_at))
                    limits[p.employee_code] = (min(earliest, p.happened_at), max(latest, p.happened_at))
                con.executemany(
                    """INSERT INTO staff(employee_code,first_scan_at,last_scan_at)
                       VALUES(?,?,?)
                       ON CONFLICT(employee_code) DO UPDATE SET
                         first_scan_at=CASE WHEN staff.first_scan_at IS NULL OR
                           staff.first_scan_at > excluded.first_scan_at
                           THEN excluded.first_scan_at ELSE staff.first_scan_at END,
                         last_scan_at=CASE WHEN staff.last_scan_at IS NULL OR
                           staff.last_scan_at < excluded.last_scan_at
                           THEN excluded.last_scan_at ELSE staff.last_scan_at END""",
                    [(code, start, end) for code, (start, end) in limits.items()],
                )
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


@app.post("/api/fieldwork", status_code=201)
def create_fieldwork(payload: FieldworkInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    with closing(connect()) as con:
        with con:
            cur = con.execute(
                "INSERT INTO fieldwork(employee_code,category,location,reason,start_at,end_at,created_by) "
                "VALUES(?,?,?,?,?,?,?)",
                (payload.employee_code,payload.category,payload.location.strip(),
                 payload.reason.strip(),payload.start_at.isoformat(sep=" "),payload.end_at.isoformat(sep=" "),user["id"]),
            )
            fid = cur.lastrowid
            con.execute(
                "INSERT INTO audit_events(actor_id,action,entity,entity_id) VALUES(?,?,?,?)",
                (user["id"],"created","fieldwork",fid),
            )
    return {"id": fid, "status": "pending"}


@app.post("/api/fieldwork/{item_id}/decision")
def review_fieldwork(item_id: int, payload: DecisionInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    with closing(connect()) as con:
        with con:
            cur = con.execute(
                "UPDATE fieldwork SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",
                (payload.decision,user["id"],item_id),
            )
            if cur.rowcount != 1:
                raise HTTPException(409, "Entry not found or already reviewed.")
            con.execute(
                "INSERT INTO audit_events(actor_id,action,entity,entity_id) VALUES(?,?,?,?)",
                (user["id"],payload.decision,"fieldwork",item_id),
            )
    return {"ok": True, "status": payload.decision}


# ── USB device directory (no biometric templates) ───────────────────────────

def _directory_file(file: UploadFile, raw: bytes):
    filename = (file.filename or "").lower()
    try:
        if filename == "user.dat":
            return "user", parse_user_dat(raw)
        if filename == "department.dat":
            return "department", parse_department_dat(raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    raise HTTPException(400, "Only user.dat and department.dat are supported. Never upload template.fp10 files.")


@app.get("/api/staff")
def staff_directory(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        employees = [dict(row) for row in con.execute(
            """SELECT employee_code,device_name,origin,first_scan_at,last_scan_at,last_roster_sync
               FROM staff ORDER BY CAST(employee_code AS INTEGER), employee_code LIMIT 500"""
        ).fetchall()]
        departments = [dict(row) for row in con.execute(
            "SELECT department_code,device_name FROM departments ORDER BY CAST(department_code AS INTEGER)"
        ).fetchall()]
        import_history = [dict(row) for row in con.execute(
            "SELECT kind,record_count,imported_at FROM directory_imports ORDER BY id DESC LIMIT 8"
        ).fetchall()]
    return {"employees": employees, "departments": departments, "directory_imports": import_history,
            "note": "Staff are synced from USB snapshots, NOT live. Department membership not verified."}


@app.post("/api/device-directory/preview")
async def directory_preview(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    raw = await file.read(MAX_ROSTER_BYTES + 1)
    kind, rows = _directory_file(file, raw)
    with closing(connect()) as con:
        existing = con.execute("SELECT id FROM directory_imports WHERE file_sha256=?", (digest(raw),)).fetchone()
    return {"kind": kind, "count": len(rows), "already_imported": bool(existing),
            "message": "Preview only; no directory records saved. Names and fingerprint data are not shown here."}


@app.post("/api/device-directory/import")
async def directory_import(request: Request, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    require_csrf(request)
    raw = await file.read(MAX_ROSTER_BYTES + 1)
    kind, rows = _directory_file(file, raw)
    with closing(connect()) as con:
        try:
            with con:
                cur = con.execute(
                    "INSERT INTO directory_imports(file_sha256,kind,record_count,imported_by) VALUES(?,?,?,?)",
                    (digest(raw), kind, len(rows), user["id"]),
                )
                if kind == "user":
                    con.executemany(
                        """INSERT INTO staff(employee_code,device_name,origin,last_roster_sync)
                           VALUES(?,?,'user_export',CURRENT_TIMESTAMP)
                           ON CONFLICT(employee_code) DO UPDATE SET
                             device_name=excluded.device_name,
                             origin='user_export',
                             last_roster_sync=CURRENT_TIMESTAMP""",
                        [(row.employee_code, row.device_name) for row in rows],
                    )
                else:
                    con.executemany(
                        """INSERT INTO departments(department_code,device_name)
                           VALUES(?,?)
                           ON CONFLICT(department_code) DO UPDATE SET
                             device_name=excluded.device_name,
                             last_roster_sync=CURRENT_TIMESTAMP""",
                        [(row.department_code, row.department_name) for row in rows],
                    )
                con.execute(
                    "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                    (user["id"], "device_directory_import", "directory_import", cur.lastrowid,
                     kind + " metadata only; biometric templates ignored"),
                )
        except sqlite3.IntegrityError as exc:
            if "file_sha256" in str(exc):
                raise HTTPException(409, "This exact directory file was already imported.") from exc
            raise HTTPException(409, "Could not import directory metadata.") from exc
    return {"kind": kind, "count": len(rows), "message": "Directory metadata updated. K14 device unchanged."}


# ── Local numeric work-code labels. These DO NOT configure the K14. ─────────

@app.get("/api/work-codes")
def get_work_codes(user: dict = Depends(current_user)):
    with closing(connect()) as con:
        configured = [dict(x) for x in con.execute(
            "SELECT numeric_code,label,updated_at FROM work_code_mappings ORDER BY CAST(numeric_code AS INTEGER)"
        ).fetchall()]
        observed = [dict(x) for x in con.execute(
            """SELECT work_code AS numeric_code,COUNT(*) AS scan_count
               FROM punches GROUP BY work_code ORDER BY CAST(work_code AS INTEGER)"""
        ).fetchall()]
    return {"configured": configured, "observed": observed,
            "note": "Mappings are LOCAL labels only; they do not change device work codes or scans."}


@app.post("/api/work-codes")
def save_work_code(payload: WorkCodeInput, request: Request, user: dict = Depends(require_admin)):
    require_csrf(request)
    with closing(connect()) as con:
        with con:
            con.execute(
                """INSERT INTO work_code_mappings(numeric_code,label,created_by)
                   VALUES(?,?,?)
                   ON CONFLICT(numeric_code) DO UPDATE SET
                   label=excluded.label,updated_at=CURRENT_TIMESTAMP""",
                (payload.numeric_code, payload.label.strip(), user["id"]),
            )
            con.execute(
                "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                (user["id"], "work_code_label", "work_code_mappings", 0,
                 "Updated local label for numeric code " + payload.numeric_code),
            )
    return {"ok": True, "device_updated": False}
