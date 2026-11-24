"""Opt-in read-only SQLite roster adapter. No source writes or biometric data."""
from __future__ import annotations

import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path

from app.db import connect, database_path
from app.device_access import authorized_ids
from app.registry import staff_row


def configured():
    return bool(os.getenv('BIONET_ROSTER_DB', '').strip())


def source_path(raw):
    raw = re.sub(r'%([A-Za-z_][A-Za-z0-9_]*)%', lambda m: os.getenv(m[1], m[0]), raw)
    path = Path(os.path.expandvars(raw)).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise ValueError('Set an existing absolute ZKBio Time.Net SQLite database path.')
    path = path.resolve()
    if path == database_path().resolve():
        raise ValueError('The ZKBio source must be separate from the website database.')
    return path


def open_source(raw):
    path = source_path(raw)
    con = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA query_only=ON')
    con.execute('PRAGMA trusted_schema=OFF')
    return con


def quote_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def schema(con):
    tables = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    return {table['name']: [row['name'] for row in con.execute(
        'PRAGMA table_info(' + quote_identifier(table['name']) + ')')] for table in tables}


def inspect_schema(raw):
    """Metadata only; never prints source employee records or credentials."""
    with closing(open_source(raw)) as con:
        return schema(con)


def sync_roster():
    if not configured():
        return None
    table = os.getenv('BIONET_ROSTER_TABLE', '').strip()
    fields = [os.getenv('BIONET_ROSTER_' + key, '').strip() for key in
              ('ID_COLUMN', 'FIRST_COLUMN', 'LAST_COLUMN')]
    department = os.getenv('BIONET_ROSTER_DEPARTMENT_COLUMN', '').strip()
    if not table or not all(fields) or len(set(fields)) != 3:
        raise ValueError('Configure the ZKBio roster table and exact ID, first-name and last-name columns.')
    with closing(open_source(os.environ['BIONET_ROSTER_DB'])) as source:
        columns = schema(source).get(table, [])
        requested = fields + ([department] if department else [])
        if any(field not in columns for field in requested):
            raise ValueError('Configured ZKBio roster columns were not found.')
        # Avoid SELECT *; do not copy passwords, biometric templates or payroll.
        sql = 'SELECT ' + ','.join(map(quote_identifier, requested)) + ' FROM ' + quote_identifier(table) + ' LIMIT 5001'
        records = source.execute(sql).fetchall()
    if len(records) > 5000:
        raise ValueError('ZKBio roster exceeds the supported employee limit.')
    counts = {'approved':0, 'updated':0, 'conflicts':0}
    with closing(connect()) as con, con:
        con.execute('BEGIN IMMEDIATE')
        allowed = authorized_ids(con)
        prepared = {}
        conflicts = set()
        for record in records:
            if record[0] is None:
                continue
            code = str(record[0]).strip()
            if code not in allowed:
                continue
            if not all(isinstance(record[i], str) and record[i].strip() for i in (1,2)):
                continue
            try:
                item = staff_row(code, ' '.join((record[1].strip(),record[2].strip())),
                                 (record[3] or '') if department else '')
            except ValueError:
                continue
            if code in prepared and prepared[code] != item:
                conflicts.add(code)
            prepared[code] = item
        counts['approved'] = len(prepared) - len(conflicts)
        counts['conflicts'] = len(conflicts)
        for code,item in prepared.items():
            if code in conflicts:
                continue
            name = item['display_name']
            old = con.execute("SELECT e.display_name,e.name_source,e.department, "
                "EXISTS(SELECT 1 FROM employee_profiles p WHERE p.employee_code=e.employee_code) AS verified "
                "FROM employees e WHERE e.employee_code=?", (code,)).fetchone()
            if old and (old['verified'] or old['name_source'] in ('profile','manual','roster','manual_dtr')):
                if old['display_name'] != name:
                    counts['conflicts'] += 1
                continue
            if old and old['name_source']=='bionet' and old['display_name'] != name:
                # A changed identity on an already assigned ID requires office review.
                if con.execute('SELECT 1 FROM manual_dtr_entries WHERE employee_code=? LIMIT 1',(code,)).fetchone():
                    counts['conflicts'] += 1
                    continue
            dept = item['department'] or (old['department'] if old else '')
            if old and old['name_source']=='bionet' and old['display_name']==name and old['department']==dept:
                continue
            con.execute("INSERT INTO employees(employee_code,display_name,department,name_source) VALUES(?,?,?,'bionet') "
                "ON CONFLICT(employee_code) DO UPDATE SET display_name=excluded.display_name,department=excluded.department,"
                "name_source='bionet',updated_at=CURRENT_TIMESTAMP", (code,name,dept))
            counts['updated'] += 1
    return counts

def workcode_diagnostics():
    """Read counts only for approved employee IDs; no raw personal timestamps."""
    if not configured():
        raise ValueError('Configure the ZKBio roster database first.')
    with closing(connect()) as con:
        allowed = authorized_ids(con)
    with closing(open_source(os.environ['BIONET_ROSTER_DB'])) as source:
        definitions = [dict(r) for r in source.execute(
            'SELECT id, wc_code, wc_name FROM att_workcode LIMIT 500')]
        counts = {}
        for row in source.execute(
            'SELECT e.emp_pin, p.workcode, COUNT(*) AS n FROM att_punches p '
            'JOIN hr_employee e ON e.id=p.employee_id GROUP BY e.emp_pin,p.workcode'):
            if str(row['emp_pin']).strip() in allowed:
                code = str(row['workcode']) if row['workcode'] is not None else '(empty)'
                counts[code] = counts.get(code, 0) + row['n']
        return {'workcode_definitions':definitions,'approved_punch_counts_by_workcode':counts}


