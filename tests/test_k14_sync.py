"""Read-only K14 connector import. Uses fictional punches, never the office database."""
import sqlite3
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


def test_sync_endpoint_is_off_until_enabled(admin):
    client, headers = admin
    monkey_off = client.post("/api/device/sync", headers=headers)
    assert monkey_off.status_code == 409
    assert client.post("/api/device/sync").status_code == 403
