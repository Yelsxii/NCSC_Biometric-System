'use strict';
/* NCSC records-first UI. All information comes from authenticated same-origin APIs. */
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
// Preserve DOM nodes if a live refresh produces identical markup.
const renderedMarkup = new WeakMap();
function setHtmlIfChanged(el, markup){
  const previous=renderedMarkup.get(el);
  if(previous && previous.markup===markup && previous.first===el.firstChild)return false;
  el.innerHTML=markup;
  renderedMarkup.set(el,{markup,first:el.firstChild});
  return true;
}
function setTextIfChanged(el,value){
  if(el.textContent!==value)el.textContent=value;
}
function setAttrIfChanged(el,name,value){
  if(el.getAttribute(name)!==value)el.setAttribute(name,value);
}
let session = null;
let currentPage = 'overview';
let selectedEmployee = null;
let selectedName = '';
let selectedDepartment = '';
let activeDtr = null;
let lastEmployeeRows = [];
let liveFilter = 'all';
let registerLiveAsOf = '';
let toastTimer = null;
let requestSerial = 0;
let rosterPreviewOkay = false;
let usbPreviewOkay = false;
let connectorReadPending = false;
const EMPLOYEE_PAGE_SIZE = 15;
let registerSearchTimer = null;
let profilePage = 1;
let profileCategory = 'All';
let profileRequest = 0;
let profileFormToken = 0;
let profileEditing = null;
let profileVersion = null;
let profileReturn = null;
let detailRequest = 0;
let dayReviewContext = null;
let attendanceRefreshTimer = null;
let attendanceRefreshEpoch = 0;
const DEVICE_REFRESH_MS = 5000;
let deviceRefreshTimer = null;
let deviceRefreshEpoch = 0;
let deviceStatusRequest = null;
let deviceStatusController = null;
let workCodeRows = [];
const titles = {
  employees:'Employee Attendance',
  profiles:'Employee profiles',
  activities:'AJA / Travel Orders',
  staff:'Users & Work Codes'
};
let activityRequest = 0;
const currentMonth = () => {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit'})
    .formatToParts(new Date());
  return parts.find(x=>x.type==='year').value + '-' + parts.find(x=>x.type==='month').value;
};

function toast(message, error=false) {
  $('toast').textContent = message;
  $('toast').className = error ? 'toast error-toast' : 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> $('toast').classList.add('hidden'),4500);
}
async function api(path,options={}) {
  const headers = new Headers(options.headers||{});
  if (session?.csrf && options.method && options.method.toUpperCase()!=='GET')
    headers.set('X-CSRF-Token',session.csrf);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  const response = await fetch(path,{credentials:'same-origin',...options,headers});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) {
    if (response.status===401 && !path.endsWith('/login')) {session=null;showLogin();}
    const detail = Array.isArray(data.detail) ? data.detail.map(x=>x.msg).join('; ') : data.detail;
    throw new Error(String(detail||'Request failed ('+response.status+')'));
  }
  return data;
}
function showLogin(){
  stopDeviceRefresh();
  stopAttendanceRefresh();
  selectedEmployee=null;activeDtr=null;dayReviewContext=null;detailRequest++;
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
  $('login-view').classList.remove('hidden');
  $('workspace').classList.add('hidden');
  $('login-password').value='';
  $('login-password').type='password';
  $('toggle-password').setAttribute('aria-pressed','false');
  $('login-username').focus();
}
function showApp(){
  $('login-view').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  const canWrite=session.role==='admin';
  document.querySelectorAll('#usb-form button,#roster-form button')
    .forEach(el=>el.disabled=!canWrite);
  $('open-attendance-import').disabled=!canWrite;
  $('open-user-import').disabled=!canWrite;
  $('open-profile').disabled=!canWrite;
  setAttendanceMonth('register-month',currentMonth());
  setAttendanceMonth('detail-month',currentMonth());
  $('activity-month').value=currentMonth();
  navigate('employees');
}
function navigate(page){
  if (!session || !titles[page]) return;
  cancelRegisterSearch();
  stopDeviceRefresh();
  stopAttendanceRefresh();
  currentPage=page;
  liveFilter='all';
  $('back-to-register').classList.add('hidden');
  document.querySelectorAll('[data-view]').forEach(node=>node.classList.toggle('hidden',node.dataset.view!==page));
  document.querySelectorAll('[data-page]').forEach(node=>{
    node.classList.toggle('active',node.dataset.page===page);
    if (node.dataset.page===page) node.setAttribute('aria-current','page');
    else node.removeAttribute('aria-current');
  });
  $('section-name').textContent=titles[page];
  document.title=titles[page]+' | NCSC Records';
  window.history.replaceState(null,'','#'+page);
  if (page==='employees') {
    $('employee-detail').classList.add('hidden');
    $('attendance-register-panel').classList.remove('hidden');
    selectedEmployee=null;activeDtr=null;
    startAttendanceRefresh();
    return loadRegister();
  }
  if (page==='profiles') return loadProfiles();
  if (page==='activities') return loadActivities();
  if (page==='staff') {startDeviceRefresh();return loadDevice();}
}
function cancelRegisterSearch(){clearTimeout(registerSearchTimer);registerSearchTimer=null;requestSerial++;}
function updateRegisterSearchControl(){$('clear-employee-search').hidden=!$('employee-search').value;}
function applyRegisterFilters({debounce=false}={}){
  cancelRegisterSearch();updateRegisterSearchControl();
  if(!session||currentPage!=='employees'||selectedEmployee)return;
  if(debounce){registerSearchTimer=setTimeout(()=>{registerSearchTimer=null;if(session&&currentPage==='employees'&&!selectedEmployee)void loadRegister({quiet:true});},120);}
  else void loadRegister();
}
async function loadRegister({quiet=false}={}){
  updateRegisterSearchControl();
  const serial=++requestSerial;
  const month=$('register-month').value||currentMonth();
  const q=$('employee-search').value.trim();
  if(!quiet)$('register-rows').innerHTML='<tr><td colspan="6" class="table-empty">Loading employees…</td></tr>';
  try {
    const result=await api('/api/employee-register?'+new URLSearchParams({month,live:'true'}));
    if (serial!==requestSerial||currentPage!=='employees'||!session||selectedEmployee||q!==$('employee-search').value.trim()||month!==($('register-month').value||currentMonth())) return;
    lastEmployeeRows=result.items;
    registerLiveAsOf=result.live_as_of||'';
    $('live-refresh-note').hidden=true;
    renderRegister();
  }catch(error){
    if(serial!==requestSerial || currentPage!=='employees' || !session || selectedEmployee)return;
    $('live-refresh-note').textContent='Attendance refresh failed';
    $('live-refresh-note').hidden=false;
    if(!quiet){$('register-rows').innerHTML='<tr><td colspan="6" class="table-empty">Unable to load employee attendance.</td></tr>';toast(error.message,true);}
  }
}
// Presentation only: preserve known abbreviations and Roman regional numbers.
function displayTitle(value){
  const acronyms=new Set(['NCSC','AJA','AM','PM','HR','HRD','HRIS','HRMO','AFS','ORD','OPS','OPD','IT','ICT','GIP','COS','OJT','DTR','PDO','RO','TO','CSC','DOLE','DSWD','DBM','COA','BAC','GAD']);
  return String(value??'').replace(/\p{L}+/gu,word=>{
    const upper=word.toUpperCase();
    if(acronyms.has(upper)||/^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII)$/.test(upper))return upper;
    return word.charAt(0).toUpperCase()+word.slice(1).toLowerCase();
  });
}
function categoryBadge(value){
  const kind={COS:'cos',Permanent:'permanent',GIP:'gip',OJT:'ojt'}[value];
  return '<span class="tag employment-chip tag-'+(kind||'neutral')+'">'+esc(value||'Not Set')+'</span>';
}
function departmentParts(value){
  const raw=String(value||'').trim();
  const official={OPS:'Operations Division',AFS:'Administrative and Finance Section',ORD:'Office of the Regional Director'};
  const suffix=raw.match(/\s*\((OPS|AFS|ORD)\)\s*$/i);
  const key=(suffix?.[1]||raw).toUpperCase();
  const code=Object.keys(official).find(k=>k===key||official[k].toLowerCase()===raw.toLowerCase());
  return code?{name:official[code],code}:{name:raw?displayTitle(raw):'—',code:''};
}
function departmentLabel(value){
  return departmentParts(value).name;
}
function departmentCell(value){
  return '<span class="department-display"><span class="department-name">'+esc(departmentLabel(value))+'</span></span>';
}
function employeeCell(row){
  const name=row.display_name||'Name not synchronized';
  const source='';
  return '<div class="employee-cell"><span class="name-avatar" aria-hidden="true">'+esc(name.slice(0,1).toUpperCase())+
    '</span><span><strong>'+esc(name)+'</strong>'+source+(row.position?'<small>'+esc(row.position)+'</small>':'')+'</span></div>';
}
// Initials are derived from the synchronized display name, never a photo.
function registerInitials(value){
  const name=String(value||'').trim();
  if(!name || name.toLowerCase()==='name not synchronized')return '—';
  const words=s=>s.trim().split(/\s+/).filter(Boolean);
  const initial=s=>(s.match(/\p{L}/u)?.[0]||'').toUpperCase();
  const parts=name.split(',');
  const suffix=/^(?:jr|sr|ii|iii|iv|v)\.?$/i;
  if(parts.length>1 && parts[1].trim() && !suffix.test(parts[1].trim())){
    return initial(words(parts[1])[0]||'')+initial(words(parts[0])[0]||'')||'—';
  }
  const tokens=words(parts[0]);
  while(tokens.length>1 && suffix.test(tokens[tokens.length-1]))tokens.pop();
  return (initial(tokens[0]||'')+(tokens.length>1?initial(tokens[tokens.length-1]):''))||'—';
}
function registerNameCell(row){
  const name=row.display_name||'Name not synchronized';
  return '<div class="register-identity"><span class="name-avatar" aria-hidden="true">'+esc(registerInitials(row.display_name))+
    '</span><strong>'+esc(name)+'</strong></div>';
}
function liveTime(stamp){
    if(!stamp)return '—';
    const match=String(stamp).match(/(\d{2}):(\d{2}):(\d{2})/);
    if(!match)return '—';
    const h=Number(match[1]);
    return String(h%12||12).padStart(2,'0')+':'+match[2]+':'+match[3]+' '+(h<12?'AM':'PM');
}
function liveMatches(row,key){
    const status=row.live?.status||'review';
    return key==='all'||(key==='other'?['review','offday'].includes(status):status===key);
}
function renderRegister(){
    const q=$('employee-search').value.trim().toLowerCase();
    const rows=lastEmployeeRows.filter(row=>liveMatches(row,liveFilter)&&(!q||String(row.employee_code).toLowerCase().includes(q)||String(row.display_name||'').toLowerCase().includes(q)));
    document.querySelectorAll('[data-live-count]').forEach(el=>{setTextIfChanged(el,String(lastEmployeeRows.filter(row=>liveMatches(row,el.dataset.liveCount)).length));});
    document.querySelectorAll('[data-live-filter]').forEach(el=>setAttrIfChanged(el,'aria-pressed',String(el.dataset.liveFilter===liveFilter)));
    const other=$('live-other-filter');
    other.classList.toggle('hidden',!lastEmployeeRows.some(row=>liveMatches(row,'other'))&&liveFilter!=='other');
    document.querySelectorAll('.live-kpi').forEach(button=>{
      const total=lastEmployeeRows.length;
      const count=lastEmployeeRows.filter(row=>liveMatches(row,button.dataset.liveFilter)).length;
      setAttrIfChanged(button,'aria-label',button.querySelector('small').textContent+': '+count+' of '+total+' employees');
    });
    
    const total=rows.length;
    setTextIfChanged($('register-count'),total?total+(total===1?' employee':' employees'):'No employees found');
    setHtmlIfChanged($('register-rows'),rows.length?rows.map(row=>
      '<tr>'+
      '<td class="employee-name-cell">'+registerNameCell(row)+'</td>'+
      '<td>'+categoryBadge(row.employment_type)+'</td>'+
      '<td>'+departmentCell(row.department)+'</td>'+
      '<td><span class="live-status live-'+esc(row.live?.status||'review')+'" title="'+esc(row.live?.reason||'Status unavailable')+'">'+esc(displayTitle(row.live?.label||'For review'))+'</span></td>'+
      '<td class="live-last-update'+(row.live?.last_update?' has-update':'')+'" title="'+esc([row.live?.at?liveTime(row.live.at):'',row.live?.reason||''].filter(Boolean).join(' · '))+'">'+esc(row.live?.last_update||'—')+'</td>'+
      '<td class="directory-action-cell"><button type="button" class="button primary row-action" data-employee="'+esc(row.employee_code)+'" aria-label="View attendance: '+esc(row.display_name||row.employee_code)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>View attendance</button></td>'+
      '</tr>'
    ).join(''):'<tr><td colspan="6" class="table-empty">No employees found.</td></tr>');
}
async function openEmployee(code){
  if (!code) return;
  cancelRegisterSearch();
  selectedEmployee=code;
  const row=lastEmployeeRows.find(x=>x.employee_code===code);
  selectedName=row?.display_name||'Name not synchronized';
  selectedDepartment=row?.department||'';
  $('detail-name').textContent=selectedName;
  $('detail-department').textContent=departmentLabel(selectedDepartment);
  $('detail-category').innerHTML=categoryBadge(row?.employment_type);
  setAttendanceMonth('detail-month',$('register-month').value);
  $('employee-detail').classList.remove('hidden');
  $('back-to-register').classList.remove('hidden');
  $('attendance-register-panel').classList.add('hidden');
  await loadDetail();
  $('main-content').scrollTop=0;
}

