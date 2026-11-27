"""Synthetic local roster only; no office data."""
import sqlite3
from contextlib import closing
from app.bionet_roster import sync_roster, inspect_schema
from app.db import connect

def test_read_only_roster_matches_approved_ids_and_protects_names(admin,tmp_path,monkeypatch):
    path=tmp_path/'vendor.db'
    with closing(sqlite3.connect(path)) as con,con:
        con.execute('CREATE TABLE staff (id TEXT, first TEXT, last TEXT, secret TEXT)')
        con.executemany('INSERT INTO staff VALUES(?,?,?,?)',[
            ('1','Example','Person','not copied'),('2','Other','Person','not copied'),
            ('99','Unauthorized','Person','not copied')])
    with closing(connect()) as con,con:
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('1','PERSON','device')")
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('2','HR Name','manual')")
    for key,value in {'DB':str(path),'TABLE':'staff','ID_COLUMN':'id','FIRST_COLUMN':'first','LAST_COLUMN':'last'}.items():
        monkeypatch.setenv('BIONET_ROSTER_'+key,value)
    assert inspect_schema(str(path))=={'staff':['id','first','last','secret']}
    result=sync_roster()
    assert result=={'approved':2,'updated':1,'conflicts':1}
    assert sync_roster()['updated']==0
    with closing(connect()) as con:
        assert con.execute("SELECT display_name,name_source FROM employees WHERE employee_code='1'").fetchone()[:]==('Example Person','bionet')
        assert con.execute("SELECT display_name FROM employees WHERE employee_code='2'").fetchone()[0]=='HR Name'
        assert con.execute("SELECT 1 FROM employees WHERE employee_code='99'").fetchone() is None
    with closing(sqlite3.connect(path)) as con:
        assert con.execute("SELECT COUNT(*) FROM staff").fetchone()[0]==3


def test_bionet_auto_discovery_without_legacy_connector(admin, tmp_path, monkeypatch):
    client, headers = admin
    path = tmp_path / 'vendor.db'
    with closing(sqlite3.connect(path)) as con, con:
        con.execute('CREATE TABLE hr_employee (id INTEGER PRIMARY KEY, emp_pin TEXT, emp_firstname TEXT, emp_lastname TEXT, secret TEXT)')
        con.executemany('INSERT INTO hr_employee VALUES(?,?,?,?,?)', [
            (1, '99', 'ANA MARIE S.', 'DELA CRUZ JR.', 'never copied'),
            (2, '98', 'SANTOS, JUAN, REYES', '', 'never copied'),
            (3, '97', 'FIRST', 'ALIAS', 'never copied'),
            (4, '97', 'OTHER', 'ALIAS', 'never copied')])
    for key, value in {'DB':str(path), 'TABLE':'hr_employee', 'ID_COLUMN':'emp_pin',
                       'FIRST_COLUMN':'emp_firstname', 'LAST_COLUMN':'emp_lastname'}.items():
        monkeypatch.setenv('BIONET_ROSTER_' + key, value)
    monkeypatch.setenv('NCSC_ATTENDANCE_SOURCE', 'bionet')
    monkeypatch.setenv('K14_CONNECTOR_DB', str(tmp_path / 'nonexistent.sqlite3'))
    monkeypatch.setenv('K14_ROSTER_DISCOVERY_ENABLED', 'false')
    # Keep this test focused on roster discovery, independent of vendor punches.
    monkeypatch.setattr('app.bionet_attendance.import_records', lambda *args: {'outcome':'success'})
    from app.k14_sync import run_sync
    assert run_sync(manual=True)['roster_discovered'] == 0
    assert client.get('/api/employee-profiles/99').status_code == 404
    monkeypatch.setenv('K14_ROSTER_DISCOVERY_ENABLED', 'true')
    assert run_sync(manual=True)['roster_discovered'] == 2
    assert run_sync(manual=True)['roster_discovered'] == 0
    pending = client.get('/api/employee-profiles/99').json()
    assert not pending['profile_complete'] and not pending['sync_authorized']
    assert pending['suggested_name'] == dict(first_name='ANA MARIE', middle_name='S.', last_name='DELA CRUZ',
                                             suffix='JR.', needs_review=True)
    assert client.get('/api/employee-profiles/98').json()['suggested_name']['middle_name'] == 'REYES'
    assert client.get('/api/employee-profiles/97').status_code == 404
    from tests.test_profiles import profile
    assert client.post('/api/employee-profiles', json=profile('99'), headers=headers).status_code == 201
    with closing(sqlite3.connect(path)) as con, con:
        con.execute("UPDATE hr_employee SET emp_firstname='WRONG' WHERE emp_pin='99'")
    run_sync(manual=True)
    saved = client.get('/api/employee-profiles/99').json()
    assert saved['display_name'] == 'Example A. Employee' and saved['sync_authorized']
    assert not (tmp_path / 'nonexistent.sqlite3').exists()
