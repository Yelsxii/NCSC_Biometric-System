"""Synthetic manual DTR packages only; no office data is a fixture."""
import datetime as dt
import json
from contextlib import closing

import pytest

from app.db import connect, initialize
from app.manual_dtr import parse_package, clock_value, sync_local_source, automatic_mapping


def row(date='2026-11-06', times=None, total=8/24, ut=0, ot=0, number=7):
    times = times or ['08:00','12:00','13:00','17:00']
    return {'row':number,'values':[date,'Friday',*times,None,None,total,ut,ot,'Complete']}


def packet(rows=None):
    return {'format':'ncsc-manual-dtr-v1','source':{'id':'fictional-workbook','title':'Fictional manual DTR'},
        'people':[{'key':'sample-one','name':'Example Employee','sheet':'EXAMPLE_EMPLOYEE','rows':rows if rows is not None else [row()]}]}


def seed_employee(code='001', name=''):
    with closing(connect()) as con, con:
        con.execute('INSERT INTO employees(employee_code,display_name) VALUES(?,?)',(code,name))


def file_bytes(data):
    return json.dumps(data).encode()


def preview(client, headers, data, mapping=None):
    return client.post('/api/manual-dtr/preview', headers=headers,
        files={'file':('fictional.json',file_bytes(data),'application/json')},
        data={'mapping':json.dumps(mapping if mapping is not None else {'sample-one':'001'})})


def merge(client, headers, data, token, mapping=None):
    return client.post('/api/manual-dtr/import', headers=headers,
        files={'file':('fictional.json',file_bytes(data),'application/json')},
        data={'mapping':json.dumps(mapping if mapping is not None else {'sample-one':'001'}),'preview_token':token})


def import_one(client, headers, data):
    p=preview(client,headers,data)
    assert p.status_code==200,p.text
    result=merge(client,headers,data,p.json()['preview_token'])
    assert result.status_code==200,result.text
    return result.json()


def monitor(client, index=5):
    return client.get('/api/dtr/monitor?employee_code=001&month=2026-11').json()['days'][index]


def test_local_source_reconciles_exact_names_without_a_button(admin, tmp_path, monkeypatch):
    client, _ = admin
    seed_employee(name='Example Employee')
    with closing(connect()) as con, con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('002','Different Employee','device')")
    source=tmp_path/'protected-manual.json'
    source.write_bytes(file_bytes(packet()))
    monkeypatch.setenv('MANUAL_DTR_SOURCE_PATH',str(source))
    first=sync_local_source()
    assert first['available'] and first['matched_tabs']==1 and first['new_days']==1
    assert monitor(client)['display_slots']['am_in']['origin']=='manual_sheet'
    assert sync_local_source()['new_days']==0
    assert client.get('/api/manual-dtr/status').json()['matched_tabs']==1
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM manual_dtr_entries").fetchone()[0]==1
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE entity='manual_dtr'").fetchone()[0]==1


def test_local_source_skips_unknown_or_ambiguous_identity(admin,tmp_path,monkeypatch):
    client,_=admin
    seed_employee(name='Unrelated Person')
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
    source=tmp_path/'manual.json'
    source.write_bytes(file_bytes(packet()))
    monkeypatch.setenv('MANUAL_DTR_SOURCE_PATH',str(source))
    result=sync_local_source()
    assert result['available'] and result['matched_tabs']==0 and result['unmatched_tabs']==1
    assert monitor(client)['display_slots']['am_in'] is None
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET display_name='Example Employee' WHERE employee_code='001'")
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('002','Example Employee','device')")
    assert automatic_mapping(parse_package(source.read_bytes()))=={}
    assert sync_local_source()['matched_tabs']==0


def test_local_source_rejects_cloud_folder_and_does_not_modify_existing_days(admin,tmp_path,monkeypatch):
    client,headers=admin
    seed_employee(name='Example Employee')
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
    first=packet()
    import_one(client,headers,first)
    changed=packet([row(times=['09:00','12:00','13:00','17:00'])])
    source=tmp_path/'manual.json'
    source.write_bytes(file_bytes(changed))
    monkeypatch.setenv('MANUAL_DTR_SOURCE_PATH',str(source))
    assert sync_local_source()['new_days']==0
    assert monitor(client)['display_slots']['am_in']['happened_at'].endswith('08:00:00')
    cloud=tmp_path/'OneDrive'
    cloud.mkdir()
    other=cloud/'manual.json'
    other.write_bytes(file_bytes(changed))
    monkeypatch.setenv('MANUAL_DTR_SOURCE_PATH',str(other))
    assert sync_local_source()['available'] is False


