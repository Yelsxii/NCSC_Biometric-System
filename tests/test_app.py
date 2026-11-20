"""Small non-PII smoke suite: parser, login, import, fieldwork."""
import os
import tempfile
from pathlib import Path

os.environ["SECRET_KEY"] = "unit-test-local-secret-with-more-than-thirty-two-characters"
os.environ["DATABASE_PATH"] = str(Path(tempfile.mkdtemp()) / "ncsc-test.sqlite3")

from fastapi.testclient import TestClient
from app.db import connect, initialize
from app.main import app
from app.parser import parse_attlog
from app.security import hash_password


SAMPLE = (
    b"DEMO001\t2026-11-03 07:21:07\t1\t0\t1\t0\r\n"
    b"DEMO001\t2026-11-03 17:05:45\t1\t4\t1\t0\r\n"
    b"DEMO002\t2026-11-03 08:12:00\t1\t0\t1\t0\r\n"
)


def test_parser_valid_and_rejects_malformed():
    rows = parse_attlog(SAMPLE)
    assert len(rows) == 3
    assert rows[0].employee_code == "DEMO001"
    assert rows[1].status_code == "4"  # code remains raw, not interpreted as OUT
    try:
        parse_attlog(b"bad row")
    except ValueError:
        pass
    else:
        assert False, "Malformed export was accepted"


def test_auth_import_and_fieldwork():
    initialize()
    with connect() as con:
        con.execute("INSERT OR IGNORE INTO users(username,password_hash,role) VALUES(?,?,?)",
                    ("demo-admin", hash_password("local-test-password-123"), "admin"))

    with TestClient(app) as client:
        assert client.get("/api/overview").status_code == 401
        assert client.post("/api/login", json={"username": "demo-admin", "password": "bad"}).status_code == 401
        auth = client.post("/api/login", json={"username": "demo-admin", "password": "local-test-password-123"})
        assert auth.status_code == 200
        csrf = auth.json()["csrf"]
        headers = {"X-CSRF-Token": csrf}

        assert client.post("/api/imports", files={"file": ("test.dat", SAMPLE)}).status_code == 403
        preview = client.post("/api/imports/preview", files={"file": ("test.dat", SAMPLE)}, headers=headers)
        assert preview.status_code == 200
        assert preview.json()["rows"] == 3
        assert client.get("/api/overview").json()["totals"]["scans"] == 0

        first = client.post("/api/imports", files={"file": ("test.dat", SAMPLE)}, headers=headers)
        assert first.status_code == 200, first.text
        assert first.json()["inserted"] == 3
        assert client.post("/api/imports", files={"file": ("test.dat", SAMPLE)}, headers=headers).status_code == 409
        assert client.get("/api/overview").json()["totals"]["scans"] == 3

        second = client.post("/api/imports", files={"file": ("test2.dat", SAMPLE + SAMPLE[:42])}, headers=headers)
        # Invalid / truncated row is rejected rather than partially applied.
        assert second.status_code == 400
        assert client.get("/api/overview").json()["totals"]["scans"] == 3

        fw = client.post("/api/fieldwork", json={
            "employee_code": "DEMO001", "category": "Fieldwork",
            "location": "Regional office", "reason": "Official onsite assignment",
            "start_at": "2026-11-03T09:00", "end_at": "2026-11-03T15:00"
        }, headers=headers)
        assert fw.status_code == 201, fw.text
        fid = fw.json()["id"]
        decision = client.post(f"/api/fieldwork/{fid}/decision",
                               json={"decision": "approved"}, headers=headers)
        assert decision.status_code == 200
        assert client.post(f"/api/fieldwork/{fid}/decision",
                           json={"decision": "approved"}, headers=headers).status_code == 409
        assert client.get("/api/fieldwork").json()["items"][0]["status"] == "approved"

        with connect() as con:
            assert con.execute("SELECT count(*) FROM audit_events").fetchone()[0] == 3


def test_no_fingerprint_templates():
    from app.db import SCHEMA
    assert "fingerprint" not in SCHEMA.lower()
