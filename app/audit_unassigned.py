"""Local read-only audit of unmatched attendance scans for one reporting month."""
from __future__ import annotations

import calendar
import datetime as dt
import json
import sqlite3
import sys
from contextlib import closing
from unittest.mock import patch

from dotenv import load_dotenv


def audit_month(month, include_review=False):
    load_dotenv()
    from app import attendance, main
    from app.db import database_path

    start = dt.date.fromisoformat(month + "-01")
    if start.strftime("%Y-%m") != month or not 2000 <= start.year <= 2100:
        raise ValueError("Use YYYY-MM (2000–2100).")
    end = start + dt.timedelta(days=calendar.monthrange(start.year, start.month)[1])
    uri = database_path().resolve().as_uri() + "?mode=ro"

    def readonly():
        con = sqlite3.connect(uri, uri=True, timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA query_only=ON")
        return con

    def describe(scan, day):
        stamp = scan["happened_at"][11:19]
        slot = scan.get("verified_slot")
        raw = day["scans"]
        same_minute = [s for s in raw if s["id"] != scan["id"] and
                       s["happened_at"][11:16] == stamp[:5]]
        same_slot = [s for s in raw if s["id"] != scan["id"] and slot and
                     s.get("verified_slot") == slot and
                     s.get("activity_type") not in ("AJA", "Travel Order", "Fieldwork", "Official Business")]
        source_times = (day.get("manual_source") or {}).get("times", {})
        matching_sheet_slots = [key for key, value in source_times.items()
                                if value and value[:5] == stamp[:5]]
        if same_minute:
            reason = "Another scan in the same minute; possible duplicate (not automatically confirmed)."
        elif same_slot:
            reason = "Multiple scans claim the same verified attendance slot."
        elif slot:
            reason = "Verified slot was not selected by the resolver; inspect the displayed and reviewed slot."
        elif not matching_sheet_slots:
            reason = "No verified AM/PM slot and no matching manual DTR minute."
        elif len(matching_sheet_slots) > 1:
            reason = "Scan minute matches multiple manual DTR slots."
        else:
            reason = "Manual DTR minute matches but resolver did not select this scan; inspect competing or reviewed entries."
        return {"time": stamp, "punch_id": scan["id"], "verified_slot": slot,
                "device_state": scan.get("k14_punch_type"), "status_code": scan.get("status_code"),
                "work_code": scan.get("work_code"), "matching_sheet_slots": matching_sheet_slots,
                "other_same_minute": [s["happened_at"][11:19] for s in same_minute],
                "other_same_slot": [s["happened_at"][11:19] for s in same_slot],
                "reason": reason}

    results = []
    with patch.object(main, "connect", readonly), patch.object(attendance, "connect", readonly):
        with closing(readonly()) as con:
            people = con.execute("SELECT employee_code, display_name FROM employees ORDER BY lower(display_name), employee_code").fetchall()
        for person in people:
            code = person["employee_code"]
            _, days, _, _ = main._monitor_days(code, start, end)
            flagged = []
            for day in days:
                ids = set(day.get("display_unassigned_ids", []))
                issues = day.get("remark_issues", [])
                status = day.get("display_remark", "")
                metrics = day.get("monitoring", {})
                needs_review = bool(issues or day.get("missing_entries") or "review" in status.lower() or metrics.get("undertime_origin") == "documented_partial")
                if not ids and "Unassigned scan" not in issues and status != "Unassigned scan" and not (include_review and needs_review):
                    continue
                flagged.append({
                    "date": day["date"],
                    "remarks": day.get("display_remark"),
                    "issues": issues,
                    "missing_entries": day.get("missing_entries", []),
                    "source_notes": (day.get("manual_source") or {}).get("notes", []),
                    "undertime_seconds": metrics.get("undertime_seconds"),
                    "undertime_origin": metrics.get("undertime_origin"),
                    "source_conflicts": day.get("source_conflicts", []),
                    "displayed_slots": {key: {"time": item["happened_at"][11:19], "origin": item.get("origin")}
                                        if item else None for key, item in day["display_slots"].items()},
                    "raw_scan_count": len(day["scans"]),
                    "unassigned_count": len(ids),
                    "unassigned_scans": [describe(scan, day) for scan in day["scans"] if scan["id"] in ids],
                    "note": None if ids else "Review label exists but no unmatched ordinary scan ID; inspect other source evidence.",
                })
            results.append({"employee": person["display_name"] or code, "employee_code": code,
                            "affected_days": len(flagged), "days": flagged})
    return {"month": month, "read_only": True, "employees_checked": len(results),
            "employees_with_unassigned": sum(bool(p["affected_days"]) for p in results),
            "total_affected_days": sum(p["affected_days"] for p in results),
            "employees": results}


def audit_all():
    """Summaries of every month containing a local biometric or imported DTR row."""
    load_dotenv()
    from app.db import database_path
    from app.dtr_reconciliation import reconciliation_path, _decode
    with closing(sqlite3.connect(database_path().resolve().as_uri()+"?mode=ro",uri=True)) as con:
        months = {r[0] for r in con.execute("SELECT DISTINCT substr(happened_at,1,7) FROM punches UNION SELECT DISTINCT substr(attendance_date,1,7) FROM manual_dtr_entries UNION SELECT DISTINCT substr(attendance_date,1,7) FROM attendance_day_reviews")}
    path = reconciliation_path()
    if path and path.is_file():
        for _, entries in _decode(path.read_bytes()).values():
            months.update(date[:7] for date in entries)
    reports=[]
    from collections import Counter
    for month in sorted(m for m in months if m and m<=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m")):
        report=audit_month(month, include_review=True)
        days=[d for employee in report["employees"] for d in employee["days"]]
        counts=Counter(d["remarks"] for d in days)
        reports.append({"month":month,"employees_checked":report["employees_checked"],
            "days_to_review":len(days),"unassigned_scans":sum(d["unassigned_count"] for d in days),
            "provisional_undertime_days":sum(d.get("undertime_origin")=="documented_partial" for d in days),
            "remarks":dict(counts)})
    return {"read_only":True,"months_checked":len(reports),"months":reports}


def audit_history():
    """Aggregate historical evidence only; never import or change either database."""
    import os
    from collections import Counter, defaultdict
    from app.db import database_path
    from app.device_access import authorized_ids
    from app.bionet_roster import open_source
    load_dotenv()
    cutoff = "2026-11-24"
    with closing(sqlite3.connect(database_path().resolve().as_uri()+"?mode=ro", uri=True)) as con:
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA query_only=ON")
        allowed = authorized_ids(con)
        punches = defaultdict(list)
        for row in con.execute("SELECT employee_code,happened_at,status_code FROM punches WHERE happened_at<?", (cutoff,)):
            if row["employee_code"] in allowed:
                punches[(row["employee_code"],row["happened_at"])].append(str(row["status_code"]))
        device = defaultdict(set)
        for row in con.execute("SELECT employee_id,punch_time_local,device_punch_type FROM k14_sync_events WHERE device_ip='192.168.254.201' AND punch_time_local<?", (cutoff,)):
            if row["employee_id"] in allowed:
                device[(row["employee_id"],row["punch_time_local"])].add(str(row["device_punch_type"]))
    vendor = defaultdict(set)
    vendor_status = "not_configured"
    raw = os.getenv("BIONET_ROSTER_DB", "").strip()
    if raw:
        try:
            with closing(open_source(raw)) as con:
                for row in con.execute("SELECT e.emp_pin,p.punch_time,p.terminal_id,p.workstate,p.punch_type,p.workcode FROM att_punches p JOIN hr_employee e ON e.id=p.employee_id WHERE p.punch_time<?", (cutoff,)):
                    key = (str(row["emp_pin"]),str(row["punch_time"]))
                    if key[0] in allowed:
                        vendor[key].add(tuple(str(row[k]) for k in ("terminal_id","workstate","punch_type","workcode")))
            vendor_status = "read_only_success"
        except (OSError, ValueError, sqlite3.Error):
            vendor_status = "unavailable"
    months = defaultdict(Counter)
    groups = defaultdict(Counter)
    daily = Counter()
    for (code,stamp), records in punches.items():
        month=stamp[:7]
        key=(code,stamp)
        d=device.get(key,set())
        v=vendor.get(key,set())
        counts=months[month]
        counts["website_punches"]+=len(records)
        counts["distinct_employee_timestamps"]+=1
        counts["exact_device_matches"]+=bool(d)
        counts["exact_vendor_matches"]+=bool(v)
        counts["multiple_website_records"]+=len(records)>1
        counts["conflicting_device_states"]+=len(d)>1
        counts["conflicting_vendor_rows"]+=len(v)>1
        daily[(code,stamp[:10])]+=len(records)
        if len(v)==1:
            terminal,state,kind,workcode=next(iter(v))
            group=(terminal,state,kind,workcode,",".join(sorted(d)) or "unknown",",".join(sorted(set(records))))
            groups[month][group]+=1
        elif len(d)==1:
            groups[month][("no_vendor","unknown","unknown","unknown",next(iter(d)),",".join(sorted(set(records))))]+=1
    for (_,date),n in daily.items():
        months[date[:7]]["days_with_"+str(n)+"_punches"]+=1
    return {"read_only":True,"cutover":cutoff,"vendor_status":vendor_status,
        "employees_checked":len(allowed),"months":[{"month":month,**counts,
        "state_comparison":[dict(zip(("terminal","vendor_state","vendor_type","work_code","device_state","website_status","count"),(*key,n))) for key,n in sorted(groups[month].items())]}
        for month,counts in sorted(months.items())]}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m app.audit_unassigned YYYY-MM|all|history")
    try:
        report = audit_history() if sys.argv[1]=="history" else audit_all() if sys.argv[1]=="all" else audit_month(sys.argv[1])
    except (ValueError, sqlite3.Error) as exc:
        raise SystemExit("Audit could not complete: " + str(exc)) from exc
    print(json.dumps(report, indent=2, ensure_ascii=True))