def test_biometric_boundaries_take_priority_and_sheet_fills_middle(admin):
    client,headers=admin
    seed_employee()
    sample=b'001\t2026-11-06 08:00:07\t1\t9\t1\t0\n001\t2026-11-06 17:00:11\t1\t9\t1\t0\n'
    assert client.post('/api/imports',headers=headers,files={'file':('fictional.dat',sample)}).status_code==200
    with closing(connect()) as con:
        before=[tuple(r) for r in con.execute('SELECT * FROM punches ORDER BY id')]
    result=import_one(client,headers,packet())
    assert result['counts']['new']==1
    day=monitor(client)
    assert [x['origin'] for x in day['display_slots'].values()]==['biometric','manual_sheet','manual_sheet','biometric']
    assert day['display_slots']['am_in']['happened_at']=='2026-11-06 08:00:07'
    assert day['display_slots']['am_out']['happened_at']=='2026-11-06 12:00:00'
    assert day['monitoring']['total_seconds']==8*3600
    assert day['monitoring']['undertime_seconds']==day['monitoring']['overtime_seconds']==0
    assert day['monitoring']['remarks']=='Complete'
    assert day['slots']==dict.fromkeys(['am_in','am_out','pm_in','pm_out'])
    with closing(connect()) as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM punches ORDER BY id')]==before
        assert con.execute("SELECT display_name,name_source FROM employees WHERE employee_code='001'").fetchone()[:]==('Example Employee','manual_dtr')


def test_duplicate_imports_and_changed_source_never_overwrite(admin):
    client,headers=admin
    seed_employee(name='Verified office name')
    data=packet()
    first=preview(client,headers,data).json()
    assert first['counts']['new']==1
    assert merge(client,headers,data,first['preview_token']).json()['counts']['new']==1
    again=merge(client,headers,data,first['preview_token']).json()['counts']
    assert again['new']==0 and again['already_present']==1
    changed=packet([row(times=['08:30','12:00','13:00','17:00'],total=7.5/24,ut=.5/24)])
    p=preview(client,headers,changed).json()
    assert p['counts']['conflict']==1
    assert merge(client,headers,changed,p['preview_token']).json()['counts']['new']==0
    assert monitor(client)['display_slots']['am_in']['happened_at'].endswith('08:00:00')
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM punches').fetchone()[0]==0
        assert con.execute('SELECT COUNT(*) FROM manual_dtr_entries').fetchone()[0]==1
        assert con.execute("SELECT display_name FROM employees WHERE employee_code='001'").fetchone()[0]=='Verified office name'


def test_preview_is_bound_to_file_mapping_actor_and_nonempty_selection(admin):
    client,headers=admin
    seed_employee();seed_employee('002')
    data=packet();token=preview(client,headers,data).json()['preview_token']
    assert merge(client,headers,data,token,{'sample-one':'002'}).status_code==400
    assert merge(client,headers,packet([row(ot=1/24)]),token).status_code==400
    assert merge(client,headers,data,'tampered').status_code==400
    assert merge(client,headers,data,token,{}).status_code==400
    assert preview(client,headers,data,{'sample-one':'NO-SUCH-EMPLOYEE'}).status_code==400
    assert preview(client,headers,data,{'unknown':'001'}).status_code==400
    assert preview(client,headers,data,{}).json()['counts']['unmapped']==1
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM manual_dtr_entries').fetchone()[0]==0


def test_source_row_cannot_be_remapped_to_another_employee(admin):
    client,headers=admin
    seed_employee();seed_employee('002')
    data=packet();import_one(client,headers,data)
    p=preview(client,headers,data,{'sample-one':'002'}).json()
    assert p['counts']['conflict']==1
    assert merge(client,headers,data,p['preview_token'],{'sample-one':'002'}).json()['counts']['new']==0
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM manual_dtr_entries WHERE employee_code='002'").fetchone()[0]==0
        assert con.execute("SELECT display_name FROM employees WHERE employee_code='002'").fetchone()[0]==''


