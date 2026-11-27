"""Print-only AJA pilot. Preserve the original Folio PDF artwork and signatures."""
import os
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
        raise HTTPException(503, "Export the original AJA Word document as PDF and save it as app/aja-template.pdf.")
    try:
        import pdfplumber
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import simpleSplit
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except ImportError as exc:
        raise HTTPException(503, "Install the updated requirements in the website virtual environment.") from exc
    reader = PdfReader(str(template))
    if len(reader.pages) != 1:
        raise HTTPException(503, "Expected the original one-page AJA form.")
    page = reader.pages[0]
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    if abs(w - 612) > 1 or abs(h - 936) > 1 or page.rotation:
        raise HTTPException(503, "Expected portrait Folio paper (8.5 x 13 inches).")

    # Resolve the actual Word PDF table geometry; never reconstruct the header,
    # logos, margins, signature block or Certificate of Appearance.
    with pdfplumber.open(str(template)) as source:
        sheet = source.pages[0]
        fonts = {str(ch.get("fontname", "")).lower() for ch in sheet.chars}
        if any(any(alias in font for alias in ("notosans", "notoserif", "carlito", "liberationsans")) for font in fonts):
            raise HTTPException(503, "The installed AJA PDF contains substituted fonts. Export AJA blank.doc directly from Microsoft Word and replace app/aja-template.pdf.")
        tables = sheet.find_tables({"snap_tolerance": 3, "join_tolerance": 3, "intersection_tolerance": 4})
        def table_text(table):
            return " ".join((cell or "") for row in table.extract() for cell in row).upper()
        info = next((t for t in tables if "POSITION" in table_text(t) and "DEPARTMENT" in table_text(t) and "OFFICIAL BUSINESS" in table_text(t)), None)
        trip = next((t for t in tables if "ITINERARY" in table_text(t) and "DEPARTURE" in table_text(t) and "RETURN" in table_text(t)), None)
        if not info or not trip or len(info.rows) != 2 or any(len(row.cells) != 2 or any(cell is None for cell in row.cells) for row in info.rows) or len(trip.rows[-1].cells) != 5 or any(cell is None for cell in trip.rows[-1].cells):
            raise HTTPException(503, "Could not identify the official AJA table cells. Use the original Word PDF without changing its layout.")
        def chars_in(cell):
            return [ch for ch in sheet.crop(cell).chars if ch["text"].strip()]
        info_cells = [cell for row in info.rows for cell in row.cells]
        trip_cells = trip.rows[-1].cells
        info_chars = [chars_in(cell) for cell in info_cells]
        # Match the actual blank department placeholder, not a guessed rectangle.
        underscores = [ch for ch in info_chars[2] if ch["text"] == "_"]
        if not underscores:
            raise HTTPException(503, "The original department placeholder could not be found in the Word PDF.")
        dept_box = (min(ch["x0"] for ch in underscores), min(ch["top"] for ch in underscores),
                    max(ch["x1"] for ch in underscores), max(ch["bottom"] for ch in underscores))

    # Use the original body font from the Windows host. Do not silently substitute.
    font_path = Path(os.environ.get("AJA_ARIAL_FONT", str(Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arial.ttf")))
    if not font_path.is_file():
        raise HTTPException(503, "Arial is required for the original AJA form. Check the Windows Arial font installation.")
    font = "AJA-Arial"
    if font not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font, str(font_path)))
    overlay = BytesIO()
    c = canvas.Canvas(overlay, pagesize=(w, h))
    size = 10
    c.setFont(font, size)

    def put(text, x, baseline, right, bottom, label, lines=1, center=False):
        width = right - x
        wrapped = simpleSplit(text, font, size, width)
        if (not wrapped or len(wrapped) > lines or baseline + (len(wrapped)-1)*12 + 3 > bottom
                or any(c.stringWidth(line, font, size) > width for line in wrapped)):
            raise HTTPException(400, f"{label} is too long for the original form. Please shorten it.")
        c.setFillColorRGB(0, 0, 0)
        for i, line in enumerate(wrapped):
            if center:
                c.drawCentredString((x + right)/2, h - baseline - i*12, line)
            else:
                c.drawString(x, h - baseline - i*12, line)

    for index, value, label in [(0, data.name, "Name"), (1, data.position, "Position"), (3, data.dates, "Dates")]:
        x0, top, x1, bottom = info_cells[index]
        chars = info_chars[index]
        if not chars:
            raise HTTPException(503, "Original AJA labels are missing.")
        left = min(ch["x0"] for ch in chars)
        label_bottom = max(ch["bottom"] for ch in chars)
        put(value, left, label_bottom+10, x1-5, bottom-1, label)

    dx0, dy0, dx1, dy1 = dept_box
    dept = data.department
    if dept.upper().startswith("NCSC-RO1/"):
        dept = dept[len("NCSC-RO1/"):].strip()
    c.setFillColorRGB(1,1,1)
    c.rect(dx0, h-dy1-1, dx1-dx0+0.5, dy1-dy0+2, stroke=0, fill=1)
    put(dept, dx0, dy1-2, info_cells[2][2]-5, info_cells[2][3]-1, "Department")

    for index, (value, label) in enumerate([(data.origin, "From"), (data.destination, "To"),
             (data.purpose, "Purpose"), (data.departure, "Departure"), (data.return_time, "Return")]):
        x0, top, x1, bottom = trip_cells[index]
        put(value, x0+5, top+14, x1-5, bottom-3, label,
            lines=1 if index >= 3 else 5, center=index >= 3)

    # The original Word PDF is the background of both preview and download.
    # All approval and appearance-certification fields remain unsigned.
    c.showPage()
    c.save()
    overlay.seek(0)
    page.merge_page(PdfReader(overlay).pages[0])
    writer = PdfWriter()
    writer.add_page(page)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
