"""Resolve displayed DTR times without changing source punches or reviews."""
from __future__ import annotations
import datetime as dt
import re

KEYS = ('am_in','am_out','pm_in','pm_out')
OFFICIAL = ('AJA','Travel Order','Fieldwork','Official Business')


def travel_coverage(day, manual, display):
    """Only merge blank half-days; never obscure actual time evidence."""
    refs = [item for item in day['display_activities'] if item['category'] == 'Travel Order']
    if not refs:
        return []
    raw = (manual or {}).get('original', {}).get('values', [])
    marked = set()
    for i, key in enumerate(KEYS):
        if len(raw)>i+2 and isinstance(raw[i+2], str) and re.search(r'\bTRAVEL\s+ORDER\b', raw[i+2], re.I):
            marked.add(key[:2])
    empty = [half for half in ('am','pm') if not any(display[half+'_'+part] for part in ('in','out'))]
    # A travel day with no office punches or named times needs no clock pair.
    # On mixed days use explicit sheet half or recorded document time range.
    if len(empty)==2:
        return empty
    for item in day.get('activities', []):
        if item['category'] != 'Travel Order':
            continue
        date=day['date']
        for half,start,end in (('am','00:00:00','12:00:00'),('pm','12:00:00','23:59:59')):
            if item['start_at'] < date+' '+end and item['end_at'] > date+' '+start:
                marked.add(half)
    return [half for half in empty if half in marked]


