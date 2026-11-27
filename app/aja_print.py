"""Print-only AJA pilot. Preserve the original Folio PDF artwork and signatures."""
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator


class AjaPrintInput(BaseModel):
    name: str = Field(min_length=1, max_length=140)
    position: str = Field(min_length=1, max_length=140)
    department: str = Field(min_length=1, max_length=140)
    dates: str = Field(min_length=1, max_length=100)
    origin: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=500)
    departure: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    return_time: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")

    @field_validator("name", "position", "department", "dates", "origin", "destination", "purpose", mode="before")
    @classmethod
    def tidy(cls, value):
        if isinstance(value, str):
            return " ".join(value.split())
        return value


def build_aja_pdf(data: AjaPrintInput, template: Path) -> bytes:
    if not template.is_file():
        raise HTTPException(503, "AJA template is not installed. Copy aja-template.pdf into the app folder.")
    try:
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import simpleSplit
    except ImportError as exc:
        raise HTTPException(503, "Install pypdf and reportlab in the website virtual environment.") from exc
    reader = PdfReader(str(template))
    if len(reader.pages) != 1:
        raise HTTPException(503, "Unexpected AJA template: expected one Folio page.")
    page = reader.pages[0]
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    if abs(w - 612) > 1 or abs(h - 936) > 1:
        raise HTTPException(503, "Unexpected AJA template dimensions.")
    overlay = BytesIO()
    c = canvas.Canvas(overlay, pagesize=(w,h))
    def put(text, x, y, width, lines, label, size=10):
        # Keep the original form's 10pt body style; refuse overflow instead of clipping.
        try:
            text.encode("cp1252")
        except UnicodeEncodeError as exc:
            raise HTTPException(400, f"{label}: use characters supported by the printable form.") from exc
        wrapped = simpleSplit(text, "Helvetica", size, width)
        if len(wrapped) > lines or any(c.stringWidth(line, "Helvetica", size) > width for line in wrapped):
            raise HTTPException(400, f"{label} is too long for the official form. Please shorten it.")
        c.setFont("Helvetica", size)
        c.setFillColorRGB(0,0,0)
        for i, line in enumerate(wrapped):
            c.drawString(x, h-y-i*(size+2), line)
    put(data.name, 90, 183, 260, 1, "Name")
    put(data.position, 362, 183, 182, 1, "Position")
    # Replace only the template's blank underline, leaving the NCSC-RO1/ prefix intact.
    c.setFillColorRGB(1,1,1)
    c.rect(144, h-218, 35, 13, stroke=0, fill=1)
    dept = data.department
    if dept.upper().startswith("NCSC-RO1/"):
        dept = dept[9:].strip()
    put(dept, 145, 214, 205, 1, "Department")
    put(data.dates, 362, 214, 182, 1, "Dates")
    put(data.origin, 90, 275, 100, 5, "From")
    put(data.destination, 202, 275, 85, 5, "To")
    put(data.purpose, 299, 275, 130, 5, "Purpose")
    put(data.departure, 441, 275, 46, 1, "Departure")
    put(data.return_time, 499, 275, 46, 1, "Return")
    # The Certificate of Appearance and all signatures stay blank:
    # a receiving office must certify actual appearance, not the software.
    c.showPage()
    c.save()
    overlay.seek(0)
    page.merge_page(PdfReader(overlay).pages[0])
    writer = PdfWriter()
    writer.add_page(page)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
