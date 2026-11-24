"""Strict, evidence-only pairing of verified work-code IN/OUT scan roles.

One IN and one later OUT of the same activity on the same local date are
required to display a code-matched interval. Multiple or missing scans are
reported for review, not silently paired, synthesized, or credited as work.
The K14 connector currently has no work-code field; this can only classify
records that actually have imported codes (e.g. a verified USB attlog).
"""
from __future__ import annotations

ACTIVITY_KINDS = ("AJA", "Travel Order")
DIRECTIONS = ("Unspecified", "IN", "OUT")


def _evidence(event: dict) -> dict:
    return {
        "id": event["id"],
        "happened_at": event["happened_at"],
        "device_id": event["device_id"],
        "work_code": event["work_code"],
        "direction": event.get("work_direction") or "Unspecified",
    }


def activity_pairs(scans: list[dict]) -> list[dict]:
    """Create conservative same-day pairs from explicitly configured scan roles.

    Never interpret raw device status/punch type or chronological order alone
    as IN or OUT. Repeated events and overnight sessions require separate
    review; leave source records unchanged.
    """
    result: list[dict] = []
    for category in ACTIVITY_KINDS:
        observed = [event for event in scans if event.get("activity_type") == category]
        if not observed:
            continue
        incoming = [x for x in observed if x.get("work_direction") == "IN"]
        outgoing = [x for x in observed if x.get("work_direction") == "OUT"]
        unknown = [x for x in observed if x.get("work_direction") not in ("IN", "OUT")]
        reasons = []
        if unknown:
            reasons.append("Scan direction not configured")
        if not incoming:
            reasons.append("Missing IN scan")
        elif len(incoming) > 1:
            reasons.append("Multiple IN scans")
        if not outgoing:
            reasons.append("Missing OUT scan")
        elif len(outgoing) > 1:
            reasons.append("Multiple OUT scans")
        if len(incoming) == 1 and len(outgoing) == 1:
            if incoming[0]["happened_at"] >= outgoing[0]["happened_at"]:
                reasons.append("OUT is not later than IN")
        result.append({
            "category": category,
            "status": "code_matched" if not reasons else "needs_review",
            "time_in": _evidence(incoming[0]) if len(incoming) == 1 else None,
            "time_out": _evidence(outgoing[0]) if len(outgoing) == 1 else None,
            "events": [_evidence(x) for x in observed],
            "review_note": "; ".join(reasons) if reasons else
                           "IN/OUT matched from configured codes; not an attendance credit",
        })
    return result



def dtr_aja_periods(day: dict) -> list[dict]:
    """Departure/return evidence for the DTR, separate from regular slots."""
    periods = []
    pending = None
    events = sorted((x for x in day["scans"] if x.get("activity_type") == "AJA"),
                    key=lambda x: (x["happened_at"], x["id"]))
    def entry(event):
        return {"time": event["happened_at"][11:19], "origin": "biometric"}
    for event in events:
        direction = event.get("work_direction")
        if direction == "OUT":
            if pending:
                periods.append({"out": pending, "in": None, "review": True})
            pending = entry(event)
        elif direction == "IN":
            incoming = entry(event)
            if pending and pending["time"] < incoming["time"]:
                periods.append({"out": pending, "in": incoming, "review": False})
                pending = None
            else:
                periods.append({"out": None, "in": incoming, "review": True})
        else:
            periods.append({"out": None, "in": None, "review": True})
    if pending:
        periods.append({"out": pending, "in": None, "review": True})
    sheet = (day.get("manual_source") or {}).get("aja")
    if sheet:
        pair = {"out": {"time": sheet["start"], "origin": "manual_sheet"} if sheet.get("start") else None,
                "in": {"time": sheet["end"], "origin": "manual_sheet"} if sheet.get("end") else None,
                "review": not bool(sheet.get("start") and sheet.get("end"))}
        def minute(x):
            return x["time"][:5] if x else None
        if not any(minute(x["out"]) == minute(pair["out"]) and minute(x["in"]) == minute(pair["in"]) for x in periods):
            # A matching sheet departure may supply a documented end, not a fingerprint.
            matches = [x for x in periods if x["out"] and minute(x["out"]) == minute(pair["out"]) and not x["in"]]
            if len(matches)==1 and pair["in"]:
                matches[0]["in"] = pair["in"]
                matches[0]["review"] = False
            else:
                periods.append(pair)
    if not periods:
        for record in day.get("activities", []):
            if record["category"]=="AJA":
                periods.append({"out":{"time":record["start_at"][11:19],"origin":"activity_reference"},
                                "in":{"time":record["end_at"][11:19],"origin":"activity_reference"},"review":False})
    approved = day["review"].get("approved_times", {})
    if "aja_out" in approved or "aja_in" in approved:
        if len(periods)<=1:
            if not periods:
                periods.append({"out":None,"in":None,"review":True})
            for key in ("out","in"):
                if "aja_"+key in approved:
                    periods[0][key]={"time":approved["aja_"+key],"origin":"hr_approved"}
            a,b=periods[0]["out"],periods[0]["in"]
            periods[0]["review"]=not (a and b and a["time"]<b["time"])
        else:
            # Do not guess which of multiple periods an adjustment belongs to.
            for period in periods:
                period["review"]=True
    return periods