def test_source_disagreement_is_visible_and_calculations_are_withheld(admin):
    client,headers=admin
    seed_employee()
    client.post('/api/imports',headers=headers,files={'file':('fictional.dat',b'001\t2026-11-06 08:10:07\t1\t9\t1\t0\n001\t2026-11-06 17:00:11\t1\t9\t1\t0\n')})
    import_one(client,headers,packet())
    day=monitor(client)
    assert day['display_slots']['am_in']['happened_at'].endswith('08:10:07')
    assert day['manual_source']['times']['am_in']=='08:00:00'
    assert day['monitoring']['remarks']=='Source difference'
    assert day['monitoring']['undertime_seconds'] is None
    assert day['monitoring']['overtime_seconds'] is None


def test_reported_overtime_and_undertime_are_copied_not_invented(admin):
    client,headers=admin
    seed_employee()
    data=packet([row('2026-11-09',['08:00','12:00','13:00','18:00'],9/24,0,1/24,8),
                 row('2026-11-10',['08:30','12:00','13:00','17:00'],7.5/24,.5/24,0,9)])
    import_one(client,headers,data)
    ot=monitor(client,8)['monitoring'];ut=monitor(client,9)['monitoring']
    assert ot['overtime_seconds']==3600 and ot['remarks']=='Overtime'
    assert ut['undertime_seconds']==1800 and ut['remarks']=='Undertime'
    assert ut['total_seconds']==27000


def test_biometric_only_elapsed_is_not_automatic_earned_overtime(admin):
    client,headers=admin
    seed_employee()
    data=''.join(f'001\t2026-11-06 {t}\t1\t9\t1\t0\n' for t in ['08:00:00','12:00:00','13:00:00','18:00:00']).encode()
    client.post('/api/imports',headers=headers,files={'file':('fictional.dat',data)})
    result=monitor(client)['monitoring']
    assert result['total_seconds']==32400
    assert result['overtime_seconds'] is None and result['undertime_seconds'] is None
    assert result['remarks']=='Needs hour review'


def test_incomplete_and_future_rows_do_not_create_deficit_hours(admin):
    future=row('2099-01-01',number=10)
    incomplete=row(times=['08:00',None,None,None],total=9/24,ut=8/24,ot=1/24)
    blank=row('2026-11-07',[None,None,None,None],total=None,ut=8/24,number=9)
    parsed=parse_package(file_bytes(packet([incomplete,blank,future])))
    assert len(parsed['groups'][0]['rows'])==1
    assert parsed['groups'][0]['rows'][0]['data']['reported_ut'] is None
    client,headers=admin;seed_employee();import_one(client,headers,packet([incomplete]))
    day=monitor(client)
    assert day['monitoring']['total_seconds'] is None
    assert day['monitoring']['remarks']=='Incomplete entries'


def test_travel_order_numbers_are_references_and_not_regular_punches(admin):
    data=packet([row(times=['Travel Order No.: EXAMPLE-2026-001',None,None,None],total=8/24)])
    parsed=parse_package(file_bytes(data))['groups'][0]['rows'][0]['data']
    assert all(v is None for v in parsed['times'].values())
    assert parsed['notes']==['Travel Order No.: EXAMPLE-2026-001']
    assert parsed['reported_total'] is None
    client,headers=admin;seed_employee();import_one(client,headers,data)
    day=monitor(client)
    assert day['tone']=='travel'
    assert day['travel_order'] is True and day['travel_periods']==['am','pm']
    assert day['monitoring']['remarks']=='Travel Order'
    assert day['monitoring']['total_seconds'] is None
    assert any(x['category']=='Travel Order' for x in day['display_activities'])


def test_source_duplicate_rows_and_ambiguous_times_are_not_silently_selected():
    a=row();b={**a,'row':8}
    parsed=parse_package(file_bytes(packet([a,b])))['groups'][0]
    assert len(parsed['rows'])==1 and parsed['duplicates']==1
    with pytest.raises(ValueError,match='Duplicate source date'):
        parse_package(file_bytes(packet([a,row(times=['08:10','12:00','13:00','17:00'],number=8)])))
    bad=parse_package(file_bytes(packet([row(times=['08:00–12:00','12:00','13:00','17:00'])])))['groups'][0]
    assert bad['warnings']==1 and bad['rows']==[]
    with pytest.raises(ValueError):clock_value(True,'am_in')
    assert clock_value('1:00','pm_in')=='13:00:00'
    assert clock_value('12:00 PM','am_out')=='12:00:00'
    assert clock_value('12:00:00\nWORK SUSPENSION','am_out')=='12:00:00'
    serial=(dt.date(2026,11,6)-dt.date(1899,12,30)).days
    assert clock_value(serial+8/24,'am_in','2026-11-06')=='08:00:00'


