"""Work-code directions are explicit, reversible and never invent punches."""
from contextlib import closing
import sqlite3


from app.activity_mapping import activity_pairs
from app.db import connect, initialize


def event(instant, category="AJA", direction="Unspecified", work_code="11", ident=1):
    return {
        "id": ident, "happened_at": "2026-11-12 " + instant,
        "device_id": "1", "work_code": work_code,
        "activity_type": category, "work_direction": direction,
    }


def test_one_explicit_in_and_one_later_out_pair_without_credit():
    scans = [event("08:08:00", direction="IN"),
             event("18:00:00", direction="OUT", work_code="12", ident=2),
             event("12:00:00", category="Regular", direction="Unspecified", ident=3)]
    result = activity_pairs(scans)
    assert len(result) == 1
    pair = result[0]
    assert pair["category"] == "AJA"
    assert pair["status"] == "code_matched"
    assert pair["time_in"]["happened_at"].endswith("08:08:00")
    assert pair["time_out"]["happened_at"].endswith("18:00:00")
    assert pair["time_out"]["work_code"] == "12"
    assert "not an attendance credit" in pair["review_note"]


def test_ambiguous_and_repeated_scans_are_flagged_not_assumed():
    out_only = activity_pairs([event("18:00:00", direction="OUT")])[0]
    assert out_only["status"] == "needs_review"
    assert out_only["time_in"] is None
    assert "Missing IN" in out_only["review_note"]
    unknown = activity_pairs([event("08:08:00"), event("18:00:00", ident=2)])[0]
    assert unknown["status"] == "needs_review"
    assert unknown["time_in"] is None and unknown["time_out"] is None
    duplicated = activity_pairs([event("08:08:00", direction="IN"),
                                 event("09:00:00", direction="IN", ident=2),
                                 event("18:00:00", direction="OUT", ident=3)])[0]
    assert duplicated["status"] == "needs_review"
    assert duplicated["time_in"] is None
    assert "Multiple IN" in duplicated["review_note"]
    reversed_pair = activity_pairs([event("18:00:00", direction="IN"),
                                    event("08:08:00", direction="OUT", ident=2)])[0]
    assert reversed_pair["status"] == "needs_review"
    assert "OUT is not later" in reversed_pair["review_note"]


def test_activity_types_are_kept_separate_even_on_same_day():
    scans = [event("08:00:00", direction="IN"), event("17:00:00", direction="OUT", ident=2),
             event("09:00:00", category="Travel Order", direction="IN", ident=3),
             event("16:00:00", category="Travel Order", direction="OUT", ident=4)]
    result = activity_pairs(scans)
    assert [item["category"] for item in result] == ["AJA", "Travel Order"]
    assert all(item["status"] == "code_matched" for item in result)


def test_api_mapping_requires_explicit_direction_and_preserves_raw_punches(admin):
    client, headers = admin
    sample = (
        b"TESTA001\t2026-11-12 07:45:00\t1\t0\t1\t0\n"
        b"TESTA001\t2026-11-12 08:08:00\t1\t0\t1\t11\n"
        b"TESTA001\t2026-11-12 18:00:00\t1\t0\t1\t12\n"
        b"TESTA001\t2026-11-13 09:00:00\t1\t0\t1\t21\n"
        b"TESTA001\t2026-11-13 17:00:00\t1\t0\t1\t22\n"
    )
    response = client.post("/api/imports", files={"file": ("sample_attlog.dat", sample)}, headers=headers)
    assert response.status_code == 200, response.text
    baseline = client.get("/api/dtr/monitor?employee_code=TESTA001&month=2026-11").json()
    assert baseline["days"][11]["activity_mappings"] == []
    assert baseline["summary"]["scans"] == 5
    invalid = client.put("/api/work-codes/1/11", headers=headers,
                         json={"label": "Wrong", "activity_type": "Regular", "direction": "IN"})
    assert invalid.status_code == 422
    assert client.put("/api/work-codes/1/11", json={
        "label": "AJA IN", "activity_type": "AJA", "direction": "IN"}).status_code == 403
    configs = [("11", "AJA", "IN"), ("12", "AJA", "OUT"),
               ("21", "Travel Order", "IN"), ("22", "Travel Order", "OUT")]
    for code, category, direction in configs:
        response = client.put("/api/work-codes/1/" + code, headers=headers,
                              json={"label": category + " " + direction,
                                    "activity_type": category, "direction": direction})
        assert response.status_code == 200, response.text
    mapped = client.get("/api/dtr/monitor?employee_code=TESTA001&month=2026-11").json()
    aja = mapped["days"][11]["activity_mappings"][0]
    to = mapped["days"][12]["activity_mappings"][0]
    assert (aja["category"], aja["status"]) == ("AJA", "code_matched")
    assert aja["time_in"]["happened_at"] == "2026-11-12 08:08:00"
    assert aja["time_out"]["happened_at"] == "2026-11-12 18:00:00"
    assert (to["category"], to["status"]) == ("Travel Order", "code_matched")
    assert mapped["days"][11]["slots"] == baseline["days"][11]["slots"]  # No AM/PM reassignment
    assert mapped["calculation_status"] == "not_calculated"
    signals = client.get("/api/activities/monitor?month=2026-11").json()
    assert sorted({entry["direction"] for entry in signals["items"]}) == ["IN", "OUT"]
    listed = client.get("/api/work-codes").json()["items"]
    assert any(x["work_code"] == "11" and x["direction"] == "IN" for x in listed)
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 5
        assert con.execute("SELECT COUNT(*) FROM audit_events WHERE entity='work_code'").fetchone()[0] == 4
    # Changing the classification never alters the scan; mapping is reversible.
    response = client.put("/api/work-codes/1/11", headers=headers,
                          json={"label": "Unmapped AJA", "activity_type": "AJA",
                                "direction": "Unspecified"})
    assert response.status_code == 200
    review = client.get("/api/dtr/monitor?employee_code=TESTA001&month=2026-11").json()
    assert review["days"][11]["activity_mappings"][0]["status"] == "needs_review"
    assert review["days"][11]["activity_mappings"][0]["time_in"] is None
    with closing(connect()) as con:
        assert con.execute("SELECT COUNT(*) FROM punches").fetchone()[0] == 5


def test_existing_work_code_rows_migrate_without_inventing_directions(tmp_path, monkeypatch):
    old = tmp_path / "old.ncsc.sqlite3"
    with sqlite3.connect(old) as con:
        con.execute("""CREATE TABLE work_codes(
            device_id TEXT NOT NULL, work_code TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            activity_type TEXT NOT NULL DEFAULT 'Unclassified',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(device_id,work_code)
        )""")
        con.execute("INSERT INTO work_codes(device_id,work_code,label,activity_type) "
                    "VALUES('1','55','Old AJA code','AJA')")
    monkeypatch.setenv("DATABASE_PATH", str(old))
    initialize()
    initialize()  # Repeatable schema migration
    with closing(connect()) as con:
        value = con.execute(
            "SELECT label,activity_type,direction FROM work_codes WHERE device_id='1' AND work_code='55'"
        ).fetchone()
        assert tuple(value) == ("Old AJA code", "AJA", "Unspecified")
