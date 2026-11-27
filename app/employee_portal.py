"""Restricted employee document portal. Employee sessions never receive HR uid."""
from base64 import b64encode
from contextlib import closing
from io import BytesIO
from pathlib import Path
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from app.db import connect
from app.security import check_password
from app.aja_print import AjaPrintInput, build_aja_pdf

router = APIRouter()
ROOT = Path(__file__).resolve().parent

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
    return {"id": row["id"], "username": row["username"], "name": name,
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

class EmployeeAjaInput(BaseModel):
    model_config = {"extra": "forbid"}
    dates: str = Field(min_length=1, max_length=100)
    origin: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=500)
    departure: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    return_time: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")

    @field_validator("dates", "origin", "destination", "purpose", mode="before")
    @classmethod
    def tidy(cls, value):
        return " ".join(value.split()) if isinstance(value, str) else value

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

@router.post("/api/employee-portal/aja/preview")
def employee_aja_preview(payload: EmployeeAjaInput, request: Request, user=Depends(employee_user)):
    check_csrf(request)
    if not all(user[key].strip() for key in ("name", "position", "department")):
        raise HTTPException(400, "Ask HR to complete your name, position and department before preparing AJA.")
    form = AjaPrintInput(name=user["name"], position=user["position"], department=user["department"], **payload.model_dump())
    pdf = build_aja_pdf(form, ROOT / "aja-template.pdf")
    # Render the exact generated PDF, not an independent HTML reconstruction.
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    try:
        page = doc[0]
        try:
            bitmap = page.render(scale=2.5)
            try:
                image = BytesIO()
                bitmap.to_pil().save(image, format="PNG")
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        doc.close()
    return {"pdf": b64encode(pdf).decode("ascii"), "preview": b64encode(image.getvalue()).decode("ascii")}
