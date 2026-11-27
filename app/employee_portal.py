"""Restricted employee document portal. Employee sessions never receive HR uid."""
from base64 import b64encode
from contextlib import closing
from datetime import date as CalendarDate, timedelta
from io import BytesIO
from pathlib import Path
import secrets
import threading
import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from app.db import connect
from app.security import check_password
from app.aja_print import AjaPrintInput, build_aja_pdf

router = APIRouter()
ROOT = Path(__file__).resolve().parent
_PDF_RENDER_LOCK = threading.Lock()

def employee_identity(con, account_id):
    row = con.execute("""
        SELECT a.id, a.username, e.employee_code, e.display_name, e.department,
               p.first_name, p.middle_name, p.last_name, p.suffix, p.position
        FROM employee_portal_accounts a
        JOIN employees e ON e.employee_code=a.employee_code
        LEFT JOIN employee_profiles p ON p.employee_code=e.employee_code
        WHERE a.id=? AND a.enabled=1 AND NOT EXISTS
          (SELECT 1 FROM employee_directory_archive ar WHERE ar.employee_code=e.employee_code)
    """, (account_id,)).fetchone()
    if not row:
        return None
    middle = (row["middle_name"] or "").strip()
    first = (row["first_name"] or "").strip()
    last = (row["last_name"] or "").strip()
    suffix = (row["suffix"] or "").strip()
    name = (last + ", " + " ".join(part for part in
            (first, middle[0] + "." if middle else "", suffix) if part)) if first and last else row["display_name"]
    return {"id": row["id"], "employee_code": row["employee_code"], "username": row["username"], "name": name,
            "position": row["position"] or "", "department": row["department"] or ""}

def employee_user(request: Request):
    account_id = request.session.get("employee_uid")
    if not isinstance(account_id, int) or "uid" in request.session:
        raise HTTPException(401, "Employee sign-in required.")
    with closing(connect()) as con:
        identity = employee_identity(con, account_id)
    if not identity:
        request.session.clear()
        raise HTTPException(401, "Employee account unavailable.")
    return identity

def check_csrf(request):
    expected = request.session.get("employee_csrf")
    given = request.headers.get("x-csrf-token")
    if not expected or not given or not secrets.compare_digest(expected, given):
        raise HTTPException(403, "Invalid session token. Sign in again.")

class EmployeeLogin(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=256)

class AjaDay(BaseModel):
    model_config = {"extra": "forbid"}
    date: CalendarDate
    departure: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    return_time: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")

    @model_validator(mode="after")
    def check_schedule(self):
        if self.return_time <= self.departure:
            raise ValueError("Return must be after departure on each selected date. Overnight trips require HR review.")
        return self


class EmployeeAjaInput(BaseModel):
    model_config = {"extra": "forbid"}
    days: list[AjaDay] = Field(min_length=1, max_length=14)
    origin: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=500)

    @field_validator("origin", "destination", "purpose", mode="before")
    @classmethod
    def tidy(cls, value):
        return " ".join(value.split()) if isinstance(value, str) else value

    @model_validator(mode="after")
    def unique_dates(self):
        if len({day.date for day in self.days}) != len(self.days):
            raise ValueError("Select each date only once.")
        self.days.sort(key=lambda day: day.date)
        return self


def print_date(day):
    return f"{day.strftime('%b')} {day.day}, {day.year}"


def format_dates(days):
    """Compact explicit dates, with ranges only for consecutive selected days."""
    ranges = []
    for day in sorted(days):
        if ranges and day == ranges[-1][1] + timedelta(days=1):
            ranges[-1][1] = day
        else:
            ranges.append([day, day])
    parts = []
    for first, last in ranges:
        if first == last:
            parts.append(print_date(first))
        elif (first.year, first.month) == (last.year, last.month):
            parts.append(f"{first.strftime('%b')} {first.day}-{last.day}, {first.year}")
        else:
            parts.append(f"{print_date(first)} - {print_date(last)}")
    return "; ".join(parts)