def test_unplaced_biometric_events_remain_for_review(admin):
    client,headers=admin;seed_employee()
    client.post('/api/imports',headers=headers,files={'file':('fictional.dat',b'001\t2026-11-06 09:00:00\t1\t9\t1\t0\n001\t2026-11-06 10:00:00\t1\t9\t1\t0\n001\t2026-11-06 11:00:00\t1\t9\t1\t0\n')})
    import_one(client,headers,packet())
    day=monitor(client)
    assert day['display_unassigned_count']==3
    assert day['monitoring']['remarks']=='Source difference'
    assert day['monitoring']['overtime_seconds'] is None


def test_official_activity_codes_do_not_fill_regular_slots(admin):
    client,headers=admin;seed_employee()
    client.post('/api/imports',headers=headers,files={'file':('fictional.dat',b'001\t2026-11-06 09:00:00\t1\t9\t1\t11\n001\t2026-11-06 16:00:00\t1\t9\t1\t12\n')})
    for code,direction in [('11','IN'),('12','OUT')]:
        client.put('/api/work-codes/1/'+code,headers=headers,json={'label':'Fictional AJA','activity_type':'AJA','direction':direction})
    import_one(client,headers,packet())
    day=monitor(client)
    assert all(x['origin']=='manual_sheet' for x in day['display_slots'].values())
    assert day['activity_mappings'][0]['status']=='code_matched'
    assert day['display_unassigned_count']==0


def test_permissions_malformed_packages_and_preview_csrf(admin):
    client,headers=admin;seed_employee();data=packet()
    assert preview(client,{},data).status_code==403
    assert preview(client,headers,{'format':'wrong'}).status_code==400
    login=client.post('/api/login',json={'username':'reviewer-test','password':'local-reviewer-test-password'})
    read_headers={'X-CSRF-Token':login.json()['csrf']}
    assert preview(client,read_headers,data).status_code==403
    assert merge(client,read_headers,data,'anything').status_code==403
    client.post('/api/logout',headers=read_headers)
    assert preview(client,read_headers,data).status_code==401


def test_verified_national_holidays_and_working_days(admin):
    client,headers=admin;seed_employee()
    days=client.get('/api/dtr/monitor?employee_code=001&month=2026-11').json()['days']
    assert days[1]['calendar']['holiday_name']=="All Souls' Day"
    assert days[29]['calendar']['holiday_name']=='Bonifacio Day'
    feb=client.get('/api/dtr/monitor?employee_code=001&month=2026-02').json()['days']
    assert feb[24]['calendar']['holiday_name']==''  # EDSA is a special WORKING day.
    future=client.get('/api/dtr/monitor?employee_code=001&month=2099-01').json()['days']
    assert future[0]['calendar_verified'] is False
    client.put('/api/attendance-calendar/2026-11-06',headers=headers,json={'version':0,'holiday_name':''})
    import_one(client,headers,packet([row(times=['HOLIDAY',None,None,None])]))
    assert monitor(client)['calendar']['holiday_name']==''  # Explicit office override takes precedence.


def test_upgrade_snapshot_and_existing_manual_rows_survive_restart(admin):
    import os,sqlite3
    from pathlib import Path
    client,headers=admin;seed_employee()
    client.post('/api/imports',headers=headers,files={'file':('fictional.dat',b'001\t2026-11-06 08:00:00\t1\t9\t1\t0\n')})
    with closing(connect()) as con,con:
        con.execute('DROP TABLE manual_dtr_entries');con.execute('DROP TABLE manual_dtr_imports')
    initialize();initialize()
    backups=list((Path(os.environ['DATABASE_PATH']).parent/'backups').glob('before-manual-dtr-*.sqlite3'))
    assert len(backups)==1
    with closing(sqlite3.connect(backups[0])) as con:
        assert con.execute('SELECT COUNT(*) FROM punches').fetchone()[0]==1
    import_one(client,headers,packet());initialize()
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM manual_dtr_entries').fetchone()[0]==1
        assert con.execute('SELECT COUNT(*) FROM punches').fetchone()[0]==1


