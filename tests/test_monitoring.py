"""Monitoring references must never become invented scans or attendance credits."""
from contextlib import closing

import pytest

from app.db import connect, initialize


ACTIVITY = {
    "employee_code": "DEMO001", "category": "Travel Order", "reference": " SAMPLE-TO-001 ",
    "start_at": "2026-11-02T09:00", "end_at": "2026-11-04T00:00",
}


def test_references_are_optional_no_second_approval_and_can_be_corrected(admin):
    client, headers = admin
    assert client.post("/api/activities", json=ACTIVITY).status_code == 403
    created = client.post("/api/activities", json=ACTIVITY, headers=headers)
    assert created.status_code == 201
    assert created.json()["status"] == "recorded"
    assert client.post("/api/activities", json=ACTIVITY, headers=headers).status_code == 409
    item = client.get("/api/activities").json()["items"][0]
    assert item["reference"] == "SAMPLE-TO-001"
    assert client.get("/api/overview").json()["totals"]["activities"] == 1
    assert client.get("/api/overview").json()["totals"]["scans"] == 0
    assert client.get("/api/employees").json()["items"] == ["DEMO001"]
    aid = created.json()["id"]
    assert client.post(f"/api/activities/{aid}/void", json={"reason": "   "}, headers=headers).status_code == 422
    assert client.post(f"/api/activities/{aid}/void", json={"reason": "Wrong reference"}, headers=headers).status_code == 200
    assert client.get("/api/overview").json()["totals"]["activities"] == 0
    assert client.get("/api/activities").json()["items"][0]["void_reason"] == "Wrong reference"
    # A corrected replacement is permitted while the original remains in history.
    assert client.post("/api/activities", json=ACTIVITY, headers=headers).status_code == 201
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 0
        assert con.execute("SELECT action FROM audit_events ORDER BY id").fetchall()[1][0] == "voided"


def test_monitor_keeps_exact_times_codes_and_half_open_activity_dates(admin):
    client, headers = admin
    sample = (b"DEMO001\t2026-11-02 07:21:07\t1\t0\t1\t0\n"
              b"DEMO001\t2026-11-02 17:05:45\t1\t4\t1\t0\n"
              b"DEMO002\t2026-11-02 18:00:00\t1\t1\t1\t0\n")
    assert client.post("/api/imports", files={"file": ("fictional.dat", sample)}, headers=headers).status_code == 200
    ref = client.post("/api/activities", json=ACTIVITY, headers=headers).json()["id"]
    monitor = client.get("/api/dtr/monitor?employee_code=DEMO001&month=2026-11").json()
    assert len(monitor["days"]) == 30
    assert monitor["summary"] == {"scans": 2, "days_with_scans": 1, "activity_records": 1}
    assert monitor["calculation_status"] == "not_calculated"
    assert monitor["days"][0]["coverage"] == "no_records"
    assert monitor["days"][0]["day"] == "Sun"
    second = monitor["days"][1]
    assert second["coverage"] == "scans"
    assert [s["happened_at"][11:] for s in second["scans"]] == ["07:21:07", "17:05:45"]
    assert second["scans"][1]["status_code"] == "4"
    assert len(second["activities"]) == 1
    assert monitor["days"][2]["coverage"] == "reference_only"
    assert monitor["days"][3]["activities"] == []  # midnight ending does not cover the next day
    assert not any("hours" in key or "absence" in key for key in second)
    client.post(f"/api/activities/{ref}/void", json={"reason": "Fictional correction"}, headers=headers)
    changed = client.get("/api/dtr/monitor?employee_code=DEMO001&month=2026-11").json()
    assert changed["days"][2]["coverage"] == "no_records"
    assert changed["summary"]["scans"] == 2  # source records untouched
    leap = client.get("/api/dtr/monitor?employee_code=DEMO001&month=2028-02").json()
    assert len(leap["days"]) == 29


def test_old_entries_are_retained_without_being_silently_approved(admin):
    client, headers = admin
    with closing(connect()) as con, con:
        uid = con.execute("SELECT id FROM users WHERE role='admin'").fetchone()[0]
        for status in ("pending", "approved", "rejected"):
            con.execute(
                "INSERT INTO fieldwork(employee_code,category,location,reason,start_at,end_at,status,created_by) "
                "VALUES('OLD001','AJA','Test location','Sample purpose','2026-11-02 09:00:00','2026-11-02 10:00:00',?,?)",
                (status, uid),
            )
    initialize()
    initialize()
    result = client.get("/api/activities").json()
    assert result["items"] == []
    assert sorted(r["status"] for r in result["legacy_items"]) == ["approved", "pending", "rejected"]
    assert len(client.get("/api/fieldwork").json()["items"]) == 3
    assert client.post("/api/fieldwork", json={}, headers=headers).status_code == 410
    assert client.post("/api/fieldwork/1/decision", json={"decision": "approved"}, headers=headers).status_code == 410
    assert client.get("/api/dtr/monitor?employee_code=OLD001&month=2026-11").json()["summary"]["activity_records"] == 0
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM fieldwork WHERE status='pending'").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0] == 0


@pytest.mark.parametrize("changes", [
    {"start_at": "2026-11-04T12:00"}, {"start_at": "2026-11-02T09:00+08:00"},
    {"reference": "  ", "purpose": " "}, {"category": "Unknown"}, {"employee_code": "bad code"},
])
def test_invalid_reference_is_rejected(admin, changes):
    client, headers = admin
    assert client.post("/api/activities", json={**ACTIVITY, **changes}, headers=headers).status_code == 422


def test_monitor_validation_auth_and_reviewer_read_only(admin):
    client, headers = admin
    for suffix in ("employee_code=bad%20code&month=2026-11", "employee_code=DEMO001&month=2026-13",
                   "employee_code=DEMO001&month=1999-01", "employee_code=DEMO001&month=2026-1"):
        assert client.get("/api/dtr/monitor?" + suffix).status_code == 400
    login = client.post("/api/login", json={"username": "reviewer-test", "password": "local-reviewer-test-password"})
    headers = {"X-CSRF-Token": login.json()["csrf"]}
    assert client.get("/api/dtr/monitor?employee_code=DEMO001&month=2026-11").status_code == 200
    assert client.get("/api/activities").status_code == 200
    assert client.post("/api/activities", json=ACTIVITY, headers=headers).status_code == 403
    assert client.post("/api/activities/1/void", json={"reason": "Test correction"}, headers=headers).status_code == 403
    client.post("/api/logout", headers=headers)
    for endpoint in ("/api/activities", "/api/employees", "/api/dtr/monitor?employee_code=DEMO001&month=2026-11"):
        assert client.get(endpoint).status_code == 401
