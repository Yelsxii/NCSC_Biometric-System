"""Records-first workflow, K14 metadata-only directory and optional LAN checks."""
from contextlib import closing
from app.db import connect


def _user_record(uid: int, name: str) -> bytes:
    row = bytearray(72)
    row[:2] = uid.to_bytes(2, "little")
    encoded = name.encode("ascii")
    row[11:11+len(encoded)] = encoded
    code = str(uid).encode("ascii")
    row[48:48+len(code)] = code
    return bytes(row)


def test_monthly_register_search_and_name_from_usb(admin):
    client, headers = admin
    logs = (
        b"1\t2026-11-03 08:00:00\t1\t0\t1\t0\n"
        b"1\t2026-11-03 17:00:00\t1\t1\t1\t0\n"
        b"2\t2026-11-04 08:15:00\t1\t0\t1\t0\n"
    )
    response = client.post("/api/imports", files={"file": ("sample.dat", logs)}, headers=headers)
    assert response.status_code == 200, response.text
    staff_data = _user_record(1,"Sample One") + _user_record(2,"Sample Two")
    preview = client.post("/api/employees/import/preview",
                          files={"file": ("user.dat",staff_data)},headers=headers)
    assert preview.status_code == 200, preview.text
    assert preview.json()["total"] == 2
    sync = client.post("/api/employees/import",
                       files={"file": ("user.dat",staff_data)},headers=headers)
    assert sync.status_code == 200, sync.text

    register = client.get("/api/employee-register?month=2026-11").json()
    assert len(register["items"]) == 2
    assert next(x for x in register["items"] if x["employee_code"]=="1")["scan_count"] == 2
    filtered = client.get("/api/employee-register?month=2026-11&q=Two").json()
    assert len(filtered["items"]) == 1
    assert filtered["items"][0]["employee_code"] == "2"
    off_month = client.get("/api/employee-register?month=2026-12").json()
    assert all(x["scan_count"] == 0 for x in off_month["items"])
    assert client.get("/api/employee-register?month=2026-13").status_code == 400
    with closing(connect()) as con:
        assert con.execute("SELECT count(*) FROM punches").fetchone()[0] == 3


def test_full_day_travel_is_a_reference_not_fake_scans(admin):
    client, headers = admin
    response = client.post("/api/activities", json={
        "employee_code": "10", "category": "Travel Order",
        "reference": "DEMO-TO-001", "purpose": "Official assignment",
        "start_at": "2026-11-23T00:00", "end_at": "2026-11-25T00:00"
    },headers=headers)
    assert response.status_code == 201, response.text
    report = client.get("/api/dtr/monitor?employee_code=10&month=2026-11")
    assert report.status_code == 200
    days = {x["date"]:x for x in report.json()["days"]}
    for date in ("2026-11-23","2026-11-24"):
        assert days[date]["travel_order"] is True
        assert days[date]["travel_remark"] == "OFFICIAL TRAVEL"
        assert days[date]["scans"] == []
    assert days["2026-11-25"]["travel_order"] is False
    assert report.json()["calculation_status"] == "not_calculated"


def test_lan_probe_never_runs_without_opt_in(admin, monkeypatch):
    client, headers = admin
    monkeypatch.setenv("K14_HOST","192.168.1.201")
    monkeypatch.setenv("K14_PORT","4370")
    monkeypatch.delenv("K14_LAN_PROBE_ENABLED",raising=False)
    info = client.get("/api/device/status")
    assert info.status_code == 200
    assert info.json()["sync_enabled"] is False
    probe = client.post("/api/device/probe",headers=headers)
    assert probe.status_code == 200
    assert probe.json()["result"] == "disabled"
    assert client.post("/api/device/probe").status_code == 403
    assert client.get("/api/device/status").json()["host"] == "192.168.1.201"


def test_binary_template_not_accepted_as_roster(admin):
    client, headers = admin
    fake = _user_record(1,"Sample One")
    assert client.post("/api/employees/import",
                       files={"file": ("template.fp10",fake)},headers=headers).status_code == 400



def test_activity_monitor_filters_office_references_and_device_work_codes(admin):
    client, headers = admin
    scans = (
        b"21\t2026-11-04 09:00:00\t1\t0\t1\t0\n"
        b"21\t2026-11-04 10:00:00\t1\t0\t1\t101\n"
    )
    assert client.post("/api/imports",files={"file":("sample.dat",scans)},headers=headers).status_code == 200
    assert client.put("/api/employees/21",json={
        "display_name":"Example Employee", "department":"Sample Office"
    },headers=headers).status_code == 200
    assert client.put("/api/work-codes/1/101",json={
        "label":"AJA device event", "activity_type":"AJA"
    },headers=headers).status_code == 200
    assert client.post("/api/activities",json={
        "employee_code":"21","category":"Travel Order","reference":"SAMPLE-TO-1",
        "purpose":"Official assignment","start_at":"2026-11-23T00:00",
        "end_at":"2026-11-25T00:00"
    },headers=headers).status_code == 201

    result=client.get("/api/activities/monitor?month=2026-11")
    assert result.status_code == 200, result.text
    data=result.json()
    assert data["summary"] == {
        "employees":1,"aja":1,"travel_orders":1,"references":1,"device_signals":1
    }
    device=next(x for x in data["items"] if x["source"]=="device_scan")
    assert device["category"]=="AJA"
    assert device["verified_by_hr"] is False
    assert device["end_at"] is None  # one scan does not imply return
    assert device["work_code"]=="101"
    trip=next(x for x in data["items"] if x["source"]=="office_reference")
    assert trip["category"]=="Travel Order"
    assert trip["reference"]=="SAMPLE-TO-1"
    assert trip["verified_by_hr"] is False
    assert len(client.get("/api/activities/monitor?month=2026-11&category=AJA").json()["items"])==1
    assert len(client.get("/api/activities/monitor?month=2026-11&category=Travel%20Order").json()["items"])==1
    assert len(client.get("/api/activities/monitor?month=2026-11&q=Example").json()["items"])==2
    assert client.get("/api/activities/monitor?month=2026-11&q=unmatched").json()["items"]==[]
    assert client.get("/api/activities/monitor?month=2026-13").status_code==400
    assert client.get("/api/activities/monitor?month=2026-11&category=Fieldwork").status_code==422
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0]==2
