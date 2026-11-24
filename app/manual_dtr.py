"""Read a minimal manual-DTR export. Source rows never become biometric scans."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
from contextlib import closing

from app.db import connect

MAX_MANUAL_BYTES = 10 * 1024 * 1024
SLOT_KEYS = ('am_in', 'am_out', 'pm_in', 'pm_out')
BASE = dt.date(1899, 12, 30)


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


def validate_mapping(mapping, packet, con):
    if not isinstance(mapping, dict) or len(mapping) > 200:
        raise ValueError('Invalid employee mapping.')
    allowed = {person['key'] for person in packet['groups']}
    targets = set()
    for key, code in mapping.items():
        if key not in allowed or not isinstance(code,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', code):
            raise ValueError('Invalid employee mapping.')
        if code in targets:
            raise ValueError('Do not map two source sheets to the same employee.')
        targets.add(code)
        if not con.execute('SELECT 1 FROM employees WHERE employee_code=?',(code,)).fetchone():
            raise ValueError('Map source sheets to existing employees only.')


def row_state(con, packet, person, row, code):
    old = con.execute('SELECT * FROM manual_dtr_entries WHERE employee_code=? AND attendance_date=? OR source_id=? AND sheet_key=? AND source_row=?',
        (code,row['date'],packet['id'],person['key'],row['source_row'])).fetchall()
    if not old:
        return 'new'
    desired = json.dumps(row['data'],sort_keys=True,separators=(',',':'))
    if len(old)==1 and old[0]['employee_code']==code and old[0]['attendance_date']==row['date'] and old[0]['normalized_json']==desired:
        return 'already_present'
    return 'conflict'


def preview_package(packet, mapping):
    with closing(connect()) as con:
        validate_mapping(mapping,packet,con)
        employees = [dict(row) for row in con.execute('SELECT employee_code,display_name,department FROM employees ORDER BY lower(display_name),employee_code LIMIT 1000')]
        groups, counts = [], {'new':0,'already_present':0,'conflict':0,'unmapped':0,'invalid':0,'source_invalid':0,'source_duplicates':0}
        for person in packet['groups']:
            counts['source_invalid'] += person['warnings']
            counts['invalid'] += person['warnings'] if person['key'] in mapping else 0
            counts['source_duplicates'] += person['duplicates']
            if person['key'] in mapping:
                for row in person['rows']:
                    counts[row_state(con,packet,person,row,mapping[person['key']])] += 1
            else:
                counts['unmapped'] += len(person['rows'])
            groups.append({'key':person['key'],'name':person['name'],'sheet':person['sheet'],'records':len(person['rows']),
                'warnings':person['warnings'],'from':min((r['date'] for r in person['rows']),default=None),'to':max((r['date'] for r in person['rows']),default=None)})
    return {'groups':groups,'employees':employees,'counts':counts,'source_title':packet['title']}


def import_package(packet, mapping, file_hash, actor_id):
    counts = {'new':0,'already_present':0,'conflict':0,'unmapped':0,'invalid':0,'source_invalid':0,'source_duplicates':0,'names_filled':0}
    with closing(connect()) as con, con:
        con.execute('BEGIN IMMEDIATE')
        validate_mapping(mapping,packet,con)
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
                state = row_state(con,packet,person,row,code)
                counts[state] += 1
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