function updateProfileTabs(){
  document.querySelectorAll('[data-profile-category]').forEach(node=>{
    const active=node.dataset.profileCategory===profileCategory;
    node.classList.toggle('active',active);node.setAttribute('aria-pressed',String(active));
  });
}
async function loadProfiles(){
  const serial=++profileRequest;
  updateProfileTabs();
  $('profile-rows').innerHTML='<tr><td colspan="7" class="table-empty">Loading employee profiles…</td></tr>';
  try{
    const data=await api('/api/employee-profiles?'+new URLSearchParams({
      q:$('profile-search').value.trim(),category:profileCategory,status:$('profile-status').value,
      page:String(profilePage),limit:String(EMPLOYEE_PAGE_SIZE)}));
    if(serial!==profileRequest || currentPage!=='profiles' || !session)return;
    const pages=Math.max(1,Math.ceil(data.total/EMPLOYEE_PAGE_SIZE));
    if(profilePage>pages){profilePage=pages;return loadProfiles();}
    $('profile-total-badge').textContent=data.summary.total;
    for(const kind of ['COS','Permanent','GIP','OJT'])
      $('profile-'+kind.toLowerCase()+'-badge').textContent=data.summary.categories[kind];
    $('profile-summary').textContent=data.summary.total+' employees · '+data.summary.registered+' verified profiles · '+data.summary.needs_details+' need details';
    $('profile-count').textContent=data.total?('Showing '+((profilePage-1)*EMPLOYEE_PAGE_SIZE+1)+'–'+Math.min(profilePage*EMPLOYEE_PAGE_SIZE,data.total)+' of '+data.total+' employees'):'No matching employees';
    $('profile-page').textContent='Page '+profilePage+' of '+pages;
    $('profile-prev').disabled=profilePage===1;$('profile-next').disabled=profilePage===pages;
    $('profile-rows').innerHTML=data.items.length?data.items.map(row=>
      '<tr><td class="id-cell">'+esc(row.employee_code)+'</td><td>'+employeeCell(row)+'</td><td>'+categoryBadge(row.employment_type)+'</td><td>'+departmentCell(row.department)+'</td>'+
      '<td><span class="tag '+(row.sync_authorized?'tag-success':'tag-paused')+'"><span class="tag-dot"></span>'+(row.sync_authorized?'Enabled':'Paused')+'</span></td>'+
      '<td><span class="tag '+(row.profile_complete?'tag-neutral':'tag-paused')+'">'+(row.profile_complete?'Registered':'Needs details')+'</span></td>'+
      '<td>'+(session.role==='admin'?'<button type="button" class="text-link" data-edit-profile="'+esc(row.employee_code)+'">'+(row.profile_complete?'Edit profile':'Complete profile')+'</button>':'—')+'</td></tr>'
    ).join(''):'<tr><td colspan="7" class="table-empty">No matching employees. Adjust your filters or register an enrolled K14 ID.</td></tr>';
  }catch(error){
    if(serial!==profileRequest)return;
    $('profile-rows').innerHTML='<tr><td colspan="7" class="table-empty">Unable to load employee profiles.</td></tr>';
    toast(error.message,true);
  }
}
async function openProfile(code=null){
  if(session?.role!=='admin')return;
  const token=++profileFormToken;
  profileReturn={page:currentPage,employee:selectedEmployee,month:$('detail-month').value};
  profileEditing=null;profileVersion=null;
  $('profile-form').reset();$('profile-id').readOnly=false;
  $('profile-error').classList.add('hidden');$('save-profile').disabled=false;
  $('profile-heading').textContent='Register employee';$('save-profile').textContent='Register employee';
  $('profile-context').textContent='Link an enrolled K14 ID to a verified employee profile.';
  $('profile-id-hint').textContent='Enter the ID already enrolled on the K14. Keep any leading zeroes.';
  try{
    if(code){
      const data=await api('/api/employee-profiles/'+encodeURIComponent(code));
      if(token!==profileFormToken || session?.role!=='admin')return;
      profileEditing=data.profile_complete?code:null;profileVersion=data.version;
      $('profile-id').value=code;$('profile-id').readOnly=true;
      for(const [field,key] of [['first','first_name'],['middle','middle_name'],['last','last_name'],['suffix','suffix'],['type','employment_type'],['department','department'],['position','position']])
        $('profile-'+field).value=data[key]||'';
      const department=String(data.department||'').trim().toLowerCase();
      const official=[...$('profile-department').options].find(option=>{
        if(!option.value)return false;
        const full=option.value.toLowerCase(),code=full.match(/\(([^)]+)\)$/)?.[1];
        return department===full||department===code||department===full.replace(/\s*\([^)]+\)$/,'');
      });
      $('profile-department').value=official?.value||'';
      $('profile-sync').checked=data.sync_authorized;
      $('profile-heading').textContent=data.profile_complete?'Edit employee profile':'Complete employee profile';
      $('save-profile').textContent=data.profile_complete?'Save changes':'Complete profile';
      $('profile-context').textContent='K14 ID '+code+(data.display_name?' · Current name: '+data.display_name:'');
      $('profile-id-hint').textContent='This existing K14 ID stays fixed. Saving verified details preserves all linked scans.';
    }
    $('profile-confirm').checked=false;
    $('profile-dialog').showModal();
    $(code?'profile-first':'profile-id').focus();
  }catch(error){toast(error.message,true);}
}
async function saveProfile(event){
  event.preventDefault();
  if(session?.role!=='admin')return;
  const account=session,code=$('profile-id').value.trim();
  const payload={};
  for(const [field,key] of [['first','first_name'],['middle','middle_name'],['last','last_name'],['suffix','suffix'],['type','employment_type'],['department','department'],['position','position']])
    payload[key]=$('profile-'+field).value.trim();
  payload.sync_authorized=$('profile-sync').checked;
  payload.device_enrollment_confirmed=$('profile-confirm').checked;
  const editing=profileEditing;
  if(editing)payload.version=profileVersion;else payload.employee_code=code;
  $('save-profile').disabled=true;$('profile-error').classList.add('hidden');
  try{
    await api('/api/employee-profiles'+(editing?'/'+encodeURIComponent(editing):''),{method:editing?'PUT':'POST',body:JSON.stringify(payload)});
    if(session!==account)return;
    $('profile-dialog').close();
    toast(editing?'Employee profile updated.':'Employee profile registered.');
    if(!editing){profilePage=1;profileCategory='All';$('profile-search').value=code;$('profile-status').value='All';}
    if(profileReturn?.page==='employees'){
      const previous=profileReturn;
      await loadRegister();
      if(previous.employee){await openEmployee(previous.employee);setAttendanceMonth('detail-month',previous.month);await loadDetail();}
    }else await navigate('profiles');
  }catch(error){
    if(session===account){$('profile-error').textContent=error.message;$('profile-error').classList.remove('hidden');}
  }finally{$('save-profile').disabled=false;}
}
function editIcon(){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z"/></svg>';
}
function activityScanCell(day){
  const periods=day.aja_periods||[];
  return ['out','in'].map(key=>'<td class="activity-evidence aja-'+key+'">'+(periods.length?periods.map(period=>{
    const entry=period[key];
    return '<div class="aja-time '+(entry?'has-aja':'aja-missing')+'" title="'+esc((entry?.origin||'Missing entry')+(period.review?' · Needs review':''))+'">'+(entry?'<span class="time-value">'+esc(entry.time)+'</span>':period.review?'<span class="no-time">—</span>':'—')+'</div>';
  }).join(''):'<span class="empty-cell">—</span>')+'</td>').join('');
}
function travelLabel(day){
  return day.travel_reference?'Travel Order No.: '+day.travel_reference:'Travel Order';
}
function regularReviewCandidates(day){
  // Keep the existing admin-initiated four-punch review for raw/unclassified
  // codes; explicitly classified official activity scans are never included.
  return day.scans.filter(event=>
    !['AJA','Travel Order','Fieldwork','Official Business'].includes(event.activity_type));
}
function provisionalOrdinarySlots(day){
  // Show evidence-only previews when exactly four unambiguous non-activity
  // source scans exist; never alter a review or calculate attendance credit.
  const candidates=regularReviewCandidates(day);
  if(candidates.length!==4 || day.is_future)return null;
  const stamps=candidates.map(event=>event.happened_at);
  if(new Set(stamps).size!==4)return null;
  const ordered=[...candidates].sort((a,b)=>a.happened_at.localeCompare(b.happened_at));
  // Provisional only; the administrator is still responsible for confirming slots.
  return Object.fromEntries(['am_in','am_out','pm_in','pm_out'].map((key,i)=>[key,ordered[i]]));
}
function unassignedPunches(day){
  const assigned=new Set(Object.values(day.slots).filter(Boolean).map(event=>event.id));
  const other=day.scans.filter(event=>!assigned.has(event.id) &&
    !['AJA','Travel Order'].includes(event.activity_type));
  if(!other.length)return '';
  return '<span class="raw-punch-evidence" title="Original biometric timestamps, not automatically approved for AM/PM">' +
    '<b>Biometric scans ('+other.length+')</b> '+other.map(event=>
    '<span class="raw-punch-time">'+esc(event.happened_at.slice(11,16))+'</span>').join('')+
    '</span>';
}
function durationText(seconds){
  if (!Number.isFinite(seconds)) return '—';
  const whole=Math.trunc(Math.abs(seconds));
  const hours=Math.floor(whole/3600), minutes=Math.floor(whole%3600/60), remainder=whole%60;
  return (seconds<0?'-':'')+[hours,minutes,remainder].map(part=>String(part).padStart(2,'0')).join(':');
}
function attendanceTimeCells(day){
  if(day.travel_order){
    return '<td colspan="4" class="time-slot slot-travel"><span class="travel-status" title="'+esc((day.travel_source_references||[]).join(' · ')||travelLabel(day))+'">'+esc(travelLabel(day).toUpperCase())+'</span></td>';
  }
  const holiday=day.calendar?.holiday_name;
  const calendarLabel=holiday||(day.is_weekend?(day.day==='Sat'?'Saturday':'Sunday'):'');
  // Merge only confirmed empty calendar days. Never hide recorded punches,
  // approved time entries, AJA evidence, or unresolved review indicators.
  if(calendarLabel && day.has_attendance_entries===false &&
      day.display_remark===calendarLabel && !(day.remark_issues||[]).length &&
      !(day.scans||[]).length && !Object.values(day.display_slots||day.slots||{}).some(Boolean) &&
      !(day.aja_periods||[]).length){
    return '<td colspan="4" class="time-slot slot-calendar '+(holiday?'slot-holiday':'slot-neutral')+'"><span class="calendar-status">'+esc(calendarLabel.toUpperCase())+'</span></td>';
  }
  return ['am_in','am_out','pm_in','pm_out'].map(key=>slotCell(day,key)).join('');
}
function manilaClock(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date());}
function slotCell(day,key){
  const event=day.display_slots?day.display_slots[key]:(day.slots[key]||provisionalOrdinarySlots(day)?.[key]);
  const origin=event?.origin||(day.slots[key]?'reviewed':'biometric');
  const tone=day.tone==='holiday'?'holiday':
    event?(day.monitoring?.remarks==='Future entry'&&event.happened_at>manilaClock()?'neutral':origin==='manual_sheet'?'sheet':(origin==='reviewed'||origin==='hr_approved')?'entry':'provisional'):
      (day.is_future||day.is_weekend?'neutral':'missing');
  const label=origin==='manual_sheet'?'Sheet':origin==='reviewed'?'HR':'Bio';
  const hint=event?event.happened_at.slice(11)+' · '+(origin==='manual_sheet'?'Manual DTR source':origin==='reviewed'?'Reviewed selection':origin==='hr_approved'?'HR-approved adjustment':'Original biometric time; observed AM/PM placement')+
    (event.verified_slot?' · Device state: '+event.verified_slot.replace('_',' ').toUpperCase():'')+
    (event.work_code_conflict?' · Work code conflict':event.work_code_pending?' · Work code awaiting synchronization':event.work_code!==undefined&&event.work_code!==''?' · Work code '+event.work_code:event.k14_state_pending?' · Work code not yet available':''):'No entry';
  return '<td class="time-slot slot-'+tone+'" data-origin="'+esc(event?origin:'')+'" title="'+esc(hint)+'">'+(event?
    '<span class="time-value">'+esc(event.happened_at.slice(11,19))+'</span>':
    '<span class="no-time">—</span>')+'</td>';
}
async function loadDetail({quiet=false}={}){
  if (!selectedEmployee) return;
  const serial=++detailRequest,month=$('detail-month').value||currentMonth(),code=selectedEmployee;
  if(!quiet)$('daily-rows').innerHTML='<tr><td colspan="13" class="table-empty">Loading attendance…</td></tr>';
  try{
    const data=await api('/api/dtr/monitor?'+new URLSearchParams({employee_code:code,month}));
    if(serial!==detailRequest || code!==selectedEmployee || month!==$('detail-month').value || currentPage!=='employees' || !session)return;
    if(quiet && document.querySelectorAll('dialog[open]').length)return;
    activeDtr=data;
    selectedName=data.display_name||'Name not synchronized';
    setTextIfChanged($('detail-name'),selectedName);
    setAttrIfChanged($('detail-name'),'title',data.name_source==='device'?'Name synchronized from K14 device; HR profile is separate':'Employee attendance');
    setTextIfChanged($('detail-department'),departmentLabel(data.department));
    setHtmlIfChanged($('detail-category'),categoryBadge(data.employment_type));
    const scroll=$('daily-table-wrap').scrollTop;
    const changed=setHtmlIfChanged($('daily-rows'),data.days.map(day=>{
      const metrics=day.monitoring||{total_seconds:day.daily_total_seconds,undertime_seconds:day.review.undertime_minutes===null?null:day.review.undertime_minutes*60,overtime_seconds:null,remarks:'For review'};
      const calendarLabel=day.calendar.holiday_name||(day.is_weekend?(day.day==='Sat'?'Saturday':'Sunday'):'');
      const ut=displayUndertimeSeconds(day);
      const utTone=ut==null?'duration-muted':ut>0?'duration-positive':'duration-muted';
      const otTone=metrics.overtime_seconds>0?'duration-positive':'duration-muted';
      const status=metrics.remarks;
      const visibleStatus=day.travel_order
        ? (day.display_remark||(['Source difference','Future entry'].includes(status)?'Review':'Travel Order'))
        : (day.display_remark||(!day.has_attendance_entries&&calendarLabel?calendarLabel:status==='Source difference'?'Review':status));
      const unassigned=day.display_unassigned_count??day.unassigned_count;
      const assignedIds=new Set(Object.values(day.display_slots||{}).filter(Boolean).map(x=>x.id));
      const rawHint=day.scans.filter(x=>!assignedIds.has(x.id)&&!['AJA','Travel Order','Fieldwork','Official Business'].includes(x.activity_type)).map(x=>x.happened_at.slice(11,19)+(x.k14_punch_type!=null?' · State '+x.k14_punch_type:'')).join(' | ');
      const sourceLabels={am_in:'AM In',am_out:'AM Out',pm_in:'PM In',pm_out:'PM Out'};
      const differences=(day.source_differences||[]).map(key=>sourceLabels[key]||key);
      const detail=[status,...(day.remark_issues||[]),
        (day.missing_entries||[]).length?'Missing: '+day.missing_entries.join(', '):'',
        differences.length?'Biometric preferred over sheet: '+differences.join(', '):'',
        day.calendar.holiday_name,day.is_weekend?(day.day==='Sat'?'Saturday':'Sunday'):'',day.review.remark,
        unassigned?'Unassigned punches: '+(rawHint||unassigned):''].filter(Boolean).join(' · ');
      const kind=['Complete','Present'].includes(visibleStatus)?'complete':visibleStatus==='Undertime'?'undertime':visibleStatus==='Overtime'?'overtime':visibleStatus==='Travel Order'?'travel':visibleStatus==='AJA'?'aja':visibleStatus==='In progress'?'progress':visibleStatus==='Invalid time sequence'?'missing':visibleStatus==='Incomplete AJA'?'aja':visibleStatus==='Travel Order conflict'?'travel':visibleStatus==='Hours for review'?'pending':(day.remark_issues||[]).length||/^(Missing |Incomplete|Review|Future entry|For review)/.test(visibleStatus)?'conflict':visibleStatus==='No entry'?'missing':!day.has_attendance_entries&&day.calendar.holiday_name?'holiday':['Saturday','Sunday','Weekend'].includes(visibleStatus)?'weekend':'pending';
      return '<tr class="day-row day-'+esc(day.tone)+'" data-date="'+esc(day.date)+'">'+
        '<td class="dtr-date'+(day.is_weekend&&!day.calendar.holiday_name?' calendar-weekend':'')+'"'+(calendarLabel?' title="'+esc(calendarLabel)+'"':'')+'><strong>'+esc(day.date.slice(8))+'</strong><span>'+esc(day.day)+'</span></td>'+
        attendanceTimeCells(day)+
        '<td class="daily-total-value" title="'+esc(metrics.metrics_origin==='template_recalculated'?'Recalculated using the existing DTR template and matched source times':metrics.metrics_origin==='manual_sheet'?'Manual DTR calculated result':'Elapsed AM + PM time; '+(metrics.total_seconds??'unknown')+' seconds')+'">'+durationText(metrics.total_seconds)+'</td>'+
        '<td class="undertime-value '+utTone+'" title="'+esc(calendarLabel?'Not applicable on weekends and holidays':ut==null?'For review':metrics.undertime_origin==='reviewed'?'Saved HR undertime override':metrics.undertime_origin==='template_recalculated'?'Recalculated from matching DTR time entries':'Available DTR undertime')+'">'+(ut==null?'—':Math.floor(ut/3600))+'</td>'+
        '<td class="undertime-value '+utTone+'">'+(ut==null?'—':String(Math.floor(ut%3600/60)).padStart(2,'0'))+'</td>'+
        '<td class="overtime-value '+otTone+'" title="'+esc(metrics.metrics_origin==='template_recalculated'?'Recalculated DTR excess hours; not payroll overtime approval':'Manual DTR overtime result')+'">'+durationText(metrics.overtime_seconds)+'</td>'+
        activityScanCell(day)+'<td class="day-activities">'+(visibleStatus?'<span title="'+esc(detail)+'" class="monitor-remark remark-'+kind+'">'+esc(visibleStatus)+'</span>':'<span class="empty-cell">—</span>')+'</td>'+
        '<td class="day-action"><button type="button" class="button outline edit-day" data-edit-day="'+esc(day.date)+'" aria-label="'+(session.role==='admin'?'Edit':'View')+' attendance for '+esc(day.date)+'">'+editIcon()+(session.role==='admin'?'Edit':'View')+'</button></td></tr>';
    }).join(''));
    if(changed)$('daily-table-wrap').scrollTop=scroll;
  }catch(error){
    if(serial!==detailRequest || code!==selectedEmployee || currentPage!=='employees' || !session)return;
    if(!quiet){$('daily-rows').innerHTML='<tr><td colspan="13" class="table-empty">Unable to load attendance.</td></tr>';toast(error.message,true);}
  }
}
const REVIEW_CLOCKS=['am_in','am_out','pm_in','pm_out','aja_out','aja_in'];
let pickerTarget=null;
function clockInput(key){return $('clock-'+key.replaceAll('_','-'));}
function normalizedClock(value){
  const raw=value.trim();
  if(!raw)return '';
  const m=/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(raw);
  return m?m[1]+':'+m[2]+':'+(m[3]||'00'):null;
}
function clockAdjustments(context){
  const approved={...(context.day.review.approved_times||{})};
  for(const key of REVIEW_CLOCKS){
    const input=clockInput(key);
    if(input.disabled)continue;
    const value=normalizedClock(input.value);
    if(value===null)return null;
    if(value===context.initialClocks[key])continue;
    if(value)approved[key]=value;else delete approved[key];
  }
  return approved;
}
function closeClockPicker(){
  if(pickerTarget)document.querySelector('[data-clock-pick="'+pickerTarget+'"]')?.setAttribute('aria-expanded','false');
  pickerTarget=null;$('clock-picker').classList.add('hidden');
}
function openClockPicker(id){
  const input=$('clock-'+id);
  if(input.disabled)return;
  if(pickerTarget===id){closeClockPicker();return;}
  closeClockPicker();pickerTarget=id;
  document.querySelector('[data-clock-pick="'+id+'"]').setAttribute('aria-expanded','true');
  const parts=(normalizedClock(input.value)||'00:00:00').split(':');
  ['hour','minute','second'].forEach((k,i)=>{$('picker-'+k).value=parts[i];});
  $('clock-picker-title').textContent=input.closest('.clock-field').querySelector('label').textContent;
  $('clock-picker').classList.remove('hidden');
  $('picker-hour').focus();$('picker-hour').select();
}
function applyClockPicker(clear=false){
  if(!pickerTarget)return;
  const values=['hour','minute','second'].map(k=>$('picker-'+k).value.trim());
  if(!clear && values.some((v,i)=>! /^\d{1,2}$/.test(v)||Number(v)>(i===0?23:59))){
    $('day-review-error').textContent='Choose a valid 24-hour time.';$('day-review-error').classList.remove('hidden');return;
  }
  const input=$('clock-'+pickerTarget);
  input.value=clear?'':values.map(v=>v.padStart(2,'0')).join(':');
  input.setCustomValidity('');closeClockPicker();
  $('day-review-error').classList.add('hidden');input.focus();
}
// The table and editor share effective undertime, not merely the stored override.
function displayUndertimeSeconds(day){
  if(day.is_weekend||day.calendar.holiday_name||day.travel_order)return null;
  if(day.monitoring)return day.monitoring.undertime_seconds??null;
  const reviewed=day.review.undertime_minutes;
  return reviewed==null?null:reviewed*60;
}
function openDayReview(date){
  const day=activeDtr?.days.find(x=>x.date===date);
  if(!day || !session)return;
  dayReviewContext={code:selectedEmployee,month:activeDtr.month,day,account:session,initialClocks:{}};
  const editable=session.role==='admin';
  $('day-review-form').reset();closeClockPicker();$('day-review-error').classList.add('hidden');
  $('day-review-heading').textContent=editable?(day.travel_order?'Edit Travel Order':'Edit attendance'):'Attendance entries';
  $('day-review-context').textContent=selectedName+' · '+date+' ('+day.day+')';
  const periods=day.aja_periods||[];
  for(const key of REVIEW_CLOCKS){
    const isAja=key.startsWith('aja_');
    const entry=isAja?(periods.length===1?periods[0][key.slice(4)]:null):day.display_slots?.[key];
    const input=clockInput(key);
    input.value=normalizedClock(isAja?entry?.time||'':entry?.happened_at.slice(11,19)||'')||'';
    input.setCustomValidity('');
    input.title=entry?.origin==='hr_approved'?'HR-approved adjustment':entry?.origin==='manual_sheet'?'DTR source':entry?.origin==='biometric'?'Biometric entry':'';
    dayReviewContext.initialClocks[key]=input.value;
    input.disabled=!editable||(isAja&&periods.length>1);
    document.querySelector('[data-clock-pick="'+key.replaceAll('_','-')+'"]').disabled=input.disabled;
  }
  $('review-aja-hint').textContent=periods.length>1?'Multiple AJA periods — review separately.':'';
  $('review-aja-hint').classList.toggle('hidden',periods.length<=1);
  const offday=day.is_weekend||Boolean(day.calendar.holiday_name);
  const seconds=displayUndertimeSeconds(day);
  const minutes=seconds==null?null:Math.floor(seconds/60);
  $('review-ut-hours').value=minutes===null?'':Math.floor(minutes/60);
  $('review-ut-minutes').value=minutes===null?'':minutes%60;
  dayReviewContext.initialUndertime={hours:$('review-ut-hours').value,minutes:$('review-ut-minutes').value};
  const fullTravel=day.travel_order===true;
  const editRef=fullTravel;
  $('review-reference').value=fullTravel?(day.travel_reference||''):'';
  dayReviewContext.initialTravelReference=$('review-reference').value;
  $('review-travel-reference').classList.toggle('hidden',!editRef);
  $('review-reference').disabled=!editable||!editRef;
  $('review-reference').required=editable&&editRef;
  $('review-reference').title=fullTravel?(day.travel_source_references||[]).join(' · '):'';
  for(const id of ['review-ut-hours','review-ut-minutes']){
    $(id).disabled=!editable||offday;
    $(id).title=offday?'Not applicable on weekends and holidays':'';
  }
  $('save-day-review').classList.toggle('hidden',!editable);$('save-day-review').disabled=false;
  $('review-time-section').classList.toggle('hidden',fullTravel);
  $('review-travel-info').classList.toggle('hidden',!fullTravel);
  $('review-travel-info').textContent=fullTravel?'Travel Order · Full day':'';
  $('day-review-dialog').showModal();
}
async function saveDayReview(event){
  event.preventDefault();
  const context=dayReviewContext;
  if(!context || context.account!==session || session.role!=='admin')return;
  const payload={version:context.day.review.version};
  for(const key of REVIEW_CLOCKS.slice(0,4))payload[key]=context.day.slots[key]?.id||null;
  let regularChanged=false;
  if(!context.day.travel_order){
    const approved=clockAdjustments(context);
    if(approved===null){
      $('day-review-error').textContent='Use HH:MM or HH:MM:SS (24-hour time).';$('day-review-error').classList.remove('hidden');return;
    }
    const before=context.day.review.approved_times||{};
    regularChanged=REVIEW_CLOCKS.slice(0,4).some(k=>approved[k]!==before[k]);
    for(const key of REVIEW_CLOCKS.slice(0,4))if(approved[key]&&approved[key]!==before[key])payload[key]=null;
    payload.approved_times=approved;
  }
  const h=$('review-ut-hours').value,m=$('review-ut-minutes').value;
  // Display source-derived values without silently converting them into overrides.
  const undertimeUnchanged=h===context.initialUndertime.hours&&m===context.initialUndertime.minutes;
  payload.undertime_minutes=context.day.is_weekend||context.day.calendar.holiday_name||context.day.travel_order
    ?context.day.review.undertime_minutes
    :undertimeUnchanged?(regularChanged?null:context.day.review.undertime_minutes)
    :h===''&&m===''?null:Number(h||0)*60+Number(m||0);
  payload.activity_type=context.day.review.activity_type;
  payload.activity_reference=context.day.review.activity_reference;
  if(context.day.travel_order && $('review-reference').value.trim()!==context.initialTravelReference){
    payload.activity_type='Travel Order';
    payload.activity_reference=$('review-reference').value.trim();
  }
  payload.remark=context.day.review.remark;
  $('save-day-review').disabled=true;$('day-review-error').classList.add('hidden');
  try{
    await api('/api/attendance/'+encodeURIComponent(context.code)+'/'+context.day.date,{method:'PUT',body:JSON.stringify(payload)});
    if(context.account!==session)return;
    $('day-review-dialog').close();toast('Attendance review saved.');
    if(selectedEmployee===context.code && $('detail-month').value===context.month)await loadDetail({quiet:true});
  }catch(error){if(context.account===session){$('day-review-error').textContent=error.message;$('day-review-error').classList.remove('hidden');}}
  finally{$('save-day-review').disabled=false;}
}
function calendarDateChanged(){
  const day=activeDtr?.days.find(x=>x.date===$('calendar-date').value);
  $('calendar-name').value=day?.calendar.holiday_name||'';$('calendar-error').classList.add('hidden');
}
function openCalendar(){
  if(!activeDtr || session?.role!=='admin')return;
  $('calendar-date').innerHTML=activeDtr.days.map(day=>'<option value="'+day.date+'">'+day.date+' ('+day.day+')</option>').join('');
  calendarDateChanged();$('calendar-dialog').showModal();
}
async function saveCalendar(event){
  event.preventDefault();
  if(!activeDtr || session?.role!=='admin')return;
  const day=activeDtr.days.find(x=>x.date===$('calendar-date').value),account=session;
  if(!day)return;
  $('save-calendar').disabled=true;$('calendar-error').classList.add('hidden');
  try{
    await api('/api/attendance-calendar/'+day.date,{method:'PUT',body:JSON.stringify({version:day.calendar.version,holiday_name:$('calendar-name').value.trim()})});
    if(session!==account)return;
    $('calendar-dialog').close();toast('Attendance calendar updated.');await loadDetail({quiet:true});
  }catch(error){if(session===account){$('calendar-error').textContent=error.message;$('calendar-error').classList.remove('hidden');}}
  finally{$('save-calendar').disabled=false;}
}
function stopAttendanceRefresh(){attendanceRefreshEpoch++;clearTimeout(attendanceRefreshTimer);attendanceRefreshTimer=null;}
function startAttendanceRefresh(){
  stopAttendanceRefresh();
  const epoch=attendanceRefreshEpoch;
  const tick=async()=>{
    if(epoch!==attendanceRefreshEpoch || currentPage!=='employees' || !session || document.hidden)return;
    if(!document.querySelectorAll('dialog[open]').length){
      if(selectedEmployee)await loadDetail({quiet:true});else await loadRegister({quiet:true});
    }
    if(epoch===attendanceRefreshEpoch && currentPage==='employees' && session && !document.hidden)
      attendanceRefreshTimer=setTimeout(tick,10000);
  };
  if(currentPage==='employees' && session && !document.hidden)attendanceRefreshTimer=setTimeout(tick,10000);
}
async function loadActivities(){
  const token=++activityRequest;
  const params=new URLSearchParams({
    month:$('activity-month').value||currentMonth(),
    category:$('activity-category').value,
    q:$('activity-search').value.trim()
  });
  $('activity-rows').innerHTML='<tr><td colspan="8" class="table-empty">Loading activity logs…</td></tr>';
  try{
    const data=await api('/api/activities/monitor?'+params);
    if(token!==activityRequest||currentPage!=='activities')return;
    const counts=data.summary;
    $('activity-counts').innerHTML=
      '<span><b>'+counts.employees+'</b> employees</span>'+
      '<span><b>'+counts.aja+'</b> AJA scans</span>'+
      '<span><b>'+counts.travel_orders+'</b> Travel Order scans</span>';
    $('activity-rows').innerHTML=data.items.length?data.items.map(item=>{
      const instant=item.happened_at||'';
      const badge=item.category==='AJA'?'activity-aja':'activity-travel';
      return '<tr><td class="id-cell">'+esc(item.employee_code)+'</td>'+
        '<td class="employee-name-cell">'+esc(item.display_name||'Name not synchronized')+'</td>'+
        '<td><span class="activity-badge '+badge+'">'+esc(item.category)+'</span></td>'+ 
        '<td><span class="direction-pill '+(item.direction==='IN'?'direction-in':item.direction==='OUT'?'direction-out':'direction-unmapped')+'">'+esc(item.direction||'Unspecified')+'</span></td>'+
        '<td class="date-cell">'+esc(instant.slice(0,10))+'</td>'+
        '<td class="date-cell">'+esc(instant.slice(11,19))+'</td>'+
        '<td><span class="code-pill">'+esc(item.work_code)+'</span></td>'+
        '<td><button class="text-link row-action" type="button" data-monitor-employee="'+
          esc(item.employee_code)+'">View attendance <span aria-hidden="true">→</span></button></td></tr>';
    }).join(''):'<tr><td colspan="8" class="table-empty">No device-classified AJA or Travel Order scans found for these filters.</td></tr>';
  }catch(error){
    if(token!==activityRequest)return;
    $('activity-rows').innerHTML='<tr><td colspan="8" class="table-empty">Unable to load activity logs.</td></tr>';
    toast(error.message,true);
  }
}
async function viewActivityEmployee(code){
  $('employee-search').value=code;
  setAttendanceMonth('register-month',$('activity-month').value||currentMonth());
  await navigate('employees');
  await openEmployee(code);
}
function deviceRefreshAllowed(){
  return Boolean(session && currentPage==='staff' && !document.hidden);
}
function deviceRefreshMessage(message){
  if($('lan-live-status').textContent!==message)$('lan-live-status').textContent=message;
}
function stopDeviceRefresh(){
  deviceRefreshEpoch++;
  clearTimeout(deviceRefreshTimer);
  deviceRefreshTimer=null;
  deviceStatusController?.abort();
}
function startDeviceRefresh(){
  stopDeviceRefresh();
  if(!deviceRefreshAllowed())return;
  const epoch=deviceRefreshEpoch;
  const tick=async()=>{
    deviceRefreshTimer=null;
    if(epoch!==deviceRefreshEpoch || !deviceRefreshAllowed())return;
    await refreshDeviceStatus({quiet:true});
    if(epoch===deviceRefreshEpoch && deviceRefreshAllowed())
      deviceRefreshTimer=setTimeout(tick,DEVICE_REFRESH_MS);
  };
  deviceRefreshTimer=setTimeout(tick,DEVICE_REFRESH_MS);
}
function renderDeviceStatus(data){
    $('lan-ip').textContent=data.host;
    $('lan-port').textContent=data.port??'—';
    $('lan-badge').textContent=data.sync_enabled?'Connector sync on':'Not synchronized';
    $('lan-message').textContent=data.message;
    const sync=data.attendance_sync||{};
    $('lan-sync').textContent=sync.in_progress?'Import in progress':
      (sync.enabled?'On · every '+sync.interval_seconds+' seconds':'Off · Manual reads available');
    $('lan-connector').textContent=sync.connector_available?(sync.source_mode==='bionet'?'ZKBio Time.Net':'Available (local file)'):'Unavailable';
    $('lan-connector').title=sync.connector_message||'';
    $('lan-total-records').textContent=Number(sync.total_imported||0).toLocaleString();
    $('lan-probe-status').textContent=data.probe_enabled?'Enabled':'Disabled';
    $('lan-last-sync').textContent=sync.last_success_at||'—';
    $('lan-new-records').textContent=sync.last_inserted==null?'—':String(sync.last_inserted);
    $('lan-sync-result').textContent=sync.latest_result||'Not yet synchronized';
    $('lan-sync-error').textContent=[data.configuration_error,sync.last_error,
      sync.connector_available?'':sync.connector_message].filter(Boolean).filter((value,index,items)=>items.indexOf(value)===index).join(' ');
    $('probe-lan').disabled=session.role!=='admin'||!data.probe_enabled;
    $('sync-connector').disabled=session.role!=='admin'||connectorReadPending;
}
async function refreshDeviceStatus({quiet=false,fresh=false}={}){
  // Keep one status request in flight. A manual read waits, then fetches fresh.
  while(deviceStatusRequest){
    await deviceStatusRequest;
    if(!fresh)return;
  }
  if(!deviceRefreshAllowed())return;
  const epoch=deviceRefreshEpoch,account=session;
  const controller=new AbortController();
  deviceStatusController=controller;
  const timeout=setTimeout(()=>controller.abort(),15000);
  const stillCurrent=()=>epoch===deviceRefreshEpoch && session===account && deviceRefreshAllowed();
  const request=(async()=>{
    try{
      const data=await api('/api/device/status',{signal:controller.signal,cache:'no-store'});
      if(!stillCurrent())return;
      renderDeviceStatus(data);
      deviceRefreshMessage('Status updates automatically every 5 seconds.');
    }catch(error){
      if(!stillCurrent())return;
      deviceRefreshMessage('Live status temporarily unavailable. Retrying automatically.');
      if(!quiet)toast(error.name==='AbortError'?'Status request timed out. Retrying automatically.':error.message,true);
    }
  })();
  deviceStatusRequest=request;
  try{await request;}
  finally{
    clearTimeout(timeout);
    if(deviceStatusRequest===request)deviceStatusRequest=null;
    if(deviceStatusController===controller)deviceStatusController=null;
  }
}
async function loadDevice(){
  const epoch=deviceRefreshEpoch,account=session;
  try{
    await refreshDeviceStatus({fresh:true});
    if(epoch!==deviceRefreshEpoch || session!==account || currentPage!=='staff')return;
    const codes=await api('/api/work-codes');
    if(epoch!==deviceRefreshEpoch || session!==account || currentPage!=='staff')return;
    workCodeRows=codes.items;
    $('code-rows').innerHTML=codes.items.length?codes.items.map(row=>
      '<tr><td>'+esc(row.device_id)+'</td><td><span class="code-pill">'+esc(row.work_code)+'</span></td>'+
      '<td>'+esc(row.activity_type)+'</td><td><span class="direction-pill '+(row.direction==='IN'?'direction-in':row.direction==='OUT'?'direction-out':'direction-unmapped')+'">'+esc(row.direction||'Unspecified')+'</span></td><td>'+esc(row.label||'Unmapped')+'</td>'+
      '<td>'+Number(row.scan_count||0)+'</td>'+
      '<td>'+(session.role==='admin'?'<button class="text-link" type="button" data-map-code="'+
      esc(row.device_id)+'|'+esc(row.work_code)+'">Edit mapping</button>':'')+'</td></tr>'
    ).join(''):'<tr><td colspan="7">Import a biometric log to discover device work codes.</td></tr>';
  }catch(error){toast(error.message,true);}
}
async function syncConnector(){
  if(connectorReadPending)return;
  connectorReadPending=true;
  $('sync-connector').disabled=true;
  try{
    const data=await api('/api/device/sync',{method:'POST'});
    const added=data.records_inserted;
    toast(added===0?'Success — No new records':'Success — '+added+' new record'+(added===1?'':'s')+'.');
    await loadDevice();
  }catch(error){
    toast(error.message,true);
    try{await loadDevice();}catch(_){}
  }finally{connectorReadPending=false;$('sync-connector').disabled=session?.role!=='admin';}
}
async function probeDevice(){
  $('probe-lan').disabled=true;
  try{
    const data=await api('/api/device/probe',{method:'POST'});
    $('lan-message').textContent=data.detail;
    toast(data.detail, data.result==='tcp_unconfirmed');
  }catch(error){toast(error.message,true);}
  finally{$('probe-lan').disabled=session.role!=='admin';}
}
function uploadBody(file){const form=new FormData();form.append('file',file);return form;}
async function processUsb(previewOnly){
  const file=$('usb-file').files[0];
  if (!file){toast('Select a USB attendance file first.',true);return;}
  if (file.size>2*1024*1024){toast('File is larger than 2 MB.',true);return;}
  if (!previewOnly && !usbPreviewOkay){toast('Preview the file before importing.',true);return;}
  const busyDialog=$('attendance-import-dialog');
  if(busyDialog.getAttribute('aria-busy')==='true')return;
  busyDialog.setAttribute('aria-busy','true');
  try{
    const result=await api(previewOnly?'/api/imports/preview':'/api/imports',
      {method:'POST',body:uploadBody(file)});
    const output=$('usb-result');
    output.classList.remove('hidden');
    output.className='upload-result '+(previewOnly?'import-preview':'import-success');
    if (previewOnly){
      usbPreviewOkay=result.format==='source'&&!result.already_imported;
      if(result.already_imported)output.className='upload-result import-warning';
      output.textContent=result.format==='report'
        ?'Excel report preview only. It cannot create raw scan events. Use the staff import for names.'
        :'Preview: '+result.rows+' scans · '+result.employees+' IDs · '+result.earliest+' to '+result.latest+
         (result.already_imported?' · File already imported':'');
    }else{
      output.textContent='Merge complete · '+result.inserted+' new scans added · '+result.duplicates+' duplicate scans skipped.';
      usbPreviewOkay=false;
      toast('Attendance import completed.');loadRegister();
    }
  }catch(error){toast(error.message,true);}
  finally{busyDialog.removeAttribute('aria-busy');}
}
async function processRoster(previewOnly){
  const file=$('roster-file').files[0];
  if (!file){toast('Select a staff file first.',true);return;}
  if (file.name.toLowerCase().includes('fp10')){toast('Do not upload fingerprint templates.',true);return;}
  if (!previewOnly && !rosterPreviewOkay){toast('Preview the staff file first.',true);return;}
  const busyDialog=$('user-import-dialog');
  if(busyDialog.getAttribute('aria-busy')==='true')return;
  busyDialog.setAttribute('aria-busy','true');
  try{
    const result=await api(previewOnly?'/api/employees/import/preview':'/api/employees/import',
      {method:'POST',body:uploadBody(file)});
    const output=$('roster-result');
    output.classList.remove('hidden');
    rosterPreviewOkay=previewOnly;
    output.className='upload-result '+(previewOnly?'import-preview':'import-success');
    output.textContent=(previewOnly?'Preview':'User sync complete')+': '+result.total+
      ' staff · New '+result.counts.new+' · Fill '+result.counts.fill+
      ' · Conflicts '+result.counts.conflict+' (not overwritten)';
    if(!previewOnly){rosterPreviewOkay=false;toast('Device user names synchronized from file.');}
  }catch(error){toast(error.message,true);}
  finally{busyDialog.removeAttribute('aria-busy');}
}
function updateCodeDirectionVisibility(){
  const permitted=['AJA','Travel Order'].includes($('code-activity').value);
  $('code-direction-field').classList.toggle('hidden',!permitted);
  $('code-direction-help').classList.toggle('hidden',!permitted);
  if(!permitted)$('code-direction').value='Unspecified';
}
function openCodeEditor(device,code){
  const saved=workCodeRows.find(row=>row.device_id===device && row.work_code===code);
  $('code-device').value=device;
  $('code-number').value=code;
  $('code-label').value=saved?.label||'';
  $('code-activity').value=saved?.activity_type||'Unclassified';
  $('code-direction').value=saved?.direction||'Unspecified';
  updateCodeDirectionVisibility();
  $('code-dialog').showModal();
}
async function saveCode(event){
  event.preventDefault();
  const device=$('code-device').value,code=$('code-number').value;
  const busyDialog=$('code-dialog');
  if(busyDialog.getAttribute('aria-busy')==='true')return;
  busyDialog.setAttribute('aria-busy','true');
  try{
    await api('/api/work-codes/'+encodeURIComponent(device)+'/'+encodeURIComponent(code),{
      method:'PUT',body:JSON.stringify({
        label:$('code-label').value,
        activity_type:$('code-activity').value,
        direction:$('code-direction').value
      })
    });
    $('code-dialog').close();toast('IN/OUT code mapping saved locally. K14 device unchanged.');loadDevice();
    if(selectedEmployee && currentPage==='employees')void loadDetail({quiet:true});
  }catch(error){toast(error.message,true);}
  finally{busyDialog.removeAttribute('aria-busy');}
}
const attendanceMonthNames=Array.from({length:12},(_,i)=>new Intl.DateTimeFormat('en-US',{month:'short',timeZone:'UTC'}).format(new Date(Date.UTC(2020,i,1))));
const attendanceMonthFull=new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
function setAttendanceMonth(id,value){
  const input=$(id);
  input.value=value;
  const selected=input.value||currentMonth();
  const [year,month]=selected.split('-').map(Number);
  const text=attendanceMonthFull.format(new Date(Date.UTC(year,month-1,1)));
  const trigger=$(id+'-trigger');
  trigger.querySelector('.month-trigger-value').textContent=text;
  trigger.setAttribute('aria-label','Reporting month: '+text);
}
function initializeAttendanceMonthPicker(){
  const dialog=$('attendance-month-picker'),grid=$('month-picker-grid'),yearGrid=$('month-year-grid'),yearTrigger=$('month-year-trigger');
  const minYear=1900,maxYear=2100,yearsPerPage=12;
  let target=null,year=0,anchor=null,yearMode=false,yearPage=minYear;
  const pageFor=value=>minYear+Math.floor((value-minYear)/yearsPerPage)*yearsPerPage;
  function render(){
    $('month-year-value').textContent=String(year);
    yearTrigger.setAttribute('aria-expanded',String(yearMode));
    yearTrigger.setAttribute('aria-label',yearMode?'Return to month selection':'Choose year: '+year);
    $('month-year-prev').setAttribute('aria-label',yearMode?'Previous years':'Previous year');
    $('month-year-next').setAttribute('aria-label',yearMode?'Next years':'Next year');
    $('month-year-prev').disabled=yearMode?yearPage<=minYear:year<=minYear;
    $('month-year-next').disabled=yearMode?yearPage+yearsPerPage>maxYear:year>=maxYear;
    grid.hidden=yearMode;yearGrid.hidden=!yearMode;
    if(yearMode){
      yearGrid.replaceChildren(...Array.from({length:Math.min(yearsPerPage,maxYear-yearPage+1)},(_,index)=>{
        const value=yearPage+index,b=document.createElement('button');
        b.type='button';b.textContent=String(value);b.dataset.yearValue=String(value);
        b.setAttribute('aria-pressed',String(value===year));return b;
      }));
      return;
    }
    const current=currentMonth(),selected=$(target).value;
    grid.replaceChildren(...attendanceMonthNames.map((name,index)=>{
      const value=String(year)+'-'+String(index+1).padStart(2,'0');
      const b=document.createElement('button');b.type='button';b.textContent=name;
      b.dataset.monthValue=value;b.setAttribute('aria-pressed',String(value===selected));
      b.setAttribute('aria-label',attendanceMonthFull.format(new Date(Date.UTC(year,index,1))));
      if(value===current)b.classList.add('is-current');
      return b;
    }));
  }
  function position(){
    if(!anchor||!dialog.open)return;
    const rect=anchor.getBoundingClientRect(),width=dialog.offsetWidth,height=dialog.offsetHeight;
    const left=Math.max(8,Math.min(rect.left,innerWidth-width-8));
    const top=rect.bottom+height+16<=innerHeight?rect.bottom+8:Math.max(8,rect.top-height-8);
    dialog.style.left=left+'px';dialog.style.top=top+'px';
  }
  function focusGrid(active){
    (active.querySelector('[aria-pressed="true"]')||active.firstElementChild)?.focus();
  }
  function switchMode(next){
    yearMode=next;if(next)yearPage=pageFor(year);
    render();position();focusGrid(next?yearGrid:grid);
  }
  function choose(value){
    if(!target)return;
    const id=target,previous=$(id).value;
    setAttendanceMonth(id,value);dialog.close();
    if($(id).value!==previous)$(id).dispatchEvent(new Event('change',{bubbles:true}));
  }
  document.querySelectorAll('[data-month-target]').forEach(b=>b.addEventListener('click',()=>{
    target=b.dataset.monthTarget;anchor=b;year=Number(($(target).value||currentMonth()).slice(0,4));
    yearMode=false;render();anchor.setAttribute('aria-expanded','true');dialog.showModal();position();
    focusGrid(grid);
  }));
  yearTrigger.addEventListener('click',()=>switchMode(!yearMode));
  grid.addEventListener('click',e=>{const b=e.target.closest('[data-month-value]');if(b)choose(b.dataset.monthValue);});
  yearGrid.addEventListener('click',e=>{const b=e.target.closest('[data-year-value]');if(b){year=Number(b.dataset.yearValue);switchMode(false);}});
  for(const active of [grid,yearGrid])active.addEventListener('keydown',e=>{
    const buttons=[...active.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);
    const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-4,ArrowDown:4}[e.key];
    if(i>=0&&delta!==undefined){e.preventDefault();buttons[(i+delta+buttons.length)%buttons.length].focus();}
  });
  function step(direction){
    if(yearMode){
      const next=yearPage+direction*yearsPerPage;
      if(next>=minYear&&next<=maxYear){yearPage=next;render();position();}
    }else if(year+direction>=minYear&&year+direction<=maxYear){year+=direction;render();position();}
  }
  $('month-year-prev').addEventListener('click',()=>step(-1));
  $('month-year-next').addEventListener('click',()=>step(1));
  dialog.addEventListener('cancel',e=>{if(yearMode){e.preventDefault();switchMode(false);}});
  dialog.addEventListener('close',()=>{if(anchor){anchor.setAttribute('aria-expanded','false');if(anchor.getClientRects().length)anchor.focus();}target=null;anchor=null;});
  window.addEventListener('resize',position);
}
// A deliberate backdrop click dismisses a modal, never a click on its padding
// or a selection/drag that began inside it.
function initializeModalDismissal(){
  function outside(dialog,event){
    if(event.target!==dialog)return false;
    const r=dialog.getBoundingClientRect();
    return event.clientX<r.left||event.clientX>=r.right||event.clientY<r.top||event.clientY>=r.bottom;
  }
  document.querySelectorAll('dialog').forEach(dialog=>{
    let start=null,endOutside=false;
    const reset=()=>{start=null;endOutside=false;};
    dialog.addEventListener('pointerdown',event=>{
      reset();
      if(event.isPrimary&&event.button===0&&outside(dialog,event))
        start={id:event.pointerId,x:event.clientX,y:event.clientY};
    });
    dialog.addEventListener('pointerup',event=>{
      endOutside=!!start&&event.pointerId===start.id&&outside(dialog,event)&&
        Math.hypot(event.clientX-start.x,event.clientY-start.y)<=10;
    });
    dialog.addEventListener('pointercancel',reset);
    dialog.addEventListener('close',reset);
    dialog.addEventListener('click',event=>{
      const dismiss=dialog.open&&start&&endOutside&&outside(dialog,event);
      reset();
      if(!dismiss)return;
      if(dialog.matches('[aria-busy="true"]')||dialog.querySelector('[aria-busy="true"],#save-profile:disabled,#save-day-review:disabled,#save-calendar:disabled'))return;
      if(dialog.id==='dtr-preview-dialog')closeDtrPreview();
      else dialog.close();
    });
  });
}
async function initialize(){
  initializeAttendanceMonthPicker();
  initializeModalDismissal();
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)updateWorkspaceClock();
    if(document.hidden){
      stopDeviceRefresh();
      stopAttendanceRefresh();
    }else if(deviceRefreshAllowed()){
      startDeviceRefresh();
      void refreshDeviceStatus({quiet:true,fresh:true});
    }
    if(!document.hidden && session && currentPage==='employees'){
      startAttendanceRefresh();
      if(!document.querySelectorAll('dialog[open]').length){
        if(selectedEmployee)void loadDetail({quiet:true});else void loadRegister({quiet:true});
      }
    }
  });
  const clockDate = new Intl.DateTimeFormat('en-PH',{
    weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Manila'
  });
  const clockTime = new Intl.DateTimeFormat('en-PH',{
    hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true,timeZone:'Asia/Manila'
  });
  function updateWorkspaceClock(){
    const now=new Date();
    setTextIfChanged($('today'),clockDate.format(now));
    setTextIfChanged($('live-time'),clockTime.format(now));
    setAttrIfChanged($('live-time'),'datetime',now.toISOString());
  }
  updateWorkspaceClock();
  window.setInterval(updateWorkspaceClock,1000);
  $('login-form').addEventListener('submit',async event=>{
    event.preventDefault();
    $('login-error').classList.add('hidden');
    $('login-submit').disabled=true;
    try{
      session=await api('/api/login',{method:'POST',body:JSON.stringify({
        username:$('login-username').value,password:$('login-password').value
      })});
      $('login-form').reset();showApp();
    }catch(error){
      $('login-error').textContent=error.message;$('login-error').classList.remove('hidden');
    }finally{$('login-submit').disabled=false;}
  });
  const signOut=async()=>{
    try{await api('/api/logout',{method:'POST'});session=null;showLogin();}
    catch(error){toast(error.message,true);}
  };
  $('logout-sidebar').addEventListener('click',signOut);
  document.querySelectorAll('[data-page],[data-go]').forEach(node=>
    node.addEventListener('click',()=>navigate(node.dataset.page||node.dataset.go)));
  $('employee-filter').addEventListener('submit',e=>{e.preventDefault();applyRegisterFilters();});
  document.querySelectorAll('[data-live-filter]').forEach(button=>button.addEventListener('click',()=>{
    liveFilter=button.dataset.liveFilter;
    $('employee-search').value='';
    updateRegisterSearchControl();
    renderRegister();
    $('attendance-register-panel').querySelector('.table-wrap').scrollTop=0;
  }));
  const kpiStrip=document.querySelector('.live-kpi-strip');
  kpiStrip.addEventListener('wheel',e=>{
    if(kpiStrip.scrollWidth>kpiStrip.clientWidth && Math.abs(e.deltaY)>Math.abs(e.deltaX)){
      e.preventDefault();
      kpiStrip.scrollLeft+=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?kpiStrip.clientWidth:1);
    }
  },{passive:false});
  $('employee-search').addEventListener('input',()=>applyRegisterFilters({debounce:true}));
  $('clear-employee-search').addEventListener('click',()=>{$('employee-search').value='';applyRegisterFilters();$('employee-search').focus();});
  $('register-month').addEventListener('change',()=>applyRegisterFilters());
  $('open-profile').addEventListener('click',()=>openProfile());
  $('close-profile').addEventListener('click',()=>$('profile-dialog').close());
  $('cancel-profile').addEventListener('click',()=>$('profile-dialog').close());
  $('profile-dialog').addEventListener('close',()=>profileFormToken++);
  $('profile-form').addEventListener('submit',saveProfile);
  $('profile-filter').addEventListener('submit',event=>{event.preventDefault();profilePage=1;loadProfiles();});
  document.querySelectorAll('[data-profile-category]').forEach(node=>node.addEventListener('click',()=>{
    profileCategory=node.dataset.profileCategory;profilePage=1;loadProfiles();
  }));
  $('profile-prev').addEventListener('click',()=>{profilePage--;loadProfiles();});
  $('profile-next').addEventListener('click',()=>{profilePage++;loadProfiles();});
  $('profile-rows').addEventListener('click',event=>{
    const button=event.target.closest('[data-edit-profile]');if(button)openProfile(button.dataset.editProfile);
  });
  $('register-rows').addEventListener('click',e=>{
    const row=e.target.closest('[data-employee]');if(row)openEmployee(row.dataset.employee);
  });
  $('register-rows').addEventListener('keydown',e=>{
    const row=e.target.closest('tr[data-employee]');
    if(row && (e.key==='Enter'||e.key===' ')){e.preventDefault();openEmployee(row.dataset.employee);}
  });
  $('back-to-register').addEventListener('click',()=>{
    $('employee-detail').classList.add('hidden');selectedEmployee=null;activeDtr=null;detailRequest++;
    $('back-to-register').classList.add('hidden');
    $('attendance-register-panel').classList.remove('hidden');
    void loadRegister({quiet:true});
  });
  initDtrPreview();
  $('dtr-form-preview').addEventListener('click',openDtrFormPreview);
  $('detail-month').addEventListener('change',()=>{setAttendanceMonth('register-month',$('detail-month').value);loadDetail();});
  $('daily-rows').addEventListener('click',event=>{
    const button=event.target.closest('[data-edit-day]');if(button)openDayReview(button.dataset.editDay);
  });
  $('day-review-form').addEventListener('submit',saveDayReview);
  $('close-day-review').addEventListener('click',()=>$('day-review-dialog').close());
  $('cancel-day-review').addEventListener('click',()=>$('day-review-dialog').close());
  $('day-review-dialog').addEventListener('close',()=>{closeClockPicker();dayReviewContext=null;});
  document.querySelectorAll('[data-clock-pick]').forEach(button=>button.addEventListener('click',()=>openClockPicker(button.dataset.clockPick)));
  REVIEW_CLOCKS.forEach(key=>{
    const input=clockInput(key);
    input.addEventListener('input',()=>{input.setCustomValidity('');});
    input.addEventListener('blur',()=>{const value=normalizedClock(input.value);if(value!==null)input.value=value;});
  });
  document.querySelectorAll('[data-clock-step]').forEach(button=>button.addEventListener('click',()=>{
    const part=button.dataset.clockStep,node=$('picker-'+part),limit=part==='hour'?24:60;
    const value=Number(node.value)||0;
    node.value=String((value+Number(button.dataset.delta)+limit)%limit).padStart(2,'0');
  }));
  $('clock-picker-close').addEventListener('click',closeClockPicker);
  $('clock-picker-apply').addEventListener('click',()=>applyClockPicker());
  $('clock-picker-clear').addEventListener('click',()=>applyClockPicker(true));
  $('open-calendar')?.addEventListener('click',openCalendar);
  $('calendar-date').addEventListener('change',calendarDateChanged);
  $('calendar-form').addEventListener('submit',saveCalendar);
  $('close-calendar').addEventListener('click',()=>$('calendar-dialog').close());
  $('cancel-calendar').addEventListener('click',()=>$('calendar-dialog').close());
  $('activity-filter').addEventListener('submit',e=>{e.preventDefault();loadActivities();});
  $('activity-rows').addEventListener('click',e=>{
    const node=e.target.closest('[data-monitor-employee]');
    if(node) viewActivityEmployee(node.dataset.monitorEmployee);
  });
  $('open-attendance-import').addEventListener('click',()=>{
    $('usb-form').reset();$('usb-file-name').textContent='No file selected';
    usbPreviewOkay=false;$('usb-result').classList.add('hidden');
    $('attendance-import-dialog').showModal();
  });
  $('close-attendance-import').addEventListener('click',()=>$('attendance-import-dialog').close());
  $('open-user-import').addEventListener('click',()=>{
    $('roster-form').reset();$('roster-file-name').textContent='No file selected';
    rosterPreviewOkay=false;$('roster-result').classList.add('hidden');
    $('user-import-dialog').showModal();
  });
  $('close-user-import').addEventListener('click',()=>$('user-import-dialog').close());
  $('toggle-password').addEventListener('click',()=>{
    const input=$('login-password'),btn=$('toggle-password');
    const visible=input.type==='password';
    input.type=visible?'text':'password';
    btn.setAttribute('aria-pressed',String(visible));
    btn.setAttribute('aria-label',visible?'Hide password':'Show password');
  });
  $('usb-file').addEventListener('change',()=>{
    usbPreviewOkay=false;$('usb-result').classList.add('hidden');
    $('usb-file-name').textContent=$('usb-file').files[0]?.name||'No file selected';
  });
  $('usb-preview').addEventListener('click',()=>processUsb(true));
  $('usb-form').addEventListener('submit',e=>{e.preventDefault();processUsb(false);});
  $('roster-file').addEventListener('change',()=>{
    rosterPreviewOkay=false;$('roster-result').classList.add('hidden');
    $('roster-file-name').textContent=$('roster-file').files[0]?.name||'No file selected';
  });
  $('roster-preview').addEventListener('click',()=>processRoster(true));
  $('roster-form').addEventListener('submit',e=>{e.preventDefault();processRoster(false);});
  $('probe-lan').addEventListener('click',probeDevice);
  $('sync-connector').addEventListener('click',syncConnector);
  $('code-rows').addEventListener('click',e=>{
    const node=e.target.closest('[data-map-code]');if(!node)return;
    const [device,code]=node.dataset.mapCode.split('|');openCodeEditor(device,code);
  });
  $('code-activity').addEventListener('change',updateCodeDirectionVisibility);
  $('close-code').addEventListener('click',()=>$('code-dialog').close());
  $('code-form').addEventListener('submit',saveCode);
  try{session=await api('/api/me');showApp();}
  catch(_){session=null;showLogin();}
}
document.addEventListener('DOMContentLoaded',initialize);
