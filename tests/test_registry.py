"""Staff identity and work-code mappings enrich logs without changing events."""
from contextlib import closing
from pathlib import Path

import pytest

from app.db import connect, initialize
from app.registry import parse_staff


ROSTER = b'employee_code,display_name,department\nDEMO001,Sample Employee One,Sample Office\nDEMO002,Sample Employee Two,Sample Office\n'
SCANS = (b'DEMO001\t2026-11-03 07:21:07\t1\t0\t1\t0\n'
         b'DEMO002\t2026-11-03 09:10:00\t1\t4\t1\t2\n'
         b'DEMO001\t2026-11-03 17:05:45\t2\t1\t1\t2\n')


def test_scan_import_registers_ids_and_codes_without_inventing_meanings(admin):
    client, headers = admin
    result = client.post('/api/imports', files={'file': ('sample.dat', SCANS)}, headers=headers)
    assert result.status_code == 200
    assert result.json()['inserted'] == 3  # metadata inserts are not counted as scans
    staff = client.get('/api/employees').json()
    assert staff['items'] == ['DEMO001', 'DEMO002']
    assert all(not item['display_name'] for item in staff['staff'])
    codes = client.get('/api/work-codes').json()['items']
    assert len(codes) == 3
    assert all(item['activity_type'] == 'Unclassified' and item['label'] == '' for item in codes)
    assert sum(item['scan_count'] for item in codes) == 3
    initialize()  # restart preserves registered metadata
    assert len(client.get('/api/work-codes').json()['items']) == 3


def test_roster_preview_is_read_only_and_import_fills_names(admin):
    client, headers = admin
    client.post('/api/imports', files={'file': ('sample.dat', SCANS)}, headers=headers)
    preview = client.post('/api/employees/import/preview', files={'file': ('staff.csv', ROSTER)}, headers=headers)
    assert preview.status_code == 200
    assert preview.json()['counts']['fill'] == 2
    assert client.get('/api/employees').json()['staff'][0]['display_name'] == ''
    saved = client.post('/api/employees/import', files={'file': ('staff.csv', ROSTER)}, headers=headers)
    assert saved.status_code == 200
    assert saved.json()['counts']['fill'] == 2
    duplicate = client.post('/api/employees/import', files={'file': ('staff.csv', ROSTER)}, headers=headers).json()
    assert duplicate['counts'] == {'new': 0, 'fill': 0, 'unchanged': 2, 'conflict': 0}
    records = client.get('/api/punches').json()
    assert records['total'] == 3
    assert all(item['display_name'].startswith('Sample Employee') for item in records['items'])
    assert client.get('/api/dtr/monitor?employee_code=DEMO001&month=2026-11').json()['display_name'] == 'Sample Employee One'
    assert client.get('/api/overview').json()['totals']['employees'] == 2


def test_roster_conflicts_never_overwrite_and_manual_edits_are_audited(admin):
    client, headers = admin
    payload = {'display_name': 'Verified Sample Name', 'department': 'Verified Office'}
    assert client.put('/api/employees/DEMO001', json=payload, headers=headers).status_code == 200
    saved = client.post('/api/employees/import', files={'file': ('staff.csv', ROSTER)}, headers=headers).json()
    assert saved['counts']['conflict'] == 1 and saved['counts']['new'] == 1
    current = client.get('/api/employees').json()['staff'][0]
    assert current['display_name'] == payload['display_name']
    assert current['department'] == payload['department']
    assert current['name_source'] == 'manual'
    assert client.put('/api/employees/bad%20id', json=payload, headers=headers).status_code == 400
    assert client.put('/api/employees/DEMO001', json={'display_name': '   '}, headers=headers).status_code == 422
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE entity='employee'").fetchone()[0] == 1


def test_work_code_labels_are_scoped_to_device_and_do_not_modify_raw_events(admin):
    client, headers = admin
    client.post('/api/imports', files={'file': ('sample.dat', SCANS)}, headers=headers)
    before = client.get('/api/punches').json()['items']
    mapping = {'label': 'Sample AJA departure', 'activity_type': 'AJA'}
    assert client.put('/api/work-codes/1/2', json=mapping, headers=headers).status_code == 200
    assert client.put('/api/work-codes/1/2', json=mapping).status_code == 403
    after = client.get('/api/punches').json()['items']
    for a, b in zip(before, after):
        for key in ('id', 'employee_code', 'happened_at', 'status_code', 'verification_code', 'work_code', 'device_id'):
            assert a[key] == b[key]
    assert next(row for row in after if row['device_id'] == '1' and row['work_code'] == '2')['work_label'] == mapping['label']
    assert next(row for row in after if row['device_id'] == '2' and row['work_code'] == '2')['work_label'] == ''
    assert client.get('/api/activities').json()['items'] == []


def test_k14_xls_roster_and_csv_preserve_identifiers_and_validate_rows(admin):
    client, headers = admin
    raw = (Path(__file__).parent / 'fixtures' / 'k14_sample.xls').read_bytes()
    rows = parse_staff(raw, 'report.xls')
    assert [r['employee_code'] for r in rows] == ['DEMO001', 'DEMO002']
    assert all(r['display_name'].startswith('Sample Employee') for r in rows)
    assert client.post('/api/employees/import', files={'file': ('report.xls', raw)}, headers=headers).json()['counts']['new'] == 2
    assert client.get('/api/punches').json()['total'] == 0
    leading = parse_staff(b'employee_code,display_name\n0007,Sample Person\n', 'staff.csv')
    assert leading[0]['employee_code'] == '0007'
    with pytest.raises(ValueError, match='conflicting'):
        parse_staff(b'employee_code,display_name\n007,Name One\n007,Name Two\n', 'staff.csv')


@pytest.mark.parametrize('name,raw', [
    ('user.dat', b'\0' * 72), ('staff.csv', b'ID,Name\n1,Test\n'),
    ('staff.csv', b'employee_code,display_name\n1,Test,Extra\n'), ('report.xls', b'not excel'),
])
def test_staff_import_rejects_unknown_formats_without_partial_writes(admin, name, raw):
    client, headers = admin
    response = client.post('/api/employees/import', files={'file': (name, raw)}, headers=headers)
    assert response.status_code == 400
    assert client.get('/api/employees').json()['items'] == []


def test_registry_permissions_and_csrf(admin):
    client, headers = admin
    assert client.post('/api/employees/import', files={'file': ('staff.csv', ROSTER)}).status_code == 403
    login = client.post('/api/login', json={'username': 'reviewer-test', 'password': 'local-reviewer-test-password'})
    headers = {'X-CSRF-Token': login.json()['csrf']}
    assert client.get('/api/employees').status_code == 200
    assert client.get('/api/work-codes').status_code == 200
    assert client.post('/api/employees/import/preview', files={'file': ('staff.csv', ROSTER)}, headers=headers).status_code == 403
    assert client.put('/api/employees/DEMO001', json={'display_name': 'Test Name'}, headers=headers).status_code == 403
    assert client.put('/api/work-codes/1/2', json={'label': 'Test Code', 'activity_type': 'AJA'}, headers=headers).status_code == 403
    client.post('/api/logout', headers=headers)
    assert client.get('/api/work-codes').status_code == 401