def aja_print_batches(days):
    """Only a continuous date range with one identical schedule shares a form."""
    ordered = sorted(days, key=lambda day: day.date)
    first = ordered[0]
    consecutive = all(b.date - a.date == timedelta(days=1)
                      for a, b in zip(ordered, ordered[1:]))
    same_times = all((day.departure, day.return_time) ==
                     (first.departure, first.return_time) for day in ordered)
    if consecutive and same_times:
        return [(first.departure, first.return_time, [day.date for day in ordered])]
    return [(day.departure, day.return_time, [day.date]) for day in ordered]


def build_aja_packet(payload, user, template):
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    def render(dates, departure, return_time):
        data = AjaPrintInput(name=user["name"], position=user["position"],
            department=user["department"], dates=dates, origin=payload.origin,
            destination=payload.destination, purpose=payload.purpose,
            departure=departure, return_time=return_time)
        return build_aja_pdf(data, template)
    # Nonconsecutive dates always receive their own signed forms, regardless
    # of the amount of space in the printed date cell.
    for departure, return_time, dates in aja_print_batches(payload.days):
        label = format_dates(dates)
        pages = []
        if len(label) <= 100:
            try:
                pages.append(render(label, departure, return_time))
            except HTTPException as exc:
                if len(dates)==1 or exc.status_code!=400 or not str(exc.detail).startswith("Dates is too long"):
                    raise
        if not pages:
            pages = [render(print_date(day), departure, return_time) for day in dates]
        for pdf in pages:
            writer.append(PdfReader(BytesIO(pdf)))
    output = BytesIO()
    writer.write(output)
    return output.getvalue()

@router.get("/employee")
def employee_home():
    return FileResponse(ROOT / "employee.html", headers={"Cache-Control":"no-store"})

@router.post("/api/employee-portal/login")
def employee_login(payload: EmployeeLogin, request: Request):
    with closing(connect()) as con:
        row = con.execute("SELECT id,password_hash FROM employee_portal_accounts WHERE username=? AND enabled=1",
                          (payload.username.strip().lower(),)).fetchone()
        if not row or not check_password(payload.password, row["password_hash"]):
            raise HTTPException(401, "Invalid employee username or password.")
        identity = employee_identity(con, row["id"])
    if not identity:
        raise HTTPException(401, "Employee account unavailable.")
    request.session.clear()
    request.session["employee_uid"] = row["id"]
    request.session["employee_csrf"] = secrets.token_urlsafe(32)
    return {"name": identity["name"], "position": identity["position"], "department": identity["department"],
            "csrf": request.session["employee_csrf"]}

@router.get("/api/employee-portal/me")
def employee_me(request: Request, user=Depends(employee_user)):
    return {"name": user["name"], "position": user["position"], "department": user["department"],
            "csrf": request.session.get("employee_csrf")}

@router.post("/api/employee-portal/logout")
def employee_logout(request: Request, user=Depends(employee_user)):
    check_csrf(request)
    request.session.clear()
    return {"ok": True}

def render_saved_pdf(pdf):
    # Render the original saved PDF, not an independent HTML reconstruction.
    import pypdfium2 as pdfium
    with _PDF_RENDER_LOCK:
        doc = pdfium.PdfDocument(pdf)
        try:
            previews = []
            for index in range(len(doc)):
                page = doc[index]
                try:
                    bitmap = page.render(scale=2.5)
                    try:
                        image = BytesIO()
                        bitmap.to_pil().save(image, format="PNG")
                        previews.append(b64encode(image.getvalue()).decode("ascii"))
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        finally:
            doc.close()
    return {"pdf": b64encode(pdf).decode("ascii"), "previews": previews}


def filing_metadata(con, row):
    days = [dict(day) for day in con.execute(
        "SELECT business_date AS date,departure,return_time FROM aja_filing_days WHERE filing_id=? ORDER BY business_date",
        (row["id"],))]
    return {key: row[key] for key in ("reference", "employee_name", "origin", "destination", "purpose", "status", "filed_at")} | {"days": days}


