"""Read-only K14 approved-name import and source evidence tests (fictional IDs)."""
import datetime as dt
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

from app import k14_poller
from app.db import connect


HOST = "192.168.254.201"


def test_read_device_names_only_keeps_approved_id_and_name(monkeypatch):
    calls = []
    class Connection:
        def get_users(self):
            calls.append("get_users")
            return [
                SimpleNamespace(user_id="7",name="Sample Device Name",password="do-not-import",card=123),
                SimpleNamespace(user_id="8",name="Other Employee"),
                SimpleNamespace(user_id="18",name=""),
                SimpleNamespace(user_id="11",name=None),
                SimpleNamespace(user_id="12",name="   "),
                SimpleNamespace(user_id="14",name="First Alias"),
                SimpleNamespace(user_id="14",name="Conflicting Alias"),
                SimpleNamespace(user_id="19",name="  Valid Name  "),
                SimpleNamespace(user_id="20",name="Bad\x00Name"),
            ]
        def disconnect(self):
            calls.append("disconnect")
    class Device:
        def __init__(self,*args,**kwargs):
            assert kwargs["force_udp"] is False
        def connect(self):
            calls.append("connect")
            return Connection()
    monkeypatch.setitem(sys.modules,"zk",SimpleNamespace(ZK=Device))
    rows = k14_poller.read_device_names(HOST,4370,False,frozenset({"7","18","11","12","14","19","20"}))
    assert rows == [("7","Sample Device Name"),("19","Valid Name")]
    assert calls == ["connect","get_users","disconnect"]


def test_name_connector_import_idempotent_and_protects_verified_names(admin, monkeypatch, tmp_path):
    client, headers = admin
    source = tmp_path/"connector.sqlite3"
    # Synthetic K14 attendance log and name metadata in separate local database.
    punches = [("7","2026-11-02 07:38:00","1","0"),
               ("7","2026-11-02 12:01:00","1","0"),
               ("7","2026-11-02 12:02:00","1","0"),
               ("7","2026-11-02 17:38:00","1","0")]
    assert k14_poller.save_new(source,HOST,punches) == 4
    assert k14_poller.save_device_names(source,HOST,[
        ("7","Sample Device Name"),("18","Second Device Name"),("99","Do Not Copy")
    ]) == 3
    assert k14_poller.save_device_names(source,HOST,[("7","Sample Device Name")]) == 0
    monkeypatch.setenv("K14_CONNECTOR_DB",str(source))
    monkeypatch.setenv("K14_HOST",HOST)
    monkeypatch.setenv("K14_PORT","4370")
    result = client.post("/api/device/sync",headers=headers)
    assert result.status_code == 200, result.text
    assert result.json()["records_inserted"] == 4
    assert result.json()["names_updated"] >= 1
    listed = client.get("/api/employee-register?month=2026-11").json()["items"]
    employee = next(x for x in listed if x["employee_code"]=="7")
    assert employee["display_name"] == "Sample Device Name"
    assert employee["name_source"] == "device"
    dtr=client.get("/api/dtr/monitor?employee_code=7&month=2026-11").json()
    assert dtr["summary"]["scans"] == 4
    assert dtr["days"][1]["slots"] == {
        "am_in":None,"am_out":None,"pm_in":None,"pm_out":None}
    assert dtr["days"][1]["scans"][0]["happened_at"].endswith("07:38:00")
    with closing(connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 4
        assert db.execute("SELECT display_name FROM employees WHERE employee_code='99'").fetchone() is None

    # Verified HR name must override device aliases even if the device changes.
    from tests.test_profiles import profile
    saved=client.post("/api/employee-profiles",json=profile("7"),headers=headers)
    assert saved.status_code==201, saved.text
    k14_poller.save_device_names(source,HOST,[("7","New Device Nickname")])
    result=client.post("/api/device/sync",headers=headers)
    assert result.status_code==200
    assert result.json()["names_updated"]==0
    assert client.get("/api/employee-profiles/7").json()["display_name"] == "Example A. Employee"
    assert client.get("/api/dtr/monitor?employee_code=7&month=2026-11").json()["summary"]["scans"] == 4


def test_optional_name_table_absent_does_not_block_existing_connector(admin,monkeypatch,tmp_path):
    client, headers = admin
    source=tmp_path/"old.sqlite3"
    k14_poller.save_new(source,HOST,[("7","2026-11-02 09:00:00","1","0")])
    monkeypatch.setenv("K14_CONNECTOR_DB",str(source))
    monkeypatch.setenv("K14_HOST",HOST)
    result=client.post("/api/device/sync",headers=headers)
    assert result.status_code==200
    assert result.json()["records_inserted"]==1
    assert result.json()["names_updated"]==0


def test_discovery_requires_opt_in_and_confirmation(admin, monkeypatch, tmp_path):
    client, headers = admin
    source = tmp_path / "roster.sqlite3"
    k14_poller.save_new(source, HOST, [("99", "2026-11-02 08:00:00", "1", "0")])
    k14_poller.save_discovered_roster(source, HOST, [("99", "DELA CRUZ, ANA MARIE, SANTOS, JR.")])
    monkeypatch.setenv("K14_CONNECTOR_DB", str(source))
    monkeypatch.setenv("K14_HOST", HOST)
    monkeypatch.setenv("K14_ROSTER_DISCOVERY_ENABLED", "false")
    assert client.post("/api/device/sync", headers=headers).status_code == 200
    assert client.get("/api/employee-profiles/99").status_code == 404
    monkeypatch.setenv("K14_ROSTER_DISCOVERY_ENABLED", "true")
    assert client.post("/api/device/sync", headers=headers).status_code == 200
    pending = client.get("/api/employee-profiles/99").json()
    assert not pending["profile_complete"] and not pending["sync_authorized"]
    assert pending["suggested_name"]["first_name"] == "ANA MARIE"
    assert pending["suggested_name"]["last_name"] == "DELA CRUZ"
    assert pending["suggested_name"]["middle_name"] == "SANTOS"
    assert pending["suggested_name"]["suffix"] == "JR."
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 0
    from tests.test_profiles import profile
    payload = profile("99", first_name="ANA MARIE", middle_name="SANTOS", last_name="DELA CRUZ", suffix="JR.")
    payload.pop("sync_authorized")
    assert client.post("/api/employee-profiles", json=payload, headers=headers).status_code == 201
    assert client.get("/api/employee-profiles/99").json()["sync_authorized"]
    assert client.post("/api/device/sync", headers=headers).json()["records_inserted"] == 1
    k14_poller.save_discovered_roster(source, HOST, [("99", "Wrong Alias")])
    client.post("/api/device/sync", headers=headers)
    assert client.get("/api/employee-profiles/99").json()["display_name"] == "ANA MARIE SANTOS DELA CRUZ JR."
