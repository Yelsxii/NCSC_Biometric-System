"""Isolated accounts and database for API integration checks."""
import os
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SECRET_KEY", "unit-test-local-secret-with-more-than-thirty-two-characters")

from app.db import connect, initialize
from app.main import app
from app.security import hash_password


@pytest.fixture
def admin(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "workspace.sqlite3"))
    initialize()
    with closing(connect()) as con, con:
        con.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')",
                    ("workspace-test", hash_password("local-workspace-test-password")))
        con.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,'reviewer')",
                    ("reviewer-test", hash_password("local-reviewer-test-password")))
    with TestClient(app) as client:
        login = client.post("/api/login", json={"username": "workspace-test", "password": "local-workspace-test-password"})
        assert login.status_code == 200
        yield client, {"X-CSRF-Token": login.json()["csrf"]}

