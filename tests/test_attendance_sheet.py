"""DTR display edits stay separate from original attendance evidence."""
from contextlib import closing

import pytest

from app.db import connect


def seed(client, headers):
    data = (b'DEMO001\t2026-11-02 07:30:07\t1\t9\t1\t0\n'
            b'DEMO001\t2026-11-02 12:00:11\t1\t9\t1\t101\n'
            b'DEMO001\t2026-11-02 13:00:13\t1\t9\t1\t0\n'
            b'DEMO001\t2026-11-02 17:00:17\t1\t9\t1\t102\n'
            b'DEMO001\t2026-11-03 08:00:00\t1\t9\t1\t0\n'
            b'DEMO002\t2026-11-02 08:00:00\t1\t9\t1\t0\n')
    assert client.post('/api/imports', files={'file': ('fictional.dat', data)}, headers=headers).status_code == 200
    with closing(connect()) as con:
        return [r[0] for r in con.execute("SELECT id FROM punches WHERE employee_code='DEMO001' ORDER BY happened_at")]


def monitor(client, code='DEMO001', month='2026-11'):
    return client.get('/api/dtr/monitor', params={'employee_code': code, 'month': month}).json()


def endpoint(code='DEMO001', date='2026-11-02'):
    return f'/api/attendance/{code}/{date}'


def test_no_automatic_numeric_code_or_clock_time_classification(admin):
    client, headers = admin
    seed(client, headers)
    day = monitor(client)['days'][1]
    assert all(value is None for value in day['slots'].values())
    assert day['unassigned_count'] == 4
    assert day['review']['undertime_minutes'] is None
    assert day['daily_total_seconds'] is None
    assert day['tone'] == 'holiday'  # Automatically verified All Souls' Day.
    assert [x['happened_at'][11:] for x in day['scans']] == ['07:30:07', '12:00:11', '13:00:13', '17:00:17']


def test_review_links_originals_and_preserves_codes_times_and_ids(admin):
    client, headers = admin
    ids = seed(client, headers)
    with closing(connect()) as con:
        before = [tuple(r) for r in con.execute('SELECT * FROM punches ORDER BY id')]
    payload = dict(zip(('am_in', 'am_out', 'pm_in', 'pm_out'), ids[:4]))
    payload.update(version=0, undertime_minutes=30, remark='Verified fictional DTR')
    assert client.put(endpoint(), json=payload).status_code == 403
    assert client.put(endpoint(), json=payload, headers=headers).json()['version'] == 1
    day = monitor(client)['days'][1]
    assert day['unassigned_count'] == 0
    assert day['slots']['am_in']['happened_at'] == '2026-11-02 07:30:07'
    assert day['slots']['am_out']['work_code'] == '101'
    assert day['review']['undertime_minutes'] == 30
    assert day['daily_total_seconds'] == (4*3600+30*60+4) + (4*3600+4)
    with closing(connect()) as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM punches ORDER BY id')] == before
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE entity='attendance_day'").fetchone()[0] == 1
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 409
    payload.update(version=1, undertime_minutes=0)
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 200
    assert monitor(client)['days'][1]['review']['undertime_minutes'] == 0


@pytest.mark.parametrize('invalid', ['duplicate', 'wrong-date', 'wrong-employee', 'reverse', 'unknown'])
def test_invalid_punch_assignment_is_atomic(admin, invalid):
    client, headers = admin
    ids = seed(client, headers)
    payload = {'version': 0, 'am_in': ids[0], 'am_out': ids[1]}
    if invalid == 'duplicate': payload['am_out'] = ids[0]
    if invalid == 'wrong-date': payload['am_out'] = ids[4]
    if invalid == 'wrong-employee':
        with closing(connect()) as con:
            payload['am_out'] = con.execute("SELECT id FROM punches WHERE employee_code='DEMO002'").fetchone()[0]
    if invalid == 'reverse': payload.update(am_in=ids[1], am_out=ids[0])
    if invalid == 'unknown': payload['am_out'] = 99999
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 400
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM attendance_day_reviews').fetchone()[0] == 0


def test_incomplete_entries_do_not_create_elapsed_or_undertime_totals(admin):
    client, headers = admin
    ids = seed(client, headers)
    assert client.put(endpoint(), json={'version': 0, 'am_in': ids[0]}, headers=headers).status_code == 200
    day = monitor(client)['days'][1]
    assert day['daily_total_seconds'] is None
    assert day['review']['undertime_minutes'] is None
    assert day['unassigned_count'] == 3


def test_holiday_is_shared_versioned_audited_and_does_not_create_punches(admin):
    client, headers = admin
    seed(client, headers)
    path = '/api/attendance-calendar/2026-11-02'
    assert client.put(path, json={'version': 0, 'holiday_name': 'Sample office holiday'}, headers=headers).status_code == 200
    for code in ('DEMO001', 'DEMO002'):
        day = monitor(client, code)['days'][1]
        assert day['tone'] == 'holiday'
        assert day['calendar'] == {'holiday_name': 'Sample office holiday', 'version': 1}
        assert day['review']['undertime_minutes'] is None
    assert client.put(path, json={'version': 0, 'holiday_name': 'Stale'}, headers=headers).status_code == 409
    assert client.put(path, json={'version': 1, 'holiday_name': ''}, headers=headers).status_code == 200
    assert monitor(client)['days'][1]['tone'] == 'entry'
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM punches').fetchone()[0] == 6
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE entity='attendance_calendar'").fetchone()[0] == 2


