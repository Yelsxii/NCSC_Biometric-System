"""Read-only K14 connector import. Uses fictional punches, never the office database."""
import sqlite3
import pytest
from contextlib import closing
from pathlib import Path

from app.db import connect
from app.k14_sync import read_connector

CONNECTOR_SQL = """
CREATE TABLE attendance_raw (
    device_ip TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    punch_time_local TEXT NOT NULL,
    device_status TEXT NOT NULL,
    device_punch_type TEXT NOT NULL,
    received_at_utc TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_ip, employee_id, punch_time_local, device_status, device_punch_type)
)
"""
HOST = "192.168.254.201"


@pytest.mark.parametrize("configured,expected", [
    (None, 60), ("60", 60), ("300", 300), ("invalid", 60),
    ("0", 60), ("59", 60), ("86401", 60),
])
def test_sync_interval_defaults_to_sixty_and_honors_valid_overrides(monkeypatch, configured, expected):
    from app.k14_sync import sync_interval
    if configured is None:
        monkeypatch.delenv("K14_SYNC_INTERVAL_SECONDS", raising=False)
    else:
        monkeypatch.setenv("K14_SYNC_INTERVAL_SECONDS", configured)
    assert sync_interval() == expected


def _connector(path: Path, rows: list[tuple]) -> None:
    with sqlite3.connect(path) as db:
        db.execute(CONNECTOR_SQL)
        db.executemany(
            """INSERT INTO attendance_raw
               (device_ip,employee_id,punch_time_local,device_status,device_punch_type,received_at_utc)
               VALUES(?,?,?,?,?,?)""",
            rows,
        )


def _enable(monkeypatch, path: Path) -> None:
    monkeypatch.setenv("K14_ATTENDANCE_SYNC_ENABLED", "true")
    monkeypatch.setenv("K14_HOST", HOST)
    monkeypatch.setenv("K14_PORT", "4370")
    monkeypatch.setenv("K14_LAN_PROBE_ENABLED", "false")
    monkeypatch.setenv("K14_CONNECTOR_DB", str(path))