# Office configuration verified in the device and ZKBio definitions on 2026-11-24.
OFFICE_CODE_ROLES = {
    "0": ("Default regular", "Regular", "Unspecified"),
    "1": ("AJA OUT", "AJA", "OUT"),
    "2": ("AJA IN", "AJA", "IN"),
    "3": ("REGULAR", "Regular", "Unspecified"),
}


def reconcile_workcodes(con, scans):
    """Read only, exact employee/timestamp match to already-linked K14 punches.

    No source writes, imports, duplicate creation, or guessed codes. A missing
    vendor row does not mean work code zero. Conflicting evidence is held.
    """
    if not configured():
        return
    allowed = authorized_ids(con)
    targets = {}
    for scan in scans:
        if scan.get("k14_state_pending") and not scan.get("bionet_evidence") and scan["employee_code"] in allowed:
            targets.setdefault((scan["employee_code"], scan["happened_at"]), []).append(scan)
    if not targets:
        return
    for group in targets.values():
        for scan in group:
            if not scan.get("work_code"):
                scan["work_code_pending"] = True
    ids = sorted({key[0] for key in targets})
    stamps = sorted({key[1] for key in targets})
    rows = {}
    try:
        with closing(open_source(os.environ["BIONET_ROSTER_DB"])) as source:
            definitions = {}
            for row in source.execute("SELECT wc_code,wc_name FROM att_workcode"):
                definitions.setdefault(str(row["wc_code"]), set()).add(
                    re.sub(r"[^A-Z0-9]", "", str(row["wc_name"]).upper()))
            valid = {"0"}
            for code in ("1","2","3"):
                if definitions.get(code) == {re.sub(r"[^A-Z0-9]", "", OFFICE_CODE_ROLES[code][0].upper())}:
                    valid.add(code)
            sql = ("SELECT e.emp_pin,p.punch_time,p.workcode FROM att_punches p "
                   "JOIN hr_employee e ON e.id=p.employee_id "
                   "WHERE CAST(e.emp_pin AS TEXT) IN (" + ",".join("?" for _ in ids) + ") "
                   "AND p.punch_time>=? AND p.punch_time<=? LIMIT 100001")
            records = source.execute(sql, (*ids, stamps[0], stamps[-1])).fetchall()
            if len(records)>100000:
                return
            for row in records:
                key = (str(row["emp_pin"]), row["punch_time"])
                if key in targets:
                    rows.setdefault(key, set()).add(str(row["workcode"]))
    except (sqlite3.Error, OSError, ValueError):
        # Keep the website available during a vendor lock or unavailable source.
        return
    for key, group in targets.items():
        codes = rows.get(key, set())
        if not codes:
            continue
        for scan in group:
            if len(group)!=1 or len(codes)!=1 or not codes.issubset(valid):
                scan["work_code_conflict"] = True
                continue
            code = next(iter(codes))
            if scan.get("work_code") not in (None, "", code):
                scan["work_code_conflict"] = True
                continue
            label, activity, direction = OFFICE_CODE_ROLES[code]
            scan.update(work_code=code, work_label=label, activity_type=activity,
                        work_direction=direction, work_code_origin="bionet",
                        work_code_pending=False)


def attendance_source_diagnostics():
    """Compare existing office records without importing or exposing identities.

    Report raw vendor field distributions and exact K14 state comparisons.
    Neither a terminal association nor a field mapping is inferred here.
    """
    if not configured():
        raise ValueError("Configure the ZKBio roster database first.")
    start = "2026-11-24"
    with closing(connect()) as con:
        allowed = authorized_ids(con)
        raw = {}
        for row in con.execute(
            """SELECT employee_id,punch_time_local,device_punch_type
               FROM k14_sync_events WHERE device_ip='192.168.254.201'
                 AND punch_time_local>=?""", (start,)):
            if row["employee_id"] in allowed:
                key = (row["employee_id"], row["punch_time_local"])
                raw.setdefault(key,set()).add(str(row["device_punch_type"]))
    with closing(open_source(os.environ["BIONET_ROSTER_DB"])) as source:
        summary = dict(source.execute(
            "SELECT COUNT(*) AS total, MAX(punch_time) AS latest FROM att_punches").fetchone())
        records = source.execute(
            """SELECT e.emp_pin,p.punch_time,p.terminal_id,p.workstate,p.punch_type,p.workcode
               FROM att_punches p JOIN hr_employee e ON e.id=p.employee_id
               WHERE p.punch_time>=? ORDER BY p.punch_time DESC LIMIT 20001""", (start,)).fetchall()
        if len(records)>20000:
            raise ValueError("Too many recent source rows for this diagnostic.")
        grouped = {}
        matched = 0
        for row in records:
            employee = str(row["emp_pin"])
            if employee not in allowed:
                continue
            states = raw.get((employee,row["punch_time"]),set())
            known = next(iter(states)) if len(states)==1 else None
            if known is not None:
                matched += 1
            key = (str(row["terminal_id"]),str(row["workstate"]),str(row["punch_type"]),
                   str(row["workcode"]),known)
            grouped[key] = grouped.get(key,0)+1
        return {
            "vendor_summary":summary,
            "approved_recent_records":sum(grouped.values()),
            "exact_k14_matches":matched,
            "comparison_groups":[dict(zip(
                ("terminal_id","workstate","punch_type","workcode","k14_punch_state","count"),
                (*key,count))) for key,count in grouped.items()],
        }