def test_activity_sources_remain_visible_without_crediting_hours(admin):
    client, headers = admin
    seed(client, headers)
    client.put('/api/attendance-calendar/2026-11-02', json={'version': 0, 'holiday_name': ''}, headers=headers)
    assert client.put('/api/work-codes/1/101', json={'label': 'Fictional AJA', 'activity_type': 'AJA'}, headers=headers).status_code == 200
    assert monitor(client)['days'][1]['tone'] == 'aja'
    payload = {'version': 0, 'activity_type': 'Travel Order', 'activity_reference': 'EXAMPLE-TO-001'}
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 200
    day = monitor(client)['days'][1]
    assert day['tone'] == 'travel'
    assert {x['category'] for x in day['display_activities']} == {'AJA', 'Travel Order'}
    assert day['review']['undertime_minutes'] is None
    assert all(x is None for x in day['slots'].values())
    assert day['daily_total_seconds'] is None


@pytest.mark.parametrize('payload', [
    {'version': 0, 'am_in': True}, {'version': 0, 'undertime_minutes': -1},
    {'version': 0, 'undertime_minutes': 1441}, {'version': 0, 'am_in': '1'},
    {'version': 0, 'activity_type': 'AJA'}, {'version': 0, 'activity_reference': 'ORPHAN'},
    {'version': 0, 'time_in': '08:00'}, {'version': 0, 'remark': 'bad\x00text'},
])
def test_invalid_review_fields_are_rejected(admin, payload):
    client, headers = admin
    seed(client, headers)
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 422


def test_review_permissions_dates_missing_employee_and_future_days(admin):
    client, headers = admin
    seed(client, headers)
    assert client.put(endpoint(date='2026-02-30'), json={'version': 0}, headers=headers).status_code == 400
    assert client.put(endpoint('MISSING'), json={'version': 0}, headers=headers).status_code == 404
    assert client.put('/api/attendance-calendar/1999-01-01', json={'version': 0}, headers=headers).status_code == 400
    future = monitor(client, month='2099-11')['days']
    assert all(day['tone'] == 'future' for day in future)
    assert all(day['review']['undertime_minutes'] is None for day in future)
    login = client.post('/api/login', json={'username': 'reviewer-test', 'password': 'local-reviewer-test-password'})
    read_headers = {'X-CSRF-Token': login.json()['csrf']}
    assert client.get('/api/dtr/monitor?employee_code=DEMO001&month=2026-11').status_code == 200
    assert client.put(endpoint(), json={'version': 0}, headers=read_headers).status_code == 403
    assert client.put('/api/attendance-calendar/2026-11-02', json={'version': 0}, headers=read_headers).status_code == 403
    client.post('/api/logout', headers=read_headers)
    assert client.put(endpoint(), json={'version': 0}, headers=read_headers).status_code == 401


def test_attendance_upgrade_backs_up_populated_database_once(admin):
    import os
    import sqlite3
    from pathlib import Path
    from app.db import initialize
    client, headers = admin
    seed(client, headers)
    with closing(connect()) as con, con:
        con.execute('DROP TABLE attendance_day_reviews')
        con.execute('DROP TABLE attendance_calendar')
        before = [tuple(r) for r in con.execute('SELECT * FROM punches ORDER BY id')]
    initialize()
    initialize()
    backups = list((Path(os.environ['DATABASE_PATH']).parent / 'backups').glob('before-attendance-*.sqlite3'))
    assert len(backups) == 1
    with closing(sqlite3.connect(backups[0])) as backup:
        assert backup.execute('SELECT * FROM punches ORDER BY id').fetchall() == before
        assert not backup.execute("SELECT 1 FROM sqlite_master WHERE name='attendance_day_reviews'").fetchone()
    with closing(connect()) as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM punches ORDER BY id')] == before
        assert con.execute('SELECT COUNT(*) FROM attendance_day_reviews').fetchone()[0] == 0



def test_hr_clock_adjustment_preserves_punches_and_requires_reason(admin):
    client, headers = admin
    seed(client, headers)
    payload = {"version":0,"approved_times":{"am_in":"07:45","aja_out":"08:07","aja_in":"18:00"}}
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 400
    payload["remark"]="Approved fictional field assignment"
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 200
    day = monitor(client)["days"][1]
    assert day["display_slots"]["am_in"]["origin"] == "hr_approved"
    assert day["display_slots"]["am_in"]["happened_at"].endswith("07:45:00")
    assert day["scans"][0]["happened_at"].endswith("07:30:07")
    assert day["aja_periods"][0]["in"]["origin"] == "hr_approved"
    assert day["aja_periods"][0]["in"]["time"] == "18:00:00"
    payload.update(version=1,approved_times={})
    assert client.put(endpoint(), json=payload, headers=headers).status_code == 200
    assert monitor(client)["days"][1]["review"]["approved_times"] == {}
