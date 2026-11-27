"""Fictional employee profiles, ID authorization, and non-destructive migration."""
from contextlib import closing
import sqlite3

import pytest

from app.db import connect, initialize
from app.device_access import LEGACY_ALLOWED_IDS, authorized_ids, read_authorized_ids
from tests.test_k14_sync import _connector, _enable, HOST


def profile(code="25", **changes):
    return {"employee_code": code, "first_name": "Example", "middle_name": "A.",
            "last_name": "Employee", "suffix": "", "employment_type": "COS",
            "department": "Sample Unit", "position": "Records Assistant",
            "sync_authorized": True, "device_enrollment_confirmed": True, **changes}


def test_register_existing_identity_preserves_original_scans_and_roster_names(admin):
    client, headers = admin
    raw = b"7\t2026-11-02 08:00:00\t1\t2\t5\t0\n"
    assert client.post('/api/imports', files={'file':('sample.dat',raw)}, headers=headers).status_code == 200
    with closing(connect()) as con:
        before = [tuple(r) for r in con.execute('SELECT * FROM punches')]
        users_before = [tuple(r) for r in con.execute('SELECT * FROM users')]
    response = client.post('/api/employee-profiles', json=profile("7"), headers=headers)
    assert response.status_code == 201, response.text
    assert response.json()['display_name'] == 'Example A. Employee'
    assert response.json()['version'] == 1
    assert response.json()['profile_complete'] is True
    assert client.post('/api/employee-profiles', json=profile("7", first_name="Wrong"), headers=headers).status_code == 409
    assert client.put('/api/employees/7', json={'display_name':'Device nickname'}, headers=headers).status_code == 409
    roster = b'employee_code,display_name\n7,Device nickname\n'
    imported = client.post('/api/employees/import', files={'file':('names.csv',roster)}, headers=headers)
    assert imported.json()['counts']['conflict'] == 1
    assert client.get('/api/employee-profiles/7').json()['display_name'] == 'Example A. Employee'
    with closing(connect()) as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM punches')] == before
        assert [tuple(r) for r in con.execute('SELECT * FROM users')] == users_before
        assert con.execute('SELECT COUNT(*) FROM employees').fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE entity='employee_profile'").fetchone()[0] == 1
    register = client.get('/api/employee-register?month=2026-11').json()['items'][0]
    assert register['employment_type'] == 'COS'
    assert register['position'] == 'Records Assistant'