def test_todays_future_timeout_is_not_reported_as_earned_time(admin, monkeypatch):
    original=dt.datetime
    class OfficeClock(original):
        @classmethod
        def now(cls,tz=None):
            return cls(2026,11,24,8,0,0,tzinfo=tz)
    monkeypatch.setattr('app.dtr_sources.dt.datetime',OfficeClock)
    client,headers=admin;seed_employee()
    import_one(client,headers,packet([row('2026-11-24')]))
    day=monitor(client,23)
    assert day['display_slots']['pm_out']['happened_at'].endswith('17:00:00')
    assert day['monitoring']['remarks']=='Future entry'
    assert day['monitoring']['total_seconds'] is None
    assert day['monitoring']['overtime_seconds'] is None
    assert day['monitoring']['undertime_seconds'] is None


def test_same_employee_archived_months_can_be_imported_together(admin):
    client,headers=admin;seed_employee()
    data=packet()
    data['people'].append({'key':'archived','name':'Example Employee','sheet':'ARCHIVED_EXAMPLE',
        'rows':[row('2026-10-06',number=17)]})
    mapping={'sample-one':'001','archived':'001'}
    p=preview(client,headers,data,mapping)
    assert p.status_code==200,p.text
    assert p.json()['counts']['new']==2
    assert merge(client,headers,data,p.json()['preview_token'],mapping).json()['counts']['new']==2
    data['people'][1]['name']='Different employee'
    assert preview(client,headers,data,mapping).status_code==400


def test_competing_source_tabs_do_not_choose_a_first_row_silently(admin):
    client,headers=admin;seed_employee()
    data=packet()
    data['people'].append({'key':'archived','name':'Example Employee','sheet':'ARCHIVED_EXAMPLE',
        'rows':[row(times=['08:30','12:00','13:00','17:00'],number=17)]})
    mapping={'sample-one':'001','archived':'001'}
    p=preview(client,headers,data,mapping).json()
    assert p['counts']['new']==0 and p['counts']['conflict']==2
    result=merge(client,headers,data,p['preview_token'],mapping).json()['counts']
    assert result['new']==0 and result['conflict']==2
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM manual_dtr_entries').fetchone()[0]==0


def test_automatic_snapshot_fills_only_newly_available_slots(admin,tmp_path,monkeypatch):
    client,headers=admin
    seed_employee(name='Example Employee')
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
    source=tmp_path/'manual.json'
    monkeypatch.setenv('MANUAL_DTR_SOURCE_PATH',str(source))
    source.write_bytes(file_bytes(packet([row(times=['08:00',None,None,'17:00'])])))
    assert sync_local_source()['new_days']==1
    assert monitor(client)['display_slots']['am_out'] is None
    biometric=b'001\t2026-11-06 08:00:07\t1\t9\t1\t0\n001\t2026-11-06 17:00:11\t1\t9\t1\t0\n'
    assert client.post('/api/imports',headers=headers,files={'file':('fictional.dat',biometric)}).status_code==200
    source.write_bytes(file_bytes(packet()))
    result=sync_local_source()
    assert result['filled_days']==1 and result['new_days']==0
    assert [x['origin'] for x in monitor(client)['display_slots'].values()]==['biometric','manual_sheet','manual_sheet','biometric']
    assert sync_local_source()['filled_days']==0
    source.write_bytes(file_bytes(packet([row(times=['09:00','12:00','13:00','17:00'])])))
    assert sync_local_source()['conflict_days']==1
    assert monitor(client)['display_slots']['am_in']['happened_at'].endswith('08:00:07')
    with closing(connect()) as con:
        assert con.execute('SELECT COUNT(*) FROM punches').fetchone()[0]==2
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE action='filled_missing_slots'").fetchone()[0]==1


def test_automatic_default_local_snapshot_and_full_name_order(admin,tmp_path,monkeypatch):
    client,_=admin
    seed_employee(name='Employee, Example')
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
    folder=tmp_path/'NCSC-K14-Pilot'
    folder.mkdir()
    source=folder/'manual-dtr.json'
    source.write_bytes(file_bytes(packet()))
    monkeypatch.delenv('MANUAL_DTR_SOURCE_PATH',raising=False)
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path))
    assert sync_local_source()['matched_tabs']==1
    assert monitor(client)['display_slots']['am_in']['origin']=='manual_sheet'
    with closing(connect()) as con,con:
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('002','Example Employee','device')")
    assert sync_local_source()['matched_tabs']==0


