"""Resolve displayed DTR times without changing source punches or reviews."""
from __future__ import annotations
import datetime as dt
import re
from app.activity_mapping import sheet_aja_evidence, is_aja_note

KEYS = ('am_in','am_out','pm_in','pm_out')
OFFICIAL = ('AJA','Travel Order','Fieldwork','Official Business')
# Conservative reconciliation tolerance for unverified scans: ten minutes.
SHEET_MATCH_SECONDS = 600


def _clock_seconds(value):
    t = dt.time.fromisoformat(value)
    return t.hour*3600 + t.minute*60 + t.second


def _documented_status(notes):
    for note in notes:
        if re.match(r'^\s*(?:S\.?\s*O\.?\s*(?:NO\.?|NUMBER)\b|SPECIAL\s+ORDER\b)', note, re.I):
            return note.strip()
        if re.fullmatch(r'\s*ABSENT\s*', note, re.I):
            return 'ABSENT'
    return ''


def resolve_day(day, manual):
    source = manual['data'] if manual else None
    sheet_times = source['times'] if source else {}
    ordinary = sorted((x for x in day['scans'] if x.get('activity_type') not in OFFICIAL and not x.get('work_code_conflict')),key=lambda x:(x['happened_at'],x['id']))
    plan = (manual or {}).get('reconciliation', {})
    force_sheet = set(plan.get('force_sheet', []))
    require_bio = set(plan.get('require_bio', []))
    def exact_event(spec, events):
        return next((e for e in events if e['id']==spec['id'] and
                     e['happened_at']==day['date']+' '+spec['time']), None)
    ignored_ids = {e['id'] for spec in plan.get('ignored', [])
                   if (e := exact_event(spec, ordinary)) is not None}
    ordinary = [e for e in ordinary if e['id'] not in ignored_ids]
    observed = {}
    confirmed_ids = set()
    reconciliation_conflict = len(ignored_ids) != len(plan.get('ignored', []))
    # Explicit reviewed selections are reserved for their assigned slots.
    reserved = {x['id'] for x in day['slots'].values() if x}
    for key, spec in plan.get('confirmed', {}).items():
        event = exact_event(spec, ordinary)
        if event and event.get('verified_slot') in (None, key) and event['id'] not in reserved and event['id'] not in confirmed_ids:
            observed[key] = event
            confirmed_ids.add(event['id'])
        elif not (day['slots'][key] and day['slots'][key]['id']==spec['id']):
            reconciliation_conflict = True
    for key in KEYS:
        if key in observed:
            continue
        matches = [x for x in ordinary if x.get('verified_slot')==key and x['id'] not in reserved and x['id'] not in confirmed_ids]
        if len(matches)==1:
            observed[key] = matches[0]
    # Named sheet slots may identify an unknown raw state, but never override
    # a verified state or assign the same punch to another slot.
    for key in KEYS:
        if key in observed or day['slots'][key]:
            continue
        clock = sheet_times.get(key)
        matches = [x for x in ordinary if clock and x['happened_at'][11:16]==clock[:5]
                   and x['id'] not in reserved and x['id'] not in {e['id'] for e in observed.values()} and not x.get('verified_slot')]
        same_slots = [slot for slot,value in sheet_times.items() if clock and value and value[:5]==clock[:5]]
        if len(matches)==1 and len(same_slots)==1:
            observed[key] = matches[0]
    # Old device states are corroborated by the historical vendor audit, but
    # are not proof that a user selected the correct attendance button.
    # Keep explicitly reviewed reconciliation dates on their original rules.
    history = [x for x in ordinary if 'historical_k14_state' in x] if not plan else []
    historic_sheet_fallback_ids = set()
    if history:
        def plausible(key, event):
            clock = event['happened_at'][11:19]
            return {'am_in': clock < '12:00:00',
                    'am_out': clock <= '13:00:00',
                    'pm_in': clock >= '12:00:00',
                    'pm_out': clock >= '12:00:00'}[key]
        for key in KEYS:
            if key in observed or day['slots'][key] or key in force_sheet:
                continue
            used_ids = reserved | {x['id'] for x in observed.values()}
            matches = [x for x in history if x.get('historical_slot') == key
                       and not x.get('verified_slot') and x['id'] not in used_ids
                       and plausible(key, x)]
            if len(matches) == 1:
                event = matches[0]
                # An exact, unique named sheet slot takes precedence over a
                # potentially stale historical device button selection.
                named = [k for k,v in sheet_times.items() if v and
                         v[:5] == event['happened_at'][11:16]]
                if not named or named == [key]:
                    observed[key] = event
            elif len(matches) > 1 and sheet_times.get(key):
                # Follow the named sheet on ambiguous multiple inputs only
                # when every candidate is close to that one sheet slot.
                # Keep the IDs in the audit trail, not deleted from raw data.
                near_key = lambda e,k: abs(_clock_seconds(e['happened_at'][11:19]) -
                           _clock_seconds(sheet_times[k])) <= SHEET_MATCH_SECONDS
                if all(near_key(e,key) and not any(near_key(e,k) for k in KEYS
                       if k != key and sheet_times.get(k)) for e in matches):
                    historic_sheet_fallback_ids.update(e['id'] for e in matches)
    if historic_sheet_fallback_ids:
        ordinary = [e for e in ordinary if e['id'] not in historic_sheet_fallback_ids]
    # One-to-one near matching; never override verified or reviewed states.
    available = [x for x in ordinary if x['id'] not in reserved and
                 x['id'] not in {e['id'] for e in observed.values()} and not x.get('verified_slot')]
    eligible = [k for k in KEYS if k not in observed and not day['slots'][k]
                and k not in force_sheet and sheet_times.get(k)]
    near = {k:[x for x in available if abs(_clock_seconds(x['happened_at'][11:19])-
            _clock_seconds(sheet_times[k]))<=SHEET_MATCH_SECONDS] for k in eligible}
    for key, matches in near.items():
        if len(matches)==1:
            event=matches[0]
            possible=[k for k in KEYS if sheet_times.get(k) and
                      abs(_clock_seconds(event['happened_at'][11:19])-
                          _clock_seconds(sheet_times[k]))<=SHEET_MATCH_SECONDS]
            if possible==[key]:
                observed[key]=event
    distinct = len({x['happened_at'][11:16] for x in ordinary})==len(ordinary)
    candidates = {}
    # Legacy imports retain their existing placement behavior. Current office
    # K14 punches without verified states must not be guessed from scan order.
    if not history and not day['is_future'] and distinct and not any(x.get('k14_state_pending') for x in ordinary):
        if len(ordinary)==4:
            clocks = [x['happened_at'][11:19] for x in ordinary]
            if clocks[0]<'12:00:00' and clocks[1]<='13:00:00' and clocks[2]>='12:00:00':
                candidates = dict(zip(KEYS,ordinary))
        elif len(ordinary)==2 and ordinary[0]['happened_at'][11:19]<'12:00:00' <=ordinary[1]['happened_at'][11:19]:
            candidates = {'am_in':ordinary[0],'pm_out':ordinary[1]}
    used = reserved | {x['id'] for x in observed.values()}
    for key,event in candidates.items():
        if key not in observed and not day['slots'][key] and event['id'] not in used:
            observed[key]=event
            used.add(event['id'])
    # The explicit PM OUT-only instruction may use a single remaining
    # afternoon punch when no verified direction contradicts it.
    if 'pm_out' in require_bio and 'pm_out' not in observed and not day['slots']['pm_out']:
        unused = [e for e in ordinary if e['id'] not in used and
                  not e.get('verified_slot') and e['happened_at'][11:19]>='13:00:00']
        if len(unused)==1:
            observed['pm_out']=unused[0]
    display, conflicts, differences = {}, [], []
    if reconciliation_conflict:
        conflicts.append('reconciliation_evidence_missing')
    superseded_ids = set()
    for key in KEYS:
        reviewed = day['slots'][key]
        if reviewed and (reviewed.get('activity_type') in OFFICIAL or reviewed.get('work_code_conflict')):
            conflicts.append('reviewed_activity_slot')
            reviewed = None
        event = reviewed or observed.get(key)
        approved = day['review'].get('approved_times',{}).get(key)
        if approved:
            # An approved replacement supersedes only its identified original slot.
            if event:
                superseded_ids.add(event['id'])
            display[key] = {'id':None,'happened_at':day['date']+' '+approved,'work_code':'',
                'origin':'hr_approved','placement':'approved_adjustment'}
        elif key in force_sheet and not reviewed:
            if event:
                superseded_ids.add(event['id'])
            display[key] = ({'id':None,'happened_at':day['date']+' '+sheet_times[key],'work_code':'',
                'origin':'manual_sheet','placement':'reviewed_source_preference','source_row':manual['row'],'source_sheet':manual['sheet']}
                if sheet_times.get(key) else None)
        elif event:
            display[key] = {**event,'origin':'reviewed' if reviewed else 'biometric', 'placement':'reviewed' if reviewed else 'observed'}
            if not reviewed and sheet_times.get(key) and event['happened_at'][11:16]!=sheet_times[key][:5]:
                # A matched biometric entry wins over a stale sheet value.
                # Preserve the discrepancy as source evidence, not a blocking conflict.
                differences.append(key)
        elif sheet_times.get(key) and key not in require_bio:
            display[key] = {'id':None,'happened_at':day['date']+' '+sheet_times[key],'work_code':'',
                'origin':'manual_sheet','placement':'named_source_column','source_row':manual['row'],'source_sheet':manual['sheet']}
        else:
            display[key] = None
    day['display_slots'] = display
    day['source_conflicts'] = conflicts
    day['source_differences'] = differences
    display_ids = {x['id'] for x in display.values() if x and x.get('id')}
    unplaced_ids = {x['id'] for x in ordinary} - display_ids - superseded_ids
    unplaced = len(unplaced_ids)
    if unplaced and (source or history or any(x.get('k14_state_pending') for x in ordinary if x['id'] in unplaced_ids)):
        conflicts.append('unplaced_biometric')
    if source and not day['calendar']['holiday_name'] and not day['calendar']['version']:
        holiday = next((note for note in source['notes'] if 'HOLIDAY' in note.upper()), '')
        if holiday:
            day['calendar']['holiday_name'] = holiday
    code_pending = any(x.get('work_code_pending') or x.get('work_code_conflict') for x in day['scans'])
    if code_pending:
        conflicts.append('work_code_pending')
    chosen = [x['happened_at'] for x in display.values() if x]
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
    future_entry = any(value > now for value in chosen)
    chronological = chosen == sorted(chosen)
    offday = day['is_weekend'] or bool(day['calendar']['holiday_name'])
    pairs = [('am_in','am_out'),('pm_in','pm_out')]
    paired = [pair for pair in pairs if all(display[k] for k in pair)]
    dangling = any(bool(display[a]) != bool(display[b]) for a,b in pairs)
    # Non-working days need only a valid recorded AM or PM pair, not four entries.
    # Never infer a lunch break or a full-day duration from unrelated endpoints.
    complete = bool((all(display.values()) or (offday and paired and not dangling))
                    and chronological and not future_entry and not code_pending)
    if not chronological:
        conflicts.append('order')
    elapsed = None
    if complete:
        stamps = {key:dt.datetime.fromisoformat(event['happened_at']) for key,event in display.items() if event}
        if all(stamps[a]<stamps[b] for a,b in paired):
            elapsed = int(sum((stamps[b]-stamps[a]).total_seconds() for a,b in paired))
        else:
            complete = False
            conflicts.append('order')
    comparable = bool(complete and all(display.values()) and source and not conflicts and not differences and all(sheet_times.get(k) and display[k]['origin']!='hr_approved' and display[k]['happened_at'][11:16]==sheet_times[k][:5] for k in KEYS))
    total = source['reported_total'] if comparable and source['reported_total'] is not None else elapsed
    # Match the existing manual DTR template (G:J/K, eight-hour daily target).
    # A stale snapshot may contain the blank-row formula's eight-hour deficit
    # even though all four named clock fields have since been populated.
    # Complete, conflict-free approved regular adjustments also use this rule.
    # Use the existing worksheet rule for all complete, conflict-free days.
    source_ut = source['reported_ut'] if comparable else None
    overtime = source['reported_ot'] if comparable else None
    recalculated = False
    calculable = bool(complete and all(display.values()) and not conflicts and not offday)
    if calculable:
        clocks = {key: dt.time.fromisoformat(sheet_times[key] if comparable else display[key]['happened_at'][11:19]) for key in KEYS}
        # The worksheet uses minute-precision slots; keep original seconds in evidence.
        sec = {key: clock.hour*3600 + clock.minute*60 + (clock.second if comparable else 0) for key, clock in clocks.items()}
        credited = (max(0, min(sec['am_out'], 12*3600) - max(sec['am_in'], 7*3600))
                    + max(0, sec['pm_out'] - max(sec['pm_in'], 13*3600)))
        expected_ut = max(8*3600 - credited, 0)
        expected_ot = max(credited - 8*3600, 0)
        recalculated = not comparable or (source['reported_total'], source_ut, overtime) != (credited, expected_ut, expected_ot)
        total, source_ut, overtime = credited, expected_ut, expected_ot
    reviewed_ut = day['review']['undertime_minutes']
    # No required hours on weekends or holidays. Keep source/review evidence intact,
    # but do not charge or display undertime for these calendar days.
    undertime = None if future_entry or offday or not any(display.values()) else reviewed_ut*60 if reviewed_ut is not None else source_ut
    remarks = ('Future entry' if future_entry else 'Source difference' if conflicts else
        'Undertime' if undertime is not None and undertime>0 else
        'Overtime' if overtime is not None and overtime>0 else
        'Present' if complete and offday else
        'Complete' if complete and undertime==0 else
        'Needs hour review' if complete else
        'Upcoming' if day['is_future'] else
        'Incomplete entries' if any(display.values()) else
        'Needs time review' if day['scans'] else
        'Holiday' if day['calendar']['holiday_name'] else
        'Weekend' if day['is_weekend'] else 'No entry')
    day['monitoring'] = {'total_seconds':total,'elapsed_seconds':elapsed,'undertime_seconds':undertime,'overtime_seconds':overtime,
        'remarks':remarks,'metrics_origin':'template_recalculated' if recalculated else 'manual_sheet' if comparable else 'reviewed' if reviewed_ut is not None else 'elapsed_only',
        'undertime_origin':'not_applicable' if future_entry or offday else 'reviewed' if reviewed_ut is not None else 'template_recalculated' if recalculated else 'manual_sheet' if comparable else 'unverified',
        'complete':bool(complete),'conflicts':len(conflicts)}
    aja_evidence = sheet_aja_evidence(source)
    day['manual_source'] = {'name':manual['name'],'sheet':manual['sheet'],'row':manual['row'],'times':sheet_times,
        'notes':source['notes'],'aja':aja_evidence} if manual else None
    day['display_unassigned_count'] = unplaced
    day['display_unassigned_ids'] = sorted(unplaced_ids)
    day['display_superseded_ids'] = sorted(superseded_ids)
    day['display_ignored_ids'] = sorted(ignored_ids)
    day['historical_sheet_fallback_ids'] = sorted(historic_sheet_fallback_ids)
    if aja_evidence:
        day['display_activities'].append({'category':'AJA','reference':aja_evidence['purpose']})
    if source:
        for note in source['notes']:
            kind = 'Travel Order' if re.search(r'TRAVEL\s+ORDER',note,re.I) else 'AJA' if is_aja_note(note) else 'Manual DTR'
            day['display_activities'].append({'category':kind,'reference':note})
    travel = any(item['category']=='Travel Order' for item in day['display_activities'])
    day['travel_order'] = travel
    # Office monitoring policy: a recorded Travel Order is a full-day status.
    # Preserve ordinary punches and source slots for audit, not clock credit.
    day['travel_periods'] = ['am','pm'] if travel else []
    if travel:
        if ordinary or any(display.values()):
            conflicts.append('travel_with_regular_entries')
        day['monitoring'].update(total_seconds=None, elapsed_seconds=None,
            undertime_seconds=None, overtime_seconds=None, complete=False,
            metrics_origin='travel_order', undertime_origin='not_applicable', conflicts=len(conflicts),
            remarks='Future entry' if future_entry else 'Source difference' if conflicts else 'Travel Order')
    if not travel and remarks in ('No entry','Weekend') and source and source['notes']:
        kinds = {x['category'] for x in day['display_activities']}
        day['monitoring']['remarks'] = 'Travel Order' if 'Travel Order' in kinds else 'AJA' if 'AJA' in kinds else 'Manual DTR note'
    if day['calendar']['holiday_name']:
        day['tone']='holiday'
    elif travel:
        day['tone']='travel'
    elif any(x['category']=='AJA' for x in day['display_activities']):
        day['tone']='aja'
    elif any(display.values()):
        day['tone']='entry'



