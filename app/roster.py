"""Safe, read-only roster metadata extraction for the observed K14 USB exports.

Observed device format from the supplied sample:
  user.dat       : 72 bytes per record; device UID [0:2], name [11:35], PIN [48:72].
  department.dat : 49 bytes per record; department number [0], label [1:49].

These formats are NOT universal. Fail closed when file layout doesn't match.
Never parse, load, persist or request fingerprint template files (*.fp10).
The user.dat file may contain other sensitive bytes (e.g. enrollment/password
metadata): this parser deliberately extracts ONLY name + personnel PIN.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

MAX_ROSTER_BYTES = 1024 * 1024
USER_RECORD_LENGTH = 72
DEPARTMENT_RECORD_LENGTH = 49
EMPLOYEE_CODE = re.compile(r"^[A-Za-z0-9._-]{1,24}$")


@dataclass(frozen=True)
class DeviceStaff:
    employee_code: str
    device_name: str


@dataclass(frozen=True)
class DeviceDepartment:
    department_code: str
    department_name: str


def _validate(raw: bytes, stride: int, kind: str) -> None:
    if not raw or len(raw) > MAX_ROSTER_BYTES or len(raw) % stride:
        raise ValueError(f"{kind}: unexpected binary format or file size; expected fixed {stride}-byte records.")
    if len(raw) // stride > 10000:
        raise ValueError("Too many directory entries.")


def _name(raw: bytes, record_no: int) -> str:
    value = raw.split(b"\x00", 1)[0]
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError:
        text = value.decode("cp1252")
    text = text.strip()
    if not text or any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise ValueError(f"Record {record_no}: invalid name/label.")
    return text


def parse_user_dat(raw: bytes) -> list[DeviceStaff]:
    """Import names and employee IDs ONLY; ignore every other binary field."""
    _validate(raw, USER_RECORD_LENGTH, "user.dat")
    rows: list[DeviceStaff] = []
    seen = set()
    for index, start in enumerate(range(0, len(raw), USER_RECORD_LENGTH), 1):
        record = raw[start:start + USER_RECORD_LENGTH]
        internal_uid = int.from_bytes(record[:2], "little")
        code_bytes = record[48:72].split(b"\x00", 1)[0]
        try:
            code = code_bytes.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ValueError(f"Record {index}: invalid employee ID encoding.") from exc
        if internal_uid == 0 or not EMPLOYEE_CODE.fullmatch(code):
            raise ValueError(f"Record {index}: unsupported user.dat record layout.")
        # In this firmware's observed export, the PIN matches the numeric internal
        # UID; require this as a sanity check so incompatible binary layouts fail.
        if code != str(internal_uid):
            raise ValueError(f"Record {index}: this device's user.dat layout is not recognized.")
        if code in seen:
            raise ValueError(f"Record {index}: duplicate employee ID.")
        seen.add(code)
        rows.append(DeviceStaff(code, _name(record[11:35], index)))
    return rows


def parse_department_dat(raw: bytes) -> list[DeviceDepartment]:
    """Read department labels; association with users is not present/verified."""
    _validate(raw, DEPARTMENT_RECORD_LENGTH, "department.dat")
    rows: list[DeviceDepartment] = []
    seen = set()
    for index, start in enumerate(range(0, len(raw), DEPARTMENT_RECORD_LENGTH), 1):
        record = raw[start:start + DEPARTMENT_RECORD_LENGTH]
        code = str(record[0])
        if record[0] == 0 or code in seen:
            raise ValueError(f"Record {index}: unsupported/duplicate department identifier.")
        seen.add(code)
        rows.append(DeviceDepartment(code, _name(record[1:49], index)))
    return rows
