"""Resolve displayed DTR times without changing source punches or reviews."""
from __future__ import annotations
import datetime as dt
import re
from app.activity_mapping import sheet_aja_evidence, is_aja_note

KEYS = ('am_in','am_out','pm_in','pm_out')
OFFICIAL = ('AJA','Travel Order','Fieldwork','Official Business')


def resolve_day(day, manual):
    source = manual['data'] if manual else None
    sheet_times = source['times'] if source else {}
    ordinary = sorted((x for x in day['scans'] if x.get('activity_type') not in OFFICIAL and not x.get('work_code_conflict')),key=lambda x:(x['happened_at'],x['id']))
    observed = {}
    # Explicit reviewed selections are reserved for their assigned slots.
    reserved = {x['id'] for x in day['slots'].values() if x}
    for key in KEYS:
        matches = [x for x in ordinary if x.get('verified_slot')==key and x['id'] not in reserved]
        if len(matches)==1:
            observed[key] = matches[0]
    # Named sheet slots may identify an unknown raw state, but never override
    # a verified state or assign the same punch to another slot.
    for key in KEYS:
        if key in observed or day['slots'][key]:
            continue
        clock = sheet_times.get(key)
        matches = [x for x in ordinary if clock and x['happened_at'][11:16]==clock[:5]
                   and x['id'] not in reserved and not x.get('verified_slot')]
        same_slots = [slot for slot,value in sheet_times.items() if clock and value and value[:5]==clock[:5]]
        if len(matches)==1 and len(same_slots)==1:
            observed[key] = matches[0]
    distinct = len({x['happened_at'][11:16] for x in ordinary})==len(ordinary)
    candidates = {}
    # Legacy imports retain their existing placement behavior. Current office
    # K14 punches without verified states must not be guessed from scan order.
    if not day['is_future'] and distinct and not any(x.get('k14_state_pending') for x in ordinary):
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
    display, conflicts, differences = {}, [], []
    for key in KEYS:
        reviewed = day['slots'][key]
        if reviewed and (reviewed.get('activity_type') in OFFICIAL or reviewed.get('work_code_conflict')):
            conflicts.append('reviewed_activity_slot')
            reviewed = None
        event = reviewed or observed.get(key)
        approved = day['review'].get('approved_times',{}).get(key)
        if approved:
            display[key] = {'id':None,'happened_at':day['date']+' '+approved,'work_code':'',
                'origin':'hr_approved','placement':'approved_adjustment'}
        elif event:
            display[key] = {**event,'origin':'reviewed' if reviewed else 'biometric', 'placement':'reviewed' if reviewed else 'observed'}
            if not reviewed and sheet_times.get(key) and event['happened_at'][11:16]!=sheet_times[key][:5]:
                # A matched biometric entry wins over a stale sheet value.
                # Preserve the discrepancy as source evidence, not a blocking conflict.
                differences.append(key)
        elif sheet_times.get(key):
            display[key] = {'id':None,'happened_at':day['date']+' '+sheet_times[key],'work_code':'',
                'origin':'manual_sheet','placement':'named_source_column','source_row':manual['row'],'source_sheet':manual['sheet']}
        else:
            display[key] = None
    day['display_slots'] = display
    day['source_conflicts'] = conflicts
    day['source_differences'] = differences
    display_ids = {x['id'] for x in display.values() if x and x.get('id')}
    unplaced = len([x for x in ordinary if x['id'] not in display_ids])
    if unplaced and (source or any(x.get('k14_state_pending') for x in ordinary if x['id'] not in display_ids)):
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
    # Reconcile only complete, matching source rows; do not infer a schedule
    # for unmatched biometric-only days or grant additional activity credits.
    source_ut = source['reported_ut'] if comparable else None
    overtime = source['reported_ot'] if comparable else None
    recalculated = False
    if comparable and not offday:
        clocks = {key: dt.time.fromisoformat(sheet_times[key]) for key in KEYS}
        sec = {key: clock.hour*3600 + clock.minute*60 + clock.second for key, clock in clocks.items()}
        credited = (max(0, min(sec['am_out'], 12*3600) - max(sec['am_in'], 7*3600))
                    + max(0, sec['pm_out'] - max(sec['pm_in'], 13*3600)))
        expected_ut = max(8*3600 - credited, 0)
        expected_ot = max(credited - 8*3600, 0)
        recalculated = (source['reported_total'], source_ut, overtime) != (credited, expected_ut, expected_ot)
        total, source_ut, overtime = credited, expected_ut, expected_ot
    reviewed_ut = day['review']['undertime_minutes']
    # No required hours on weekends or holidays. Keep source/review evidence intact,
    # but do not charge or display undertime for these calendar days.
    undertime = None if future_entry or offday else reviewed_ut*60 if reviewed_ut is not None else source_ut
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
            metrics_origin='travel_order', conflicts=len(conflicts),
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
    missing = [labels[k] for k in KEYS if not slots[k]]
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
    if not issues and day["travel_order"]:
        text = "Travel Order"
    elif issues:
        text = issues[0] if len(issues)==1 else f"Review ({len(issues)} issues)"
    elif has_entries:
        now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
        ongoing = day["date"] == now.date().isoformat() and now.time() < dt.time(17)
        if status == "Incomplete entries":
            if ongoing:
                text = "In progress"
            elif len(missing)==1:
                text = "Missing " + missing[0]
            elif missing:
                text = f"Incomplete entries ({len(missing)})"
            else:
                text = "Incomplete entries"
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
    day["missing_entries"] = missing if has_entries and not day["travel_order"] and status=="Incomplete entries" and text!="In progress" else []
    day["display_remark"] = text