def _travel_number(value):
    """Keep an actual reference, without duplicating its display label."""
    return re.sub(r"^TRAVEL\s+ORDER\b\s*(?:(?:NO\.?|NUMBER|REF(?:ERENCE)?\.?)\s*)?[:#]?\s*",
                  "", str(value or "").strip(), flags=re.I).strip()


def present_day(day):
    """Single monitoring remark and a date-specific travel reference.

    Presentation only: never change attendance calculations or source records.
    """
    metrics = day["monitoring"]
    status = metrics["remarks"]
    has_entries = bool(day["scans"] or any(day["display_slots"].values()) or
                       any(p["out"] or p["in"] for p in day.get("aja_periods", [])))
    day["has_attendance_entries"] = has_entries
    source = day.get("manual_source") or {}
    references = [_travel_number(x["reference"]) for x in day["activities"] if x["category"]=="Travel Order"]
    references += [_travel_number(note) for note in source.get("notes", []) if re.search(r"\bTRAVEL\s+ORDER\b", note, re.I)]
    references = list(dict.fromkeys(x for x in references if x))
    reviewed_reference = _travel_number(day["review"]["activity_reference"]) if day["review"]["activity_type"]=="Travel Order" else ""
    day["travel_reference"] = reviewed_reference or (references[0] if len(references)==1 else "")
    day["travel_source_references"] = references
    labels = dict(zip(KEYS, ("AM In", "AM Out", "PM In", "PM Out")))
    slots = day["display_slots"]
    offday = day["is_weekend"] or bool(day["calendar"]["holiday_name"])
    # A recorded full-day leave is a documented status, not missing punches.
    # Never hide actual scans, future dates, calendar days or conflicting entries.
    leave = next((n for n in source.get("notes", []) if re.search(r"\b(?:LEAVE|CTO|WORK SUSPENSION)\b", n, re.I)), "")
    day["leave_status"] = (leave if leave and not has_entries and not day["travel_order"]
                           and not offday and not day["is_future"] and not day.get("source_conflicts") else "")
    if day["leave_status"]:
        day["tone"] = "leave"
        metrics.update(remarks=leave, total_seconds=None, undertime_seconds=None,
                       overtime_seconds=None, undertime_origin="not_applicable", metrics_origin="leave")
        status = leave

    # A documented AJA spanning the remainder of the working day can explain
    # absent PM punches when the employee departed directly from the office.
    # The recorded endpoint is an activity END, not a fabricated office return.
    # Do not infer payable hours, overtime, or an activity end from a missing scan.
    day["aja_covered_slots"] = []
    periods = day.get("aja_periods", [])
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    if (status == "Incomplete entries" and not offday and not day["is_future"]
            and not day["travel_order"] and not day.get("source_conflicts")
            and not metrics.get("aja_review") and slots["am_in"] and slots["am_out"]
            and not slots["pm_in"] and not slots["pm_out"] and len(periods) == 1):
        period = periods[0]
        departure, end = period.get("out"), period.get("in")
        am_in, am_out = slots["am_in"]["happened_at"][11:19], slots["am_out"]["happened_at"][11:19]
        if (not period.get("review") and departure and end
                and departure.get("origin") in ("manual_sheet", "biometric", "hr_approved")
                and end.get("origin") in ("manual_sheet", "biometric", "hr_approved")
                and am_in < am_out and am_out[:5] == departure["time"][:5]
                and departure["time"] <= "12:00:00" and end["time"] >= "17:00:00"
                and day["date"] + " " + end["time"] <= now):
            day["aja_covered_slots"] = ["pm_in", "pm_out"]
            metrics.update(remarks="AJA", metrics_origin="aja_coverage")
            status = "AJA"
    # Closed days: calculate the deficit of documented complete regular pairs,
    # not presumed actual absence. Never invent a missing endpoint or AJA credit.
    day["documented_status"] = _documented_status(source.get("notes", [])) if not has_entries and not offday and not day["is_future"] and not day["travel_order"] else ""
    if day["documented_status"]:
        status = day["documented_status"]
        metrics.update(remarks=status, total_seconds=None, undertime_seconds=None,
                       overtime_seconds=None, undertime_origin="not_applicable")
    closed = day["date"] + " 17:00:00" <= now
    if (closed and status == "Incomplete entries" and not offday and
            not day["travel_order"] and not day.get("source_conflicts") and
            not periods and not metrics.get("aja_review")):
        seconds = 0
        pairs = 0
        for a,b,lo,hi in (("am_in","am_out",7*3600,12*3600),("pm_in","pm_out",13*3600,24*3600)):
            if slots[a] and slots[b]:
                start = _clock_seconds(slots[a]["happened_at"][11:19])//60*60
                end = _clock_seconds(slots[b]["happened_at"][11:19])//60*60
                if start < end:
                    pairs += 1
                    seconds += max(0,min(end,hi)-max(start,lo))
        if pairs:
            deficit = max(0,8*3600-seconds)
            metrics.update(total_seconds=seconds, undertime_seconds=deficit,
                           overtime_seconds=None, metrics_origin="documented_partial",
                           undertime_origin="documented_partial", remarks="Undertime (provisional)" if deficit else "Undertime for review")
            status=metrics["remarks"]
        else:
            status="Undertime for review"
            metrics["remarks"]=status
    missing = [labels[k] for k in KEYS if not slots[k] and k not in day["aja_covered_slots"]]
    if offday:
        missing = [labels[k] for a,b in (("am_in","am_out"),("pm_in","pm_out"))
                   if bool(slots[a]) != bool(slots[b]) for k in (a,b) if not slots[k]]
    issues = []
    conflicts = day.get("source_conflicts", [])
    if "order" in conflicts:
        issues.append("Invalid time sequence")
    if "unplaced_biometric" in conflicts or status == "Needs time review":
        issues.append("Unassigned scan")
    if "work_code_pending" in conflicts or "reviewed_activity_slot" in conflicts:
        issues.append("Work code conflict" if any(x.get("work_code_conflict") for x in day["scans"]) or "reviewed_activity_slot" in conflicts else "Work code pending")
    if "travel_with_regular_entries" in conflicts or (day["travel_order"] and len(references)>1 and not reviewed_reference):
        issues.append("Travel Order conflict")
    if metrics.get("aja_review"):
        issues.append("Incomplete AJA")
    if status == "Future entry":
        issues.append("Future entry")
    if status == "Source difference" and not issues:
        issues.append("Source conflict")
    if status == "Needs hour review":
        issues.append("Hours for review")
    if status == "Manual DTR note" and has_entries:
        issues.append("DTR note for review")
    if not issues and day["leave_status"]:
        text = day["leave_status"]
    elif not issues and day["travel_order"]:
        text = "Travel Order"
    elif not issues and day["documented_status"]:
        text = day["documented_status"]
    elif issues:
        text = issues[0] if len(issues)==1 else f"Review ({len(issues)} issues)"
    elif has_entries:
        now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
        ongoing = day["date"] == now.date().isoformat() and now.time() < dt.time(17)
        if status == "Incomplete entries":
            if ongoing:
                text = "In progress"
            elif offday:
                text = "Missing " + missing[0] if len(missing)==1 else "Incomplete entries"
            else:
                text = "Undertime for review"
        elif status in ("Holiday","Weekend","No entry","Upcoming"):
            text = "Unassigned scan"
            issues.append(text)
        else:
            text = status
    elif offday:
        text = day["calendar"]["holiday_name"] or ("Saturday" if day["day"]=="Sat" else "Sunday")
    elif day["is_future"]:
        text = "Upcoming"
    else:
        notes = source.get("notes", [])
        leave = next((n for n in notes if re.search(r"\b(?:LEAVE|CTO|WORK SUSPENSION)\b",n,re.I)), "")
        text = leave or ("DTR note for review" if status in ("Manual DTR note","AJA") else status)
        if text == "DTR note for review":
            issues.append(text)
    day["remark_issues"] = issues
    day["missing_entries"] = missing if has_entries and not day["travel_order"] and status in ("Incomplete entries","Undertime","Undertime (provisional)","Undertime for review") and text!="In progress" else []
    day["display_remark"] = text
