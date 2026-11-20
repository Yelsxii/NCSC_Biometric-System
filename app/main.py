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
from app.security import check_password
from app.reports import preview_k14_report

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
    sql = ("SELECT id,employee_code,happened_at,device_id,status_code,verification_code,work_code "
           "FROM punches ")
    args: list = []
    filters = []
    if employee_code:
        filters.append("employee_code=?")
        args.append(employee_code)
    if date_from:
        filters.append("happened_at>=?")
        args.append(date_from.isoformat())
    if date_to:
        filters.append("happened_at<?")
        args.append((date_to + dt.timedelta(days=1)).isoformat())
    where = "WHERE " + " AND ".join(filters) + " " if filters else ""
    sql += where + "ORDER BY happened_at DESC, id DESC LIMIT ? OFFSET ?"
    with closing(connect()) as con:
        total = con.execute("SELECT COUNT(*) FROM punches " + where, args).fetchone()[0]
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
        raise HTTPException(400, "Excel reports are preview-only. Import the original _attlog.dat source file.")
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
