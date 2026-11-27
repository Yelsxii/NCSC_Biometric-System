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
    assert client.post("/api/employee-portal/aja/file", json=payload).status_code == 403
    forged = dict(payload, name="Other Employee")
    assert client.post("/api/employee-portal/aja/file", json=forged,
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

def test_aja_print_batches_are_deterministic():
    from app.employee_portal import EmployeeAjaInput, aja_print_batches
    common = dict(origin="Office", destination="Venue", purpose="Meeting")
    def batches(dates, different=False):
        days = [dict(date=date, departure="09:00" if different and i == 1 else "08:00",
                     return_time="16:00") for i, date in enumerate(dates)]
        return aja_print_batches(EmployeeAjaInput(days=days, **common).days)
    assert len(batches(["2026-12-16"])) == 1
    assert len(batches(["2026-12-16", "2026-12-18"])) == 2
    assert len(batches(["2026-12-16", "2026-12-17", "2026-12-18"])) == 1
    assert len(batches(["2026-12-16", "2026-12-17", "2026-12-19"])) == 3
    assert len(batches(["2026-12-16", "2026-12-17"], different=True)) == 2
    assert len(batches(["2026-12-31", "2027-01-01"])) == 1


def test_aja_filing_persistence_and_ownership(admin, monkeypatch):
    import app.employee_portal as portal
    client, admin_user = admin
    with closing(connect()) as con, con:
        for code in ("aja-test-1","aja-test-2"):
            con.execute("INSERT INTO employees(employee_code,display_name,department) VALUES(?,?,?)",
                        (code, "Test Employee", "Division"))
            con.execute("""INSERT INTO employee_profiles(employee_code,first_name,last_name,employment_type,position,registered_by)
                VALUES(?,?,?,?,?,(SELECT id FROM users ORDER BY id LIMIT 1))""",
                (code,"Test","Employee","COS","Officer"))
            con.execute("INSERT INTO employee_portal_accounts(employee_code,username,password_hash) VALUES(?,?,?)",
                        (code,code,hash_password("local-test-password")))
    monkeypatch.setattr(portal, "build_aja_packet", lambda *args: b"saved-pdf")
    monkeypatch.setattr(portal, "render_saved_pdf", lambda pdf: {"pdf":"test", "previews":["test"]})
    def login(code):
        response = client.post("/api/employee-portal/login", json={"username":code,"password":"local-test-password"})
        assert response.status_code == 200
        return {"X-CSRF-Token":response.json()["csrf"]}
    headers = login("aja-test-1")
    payload = {"days":[{"date":"2026-12-16","departure":"08:00","return_time":"10:00"}],
               "origin":"Office","destination":"Venue","purpose":"Meeting"}
    first = client.post("/api/employee-portal/aja/file", json=payload, headers=headers)
    assert first.status_code == 200, first.text
    ref = first.json()["filing"]["reference"]
    assert first.json()["filing"]["status"] == "awaiting_signatures"
    retry = client.post("/api/employee-portal/aja/file", json=payload, headers=headers)
    assert retry.json()["already_filed"] is True
    assert retry.json()["filing"]["reference"] == ref
    conflict = client.post("/api/employee-portal/aja/file", json=dict(payload,purpose="Different"), headers=headers)
    assert conflict.status_code == 409
    assert len(client.get("/api/employee-portal/aja/filings").json()["filings"]) == 1
    url = "/api/employee-portal/aja/filings/"+ref+"/document"
    assert client.get(url).status_code == 200
    login("aja-test-2")
    assert client.get(url).status_code == 404
    assert client.get("/api/employee-portal/aja/filings").json()["filings"] == []
