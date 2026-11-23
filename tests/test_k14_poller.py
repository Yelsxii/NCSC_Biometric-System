"""No device/SDK connection: synthetic SDK and temporary local files only."""
import datetime as dt
import sqlite3
import sys
from contextlib import closing
from types import SimpleNamespace

import pytest

from app import k14_poller
from app.db import connect, database_path
from tests.test_profiles import profile


def arguments(tmp_path, *extra):
    return ['--host','192.168.254.201','--port','4370','--db',str(tmp_path/'connector.sqlite3'),
            '--registry-db',str(database_path()),*extra]


def test_read_only_sdk_surface_and_exact_raw_values(monkeypatch):
    calls = []
    class Connection:
        def get_attendance(self):
            calls.append('get_attendance')
            return [SimpleNamespace(user_id='25', timestamp=dt.datetime(2026,11,2,8,0,1), status=2, punch=5),
                    SimpleNamespace(user_id='13', timestamp=dt.datetime(2026,11,2,8,0,1), status=1, punch=0)]
        def disconnect(self):calls.append('disconnect')
    class Device:
        def __init__(self,*args,**kwargs):
            assert kwargs['force_udp'] is False
        def connect(self):calls.append('connect');return Connection()
    monkeypatch.setitem(sys.modules, 'zk', SimpleNamespace(ZK=Device))
    total, records = k14_poller.read_attendance('192.168.254.201',4370,False,frozenset({'25'}))
    assert total == 2
    assert records == [('25','2026-11-02 08:00:01','2','5')]
    assert calls == ['connect','get_attendance','disconnect']


def test_loop_picks_up_new_registration_without_restart(admin, monkeypatch, tmp_path):
    client, headers = admin
    approvals = []
    def read(host, port, udp, allowed):
        approvals.append(allowed)
        return 1, [('25','2026-11-02 08:00:01','2','5')] if '25' in allowed else []
    sleeps = []
    def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 1:
            assert client.post('/api/employee-profiles',json=profile(),headers=headers).status_code == 201
        else:raise KeyboardInterrupt()
    monkeypatch.setattr(k14_poller,'read_attendance',read)
    monkeypatch.setattr(k14_poller.time,'sleep',sleep)
    assert k14_poller.main(arguments(tmp_path,'--loop','--interval','60')) == 0
    assert '25' not in approvals[0] and '25' in approvals[1]
    assert sleeps == [60,60]
    with sqlite3.connect(tmp_path/'connector.sqlite3') as con:
        assert con.execute('SELECT employee_id FROM attendance_raw').fetchone()[0] == '25'
    # Reading permissions never writes back to the website registry.
    assert client.get('/api/employee-profiles/25').json()['version'] == 1


def test_network_failure_retries_and_single_read_failure_is_nonzero(admin, monkeypatch, tmp_path, capsys):
    calls = []
    def flaky(*args):
        calls.append(1)
        if len(calls) == 1:raise TimeoutError('private-detail-that-must-not-be-logged')
        return 1, [('7','2026-11-02 08:00:01','2','5')]
    waits = []
    def sleep(seconds):
        waits.append(seconds)
        if len(waits) == 2:raise KeyboardInterrupt()
    monkeypatch.setattr(k14_poller,'read_attendance',flaky)
    monkeypatch.setattr(k14_poller.time,'sleep',sleep)
    assert k14_poller.main(arguments(tmp_path,'--loop')) == 0
    assert len(calls) == 2 and waits == [60,60]
    assert 'private-detail' not in capsys.readouterr().out
    monkeypatch.setattr(k14_poller,'read_attendance',lambda *a: (_ for _ in ()).throw(TimeoutError()))
    assert k14_poller.main(arguments(tmp_path)) == 1


def test_revocation_during_read_prevents_storage(admin, monkeypatch, tmp_path):
    client, headers = admin
    client.post('/api/employee-profiles',json=profile(),headers=headers)
    def read(*args):
        with closing(connect()) as con, con:
            con.execute("UPDATE k14_authorizations SET sync_authorized=0 WHERE employee_code='25'")
        return 1, [('25','2026-11-02 08:00:01','2','5')]
    monkeypatch.setattr(k14_poller,'read_attendance',read)
    assert k14_poller.main(arguments(tmp_path)) == 0
    with sqlite3.connect(tmp_path/'connector.sqlite3') as con:
        assert con.execute('SELECT COUNT(*) FROM attendance_raw').fetchone()[0] == 0


def test_poller_refuses_the_website_database(admin, tmp_path):
    args = arguments(tmp_path)
    args[args.index('--db')+1] = str(database_path())
    with pytest.raises(SystemExit) as error:k14_poller.main(args)
    assert error.value.code == 2


def test_cli_launcher_uses_existing_sdk_python_and_current_registry(admin, monkeypatch, tmp_path):
    from app.cli import main
    captured = []
    monkeypatch.setenv('K14_POLLER_PYTHON',sys.executable)
    monkeypatch.setenv('K14_CONNECTOR_DB',str(tmp_path/'connector.sqlite3'))
    monkeypatch.setenv('K14_SYNC_INTERVAL_SECONDS','60')
    monkeypatch.setattr(sys,'argv',['app.cli','poll-k14'])
    monkeypatch.setattr('app.cli.subprocess.call',lambda args, **kwargs: captured.append(args) or 0)
    with pytest.raises(SystemExit) as error:main()
    assert error.value.code == 0
    command = captured[0]
    assert command[:3] == [sys.executable,'-m','app.k14_poller']
    assert command[command.index('--interval')+1] == '60'
    assert command[command.index('--registry-db')+1] == str(database_path().resolve())
