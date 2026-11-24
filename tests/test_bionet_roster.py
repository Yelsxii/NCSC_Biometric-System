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
