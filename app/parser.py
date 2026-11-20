"""Strict, read-only parser for ZKTeco K14 USB attendance exports.

Status and verification codes are deliberately stored as raw codes. They are NOT
translated to IN/OUT until validated with the device's firmware/settings.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import re
from dataclasses import dataclass

MAX_BYTES = 2 * 1024 * 1024
MAX_LINES = 50000
CODE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


@dataclass(frozen=True)
class Punch:
    employee_code: str
    happened_at: str
    device_id: str
    status_code: str
    verification_code: str
    work_code: str


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def parse_attlog(raw: bytes) -> list[Punch]:
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Attendance log must be nonempty and under 2 MB.")
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            content = raw.decode("cp1252")
        except UnicodeDecodeError as exc:
            raise ValueError("Unsupported file encoding.") from exc

    lines = content.splitlines()
    if len(lines) > MAX_LINES:
        raise ValueError("Too many attendance records (limit 50,000).")
    results: list[Punch] = []
    for i, row in enumerate(lines, 1):
        if not row.strip():
            continue
        pieces = row.strip().split("\t")
        if len(pieces) != 6:
            raise ValueError(f"Line {i}: expected exactly six tab-separated fields.")
        emp, timestamp, device, status, verify, work = (v.strip() for v in pieces)
        if not CODE.fullmatch(emp) or not all(CODE.fullmatch(v) for v in (device, status, verify, work)):
            raise ValueError(f"Line {i}: one or more fields contain unsupported characters.")
        try:
            moment = dt.datetime.strptime(timestamp, "%Y-%m-%d %H:%M:%S")
        except ValueError as exc:
            raise ValueError(f"Line {i}: invalid timestamp.") from exc
        if not (2000 <= moment.year <= 2100):
            raise ValueError(f"Line {i}: timestamp is outside supported years.")
        results.append(Punch(emp, moment.isoformat(sep=" "), device, status, verify, work))
    if not results:
        raise ValueError("No attendance events found.")
    return results