def test_new_authorized_id_imports_without_code_changes_and_pause_retains_history(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / 'source.sqlite3'
    _connector(path, [(HOST,'25','2026-11-02 08:00:00','2','5','2026-11-23 03:23:42')])
    _enable(monkeypatch,path)
    assert client.post('/api/device/sync', headers=headers).json()['records_inserted'] == 0
    assert client.post('/api/employee-profiles', json=profile(), headers=headers).status_code == 201
    assert client.post('/api/device/sync', headers=headers).json()['records_inserted'] == 1
    assert client.post('/api/device/sync', headers=headers).json()['records_inserted'] == 0
    data = profile(sync_authorized=False)
    data.pop('employee_code');data['version'] = 1
    saved = client.put('/api/employee-profiles/25', json=data, headers=headers)
    assert saved.status_code == 200
    assert saved.json()['version'] == 2
    assert saved.json()['sync_authorized'] is False
    initialize()  # Bootstrap must never re-enable a paused ID.
    with closing(connect()) as con:
        assert '25' not in authorized_ids(con)
        assert con.execute('SELECT COUNT(*) FROM punches').fetchone()[0] == 1
    assert client.post('/api/device/sync', headers=headers).json()['records_skipped'] == 1


def test_exact_ids_and_optimistic_profile_updates(admin):
    client, headers = admin
    assert client.post('/api/employee-profiles', json=profile('0007'), headers=headers).status_code == 201
    data = profile(last_name='Updated', employment_type='OJT')
    data.pop('employee_code');data['version'] = 1
    saved = client.put('/api/employee-profiles/0007', json=data, headers=headers)
    assert saved.status_code == 200
    assert saved.json()['employee_code'] == '0007'
    assert client.put('/api/employee-profiles/0007', json=data, headers=headers).status_code == 409
    data['version'] = 2;data['employee_code'] = '7'
    assert client.put('/api/employee-profiles/0007', json=data, headers=headers).status_code == 422
    assert client.get('/api/employee-profiles/7').status_code == 404


@pytest.mark.parametrize('changes', [
    {'employee_code':'bad id'}, {'first_name':'  '}, {'last_name':'Wrong\nName'},
    {'employment_type':'Invented'}, {'device_enrollment_confirmed':False},
    {'unexpected':'not allowed'},
])
def test_invalid_registration_never_partially_writes(admin, changes):
    client, headers = admin
    assert client.post('/api/employee-profiles', json=profile(**changes), headers=headers).status_code == 422
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM employees').fetchone()[0] == 0
        assert authorized_ids(con) == LEGACY_ALLOWED_IDS


def test_profile_filters_pagination_and_permissions(admin):
    client, headers = admin
    for i, kind in enumerate(('COS','Permanent','GIP','OJT')):
        assert client.post('/api/employee-profiles', json=profile(str(i+30), employment_type=kind), headers=headers).status_code == 201
    with closing(connect()) as con, con:
        con.execute("INSERT INTO employees(employee_code,display_name) VALUES('99','Unverified Alias')")
    listed = client.get('/api/employee-profiles?limit=2&page=2').json()
    assert len(listed['items']) == 2
    assert listed['total'] == 5
    assert listed['summary']['registered'] == 4
    assert listed['summary']['needs_details'] == 1
    assert len(client.get('/api/employee-profiles?category=OJT').json()['items']) == 1
    assert client.get('/api/employee-profiles?status=Needs%20details').json()['items'][0]['employee_code'] == '99'
    assert client.get('/api/employee-profiles?q=99').json()['total'] == 1
    assert client.post('/api/employee-profiles', json=profile('100')).status_code == 403
    login = client.post('/api/login', json={'username':'reviewer-test','password':'local-reviewer-test-password'})
    review_headers = {'X-CSRF-Token':login.json()['csrf']}
    assert client.get('/api/employee-profiles').status_code == 200
    assert client.post('/api/employee-profiles', json=profile('100'), headers=review_headers).status_code == 403
    edited = profile();edited.pop('employee_code');edited['version'] = 1
    assert client.put('/api/employee-profiles/30', json=edited, headers=review_headers).status_code == 403


def test_populated_legacy_database_is_backed_up_before_profile_tables_are_added(admin, tmp_path):
    client, headers = admin
    client.post('/api/imports', files={'file':('sample.dat', b'7\t2026-11-02 08:00:00\t1\t0\t1\t0\n')}, headers=headers)
    with closing(connect()) as con, con:
        before = [tuple(r) for r in con.execute('SELECT * FROM punches')]
        con.execute('DROP TABLE employee_profiles')
        con.execute('DROP TABLE k14_authorizations')
    initialize()
    backups = list((tmp_path / 'backups').glob('before-profiles-*.sqlite3'))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert list(backup.execute('SELECT * FROM punches')) == before
    with closing(connect()) as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM punches')] == before
        assert authorized_ids(con) == LEGACY_ALLOWED_IDS
    initialize()
    assert len(list((tmp_path / 'backups').glob('*.sqlite3'))) == 1


def test_missing_registry_fails_closed_without_creating_it(tmp_path):
    path = tmp_path / 'missing.sqlite3'
    with pytest.raises(ValueError, match='registry not found'):
        read_authorized_ids(path)
    assert not path.exists()


def test_restarts_do_not_reenable_a_paused_original_pilot_id(admin):
    client, headers = admin
    assert client.post('/api/employee-profiles', json=profile('7', sync_authorized=False), headers=headers).status_code == 201
    initialize()
    with closing(connect()) as con:
        assert '7' not in authorized_ids(con)
        assert '13' not in authorized_ids(con)


def test_device_roster_cannot_fill_over_a_verified_profile_department(admin):
    client, headers = admin
    assert client.post('/api/employee-profiles', json=profile('7',department=''), headers=headers).status_code == 422
    assert client.post('/api/employee-profiles', json=profile('7'), headers=headers).status_code == 201
    # An older verified profile may still have a blank department.
    with closing(connect()) as con, con:
        con.execute("UPDATE employees SET department='' WHERE employee_code='7'")
    roster = b'employee_code,display_name,department\n7,Example A. Employee,Device department\n'
    result = client.post('/api/employees/import', files={'file':('names.csv',roster)}, headers=headers)
    assert result.json()['counts']['conflict'] == 1
    actual = client.get('/api/employee-profiles/7').json()
    assert actual['department'] == '' and actual['name_source'] == 'profile'



def test_directory_archive_is_reversible_and_preserves_attendance(admin):
    client, headers = admin
    raw = b"7\t2026-11-02 08:00:00\t1\t2\t5\t0\n"
    assert client.post('/api/imports', files={'file':('sample.dat',raw)}, headers=headers).status_code == 200
    assert client.post('/api/employee-profiles', json=profile('7'), headers=headers).status_code == 201
    with closing(connect()) as con:
        before = [tuple(r) for r in con.execute('SELECT * FROM punches')]
    assert client.delete('/api/employee-profiles/7', headers=headers).status_code == 200
    assert client.get('/api/employee-profiles').json()['total'] == 0
    assert client.get('/api/employee-profiles?archived=true').json()['items'][0]['employee_code'] == '7'
    assert client.get('/api/employee-profiles/7').json()['profile_complete']
    assert client.get('/api/employee-register?month=2026-11').json()['items'][0]['employee_code'] == '7'
    assert client.post('/api/employee-profiles/7/restore', headers=headers).status_code == 200
    assert client.get('/api/employee-profiles').json()['total'] == 1
    assert client.get('/api/employee-profiles?archived=true').json()['total'] == 0
    with closing(connect()) as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM punches')] == before
        assert '7' in authorized_ids(con)


def test_device_name_suggestions():
    from app.profiles import suggest_name_parts
    assert suggest_name_parts("DELA CRUZ, ANA MARIE, SANTOS, JR.") == {
        "last_name":"DELA CRUZ", "first_name":"ANA MARIE", "middle_name":"SANTOS", "suffix":"JR.", "needs_review":False}
    assert suggest_name_parts("ANA MARIE S. CRUZ") == {
        "first_name":"ANA MARIE", "middle_name":"S.", "last_name":"CRUZ", "suffix":"", "needs_review":True}
    assert suggest_name_parts("ANA")["last_name"] == ""