def test_sync_is_idempotent_and_keeps_raw_codes(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [
        (HOST, "7", "2026-11-02 07:21:07", "1", "0", "2026-11-23 03:23:42"),
        (HOST, "7", "2026-11-02 17:05:45", "1", "4", "2026-11-23 03:23:42"),
        (HOST, "13", "2026-11-02 08:00:00", "1", "0", "2026-11-23 03:23:42"),
        (HOST, "18", "2026-11-02 08:05:00", "2", "5", "2026-11-23 03:23:42"),
        ("10.1.1.1", "8", "2026-11-02 09:00:00", "1", "1", "2026-11-23 03:23:42"),
    ])
    before = path.read_bytes()
    _enable(monkeypatch, path)
    first = client.post("/api/device/sync", headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["records_inserted"] == 3
    assert first.json()["records_skipped"] == 2
    second = client.post("/api/device/sync", headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["records_inserted"] == 0
    assert second.json()["records_already_present"] == 3
    assert path.read_bytes() == before
    with closing(connect()) as con:
        punches = [dict(row) for row in con.execute(
            "SELECT employee_code,happened_at,device_id,status_code,verification_code,work_code,source FROM punches ORDER BY happened_at"
        )]
        assert [row["employee_code"] for row in punches] == ["7", "18", "7"]
        afternoon = punches[2]
        assert afternoon["status_code"] == "1"
        assert afternoon["verification_code"] == "4"
        assert afternoon["work_code"] == ""
        assert afternoon["device_id"] == HOST
        assert afternoon["source"] == "k14"
        assert con.execute("SELECT COUNT(*) FROM work_codes").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM k14_sync_events").fetchone()[0] == 3
    status = client.get("/api/device/status").json()
    assert status["sync_enabled"] is True
    assert status["attendance_sync"]["last_inserted"] == 0
    assert status["attendance_sync"]["last_error"] == ""
    overview = client.get("/api/overview").json()
    assert overview["totals"]["scans"] == 3
    monitor = client.get("/api/dtr/monitor?employee_code=7&month=2026-11").json()
    assert monitor["calculation_status"] == "not_calculated"
    assert [row["status_code"] for row in monitor["days"][1]["scans"]] == ["1", "1"]
    assert monitor["days"][1]["undertime_review"] == "Not calculated"
    activity = client.get("/api/activities/monitor?month=2026-11").json()
    assert activity["summary"]["device_signals"] == 0
    reviewer = client.post("/api/login", json={"username": "reviewer-test", "password": "local-reviewer-test-password"})
    assert reviewer.status_code == 200
    assert client.post("/api/device/sync", headers={"X-CSRF-Token": reviewer.json()["csrf"]}).status_code == 403


def test_usb_and_connector_share_one_punch(admin, monkeypatch, tmp_path):
    client, headers = admin
    usb = b"7\t2026-11-02 07:21:07\t1\t0\t1\t15\n"
    assert client.post("/api/imports", files={"file": ("sample.dat", usb)}, headers=headers).status_code == 200
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "1", "4", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    synced = client.post("/api/device/sync", headers=headers)
    assert synced.status_code == 200, synced.text
    assert synced.json()["records_inserted"] == 0
    assert synced.json()["records_already_present"] == 1
    with closing(connect()) as con:
        row = dict(con.execute("SELECT * FROM punches").fetchone())
        assert row["device_id"] == "1"
        assert row["status_code"] == "0"
        assert row["verification_code"] == "1"
        assert row["work_code"] == "15"
        assert row["source"] == "usb"
        link = dict(con.execute("SELECT device_status,device_punch_type,link_reason FROM k14_sync_events").fetchone())
        assert link == {"device_status": "1", "device_punch_type": "4", "link_reason": "matched_existing_timestamp"}
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 1


def test_usb_backup_fills_codes_without_a_second_punch(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "2", "5", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    assert client.post("/api/device/sync", headers=headers).status_code == 200
    usb = b"7\t2026-11-02 07:21:07\t1\t0\t1\t15\n"
    imported = client.post("/api/imports", files={"file": ("backup.dat", usb)}, headers=headers)
    assert imported.status_code == 200, imported.text
    assert imported.json()["inserted"] == 0
    with closing(connect()) as con:
        row = dict(con.execute(
            "SELECT device_id,status_code,verification_code,work_code,source,happened_at FROM punches"
        ).fetchone())
        assert row["happened_at"] == "2026-11-02 07:21:07"
        assert row["device_id"] == "1"
        assert row["status_code"] == "0"
        assert row["verification_code"] == "1"
        assert row["work_code"] == "15"
        assert row["source"] == "usb+k14"
        raw = dict(con.execute("SELECT device_status,device_punch_type FROM k14_sync_events").fetchone())
        assert raw == {"device_status": "2", "device_punch_type": "5"}
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 1


def test_missing_or_unexpected_connector_schema_imports_nothing(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE attendance_raw (employee_id TEXT)")
    _enable(monkeypatch, path)
    failed = client.post("/api/device/sync", headers=headers)
    assert failed.status_code == 409
    assert "missing columns" in failed.json()["detail"]
    status = client.get("/api/device/status").json()["attendance_sync"]
    assert status["last_success_at"] is None
    assert "missing columns" in status["last_error"]
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 0
    reviewer = client.post("/api/login", json={"username": "reviewer-test", "password": "local-reviewer-test-password"})
    assert reviewer.status_code == 200
    hidden = client.get("/api/device/status").json()["attendance_sync"]["last_error"]
    assert hidden == "An administrator can review the synchronization error."
    assert "missing columns" not in hidden


def test_connector_reader_rejects_the_website_database(admin, monkeypatch, tmp_path):
    website = tmp_path / "website.sqlite3"
    monkeypatch.setenv("DATABASE_PATH", str(website))
    from app.db import initialize
    initialize()
    monkeypatch.setenv("K14_CONNECTOR_DB", str(website))
    try:
        read_connector(website)
    except ValueError as exc:
        assert "separate" in str(exc)
    else:
        raise AssertionError("Website database was accepted as the connector source.")
    source = Path(__file__).resolve().parents[1] / "app" / "k14_sync.py"
    text = source.read_text(encoding="utf-8")
    assert "import zk" not in text
    assert "get_attendance" not in text
    assert "get_templates" not in text


def test_manual_read_does_not_require_automatic_imports_or_tcp_probe(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "1", "0", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    monkeypatch.setenv("K14_ATTENDANCE_SYNC_ENABLED", "false")
    monkeypatch.delenv("K14_HOST")
    def unexpected_socket(*args, **kwargs):
        raise AssertionError("A local connector import attempted a network connection")
    monkeypatch.setattr("app.lan.socket.create_connection", unexpected_socket)
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 1
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 0
    status = client.get("/api/device/status").json()
    assert status["host"] == HOST
    assert status["probe_enabled"] is False
    assert status["sync_enabled"] is False
    sync = status["attendance_sync"]
    assert sync["connector_available"] is True
    assert sync["latest_result"] == "Success — No new records"
    assert sync["last_error"] == ""
    assert sync["total_imported"] == sync["total_connector_imported"] == 1
    assert client.post("/api/device/sync").status_code == 403


def test_source_outage_keeps_attendance_and_recovers(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "2", "5", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 1
    success_at = client.get("/api/device/status").json()["attendance_sync"]["last_success_at"]
    with closing(connect()) as con:
        before = [tuple(row) for row in con.execute("SELECT * FROM punches")]
    moved = path.rename(tmp_path / "temporarily-unavailable.sqlite3")
    assert client.post("/api/device/sync", headers=headers).status_code == 409
    sync = client.get("/api/device/status").json()["attendance_sync"]
    assert sync["last_success_at"] == success_at
    assert sync["latest_result"] == "Error"
    assert sync["connector_available"] is False
    assert sync["total_imported"] == 1
    assert str(tmp_path) not in sync["last_error"]
    assert not path.exists()
    moved.rename(path)
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 0
    sync = client.get("/api/device/status").json()["attendance_sync"]
    assert sync["last_error"] == ""
    assert sync["latest_result"] == "Success — No new records"
    with closing(connect()) as con:
        assert [tuple(row) for row in con.execute("SELECT * FROM punches")] == before


def test_background_timer_retries_missing_source_every_sixty_seconds(admin, monkeypatch, tmp_path):
    from app import k14_sync
    path = tmp_path / "attendance.sqlite3"
    _enable(monkeypatch, path)
    monkeypatch.delenv("K14_SYNC_INTERVAL_SECONDS", raising=False)
    class ThreeCycles:
        delays = []
        def set(self):
            pass
        def is_set(self):
            return len(self.delays) == 3
        def wait(self, delay):
            self.delays.append(delay)
            if len(self.delays) == 1:
                _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "1", "0", "2026-11-23 03:23:42")])
    stop = ThreeCycles()
    monkeypatch.setattr(k14_sync, "_STOP", stop)
    k14_sync._loop()
    assert stop.delays == [60, 60, 60]
    with closing(connect()) as con:
        runs = [tuple(row) for row in con.execute("SELECT outcome,records_inserted FROM k14_sync_runs ORDER BY id")]
        assert runs == [("error", 0), ("success", 1), ("success", 0)]
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 1


def test_worker_retries_even_when_error_cannot_be_saved(monkeypatch, caplog):
    from app import k14_sync
    calls = []
    class TwoCycles:
        def is_set(self):
            return len(calls) == 2
        def wait(self, delay):
            assert delay == 60
    def flaky_sync(actor):
        calls.append(actor)
        if len(calls) == 1:
            raise sqlite3.OperationalError("private-path-and-token")
    monkeypatch.setattr(k14_sync, "_STOP", TwoCycles())
    monkeypatch.setattr(k14_sync, "run_sync", flaky_sync)
    monkeypatch.setenv("K14_SYNC_INTERVAL_SECONDS", "invalid")
    k14_sync._loop()
    assert len(calls) == 2
    assert "will retry" in caplog.text
    assert "private-path-and-token" not in caplog.text


def test_worker_stops_and_can_restart_without_duplicate_threads(monkeypatch):
    import threading
    from app import k14_sync
    called = threading.Event()
    calls = []
    def fake_sync(actor):
        calls.append(actor)
        called.set()
    monkeypatch.setattr(k14_sync, "_THREAD", None)
    monkeypatch.setattr(k14_sync, "_STOP", threading.Event())
    monkeypatch.setattr(k14_sync, "run_sync", fake_sync)
    monkeypatch.setattr(k14_sync, "autostart_allowed", lambda: True)
    try:
        k14_sync.start_background_sync()
        assert called.wait(2)
        worker = k14_sync._THREAD
        k14_sync.start_background_sync()
        assert k14_sync._THREAD is worker
        k14_sync.stop_background_sync()
        assert not worker.is_alive()
        called.clear()
        k14_sync.start_background_sync()
        assert called.wait(2)
        assert len(calls) == 2
    finally:
        k14_sync.stop_background_sync()


def test_windows_environment_path_and_invalid_settings_are_sanitized(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "NCSC-K14-Pilot" / "attendance.sqlite3"
    path.parent.mkdir()
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "1", "0", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("K14_CONNECTOR_DB", "%LOCALAPPDATA%/NCSC-K14-Pilot/attendance.sqlite3")
    assert client.post("/api/device/sync", headers=headers).status_code == 200
    monkeypatch.setenv("K14_PORT", "private-path-and-token")
    info = client.get("/api/device/status")
    assert info.status_code == 200
    assert info.json()["configuration_error"] == "K14_PORT must be a valid TCP port."
    failed = client.post("/api/device/sync", headers=headers)
    assert failed.status_code == 409
    assert "private-path-and-token" not in failed.text
    assert "private-path-and-token" not in client.get("/api/device/status").text
    monkeypatch.setenv("K14_CONNECTOR_DB", "%NCSC_UNSET_TEST_VARIABLE%/private.sqlite3")
    monkeypatch.delenv("NCSC_UNSET_TEST_VARIABLE", raising=False)
    assert client.post("/api/device/sync", headers=headers).status_code == 409
    assert "private.sqlite3" not in client.get("/api/device/status").text


def test_saved_unknown_errors_do_not_expose_paths_or_credentials(admin):
    client, _ = admin
    with closing(connect()) as con, con:
        con.execute("INSERT INTO k14_sync_runs(started_at,outcome,error_message) VALUES('2026-11-23','error',?)",
                    ("C:/Users/Private/secret.sqlite3 password=private-token",))
    status = client.get("/api/device/status")
    assert status.status_code == 200
    assert "private-token" not in status.text
    assert "secret.sqlite3" not in status.text
    assert "Review the local connector settings" in status.json()["attendance_sync"]["last_error"]


def test_cli_manual_import_and_status_work_with_timer_off(admin, monkeypatch, tmp_path, capsys):
    import json
    import sys
    from app.cli import main
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "1", "0", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    monkeypatch.setenv("K14_ATTENDANCE_SYNC_ENABLED", "false")
    monkeypatch.setattr(sys, "argv", ["app.cli", "k14-status"])
    main()
    before = json.loads(capsys.readouterr().out)
    assert before["host"] == HOST
    assert before["attendance_sync"]["connector_available"] is True
    assert before["sync_enabled"] is False
    monkeypatch.setattr(sys, "argv", ["app.cli", "sync-k14"])
    main()
    assert "Outcome: success; read 1; new 1" in capsys.readouterr().out
    main()
    assert "Outcome: success; read 1; new 0" in capsys.readouterr().out
    monkeypatch.setattr(sys, "argv", ["app.cli", "k14-status"])
    main()
    after = json.loads(capsys.readouterr().out)["attendance_sync"]
    assert after["latest_result"] == "Success — No new records"
    assert after["total_imported"] == 1


def test_usb_codes_at_same_time_survive_connector_deduplication(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [(HOST, "7", "2026-11-02 07:21:07", "2", "5", "2026-11-23 03:23:42")])
    _enable(monkeypatch, path)
    assert client.post("/api/device/sync", headers=headers).status_code == 200
    usb = (b"7\t2026-11-02 07:21:07\t1\t0\t1\t15\n"
           b"7\t2026-11-02 07:21:07\t1\t0\t1\t16\n")
    result = client.post("/api/imports", files={"file": ("backup.dat", usb)}, headers=headers)
    assert result.status_code == 200
    assert result.json()["inserted"] == 1
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 0
    with closing(connect()) as con:
        assert [row[0] for row in con.execute("SELECT work_code FROM punches ORDER BY id")] == ["15", "16"]
        assert tuple(con.execute("SELECT device_status,device_punch_type FROM k14_sync_events").fetchone()) == ("2", "5")


def test_synthetic_pilot_volume_is_idempotent_and_keeps_source_unchanged(admin, monkeypatch, tmp_path):
    import datetime as dt
    from app.k14_sync import ALLOWED_IDS
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    ids = sorted(ALLOWED_IDS, key=int)
    start = dt.datetime(2026, 10, 1)
    rows = [(HOST, ids[index % 14] if index < 4986 else "13",
             (start + dt.timedelta(seconds=index)).isoformat(sep=" "), "2", "5", "2026-11-23 03:23:42")
            for index in range(5736)]
    _connector(path, rows)
    source_before = path.read_bytes()
    _enable(monkeypatch, path)
    first = client.post("/api/device/sync", headers=headers).json()
    assert (first["records_read"], first["records_inserted"], first["records_skipped"]) == (5736, 4986, 750)
    second = client.post("/api/device/sync", headers=headers).json()
    assert (second["records_inserted"], second["records_already_present"]) == (0, 4986)
    sync = client.get("/api/device/status").json()["attendance_sync"]
    assert sync["total_imported"] == 4986
    assert sync["latest_result"] == "Success — No new records"
    assert path.read_bytes() == source_before


def test_current_office_pm_in_uses_verified_state_not_scan_order(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    _connector(path, [
        (HOST, "7", "2026-11-24 11:29:51", "2", "0", "2026-11-24 06:00:00"),
        (HOST, "7", "2026-11-24 13:07:26", "1", "5", "2026-11-24 06:00:00"),
        (HOST, "18", "2026-11-24 13:09:31", "1", "5", "2026-11-24 06:00:00"),
    ])
    _enable(monkeypatch, path)
    result = client.post("/api/device/sync", headers=headers)
    assert result.status_code == 200, result.text
    for employee, expected in (("7","13:07:26"),("18","13:09:31")):
        day = client.get("/api/dtr/monitor?employee_code="+employee+"&month=2026-11").json()["days"][23]
        assert day["display_slots"]["pm_in"]["happened_at"].endswith(expected)
        assert day["display_slots"]["pm_out"] is None
        if employee == "7":
            assert day["display_slots"]["am_in"]["happened_at"].endswith("11:29:51")
        else:
            assert day["display_slots"]["am_in"] is None
        assert day["monitoring"]["total_seconds"] is None
        assert day["scans"][-1]["work_code"] == ""
        assert day["scans"][-1]["k14_punch_type"] == "5"
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 3


def test_all_four_confirmed_office_states_and_unknown_state(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    punches = [("07:10:05","0"),("12:01:05","1"),("13:01:05","5"),("17:15:05","4")]
    _connector(path, [(HOST,"7","2026-11-24 "+clock,"1",state,"2026-11-25 00:00:00")
                      for clock,state in punches] +
                     [(HOST,"18","2026-11-24 12:05:01","1","2","2026-11-25 00:00:00")])
    _enable(monkeypatch, path)
    assert client.post("/api/device/sync", headers=headers).status_code == 200
    day = client.get("/api/dtr/monitor?employee_code=7&month=2026-11").json()["days"][23]
    assert [day["display_slots"][key]["happened_at"][11:] for key in ("am_in","am_out","pm_in","pm_out")] == [clock for clock,_ in punches]
    unknown = client.get("/api/dtr/monitor?employee_code=18&month=2026-11").json()["days"][23]
    assert not any(unknown["display_slots"].values())
    assert unknown["display_unassigned_count"] == 1
    assert unknown["display_remark"] == "Review"


def test_bionet_code_overlay_uses_exact_match_and_preserves_raw_punches(admin, monkeypatch, tmp_path):
    client, headers = admin
    path = tmp_path / "attendance.sqlite3"
    punches = [("08:00:00","0",3),("09:00:00","1",1),("10:00:00","0",2),
               ("12:00:00","1",3),("13:00:00","5",3),("17:00:00","4",3)]
    _connector(path, [(HOST,"7","2026-11-24 "+clock,"1",state,"2026-11-25 00:00:00")
                      for clock,state,_ in punches])
    _enable(monkeypatch,path)
    assert client.post("/api/device/sync",headers=headers).status_code==200
    vendor=tmp_path/"TimeNet.db"
    with closing(sqlite3.connect(vendor)) as source,source:
        source.executescript("CREATE TABLE hr_employee(id INTEGER,emp_pin TEXT);"
                             "CREATE TABLE att_punches(employee_id INTEGER,punch_time TEXT,workcode INTEGER);"
                             "CREATE TABLE att_workcode(wc_code INTEGER,wc_name TEXT);"
                             "INSERT INTO hr_employee VALUES(100,'7'),(101,'19');"
                             "INSERT INTO att_workcode VALUES(1,'AJA OUT'),(2,'AJA IN'),(3,'REGULAR');")
        source.executemany("INSERT INTO att_punches VALUES(100,?,?)",
                           [("2026-11-24 "+clock,code) for clock,_,code in punches])
        source.execute("INSERT INTO att_punches VALUES(101,'2026-11-24 08:00:00',1)")
    before=vendor.read_bytes()
    monkeypatch.setenv("BIONET_ROSTER_DB",str(vendor))
    def day():
        return client.get("/api/dtr/monitor?employee_code=7&month=2026-11").json()["days"][23]
    d=day()
    assert d["display_slots"]["am_in"]["work_code"]=="3"
    assert d["display_slots"]["am_out"]["happened_at"].endswith("12:00:00")
    assert d["aja_periods"]==[{"out":{"time":"09:00:00","origin":"biometric"},"in":{"time":"10:00:00","origin":"biometric"},"review":False}]
    items=client.get("/api/activities/monitor?month=2026-11&category=AJA").json()["items"]
    assert [(x["work_code"],x["direction"]) for x in items]==[("2","IN"),("1","OUT")]
    assert vendor.read_bytes()==before
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches WHERE work_code=''").fetchone()[0]==6
    # A conflicting vendor code is never guessed or turned into a regular punch.
    with closing(sqlite3.connect(vendor)) as source,source:
        source.execute("INSERT INTO att_punches VALUES(100,'2026-11-24 09:00:00',3)")
    assert day()["display_remark"]=="Review"
