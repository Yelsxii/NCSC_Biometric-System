"""Read a minimal manual-DTR export. Source rows never become biometric scans."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import re
import logging
import sqlite3
import sys
import threading
import unicodedata
from contextlib import closing
from pathlib import Path

from app.db import connect

MAX_MANUAL_BYTES = 10 * 1024 * 1024
SLOT_KEYS = ('am_in', 'am_out', 'pm_in', 'pm_out')
BASE = dt.date(1899, 12, 30)
_STOP = threading.Event()
_WORKER_LOCK = threading.Lock()
_THREAD: threading.Thread | None = None
_STATE = {'available': False, 'message': 'No local manual DTR source configured.',
          'matched_tabs': 0, 'unmatched_tabs': 0, 'new_days': 0, 'last_checked': None}


def text(value, limit=300):
    return ' '.join(str(value or '').split())[:limit]


def date_value(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value == int(value):
        day = BASE + dt.timedelta(days=int(value))
    elif isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        day = dt.date.fromisoformat(value)
    else:
        raise ValueError('Invalid source date.')
    if not 2000 <= day.year <= 2100:
        raise ValueError('Unsupported source year.')
    return day.isoformat()


def clock_value(value, slot, date=None):
    if isinstance(value, bool):
        raise ValueError('Invalid source clock value.')
    if value is None or value == '':
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isfinite(value) and value >= 1 and date and date_value(math.floor(value)) == date:
            value = value - math.floor(value)
        if not math.isfinite(value) or not 0 <= value < 1:
            raise ValueError('Invalid source clock value.')
        seconds = round(value * 86400)
        if seconds >= 86400:
            raise ValueError('Midnight rollover needs review.')
    else:
        raw = text(value).upper()
        if raw.startswith('#'):
            raise ValueError('Source formula error needs review.')
        if re.match(r'^(?:TRAVEL\b|OFFICIAL\b|AJA\b|FIELD\b|SO\b|S\.O\b|SPECIAL\b|REGIONAL\b|WORK SUSPENSION\b)',raw):
            return None
        if not re.search(r'\d', raw):
            return None
        found = re.fullmatch(r'(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*\([^)]*\)|\s+(?:WORK SUSPENSION|AJA|TRAVEL ORDER|OFFICIAL BUSINESS).*)?', raw)
        if not found:
            raise ValueError('Ambiguous source clock value.')
        hour, minute, second = map(int, (found[1], found[2], found[3] or 0))
        if minute > 59 or second > 59 or hour > 23:
            raise ValueError('Invalid source clock value.')
        if found[4]:
            if not 1 <= hour <= 12:
                raise ValueError('Invalid twelve-hour clock value.')
            hour = hour % 12 + (12 if found[4] == 'PM' else 0)
        elif slot.startswith('pm_') and 1 <= hour < 12:
            hour += 12
        seconds = hour * 3600 + minute * 60 + second
    return f'{seconds//3600:02}:{seconds%3600//60:02}:{seconds%60:02}'


def duration_value(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return round(value * 86400) if math.isfinite(value) and 0 <= value <= 2 else None
    match = re.fullmatch(r'(\d{1,2}):(\d{2})(?::(\d{2}))?', text(value))
    if not match or int(match[2]) > 59 or int(match[3] or 0) > 59:
        return None
    return int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3] or 0)


def parse_package(raw: bytes):
    if not raw or len(raw) > MAX_MANUAL_BYTES:
        raise ValueError('Choose a manual DTR package up to 10 MB.')
    try:
        packet = json.loads(raw.decode('utf-8-sig'), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid number.')))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('Choose the prepared NCSC manual DTR JSON package.') from exc
    if not isinstance(packet, dict) or packet.get('format') != 'ncsc-manual-dtr-v1':
        raise ValueError('Unrecognized manual DTR package.')
    people = packet.get('people')
    if not isinstance(people, list) or not 1 <= len(people) <= 200:
        raise ValueError('Invalid source employee list.')
    source = packet.get('source', {})
    if not isinstance(source, dict):
        raise ValueError('Invalid source metadata.')
    origin = text(source.get('id'), 150)
    if not origin:
        raise ValueError('Source identity is required.')
    groups, keys, total = [], set(), 0
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
    for person in people:
        if not isinstance(person, dict):
            raise ValueError('Invalid source employee.')
        key, name = text(person.get('key'), 100), text(person.get('name'), 140)
        if not key or key in keys or not name or not isinstance(person.get('rows'), list):
            raise ValueError('Invalid or duplicate source employee.')
        keys.add(key)
        rows, warnings, seen, duplicates = [], 0, {}, 0
        for original in person['rows']:
            total += 1
            if total > 40000 or not isinstance(original, dict):
                raise ValueError('Too many or invalid source rows.')
            values = original.get('values')
            row_number = original.get('row')
            if not isinstance(values, list) or len(values) > 15 or type(row_number) is not int or not 1 <= row_number <= 100000:
                warnings += 1
                continue
            values = values + [None] * (15-len(values))
            if any(v is not None and (not isinstance(v,(str,int,float,bool)) or
                   isinstance(v,(int,float)) and not math.isfinite(v)) for v in values):
                warnings += 1
                continue
            try:
                date = date_value(values[0])
                times = {slot: clock_value(values[i+2], slot, date) for i, slot in enumerate(SLOT_KEYS)}
            except (ValueError, OverflowError, TypeError):
                warnings += 1
                continue
            if date > today:
                continue
            notes = []
            for i, slot in enumerate(SLOT_KEYS):
                value = values[i+2]
                if isinstance(value,str) and value.strip():
                    note = text(value) if times[slot] is None else re.sub(r'^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?', '', text(value), flags=re.I).strip(' ()')
                    if note:
                        notes.append(note)
            notes = list(dict.fromkeys(notes))
            notes = [v for v in notes if v.upper() not in ('SATURDAY', 'SUNDAY', 'SAT', 'SUN')]
            if not any(times.values()) and not notes and not any(values[12:15]):
                continue
            if date in seen:
                if seen[date] == values:
                    duplicates += 1
                    continue
                raise ValueError('Duplicate source date for an employee; resolve it before importing.')
            seen[date] = values
            ordered = [value for value in times.values() if value]
            if ordered != sorted(ordered) or any(times[a] and times[b] and times[a] >= times[b] for a,b in [('am_in','am_out'),('pm_in','pm_out')]):
                warnings += 1
                continue
            complete = all(times.values())
            aja = None
            if any(values[12:15]):
                def activity_clock(value):
                    try:
                        return clock_value(value,'am_in',date) or text(value,80)
                    except (ValueError,TypeError,OverflowError):
                        return text(value,80)
                aja = {'start':activity_clock(values[12]),'purpose':text(values[13],300),'end':activity_clock(values[14])}
            normalized = {'date': date, 'times': times, 'notes': notes,
                'reported_total': duration_value(values[8]) if complete else None,
                'reported_ut': duration_value(values[9]) if complete else None,
                'reported_ot': duration_value(values[10]) if complete else None,
                'reported_status': text(values[11], 100) if complete else '',
                'aja': aja}
            rows.append({'date': date, 'source_row': row_number, 'data': normalized, 'original': original})
        groups.append({'key': key, 'name': name, 'sheet': text(person.get('sheet'),140), 'rows': rows, 'warnings': warnings, 'duplicates': duplicates})
    return {'id': origin, 'title': text(source.get('title'),140) or 'Manual DTR', 'groups': groups}


def mapping_hash(mapping):
    return hashlib.sha256(json.dumps(mapping,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def identity(value):
    value = unicodedata.normalize('NFKC', value).casefold().strip()
    if value.count(',') == 1:
        surname, given = (part.strip() for part in value.split(','))
        if surname and given and given not in ('jr.', 'jr', 'sr.', 'sr', 'ii', 'iii', 'iv'):
            value = given + ' ' + surname
    return ' '.join(re.sub(r'[.,]', '', value).split())


def local_source_path():
    raw = os.getenv('MANUAL_DTR_SOURCE_PATH', '').strip()
    if not raw:
        local = os.getenv('LOCALAPPDATA', '').strip()
        if not local:
            raise ValueError('No local manual DTR source configured.')
        raw = str(Path(local) / 'NCSC-K14-Pilot' / 'manual-dtr.json')
    raw = re.sub(r'%([A-Za-z_][A-Za-z0-9_]*)%', lambda m: os.getenv(m[1], m[0]), raw)
    path = Path(os.path.expandvars(raw)).expanduser()
    if not path.is_absolute() or '%' in str(path) or '$' in str(path) or str(path).startswith(('\\\\','//')):
        raise ValueError('Set an absolute local manual DTR path.')
    resolved = path.resolve()
    if any(part.lower() in ('onedrive','dropbox','google drive','icloud') for part in resolved.parts):
        raise ValueError('Keep the manual DTR source outside cloud-synced folders.')
    if not resolved.is_file():
        raise ValueError('Manual DTR source file was not found.')
    return resolved


def surname_alias(alias, full_name):
    """Match a whole surname token/phrase, never a substring or initial."""
    short, full = alias.split(), full_name.split()
    if not short or len(short) >= len(full) or any(len(part) < 2 for part in short):
        return False
    return full[:len(short)] == short or full[-len(short):] == short


def corroborates_alias(con, code, groups):
    """Require independent date/time agreement before assigning an abbreviated name."""
    source_minutes = set()
    for group in groups:
        for row in group['rows']:
            for clock in row['data']['times'].values():
                if clock and clock[3:5] not in ('00','15','30','45'):
                    source_minutes.add((row['date'],clock[:5]))
    if not source_minutes:
        return False
    punches = con.execute(
        'SELECT happened_at FROM punches WHERE employee_code=?', (code,)).fetchall()
    matching = {(row['happened_at'][:10],row['happened_at'][11:16])
                for row in punches} & source_minutes
    # Require two dates and two different non-default clock minutes.
    return len({date for date,_ in matching}) >= 2 and len({clock for _,clock in matching}) >= 2


def automatic_mapping(packet, diagnostics=None):
    """Match full names, or a unique K14 alias corroborated by original punches."""
    with closing(connect()) as con:
        rows = con.execute('SELECT employee_code,display_name,name_source FROM employees').fetchall()
        employees = [row for row in rows if row['name_source'] in ('profile','manual','roster','device')
                     and row['display_name'] and identity(row['display_name'])]
        by_name = {}
        for row in employees:
            by_name.setdefault(identity(row['display_name']), set()).add(row['employee_code'])
        source_names = {}
        for group in packet['groups']:
            source_names.setdefault(identity(group['name']), []).append(group)
        matched = {}
        for name, groups in source_names.items():
            candidates = by_name.get(name,set())
            if len(candidates)==1 and len({g['name'] for g in groups})==1:
                matched[name] = next(iter(candidates))
        exact_tabs = sum(len(source_names[name]) for name in matched)
        alias_tabs = 0
        used = set(matched.values())
        for employee in employees:
            code = employee['employee_code']
            if employee['name_source'] != 'device' or code in used:
                continue
            alias = identity(employee['display_name'])
            if len(by_name[alias]) != 1:
                continue
            candidates = [name for name in source_names if surname_alias(alias,name)]
            if len(candidates) != 1:
                continue
            name = candidates[0]
            if name in matched or len({g['name'] for g in source_names[name]}) != 1:
                continue
            # A surname may belong to more than one enrolled employee, even
            # when one is represented by a full name. Never guess in that case.
            competitors = [row for row in employees if row['employee_code'] != code and
                (identity(row['display_name']) == name or
                 surname_alias(alias,identity(row['display_name'])) or
                 surname_alias(identity(row['display_name']),name))]
            if competitors or not corroborates_alias(con,code,source_names[name]):
                continue
            matched[name] = code
            used.add(code)
            alias_tabs += len(source_names[name])
        if diagnostics is not None:
            diagnostics.update(exact_tabs=exact_tabs,alias_tabs=alias_tabs)
        return {group['key']:matched[name] for name,groups in source_names.items()
                if name in matched for group in groups}


def automatic_status():
    with _WORKER_LOCK:
        return dict(_STATE)


def sync_local_source():
    """Reconcile a protected, locally refreshed snapshot. Never read Google credentials."""
    global _STATE
    try:
        path = local_source_path()
        if path.stat().st_size > MAX_MANUAL_BYTES:
            raise ValueError('Manual DTR source exceeds 10 MB.')
        raw = path.read_bytes()
        packet = parse_package(raw)
        match_details = {}
        mapping = automatic_mapping(packet, match_details)
        actor = None
        planned = preview_package(packet,mapping,fill_missing=True)['counts'] if mapping else {'new':0,'filled':0,'conflict':0,'invalid':0}
        if planned['new'] or planned['filled']:
            with closing(connect()) as con:
                actor = con.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
            if actor is None:
                raise ValueError('An administrator account is required for source attribution.')
            counts = import_package(packet,mapping,hashlib.sha256(raw).hexdigest(),actor['id'],fill_missing=True)
        else:
            counts = planned
        state = {'available':True,'message':'Local manual DTR source checked.',
                 'matched_tabs':len(mapping),'unmatched_tabs':len(packet['groups'])-len(mapping),
                 **match_details,
                 'new_days':counts['new'],'filled_days':counts['filled'],
                  'conflict_days':counts['conflict'],'invalid_rows':counts['invalid'],'last_checked':dt.datetime.now().isoformat(timespec='seconds')}
    except (OSError,ValueError,UnicodeError,RecursionError,sqlite3.Error) as exc:
        known = {'No local manual DTR source configured.','Set an absolute local manual DTR path.',
                 'Keep the manual DTR source outside cloud-synced folders.',
                 'Manual DTR source file was not found.','Manual DTR source exceeds 10 MB.',
                 'An administrator account is required for source attribution.'}
        state = {'available':False,'message':str(exc) if str(exc) in known else 'Could not read the local manual DTR source.',
                 'matched_tabs':0,'unmatched_tabs':0,'new_days':0,'last_checked':dt.datetime.now().isoformat(timespec='seconds')}
    with _WORKER_LOCK:
        _STATE = state
    return state


def _poll_source():
    while not _STOP.is_set():
        try:
            sync_local_source()
        except Exception:
            logging.getLogger(__name__).error('Manual DTR reconciliation failed; retrying next cycle.')
        _STOP.wait(60)


def start_local_source_sync():
    global _THREAD
    if (not os.getenv('MANUAL_DTR_SOURCE_PATH') and not os.getenv('LOCALAPPDATA')) or 'pytest' in sys.modules or os.getenv('PYTEST_CURRENT_TEST') or os.getenv('QA_PORT'):
        return
    with _WORKER_LOCK:
        if _THREAD is not None and _THREAD.is_alive():
            return
        _STOP.clear()
        _THREAD = threading.Thread(target=_poll_source,name='manual-dtr-local-sync',daemon=True)
        _THREAD.start()


def stop_local_source_sync():
    with _WORKER_LOCK:
        _STOP.set()
        worker = _THREAD
    if worker is not None:
        worker.join(timeout=5)


def validate_mapping(mapping, packet, con):
    if not isinstance(mapping, dict) or len(mapping) > 200:
        raise ValueError('Invalid employee mapping.')
    allowed = {person['key'] for person in packet['groups']}
    people = {person['key']: person for person in packet['groups']}
    targets = {}
    for key, code in mapping.items():
        if key not in allowed or not isinstance(code,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', code):
            raise ValueError('Invalid employee mapping.')
        normalized_name = identity(people[key]['name'])
        if code in targets and targets[code] != normalized_name:
            raise ValueError('Do not map different source employee names to the same employee.')
        targets[code] = normalized_name
        if not con.execute('SELECT 1 FROM employees WHERE employee_code=?',(code,)).fetchone():
            raise ValueError('Map source sheets to existing employees only.')


def row_state(con, packet, person, row, code, fill_missing=False):
    old = con.execute('SELECT * FROM manual_dtr_entries WHERE employee_code=? AND attendance_date=? OR source_id=? AND sheet_key=? AND source_row=?',
        (code,row['date'],packet['id'],person['key'],row['source_row'])).fetchall()
    if not old:
        return 'new'
    desired = json.dumps(row['data'],sort_keys=True,separators=(',',':'))
    if len(old)==1 and old[0]['employee_code']==code and old[0]['attendance_date']==row['date'] and old[0]['normalized_json']==desired:
        return 'already_present'
    if fill_missing and len(old)==1:
        previous = old[0]
        if (previous['employee_code']==code and previous['attendance_date']==row['date']
            and previous['source_id']==packet['id'] and previous['sheet_key']==person['key']
            and previous['source_row']==row['source_row']):
            before = json.loads(previous['normalized_json'])
            after = row['data']
            old_times, new_times = before['times'], after['times']
            adds_time = any(not old_times.get(k) and new_times.get(k) for k in SLOT_KEYS)
            preserves_times = all(not old_times.get(k) or old_times[k]==new_times.get(k) for k in SLOT_KEYS)
            preserves_other = (set(before['notes']).issubset(after['notes']) and
                all(before.get(k) in (None, '') or before[k]==after.get(k)
                    for k in ('aja','reported_total','reported_ut','reported_ot','reported_status')))
            if adds_time and preserves_times and preserves_other:
                return 'filled'
    return 'conflict'


def conflicting_packet_dates(packet, mapping):
    variants = {}
    for person in packet['groups']:
        if person['key'] not in mapping:
            continue
        for row in person['rows']:
            key = (mapping[person['key']],row['date'])
            variants.setdefault(key,set()).add(json.dumps(row['data'],sort_keys=True,separators=(',',':')))
    return {key for key,values in variants.items() if len(values)>1}


def preview_package(packet, mapping, fill_missing=False):
    with closing(connect()) as con:
        validate_mapping(mapping,packet,con)
        blocked = conflicting_packet_dates(packet,mapping)
        planned = set()
        employees = [dict(row) for row in con.execute('SELECT employee_code,display_name,department FROM employees ORDER BY lower(display_name),employee_code LIMIT 1000')]
        groups, counts = [], {'new':0,'already_present':0,'conflict':0,'unmapped':0,'invalid':0,'source_invalid':0,'source_duplicates':0}
        if fill_missing:
            counts['filled'] = 0
        for person in packet['groups']:
            counts['source_invalid'] += person['warnings']
            counts['invalid'] += person['warnings'] if person['key'] in mapping else 0
            counts['source_duplicates'] += person['duplicates']
            if person['key'] in mapping:
                for row in person['rows']:
                    target = (mapping[person['key']],row['date'])
                    state = 'conflict' if target in blocked else row_state(con,packet,person,row,target[0],fill_missing)
                    if state in ('new','filled') and target in planned:
                        state = 'already_present'
                    if state in ('new','filled'):
                        planned.add(target)
                    counts[state] += 1
            else:
                counts['unmapped'] += len(person['rows'])
            groups.append({'key':person['key'],'name':person['name'],'sheet':person['sheet'],'records':len(person['rows']),
                'warnings':person['warnings'],'from':min((r['date'] for r in person['rows']),default=None),'to':max((r['date'] for r in person['rows']),default=None)})
    return {'groups':groups,'employees':employees,'counts':counts,'source_title':packet['title']}


def import_package(packet, mapping, file_hash, actor_id, fill_missing=False):
    counts = {'new':0,'already_present':0,'conflict':0,'unmapped':0,'invalid':0,'source_invalid':0,'source_duplicates':0,'names_filled':0}
    if fill_missing:
        counts['filled'] = 0
    with closing(connect()) as con, con:
        con.execute('BEGIN IMMEDIATE')
        validate_mapping(mapping,packet,con)
        blocked = conflicting_packet_dates(packet,mapping)
        con.execute('INSERT OR IGNORE INTO manual_dtr_imports(file_sha256,mapping_sha256,source_title,imported_by) VALUES(?,?,?,?)',
            (file_hash,mapping_hash(mapping),packet['title'],actor_id))
        batch = con.execute('SELECT id FROM manual_dtr_imports WHERE file_sha256=? AND mapping_sha256=?',(file_hash,mapping_hash(mapping))).fetchone()[0]
        for person in packet['groups']:
            counts['source_invalid'] += person['warnings']
            counts['invalid'] += person['warnings'] if person['key'] in mapping else 0
            counts['source_duplicates'] += person['duplicates']
            code = mapping.get(person['key'])
            if not code:
                counts['unmapped'] += len(person['rows'])
                continue
            for row in person['rows']:
                state = 'conflict' if (code,row['date']) in blocked else row_state(con,packet,person,row,code,fill_missing)
                counts[state] += 1
                if state=='filled':
                    previous = con.execute('SELECT * FROM manual_dtr_entries WHERE employee_code=? AND attendance_date=?',
                        (code,row['date'])).fetchone()
                    con.execute('INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)',
                        (actor_id,'filled_missing_slots','manual_dtr',previous['id'],
                         json.dumps({'before':dict(previous),'new_batch':batch})))
                    con.execute('UPDATE manual_dtr_entries SET normalized_json=?,original_json=?,imported_batch_id=? WHERE id=?',
                        (json.dumps(row['data'],sort_keys=True,separators=(',',':')),
                         json.dumps(row['original'],ensure_ascii=False),batch,previous['id']))
                if state!='new':
                    continue
                filled = con.execute("UPDATE employees SET display_name=?,name_source='manual_dtr',updated_at=CURRENT_TIMESTAMP "
                    "WHERE employee_code=? AND display_name='' AND NOT EXISTS(SELECT 1 FROM employee_profiles WHERE employee_code=?)",
                    (person['name'],code,code))
                counts['names_filled'] += filled.rowcount
                con.execute('INSERT INTO manual_dtr_entries(employee_code,attendance_date,source_id,sheet_key,source_row,source_name,normalized_json,original_json,imported_batch_id) VALUES(?,?,?,?,?,?,?,?,?)',
                    (code,row['date'],packet['id'],person['key'],row['source_row'],person['name'],json.dumps(row['data'],sort_keys=True,separators=(',',':')),
                     json.dumps(row['original'],ensure_ascii=False),batch))
        con.execute('INSERT INTO audit_events(actor_id,action,entity,entity_id,details) VALUES(?,?,?,?,?)',
            (actor_id,'imported','manual_dtr',batch,json.dumps({'counts':counts,'mapping':mapping})))
    return counts
