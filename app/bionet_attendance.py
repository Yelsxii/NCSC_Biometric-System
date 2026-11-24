"""Opt-in direct import of approved office attendance from TimeNet.db.

Read-only vendor connection; no device calls. Keep original website punches and
link verified vendor evidence by exact employee/time. Never infer work codes.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import os
import sqlite3
import uuid
from contextlib import closing

from app.bionet_roster import open_source, OFFICE_CODE_ROLES
from app.db import connect, register_scan_metadata
from app.device_access import authorized_ids

HOST = "192.168.254.201"
TERMINAL = "1"
CUTOVER = "2026-11-24"
SLOTS = {"0":"am_in","1":"am_out","4":"pm_out","5":"pm_in"}


def active():
    return os.getenv("NCSC_ATTENDANCE_SOURCE","connector").strip().lower()=="bionet"


def source_records():
    with closing(open_source(os.environ.get("BIONET_ROSTER_DB",""))) as con:
        definitions = {}
        for row in con.execute("SELECT wc_code,wc_name FROM att_workcode"):
            definitions.setdefault(str(row[0]),set()).add("".join(c for c in str(row[1]).upper() if c.isalnum()))
        for code in ("1","2","3"):
            expected = "".join(c for c in OFFICE_CODE_ROLES[code][0] if c.isalnum())
            if definitions.get(code)!={expected}:
                raise ValueError("ZKBio work-code definitions do not match the verified office mapping.")
        records = con.execute(
            """SELECT e.emp_pin,p.punch_time,p.terminal_id,p.workstate,p.punch_type,p.workcode
               FROM att_punches p JOIN hr_employee e ON e.id=p.employee_id
               WHERE CAST(p.terminal_id AS TEXT)=? AND p.punch_time>=?
               ORDER BY p.punch_time LIMIT 100001""",(TERMINAL,CUTOVER)).fetchall()
        if len(records)>100000:
            raise ValueError("ZKBio attendance source exceeds the supported import window.")
        return records


def availability():
    try:
        source_records()
        return {"connector_available":True,"connector_message":"ZKBio Time.Net (read-only)"}
    except (ValueError, OSError, sqlite3.Error):
        return {"connector_available":False,"connector_message":"Check the ZKBio database and office work-code definitions."}


def import_records(actor_id, started):
    from app.k14_sync import _record_run
    records = source_records()
    inserted = already = skipped = 0
    with closing(connect()) as con, con:
        con.execute("BEGIN IMMEDIATE")
        allowed = authorized_ids(con)
        grouped = {}
        for row in records:
            employee,stamp,terminal,state,kind,code = map(str,row)
            if employee not in allowed:
                skipped += 1
                continue
            try:
                clock = dt.datetime.strptime(stamp,"%Y-%m-%d %H:%M:%S")
                if clock.isoformat(sep=" ")!=stamp or not 2000<=clock.year<=2100:
                    raise ValueError()
            except ValueError:
                skipped += 1
                continue
            grouped.setdefault((employee,stamp),[]).append((terminal,state,kind,code))
        batch = None
        for (employee,stamp), raw in grouped.items():
            values = set(raw)
            existing = con.execute("SELECT id,work_code FROM punches WHERE employee_code=? AND happened_at=? ORDER BY id",(employee,stamp)).fetchall()
            if len(values)!=1 or len(existing)>1:
                for e in existing:
                    con.execute("UPDATE bionet_attendance_evidence SET conflict=1 WHERE punch_id=?",(e["id"],))
                skipped += len(raw)
                continue
            terminal,state,kind,code = next(iter(values))
            # AJA direction comes from work code, not punch state.
            # Unknown codes are retained as evidence but held for review.
            conflict = int(code not in OFFICE_CODE_ROLES or state not in SLOTS)
            if existing:
                punch_id = existing[0]["id"]
                legacy_states = {r[0] for r in con.execute(
                    "SELECT device_punch_type FROM k14_sync_events WHERE punch_id=? AND device_ip=?",(punch_id,HOST))}
                conflict |= int(bool(legacy_states and legacy_states!={state}))
                conflict |= int(existing[0]["work_code"] not in ("",code))
                already += 1
            else:
                if batch is None:
                    actor = actor_id
                    if actor is None:
                        admin = con.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
                        if admin is None:
                            raise ValueError("No administrator account is available to attribute new attendance records.")
                        actor = admin[0]
                    batch = con.execute(
                        "INSERT INTO import_batches(file_sha256,original_name,total_records,inserted_records,imported_by) VALUES(?,?,0,0,?)",
                        (hashlib.sha256(uuid.uuid4().hex.encode()).hexdigest(),"ZKBio Time.Net direct sync",actor)).lastrowid
                punch_id = con.execute(
                    """INSERT INTO punches(employee_code,happened_at,device_id,status_code,verification_code,work_code,imported_batch_id,source)
                       VALUES(?,?,?,?,'',?,?, 'bionet')""",
                    (employee,stamp,HOST,state,code,batch)).lastrowid
                inserted += 1
            old = con.execute("SELECT terminal_id,workstate,punch_type,workcode,conflict FROM bionet_attendance_evidence WHERE punch_id=?",(punch_id,)).fetchone()
            if old is None:
                con.execute("INSERT INTO bionet_attendance_evidence(punch_id,terminal_id,workstate,punch_type,workcode,conflict) VALUES(?,?,?,?,?,?)",
                            (punch_id,terminal,state,kind,code,conflict))
            elif tuple(old)[:4]!=(terminal,state,kind,code) or conflict:
                con.execute("UPDATE bionet_attendance_evidence SET conflict=1 WHERE punch_id=?",(punch_id,))
            already += len(raw)-1
        if batch is not None:
            con.execute("UPDATE import_batches SET total_records=?,inserted_records=? WHERE id=?",(inserted,inserted,batch))
            if actor_id is not None:
                con.execute("INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)",
                            (actor_id,"import","bionet_sync",batch,f"{inserted} new ZKBio records"))
        register_scan_metadata(con)
        finished = _record_run(con,started,"success","TimeNet.db",len(records),inserted,already,skipped,"",actor_id)
    return {"outcome":"success","records_read":len(records),"records_inserted":inserted,
            "records_already_present":already,"records_skipped":skipped,"names_updated":0,
            "error_message":"","finished_at":finished}


def apply_evidence(con, scans):
    """Use saved vendor evidence even when the source is temporarily offline."""
    if not scans:
        return
    allowed = authorized_ids(con)
    ids = [x["id"] for x in scans]
    evidence = {}
    for pos in range(0,len(ids),500):
        chunk = ids[pos:pos+500]
        for row in con.execute("SELECT * FROM bionet_attendance_evidence WHERE punch_id IN ("+
                               ",".join("?" for _ in chunk)+")",chunk):
            evidence[row["punch_id"]]=row
    for scan in scans:
        row = evidence.get(scan["id"])
        if not row or scan["employee_code"] not in allowed:
            continue
        scan["bionet_evidence"] = True
        scan["k14_state_pending"] = True
        scan["k14_punch_type"] = row["workstate"]
        scan["verified_slot"] = SLOTS.get(row["workstate"])
        scan["work_code_pending"] = False
        if row["conflict"] or row["workcode"] not in OFFICE_CODE_ROLES:
            scan["work_code_conflict"] = True
            scan["verified_slot"] = None
            continue
        label,activity,direction = OFFICE_CODE_ROLES[row["workcode"]]
        scan.update(work_code=row["workcode"],work_label=label,activity_type=activity,
                    work_direction=direction,work_code_origin="bionet")
