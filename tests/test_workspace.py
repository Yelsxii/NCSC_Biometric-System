"""Regression checks for filtering and preview-only K14 Excel reports.

The committed workbook fixture contains two fictional DEMO identifiers only.
"""
from contextlib import closing
from pathlib import Path

import pytest

from app.db import connect
from app.parser import MAX_BYTES
from app.reports import preview_k14_report



def test_date_filters_pagination_and_daily_counts(admin):
    client, headers = admin
    sample = (b"DEMO001\t2026-11-01 23:59:59\t1\t0\t1\t0\n"
              b"DEMO001\t2026-11-02 00:00:00\t1\t4\t1\t0\n"
              b"DEMO002\t2026-11-02 23:59:59\t1\t0\t1\t0\n"
              b"DEMO002\t2026-11-03 00:00:00\t1\t1\t1\t0\n")
    assert client.post("/api/imports", files={"file": ("fictional.txt", sample)}, headers=headers).status_code == 200
    first = client.get("/api/punches?date_from=2026-11-02&date_to=2026-11-02&limit=1").json()
    second = client.get("/api/punches?date_from=2026-11-02&date_to=2026-11-02&limit=1&offset=1").json()
    assert first["total"] == second["total"] == 2
    assert first["items"][0]["employee_code"] == "DEMO002"
    assert second["items"][0]["happened_at"] == "2026-11-02 00:00:00"
    combined = client.get("/api/punches?employee_code=DEMO001&date_from=2026-11-02").json()
    assert combined["total"] == 1
    assert client.get("/api/punches?date_from=2026-11-03&date_to=2026-11-01").status_code == 400
    assert client.get("/api/punches?offset=-1").status_code == 400
    assert client.get("/api/punches?date_to=9999-12-31").status_code == 400
    days = client.get("/api/overview").json()["daily_scans"]
    assert len(days) == 7
    assert days[-1] == {"date": "2026-11-03", "scans": 1}
    assert days[-2]["scans"] == 2
    assert days[0]["scans"] == 0
    assert sum(d["scans"] for d in days) == 4


def test_report_preview_requires_auth_and_never_inserts_scans(admin):
    client, headers = admin
    raw = (Path(__file__).parent / "fixtures" / "k14_sample.xls").read_bytes()
    assert client.post("/api/imports/preview", files={"file": ("report.xls", raw)}).status_code == 403
    preview = client.post("/api/imports/preview", files={"file": ("report.xls", raw)}, headers=headers)
    assert preview.status_code == 200
    assert preview.json()["format"] == "report"
    assert preview.json()["employees"] == 2
    assert preview.json()["period"] == "2026-11-01 to 2026-11-19"
    rejected = client.post("/api/imports", files={"file": ("report.xls", raw)}, headers=headers)
    assert rejected.status_code == 400
    assert "preview-only" in rejected.json()["detail"]
    with closing(connect()) as con:
        for table in ("punches", "import_batches", "audit_events"):
            assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    client.post("/api/logout", headers=headers)
    assert client.post("/api/imports/preview", files={"file": ("report.xls", raw)}).status_code == 401


def test_report_rejects_corrupt_and_oversize_files(admin):
    client, headers = admin
    for raw in (b"not excel", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504):
        response = client.post("/api/imports/preview", files={"file": ("broken.xls", raw)}, headers=headers)
        assert response.status_code == 400
    with pytest.raises(ValueError, match="2 MB"):
        preview_k14_report(b"x" * (MAX_BYTES + 1))


def test_reviewer_cannot_preview_uploads_or_create_activities(admin):
    client, _ = admin
    login = client.post("/api/login", json={"username": "reviewer-test", "password": "local-reviewer-test-password"})
    headers = {"X-CSRF-Token": login.json()["csrf"]}
    assert client.get("/api/punches").status_code == 200
    assert client.post("/api/imports/preview", files={"file": ("report.xls", b"test")}, headers=headers).status_code == 403
    assert client.post("/api/activities", json={
        "employee_code": "DEMO001", "category": "AJA", "reference": "Fictional example activity", "start_at": "2026-11-20T08:00", "end_at": "2026-11-20T17:00"
    }, headers=headers).status_code == 403