@router.post("/api/employee-portal/aja/file")
def employee_aja_file(payload: EmployeeAjaInput, request: Request, response: Response, user=Depends(employee_user)):
    response.headers['Cache-Control'] = 'no-store'
    check_csrf(request)
    if not all(user[key].strip() for key in ("name", "position", "department")):
        raise HTTPException(400, "Ask HR to complete your name, position and department before filing AJA.")
    fingerprint = hashlib.sha256(json.dumps(payload.model_dump(mode="json"), sort_keys=True,
        ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    # Validate against the original template before writing a new filing.
    # Identical retries reopen the original immutable document, rather than filing twice.
    with closing(connect()) as con:
        row = con.execute("SELECT * FROM aja_filings WHERE employee_code=? AND fingerprint=?",
                          (user["employee_code"], fingerprint)).fetchone()
        if row:
            return {"filing": filing_metadata(con, row), "already_filed": True}
    pdf = build_aja_packet(payload, user, ROOT / "aja-template.pdf")
    # Preflight page rendering before accepting a filing.
    render_saved_pdf(pdf)
    with closing(connect()) as con, con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM aja_filings WHERE employee_code=? AND fingerprint=?",
                          (user["employee_code"], fingerprint)).fetchone()
        if row:
            return {"filing": filing_metadata(con, row), "already_filed": True}
        # Do not silently file conflicting schedules for the same employee/date.
        for day in payload.days:
            overlap = con.execute("""SELECT f.reference FROM aja_filing_days d
                JOIN aja_filings f ON f.id=d.filing_id
                WHERE f.employee_code=? AND d.business_date=? AND d.departure<? AND d.return_time>?
                LIMIT 1""", (user["employee_code"], day.date.isoformat(), day.return_time, day.departure)).fetchone()
            if overlap:
                raise HTTPException(409, f"An overlapping AJA is already filed for {day.date.isoformat()} ({overlap['reference']}).")
        reference = "AJA-" + secrets.token_hex(8).upper()
        cursor = con.execute("""INSERT INTO aja_filings(employee_code,reference,fingerprint,employee_name,
            position,department,origin,destination,purpose,pdf) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (user["employee_code"],reference,fingerprint,user["name"],user["position"],user["department"],
             payload.origin,payload.destination,payload.purpose,pdf))
        con.executemany("INSERT INTO aja_filing_days(filing_id,business_date,departure,return_time) VALUES(?,?,?,?)",
            [(cursor.lastrowid,day.date.isoformat(),day.departure,day.return_time) for day in payload.days])
        row = con.execute("SELECT * FROM aja_filings WHERE id=?", (cursor.lastrowid,)).fetchone()
        return {"filing": filing_metadata(con, row), "already_filed": False}


@router.get("/api/employee-portal/aja/filings")
def employee_aja_filings(response: Response, user=Depends(employee_user)):
    response.headers['Cache-Control'] = 'no-store'
    with closing(connect()) as con:
        rows = con.execute("""SELECT id,reference,employee_name,origin,destination,purpose,status,filed_at
            FROM aja_filings WHERE employee_code=? ORDER BY id DESC""",
            (user["employee_code"],)).fetchall()
        return {"filings": [filing_metadata(con, row) for row in rows]}


@router.get("/api/employee-portal/aja/filings/{reference}/document")
def employee_aja_document(reference: str, response: Response, user=Depends(employee_user)):
    response.headers['Cache-Control'] = 'no-store'
    with closing(connect()) as con:
        row = con.execute("SELECT * FROM aja_filings WHERE reference=? AND employee_code=?",
                          (reference,user["employee_code"])).fetchone()
        if not row:
            raise HTTPException(404, "AJA filing not found.")
        metadata = filing_metadata(con, row)
        pdf = row["pdf"]
    return {"filing": metadata, **render_saved_pdf(pdf)}


@router.get("/api/employee-portal/aja/filings/{reference}/pdf")
def employee_aja_download(reference: str, user=Depends(employee_user)):
    with closing(connect()) as con:
        row = con.execute("SELECT reference,pdf FROM aja_filings WHERE reference=? AND employee_code=?",
                          (reference, user["employee_code"])).fetchone()
        if not row:
            raise HTTPException(404, "AJA filing not found.")
        return Response(content=row["pdf"], media_type="application/pdf", headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{row["reference"]}.pdf"'
        })
