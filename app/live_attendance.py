"""Read-only, evidence-based status for the current Manila calendar day."""
from __future__ import annotations

import datetime as dt
import re

LABELS = {"in": "Timed in", "out": "Timed out", "aja": "On AJA",
          "travel": "Travel Order", "missing": "No entry", "review": "For review",
          "offday": "Non-working day"}
OFFICIAL = {"AJA", "Travel Order", "Fieldwork", "Official Business"}
SLOT_LABELS = {"am_in": "AM IN", "am_out": "AM OUT", "pm_in": "PM IN", "pm_out": "PM OUT"}


def _stamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value)
        if parsed.tzinfo:
            parsed = parsed.astimezone(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None)
        return parsed
    except (TypeError, ValueError):
        return None


def live_status(day, now, arrival_time=""):
    """Never infer direction from punch order, or presence from an expired plan."""
    date = day["date"]
    events = []
    def record(value, kind, reason, update="For review"):
        stamp = _stamp(value)
        if stamp and stamp.date() == now.date() and stamp <= now:
            events.append((stamp, kind, reason, update))

    def result(kind, stamp=None, reason="", label=None, update=None):
        return {"status": kind, "label": label or LABELS[kind],
                "at": stamp.isoformat(sep=" ") if stamp else None, "reason": reason,
                "last_update": update}

    activities = day.get("activities", [])
    for category, kind in (("Travel Order", "travel"), ("AJA", "aja")):
        active = []
        for activity in activities:
            if activity.get("category") != category:
                continue
            start, end = _stamp(activity.get("start_at")), _stamp(activity.get("end_at"))
            if start and end and start <= now < end:
                active.append(start)
        if category == "Travel Order" and active:
            return result(kind, max(active), "Within recorded Travel Order coverage; not proof of physical location.", update="Travel Order")

    travel_records = [a for a in activities if a.get("category") == "Travel Order"]
    manual = day.get("manual_source") or {}
    review = day.get("review") or {}
    full_day_travel = review.get("activity_type") == "Travel Order" or any(
        re.search(r"\bTRAVEL\s+ORDER\b", note, re.I) for note in manual.get("notes", []))
    if full_day_travel and not travel_records:
        return result("travel", reason="Documented full-day Travel Order; no precise event time.", update="Travel Order")

    # Explicitly reviewed selections and approved time adjustments are trusted.
    chosen = {}
    for slot, event in (day.get("display_slots") or {}).items():
        if not event:
            continue
        if event.get("origin") == "reviewed" and event.get("id") is not None:
            chosen[event["id"]] = slot
        if event.get("origin") == "hr_approved":
            record(event.get("happened_at"), "in" if slot.endswith("_in") else "out", "HR-approved recorded time.", SLOT_LABELS.get(slot, "For review"))
        elif event.get("origin") == "manual_sheet":
            record(event.get("happened_at"), "review", "Manual DTR evidence; no verified live punch direction.", SLOT_LABELS.get(slot, "For review"))

    for scan in day.get("scans", []):
        stamp = scan.get("happened_at")
        category = scan.get("activity_type")
        if scan.get("work_code_conflict") or scan.get("work_code_pending"):
            record(stamp, "review", "Work code is conflicting or awaiting synchronization.")
        elif category == "AJA":
            direction = scan.get("work_direction")
            record(stamp, "aja" if direction == "OUT" else "in" if direction == "IN" else "review",
                   "Recorded AJA departure; return not yet confirmed." if direction == "OUT" else
                   "Recorded AJA return." if direction == "IN" else "Unverified AJA direction.",
                   "AJA OUT" if direction == "OUT" else "AJA IN" if direction == "IN" else "For review")
        elif category in OFFICIAL:
            record(stamp, "review", "Official activity scan without confirmed current interval.")
        else:
            slot = chosen.get(scan.get("id")) or scan.get("verified_slot")
            kind = "in" if slot in ("am_in", "pm_in") else "out" if slot in ("am_out", "pm_out") else "review"
            record(stamp, kind, "Verified or reviewed attendance direction." if kind != "review" else "Unverified punch direction.",
                   SLOT_LABELS.get(slot, "For review"))

    # A timed AJA reference is coverage, not a fingerprint. A verified return
    # or later verified regular punch takes precedence over that reference.
    for activity in activities:
        if activity.get("category") != "AJA":
            continue
        start, end = _stamp(activity.get("start_at")), _stamp(activity.get("end_at"))
        if start and end and start <= now < end:
            events.append((start, "aja", "Within recorded AJA coverage; not proof of physical location.", "AJA"))
    for period in day.get("aja_periods", []):
        departure, returned = period.get("out"), period.get("in")
        if departure and departure.get("origin") in ("manual_sheet", "hr_approved", "activity_reference"):
            start = _stamp(date + " " + departure["time"])
            end = _stamp(date + " " + returned["time"]) if returned else None
            if start and end and start <= now < end:
                events.append((start, "aja", "Within documented AJA interval.", "AJA"))
            elif start and start <= now and not end:
                events.append((start, "review", "AJA end is not confirmed.", "For review"))
        if returned and returned.get("origin") == "hr_approved":
            record(date + " " + returned["time"], "in", "HR-approved AJA return.", "AJA IN")
        elif returned and returned.get("origin") in ("manual_sheet", "activity_reference"):
            # A documented end cannot turn an actual open departure into a
            # verified return. Only add review if a departure scan exists.
            if departure and departure.get("origin") == "biometric":
                record(date + " " + returned["time"], "review", "Documented AJA end; actual return not confirmed.")

    if events:
        stamp = max(e[0] for e in events)
        latest = [e for e in events if e[0] == stamp]
        kinds = {e[1] for e in latest}
        if len(kinds) != 1:
            return result("review", stamp, "Conflicting status evidence at the same time.", update="For review")
        updates = {e[3] for e in latest}
        update = next(iter(updates)) if len(updates) == 1 else "For review"
        return result(latest[0][1], stamp, latest[0][2], update=update)
    if day.get("calendar", {}).get("holiday_name") or day.get("is_weekend"):
        return result("offday", reason=day.get("calendar", {}).get("holiday_name") or "Weekend")
    if manual.get("notes") or review.get("activity_type"):
        return result("review", reason="Documented activity or note without verified live timing.")
    if arrival_time and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", arrival_time):
        if now.strftime("%H:%M") > arrival_time:
            return result("missing", reason="No recorded entry past the configured arrival time.", label="No entry · past arrival")
        if now.strftime("%H:%M") < arrival_time:
            return result("missing", reason="Before configured arrival time.", label="Awaiting time in")
    return result("missing", reason="No entry in the synchronized records for today; not an absence determination.")
