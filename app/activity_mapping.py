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
