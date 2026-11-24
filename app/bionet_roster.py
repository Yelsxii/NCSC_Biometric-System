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
