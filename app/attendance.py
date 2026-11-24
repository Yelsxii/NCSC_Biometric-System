"""Reviewed DTR slots reference original punches; they never rewrite them.

No numeric device status or work code is assumed to mean AM/PM In/Out.
Undertime is an explicitly reviewed value until office hours are confirmed.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from contextlib import closing
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.db import connect
from app.registry import clean
from app.dtr_sources import resolve_day
from app.holidays import national_holiday, VERIFIED_YEARS

SLOTS = ("am_in", "am_out", "pm_in", "pm_out")
ACTIVITIES = ("", "AJA", "Fieldwork", "Official Business", "Travel Order")


def valid_day(value: str) -> dt.date:
    try:
        day = dt.date.fromisoformat(value)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) or not 2000 <= day.year <= 2100:
            raise ValueError
        return day
    except ValueError as exc:
        raise HTTPException(400, "Use a valid date between 2000 and 2100.") from exc


class DayReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    am_in: int | None = Field(default=None, strict=True, gt=0)
    am_out: int | None = Field(default=None, strict=True, gt=0)
    pm_in: int | None = Field(default=None, strict=True, gt=0)
    pm_out: int | None = Field(default=None, strict=True, gt=0)
    undertime_minutes: int | None = Field(default=None, strict=True, ge=0, le=1440)
    activity_type: Literal["", "AJA", "Fieldwork", "Official Business", "Travel Order"] = ""
    activity_reference: str = Field(default="", max_length=140)
    remark: str = Field(default="", max_length=300)
    approved_times: dict[Literal["am_in","am_out","pm_in","pm_out","aja_out","aja_in"], str] | None = None

    @field_validator("activity_reference", "remark", mode="before")
    @classmethod
    def clean_text(cls, value):
        return clean(value, 300, "Daily review") if isinstance(value, str) else value

    @field_validator("approved_times")
    @classmethod
    def valid_approved_times(cls, values):
        if values is None:
            return values
        for clock in values.values():
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?", clock):
                raise ValueError("Use a valid 24-hour clock time.")
        return {key: clock if len(clock)==8 else clock+":00" for key,clock in values.items()}

    @model_validator(mode="after")
    def activity_needs_reference(self):
        if self.activity_type and not self.activity_reference:
            raise ValueError("Enter the existing activity reference.")
        if not self.activity_type and self.activity_reference:
            raise ValueError("Choose an activity for this reference.")
        return self


class CalendarInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    holiday_name: str = Field(default="", max_length=140)

    @field_validator("holiday_name", mode="before")
    @classmethod
    def clean_name(cls, value):
        return clean(value, 140, "Holiday name") if isinstance(value, str) else value


def save_day_review(employee_code: str, date: str, payload: DayReviewInput, actor_id: int) -> dict:
    valid_day(date)
    with closing(connect()) as con, con:
        con.execute("BEGIN IMMEDIATE")
        if not con.execute("SELECT 1 FROM employees WHERE employee_code=?", (employee_code,)).fetchone():
            raise HTTPException(404, "Employee not found.")
        previous = con.execute(
            "SELECT * FROM attendance_day_reviews WHERE employee_code=? AND attendance_date=?",
            (employee_code, date),
        ).fetchone()
        version = previous["version"] if previous else 0
        if payload.version != version:
            raise HTTPException(409, "This day changed. Reopen it before saving.")
        ids = [getattr(payload, slot) for slot in SLOTS if getattr(payload, slot) is not None]
        if len(ids) != len(set(ids)):
            raise HTTPException(400, "Choose a different entry for each time slot.")
        events = {}
        for event_id in ids:
            row = con.execute("SELECT employee_code,happened_at FROM punches WHERE id=?", (event_id,)).fetchone()
            if row is None or row["employee_code"] != employee_code or row["happened_at"][:10] != date:
                raise HTTPException(400, "Select an entry from this employee and date.")
            events[event_id] = row["happened_at"]
        times = [events[getattr(payload, slot)] for slot in SLOTS if getattr(payload, slot) is not None]
        if times != sorted(times):
            raise HTTPException(400, "Time slots must follow AM In, AM Out, PM In, PM Out order.")
        for start, end in (("am_in", "am_out"), ("pm_in", "pm_out")):
            if getattr(payload, start) and getattr(payload, end):
                if events[getattr(payload, start)] >= events[getattr(payload, end)]:
                    raise HTTPException(400, "Time out must be later than time in.")
        old_times = json.loads(previous["approved_times"]) if previous else {}
        approved = old_times if payload.approved_times is None else payload.approved_times
        if approved != old_times and not payload.remark:
            raise HTTPException(400, "Enter the HR-approved adjustment reason.")
        now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
        if approved != old_times and any(date+" "+clock > now for clock in approved.values()):
            raise HTTPException(400, "Approved times cannot be in the future.")
        effective = [date+" "+approved[k] if k in approved else events.get(getattr(payload,k)) for k in SLOTS]
        chosen = [x for x in effective if x]
        if chosen != sorted(chosen):
            raise HTTPException(400, "Approved regular slots must be in chronological order.")
        for a,b in ((0,1),(2,3)):
            if effective[a] and effective[b] and effective[a]>=effective[b]:
                raise HTTPException(400, "Time out must be later than time in.")
        if approved.get("aja_out") and approved.get("aja_in") and approved["aja_out"]>=approved["aja_in"]:
            raise HTTPException(400, "AJA end must be later than departure.")
        data = payload.model_dump(exclude={"version"})
        data["approved_times"] = approved
        con.execute(
            """INSERT INTO attendance_day_reviews
               (employee_code,attendance_date,am_in,am_out,pm_in,pm_out,undertime_minutes,
                activity_type,activity_reference,remark,approved_times,version,reviewed_by)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(employee_code,attendance_date) DO UPDATE SET
                 am_in=excluded.am_in,am_out=excluded.am_out,pm_in=excluded.pm_in,pm_out=excluded.pm_out,
                 undertime_minutes=excluded.undertime_minutes,activity_type=excluded.activity_type,
                 activity_reference=excluded.activity_reference,remark=excluded.remark,approved_times=excluded.approved_times,
                 version=excluded.version,reviewed_by=excluded.reviewed_by,reviewed_at=CURRENT_TIMESTAMP""",
            (employee_code, date, *(getattr(payload, slot) for slot in SLOTS), payload.undertime_minutes,
             payload.activity_type, payload.activity_reference, payload.remark, json.dumps(approved), version + 1, actor_id),
        )
        con.execute(
            "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
            (actor_id, "reviewed", "attendance_day", json.dumps({
                "employee_code": employee_code, "date": date,
                "before": dict(previous) if previous else None, "after": data,
            })),
        )
    return {"ok": True, "version": version + 1}


def save_calendar(date: str, payload: CalendarInput, actor_id: int) -> dict:
    valid_day(date)
    with closing(connect()) as con, con:
        con.execute("BEGIN IMMEDIATE")
        old = con.execute("SELECT * FROM attendance_calendar WHERE attendance_date=?", (date,)).fetchone()
        version = old["version"] if old else 0
        if payload.version != version:
            raise HTTPException(409, "This calendar date changed. Reload before saving.")
        con.execute(
            """INSERT INTO attendance_calendar(attendance_date,holiday_name,version,updated_by) VALUES(?,?,?,?)
               ON CONFLICT(attendance_date) DO UPDATE SET holiday_name=excluded.holiday_name,
               version=excluded.version,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP""",
            (date, payload.holiday_name, version + 1, actor_id),
        )
        con.execute(
            "INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,0,?)",
            (actor_id, "updated", "attendance_calendar", json.dumps({
                "date": date, "before": dict(old) if old else None, "holiday_name": payload.holiday_name,
            })),
        )
    return {"ok": True, "version": version + 1}


def decorate_days(employee_code: str, days: list[dict]) -> None:
    """Add DTR presentation fields without changing legacy evidence fields."""
    with closing(connect()) as con:
        reviews = {r["attendance_date"]: dict(r) for r in con.execute(
            "SELECT * FROM attendance_day_reviews WHERE employee_code=? AND attendance_date BETWEEN ? AND ?",
            (employee_code, days[0]["date"], days[-1]["date"]),
        )}
        dates = {r["attendance_date"]: dict(r) for r in con.execute(
            "SELECT * FROM attendance_calendar WHERE attendance_date BETWEEN ? AND ?",
            (days[0]["date"], days[-1]["date"]),
        )}
        manual = {r["attendance_date"]: {"data": json.loads(r["normalized_json"]), "name": r["source_name"],
                  "sheet": r["sheet_key"], "row": r["source_row"]} for r in con.execute(
            "SELECT * FROM manual_dtr_entries WHERE employee_code=? AND attendance_date BETWEEN ? AND ?",
            (employee_code, days[0]["date"], days[-1]["date"]),
        )}
    # Manila uses UTC+08:00; do not depend on an optional Windows tzdata package.
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
    for day in days:
        review = reviews.get(day["date"], {})
        calendar = dates.get(day["date"], {"holiday_name": national_holiday(day["date"]), "version": 0})
        day["calendar_verified"] = int(day["date"][:4]) in VERIFIED_YEARS
        events = {event["id"]: event for event in day["scans"]}
        day["slots"] = {slot: events.get(review.get(slot)) for slot in SLOTS}
        chosen = {event["id"] for event in day["slots"].values() if event}
        day["unassigned_count"] = len(events.keys() - chosen)
        day["review"] = {key: review.get(key, default) for key, default in (
            ("version", 0), ("undertime_minutes", None), ("activity_type", ""),
            ("activity_reference", ""), ("remark", ""),
        )}
        day["review"]["approved_times"] = json.loads(review.get("approved_times","{}"))
        day["calendar"] = {"holiday_name": calendar.get("holiday_name", ""), "version": calendar.get("version", 0)}
        activities = [{"category": x["category"], "reference": x["reference"]} for x in day["activities"]]
        for event in day["scans"]:
            if event["activity_type"] in ACTIVITIES[1:]:
                activities.append({"category": event["activity_type"], "reference": event["work_label"] or ""})
        if review.get("activity_type"):
            activities.append({"category": review["activity_type"], "reference": review["activity_reference"]})
        day["display_activities"] = list({(x["category"], x["reference"]): x for x in activities}.values())
        categories = {x["category"] for x in activities}
        weekend = dt.date.fromisoformat(day["date"]).weekday() >= 5
        day["is_future"] = day["date"] > today
        day["is_weekend"] = weekend
        day["tone"] = (
            "holiday" if calendar.get("holiday_name") else
            "travel" if "Travel Order" in categories else
            "aja" if "AJA" in categories else
            "entry" if events else
            "future" if day["is_future"] else "weekend" if weekend else "missing"
        )
        # GIP's printable form totals elapsed AM + PM only when all four
        # reviewed slots exist. This is not an automatic attendance credit.
        seconds = None
        if all(day["slots"].values()):
            stamp = {slot: dt.datetime.fromisoformat(event["happened_at"])
                     for slot, event in day["slots"].items()}
            seconds = int(((stamp["am_out"] - stamp["am_in"]) +
                           (stamp["pm_out"] - stamp["pm_in"])).total_seconds())
        day["daily_total_seconds"] = seconds
        resolve_day(day, manual.get(day["date"]))