def resolve_day(day, manual):
    source = manual['data'] if manual else None
    sheet_times = source['times'] if source else {}
    ordinary = sorted((x for x in day['scans'] if x.get('activity_type') not in OFFICIAL),key=lambda x:(x['happened_at'],x['id']))
    observed = {}
    # Named manual slots can identify a unique observed punch in the same minute.
    for key in KEYS:
        clock = sheet_times.get(key)
        matches = [x for x in ordinary if clock and x['happened_at'][11:16]==clock[:5]]
        same_slots = [slot for slot,value in sheet_times.items() if clock and value and value[:5]==clock[:5]]
        if len(matches)==1 and len(same_slots)==1:
            observed[key] = matches[0]
    distinct = len({x['happened_at'][11:16] for x in ordinary})==len(ordinary)
    candidates = {}
    if not day['is_future'] and distinct:
        if len(ordinary)==4:
            clocks = [x['happened_at'][11:19] for x in ordinary]
            if clocks[0]<'12:00:00' and clocks[1]<='13:00:00' and clocks[2]>='12:00:00':
                candidates = dict(zip(KEYS,ordinary))
        elif len(ordinary)==2 and ordinary[0]['happened_at'][11:19]<'12:00:00' <=ordinary[1]['happened_at'][11:19]:
            candidates = {'am_in':ordinary[0],'pm_out':ordinary[1]}
    used = {x['id'] for x in observed.values()}
    for key,event in candidates.items():
        if key not in observed and event['id'] not in used:
            observed[key]=event
            used.add(event['id'])
    display, conflicts = {}, []
    for key in KEYS:
        reviewed = day['slots'][key]
        event = reviewed or observed.get(key)
        if event:
            display[key] = {**event,'origin':'reviewed' if reviewed else 'biometric', 'placement':'reviewed' if reviewed else 'observed'}
            if not reviewed and sheet_times.get(key) and event['happened_at'][11:16]!=sheet_times[key][:5]:
                conflicts.append(key)
        elif sheet_times.get(key):
            display[key] = {'id':None,'happened_at':day['date']+' '+sheet_times[key],'work_code':'',
                'origin':'manual_sheet','placement':'named_source_column','source_row':manual['row'],'source_sheet':manual['sheet']}
        else:
            display[key] = None
    day['display_slots'] = display
    day['source_conflicts'] = conflicts
    display_ids = {x['id'] for x in display.values() if x and x.get('id')}
    unplaced = len([x for x in ordinary if x['id'] not in display_ids])
    if source and unplaced:
        conflicts.append('unplaced_biometric')
    if source and not day['calendar']['holiday_name'] and not day['calendar']['version']:
        holiday = next((note for note in source['notes'] if 'HOLIDAY' in note.upper()), '')
        if holiday:
            day['calendar']['holiday_name'] = holiday
    chosen = [x['happened_at'] for x in display.values() if x]
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
    future_entry = any(value > now for value in chosen)
    chronological = chosen == sorted(chosen)
    complete = all(display.values()) and chronological and not future_entry
    if not chronological:
        conflicts.append('order')
    elapsed = None
    if complete:
        stamps = {key:dt.datetime.fromisoformat(event['happened_at']) for key,event in display.items()}
        if stamps['am_in']<stamps['am_out']<=stamps['pm_in']<stamps['pm_out']:
            elapsed = int(((stamps['am_out']-stamps['am_in'])+(stamps['pm_out']-stamps['pm_in'])).total_seconds())
        else:
            complete = False
            conflicts.append('order')
    comparable = bool(complete and source and not conflicts and all(sheet_times.get(k) and display[k]['happened_at'][11:16]==sheet_times[k][:5] for k in KEYS))
    total = source['reported_total'] if comparable and source['reported_total'] is not None else elapsed
    reviewed_ut = day['review']['undertime_minutes']
    undertime = None if future_entry else reviewed_ut*60 if reviewed_ut is not None else source['reported_ut'] if comparable else None
    overtime = source['reported_ot'] if comparable else None
    remarks = ('Future entry' if future_entry else 'Source difference' if conflicts else
        'Undertime' if undertime is not None and undertime>0 else
        'Overtime' if overtime is not None and overtime>0 else
        'Complete' if complete and undertime==0 else
        'Needs hour review' if complete else
        'Upcoming' if day['is_future'] else
        'Incomplete entries' if any(display.values()) else
        'Needs time review' if day['scans'] else
        'Holiday' if day['calendar']['holiday_name'] else
        'Weekend' if day['is_weekend'] else 'No entry')
    day['monitoring'] = {'total_seconds':total,'elapsed_seconds':elapsed,'undertime_seconds':undertime,'overtime_seconds':overtime,
        'remarks':remarks,'metrics_origin':'manual_sheet' if comparable else 'reviewed' if reviewed_ut is not None else 'elapsed_only',
        'complete':bool(complete),'conflicts':len(conflicts)}
    day['manual_source'] = {'name':manual['name'],'sheet':manual['sheet'],'row':manual['row'],'times':sheet_times,
        'notes':source['notes'],'aja':source.get('aja')} if manual else None
    day['display_unassigned_count'] = unplaced
    if source and source.get('aja'):
        day['display_activities'].append({'category':'AJA','reference':source['aja']['purpose']})
    if source:
        for note in source['notes']:
            kind = 'Travel Order' if re.search(r'TRAVEL\s+ORDER',note,re.I) else 'AJA' if re.search(r'\bAJA\b',note,re.I) else 'Manual DTR'
            day['display_activities'].append({'category':kind,'reference':note})
    travel = any(item['category']=='Travel Order' for item in day['display_activities'])
    day['travel_order'] = travel
    day['travel_periods'] = travel_coverage(day, manual, display)
    if travel:
        # No fabricated hours or deficit on a travel-only day; evidence stays available.
        if day['travel_periods']:
            day['monitoring'].update(total_seconds=None, elapsed_seconds=None,
                undertime_seconds=None, overtime_seconds=None, complete=False)
        if not conflicts and not future_entry:
            day['monitoring']['remarks'] = 'Travel Order'
    if not travel and remarks in ('No entry','Weekend') and source and source['notes']:
        kinds = {x['category'] for x in day['display_activities']}
        day['monitoring']['remarks'] = 'Travel Order' if 'Travel Order' in kinds else 'AJA' if 'AJA' in kinds else 'Manual DTR note'
    if day['calendar']['holiday_name']:
        day['tone']='holiday'
    elif any('TRAVEL' in x['category'].upper() or 'TRAVEL' in x['reference'].upper() for x in day['display_activities']):
        day['tone']='travel'
    elif any('AJA' in x['category'].upper() or 'AJA' in x['reference'].upper() for x in day['display_activities']):
        day['tone']='aja'
    elif any(display.values()):
        day['tone']='entry'
