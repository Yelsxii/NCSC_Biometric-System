import datetime as dt
from app.live_attendance import live_status

DATE = "2026-11-25"
def at(clock):
    return dt.datetime.fromisoformat(DATE + " " + clock)
def punch(i, clock, **fields):
    return {"id": i, "happened_at": DATE + " " + clock, **fields}
def day(scans=(), activities=(), **fields):
    return {"date": DATE, "scans": list(scans), "activities": list(activities), **fields}

def test_verified_in_and_out():
    d = day([punch(1,"07:30:00",verified_slot="am_in"),punch(2,"12:00:00",verified_slot="am_out"),
             punch(3,"13:00:00",verified_slot="pm_in")])
    assert live_status(d,at("10:00:00"))["status"]=="in"
    assert live_status(d,at("12:30:00"))["status"]=="out"
    assert live_status(d,at("14:00:00"))["status"]=="in"

def test_aja_current_then_return():
    d = day([punch(1,"07:30:00",verified_slot="am_in"),
             punch(2,"09:30:00",activity_type="AJA",work_direction="OUT"),
             punch(3,"10:45:00",activity_type="AJA",work_direction="IN")])
    assert live_status(d,at("10:00:00"))["status"]=="aja"
    assert live_status(d,at("11:00:00"))["status"]=="in"

def test_travel_coverage_expires():
    d = day([punch(1,"07:30:00",verified_slot="am_in")],
            [{"category":"Travel Order","start_at":DATE+" 09:00:00","end_at":DATE+" 11:00:00"}])
    assert live_status(d,at("08:00:00"))["status"]=="in"
    assert live_status(d,at("10:00:00"))["status"]=="travel"
    assert live_status(d,at("12:00:00"))["status"]=="in"

def test_unknown_and_no_entry():
    assert live_status(day([punch(1,"07:30:00")]),at("10:00:00"))["status"]=="review"
    assert live_status(day(),at("10:00:00"))["status"]=="missing"
    assert live_status(day(is_weekend=True),at("10:00:00"))["status"]=="offday"
    assert live_status(day(),at("10:00:00"),"08:00")["label"]=="No entry · past arrival"
    assert live_status(day(),at("07:00:00"),"08:00")["label"]=="Awaiting time in"


def test_last_update_uses_verified_attendance_action():
    d = day([punch(1,"07:30:00",verified_slot="am_in"),
             punch(2,"12:00:00",verified_slot="am_out"),
             punch(3,"13:00:00",verified_slot="pm_in"),
             punch(4,"17:00:00",verified_slot="pm_out")])
    for now, label, status in (("10:00:00","AM IN","in"),("12:30:00","AM OUT","out"),
                               ("14:00:00","PM IN","in"),("18:00:00","PM OUT","out")):
        result = live_status(d,at(now))
        assert result["last_update"] == label
        assert result["status"] == status
        assert result["at"] is not None

def test_last_update_aja_and_unknown():
    d = day([punch(1,"09:30:00",activity_type="AJA",work_direction="OUT"),
             punch(2,"10:45:00",activity_type="AJA",work_direction="IN")])
    assert live_status(d,at("10:00:00"))["last_update"] == "AJA OUT"
    assert live_status(d,at("11:00:00"))["last_update"] == "AJA IN"
    assert live_status(day([punch(1,"07:30:00")]),at("10:00:00"))["last_update"] == "For review"
    assert live_status(day(),at("10:00:00"))["last_update"] is None

def test_last_update_conflicting_slots_not_guessed():
    d = day([punch(1,"07:30:00",verified_slot="am_in"),
             punch(2,"07:30:00",verified_slot="pm_in")])
    assert live_status(d,at("10:00:00"))["last_update"] == "For review"

def test_last_update_documented_slot_is_not_live_presence():
    d = day(display_slots={"am_in": {"happened_at": DATE+" 07:30:00", "origin":"manual_sheet"}})
    result = live_status(d,at("10:00:00"))
    assert result["last_update"] == "AM IN"
    assert result["status"] == "review"

def test_last_update_travel_without_fabricated_time():
    result = live_status(day(review={"activity_type":"Travel Order"}),at("10:00:00"))
    assert result["last_update"] == "Travel Order"
    assert result["at"] is None