def test_surname_only_never_matches_even_when_punches_agree(admin,tmp_path,monkeypatch):
    client,headers=admin
    seed_employee(name='EMPLOYEE')
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
    data=packet([row(times=['07:47','12:01','13:02','18:06']),
                 row('2026-11-05',['08:01','12:03','13:04','17:53'],number=8)])
    data['people'].append({'key':'archive','name':'Example Employee','sheet':'ARCHIVE',
                          'rows':[row('2026-10-06',number=9)]})
    source=tmp_path/'manual.json'
    source.write_bytes(file_bytes(data))
    monkeypatch.setenv('MANUAL_DTR_SOURCE_PATH',str(source))
    biometric=b'001\t2026-11-06 07:47:07\t1\t9\t1\t0\n001\t2026-11-05 08:01:09\t1\t9\t1\t0\n'
    assert client.post('/api/imports',headers=headers,files={'file':('fictional.dat',biometric)}).status_code==200
    assert sync_local_source()['matched_tabs']==0
    # Updated full names match only the intended employee, even with shared surnames.
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET display_name='Example Employee' WHERE employee_code='001'")
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('002','Another Employee','device')")
    result=sync_local_source()
    assert result['matched_tabs']==2 and result['exact_tabs']==2 and result['new_days']==3
    assert monitor(client)['display_slots']['am_out']['origin']=='manual_sheet'
    assert sync_local_source()['new_days']==0
    with closing(connect()) as con,con:
        assert con.execute("SELECT COUNT(*) FROM manual_dtr_entries WHERE employee_code='002'").fetchone()[0]==0
        con.execute("INSERT INTO employees(employee_code,display_name,name_source) VALUES('003','Example Employee','device')")
    assert automatic_mapping(parse_package(source.read_bytes()))=={}


def test_single_token_source_is_not_a_full_name(admin):
    seed_employee(name='EMPLOYEE')
    with closing(connect()) as con,con:
        con.execute("UPDATE employees SET name_source='device' WHERE employee_code='001'")
    data=packet()
    data['people'][0]['name']='Employee'
    assert automatic_mapping(parse_package(file_bytes(data)))=={}

def test_full_day_travel_order_preserves_mixed_regular_evidence(admin):
    client,headers=admin;seed_employee()
    data=packet([row(times=['08:00','12:00','Travel Order No. EXAMPLE',None],total=None)])
    import_one(client,headers,data)
    day=monitor(client)
    assert day['travel_periods']==['am','pm']
    assert 'travel_with_regular_entries' in day['source_conflicts']
    assert day['monitoring']['undertime_seconds'] is None
    assert day['monitoring']['overtime_seconds'] is None
    assert day['display_slots']['am_in']['happened_at'].endswith('08:00:00')
    assert day['display_slots']['pm_in'] is None
    assert day['monitoring']['total_seconds'] is None

def test_legacy_aja_note_recovers_times_without_regular_slot_reassignment(admin):
    client,headers=admin
    seed_employee()
    import_one(client,headers,packet([row(times=['7:18','8:07','AJA\n8:07-18:00',None])]))
    day=monitor(client)
    assert day['tone']=='aja'
    assert day['display_slots']['pm_in'] is None
    assert day['aja_periods'][0]['out']=={'time':'08:07:00','origin':'manual_sheet'}
    assert day['aja_periods'][0]['in']=={'time':'18:00:00','origin':'manual_sheet'}
    assert not day['aja_periods'][0]['review']


def test_empty_aja_placeholder_does_not_color_regular_day(admin):
    client,headers=admin
    seed_employee()
    data=row()
    data['values'] += ['-', 'N/A', '-']
    import_one(client,headers,packet([data]))
    day=monitor(client)
    assert day['tone']=='entry'
    assert day['aja_periods']==[]
    assert day['monitoring']['remarks']=='Complete'


def test_aja_note_without_times_is_visible_for_review(admin):
    client,headers=admin
    seed_employee()
    import_one(client,headers,packet([row(times=['7:18','8:07','AJA',None])]))
    day=monitor(client)
    assert day['aja_periods']==[{'out':None,'in':None,'review':True}]
    assert day['monitoring']['aja_review'] is True
