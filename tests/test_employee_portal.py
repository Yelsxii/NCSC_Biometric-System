"""Employee document portal must not expose HR data or another employee's identity."""
from contextlib import closing

from app.db import connect
from app.security import hash_password


def test_employee_portal_access_boundary(admin):
    client, _ = admin
    with closing(connect()) as con, con:
        con.execute("INSERT INTO employees(employee_code,display_name,department) VALUES(?,?,?)",
                    ("test-employee-1", "Test Employee", "Test Division"))
        con.execute("INSERT INTO employees(employee_code,display_name,department) VALUES(?,?,?)",
                    ("test-employee-2", "Other Employee", "Other Division"))
        con.execute("INSERT INTO employee_portal_accounts(employee_code,username,password_hash) VALUES(?,?,?)",
                    ("test-employee-1", "employee-test", hash_password("local-employee-test-password")))
    assert client.get("/api/employee-portal/me").status_code == 401
    login = client.post("/api/employee-portal/login", json={
        "username":"employee-test", "password":"local-employee-test-password"})
    assert login.status_code == 200
    assert login.json()["name"] == "Test Employee"
    assert login.json()["department"] == "Test Division"
    assert client.get("/api/me").status_code == 401
    for path in ("/api/employee-profiles", "/api/employee-profiles/test-employee-2",
                 "/api/employee-register?month=2026-11", "/api/punches",
                 "/api/dtr/monitor?employee_code=test-employee-2&month=2026-11",
                 "/api/device/status"):
        assert client.get(path).status_code == 401, path
    payload = {"days":[{"date":"2026-11-27", "departure":"09:00", "return_time":"11:00"}],
               "origin":"Office", "destination":"Other office", "purpose":"Meeting"}
    assert client.post("/api/employee-portal/aja/preview", json=payload).status_code == 403
    forged = dict(payload, name="Other Employee")
    assert client.post("/api/employee-portal/aja/preview", json=forged,
                       headers={"X-CSRF-Token":login.json()["csrf"]}).status_code == 422
    with closing(connect()) as con, con:
        con.execute("UPDATE employee_portal_accounts SET enabled=0 WHERE username='employee-test'")
    assert client.get("/api/employee-portal/me").status_code == 401


def test_aja_structured_days():
    import pytest
    from pydantic import ValidationError
    from app.employee_portal import EmployeeAjaInput, format_dates
    common = dict(origin="Office", destination="Venue", purpose="Meeting")
    day = dict(date="2026-11-27", departure="08:00", return_time="16:00")
    other = dict(day, date="2026-11-30", departure="09:00")
    payload = EmployeeAjaInput(days=[other, day], **common)
    assert format_dates([d.date for d in payload.days]) == "Nov 27, 2026; Nov 30, 2026"
    for days in ([day, day], [dict(day, date="2026-02-30")], [dict(day, return_time="07:00")], []):
        with pytest.raises(ValidationError):
            EmployeeAjaInput(days=days, **common)
