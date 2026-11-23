'use strict';
/* NCSC records-first UI. All information comes from authenticated same-origin APIs. */
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
let session = null;
let currentPage = 'overview';
let selectedEmployee = null;
let selectedName = '';
let selectedDepartment = '';
let activeDtr = null;
let lastEmployeeRows = [];
let toastTimer = null;
let requestSerial = 0;
let rosterPreviewOkay = false;
let usbPreviewOkay = false;
let connectorReadPending = false;
const EMPLOYEE_PAGE_SIZE = 15;
let registerPage = 1;
let profilePage = 1;
let profileCategory = 'All';
let profileRequest = 0;
let profileFormToken = 0;
let profileEditing = null;
let profileVersion = null;
const DEVICE_REFRESH_MS = 5000;
let deviceRefreshTimer = null;
let deviceRefreshEpoch = 0;
let deviceStatusRequest = null;
let deviceStatusController = null;
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
  $('account').textContent=session.username;
  const canWrite=session.role==='admin';
  document.querySelectorAll('#usb-form button,#roster-form button')
    .forEach(el=>el.disabled=!canWrite);
  $('open-attendance-import').disabled=!canWrite;
  $('open-user-import').disabled=!canWrite;
  $('open-profile').disabled=!canWrite;
  $('register-from-attendance').disabled=!canWrite;
  $('register-month').value=currentMonth();
  $('detail-month').value=currentMonth();
  $('activity-month').value=currentMonth();
  navigate('employees');
}
function navigate(page){
  if (!session || !titles[page]) return;
  stopDeviceRefresh();
  currentPage=page;
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
    return loadRegister();
  }
  if (page==='profiles') return loadProfiles();
  if (page==='activities') return loadActivities();
  if (page==='staff') {startDeviceRefresh();return loadDevice();}
}
async function loadRegister(){
  const serial=++requestSerial;
  const month=$('register-month').value||currentMonth();
  const q=$('employee-search').value.trim();
  $('register-rows').innerHTML='<tr><td colspan="5" class="table-empty">Loading attendance register…</td></tr>';
  try {
    const result=await api('/api/employee-register?'+new URLSearchParams({month,q}));
    if (serial!==requestSerial||currentPage!=='employees') return;
    lastEmployeeRows=result.items;
    renderRegister();
  }catch(error){
    $('register-rows').innerHTML='<tr><td colspan="5" class="table-empty">Unable to load employee attendance.</td></tr>';
    toast(error.message,true);
  }
}
function categoryBadge(value){
  const kind={COS:'cos',Permanent:'permanent',GIP:'gip',OJT:'ojt'}[value];
  return '<span class="tag tag-'+(kind||'neutral')+'">'+esc(value||'Not set')+'</span>';
}
function employeeCell(row){
  const name=row.display_name||'Name not verified';
  return '<div class="employee-cell"><span class="name-avatar" aria-hidden="true">'+esc(name.slice(0,1).toUpperCase())+
    '</span><span><strong>'+esc(name)+'</strong>'+(row.position?'<small>'+esc(row.position)+'</small>':'')+'</span></div>';
}
function renderRegister(){
    const total=lastEmployeeRows.length,pages=Math.max(1,Math.ceil(total/EMPLOYEE_PAGE_SIZE));
    registerPage=Math.max(1,Math.min(registerPage,pages));
    const start=(registerPage-1)*EMPLOYEE_PAGE_SIZE;
    const rows=lastEmployeeRows.slice(start,start+EMPLOYEE_PAGE_SIZE);
    $('register-count').textContent=total?('Showing '+(start+1)+'–'+Math.min(start+EMPLOYEE_PAGE_SIZE,total)+' of '+total+' employees'):'No employees found';
    $('register-page').textContent='Page '+registerPage+' of '+pages;
    $('register-prev').disabled=registerPage===1;$('register-next').disabled=registerPage===pages;
    $('register-rows').innerHTML=rows.length?rows.map(row=>
      '<tr class="click-row" tabindex="0" role="button" data-employee="'+esc(row.employee_code)+'">'+
      '<td class="id-cell">'+esc(row.employee_code)+'</td>'+
      '<td class="employee-name-cell">'+employeeCell(row)+'</td>'+
      '<td>'+categoryBadge(row.employment_type)+'</td>'+
      '<td>'+esc(row.department||'—')+'</td>'+
      '<td><button type="button" class="text-link row-action" data-employee="'+esc(row.employee_code)+'">View attendance <span aria-hidden="true">→</span></button></td>'+
      '</tr>'
    ).join(''):'<tr><td colspan="5" class="table-empty">No employees found. Register an employee or adjust your search.</td></tr>';
}
async function openEmployee(code){
  if (!code) return;
  selectedEmployee=code;
  const row=lastEmployeeRows.find(x=>x.employee_code===code);
  selectedName=row?.display_name||'Employee '+code;
  selectedDepartment=row?.department||'';
  $('detail-name').textContent=selectedName;
  $('detail-id').textContent='Device employee ID: '+code;
  $('detail-department').textContent=selectedDepartment?' · '+selectedDepartment:'';
  $('detail-month').value=$('register-month').value;
  $('employee-detail').classList.remove('hidden');
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
      '<tr><td class="id-cell">'+esc(row.employee_code)+'</td><td>'+employeeCell(row)+'</td><td>'+categoryBadge(row.employment_type)+'</td><td>'+esc(row.department||'—')+'</td>'+
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
    await navigate('profiles');
  }catch(error){
    if(session===account){$('profile-error').textContent=error.message;$('profile-error').classList.remove('hidden');}
  }finally{$('save-profile').disabled=false;}
}
function statusForDay(day){
  if (day.activities.some(x=>x.category==='Travel Order')) return '<span class="pill-neutral pill-to">Official Travel reference</span>';
  if (day.activities.some(x=>x.category==='AJA')) return '<span class="pill-neutral pill-aja">AJA reference</span>';
  if (day.scans.length) return '<span class="pill-neutral pill-regular">Biometric scans</span>';
  return '<span class="empty-cell">No records / for review</span>';
}
function timeList(scans){
  if (!scans.length) return '<span class="empty-cell">—</span>';
  return '<div class="scan-tags">'+scans.map(x=>
    '<span class="scan-tag" title="'+esc('Device '+x.device_id+' · status '+x.status_code+' · work code '+x.work_code)+'">'+
    esc(x.happened_at.slice(11,16))+'</span>').join('')+'</div>';
}
function activityList(activities){
  if (!activities.length) return '<span class="empty-cell">—</span>';
  return activities.map(x=>'<span class="ref-line"><strong>'+esc(x.category)+'</strong>'+
    (x.reference?' · '+esc(x.reference):'')+
    (x.category==='AJA'?' · '+esc(x.start_at.slice(11,16))+'–'+esc(x.end_at.slice(11,16)):'')+
    '</span>').join('');
}
async function loadDetail(){
  if (!selectedEmployee) return;
  const month=$('detail-month').value||currentMonth();
  const code=selectedEmployee;
  $('daily-rows').innerHTML='<tr><td colspan="4">Loading daily records…</td></tr>';
  try{
    const data=await api('/api/dtr/monitor?'+new URLSearchParams({employee_code:code,month}));
    if (code!==selectedEmployee || month!==$('detail-month').value) return;
    activeDtr=data;
    $('detail-summary').textContent=month+' · '+data.summary.scans+' actual scans · '+data.summary.activity_records+' activity references';
    $('daily-rows').innerHTML=data.days.map(day=>
      '<tr><td>'+esc(day.date.slice(8))+' '+esc(day.day)+'</td><td>'+timeList(day.scans)+'</td>'+
      '<td>'+activityList(day.activities)+'</td><td>'+statusForDay(day)+'</td></tr>'
    ).join('');
    const first=month+'-01';
    const last=data.days.at(-1).date;
    const events=await api('/api/punches?'+new URLSearchParams({employee_code:code,date_from:first,date_to:last,limit:'250'}));
    $('detail-events').innerHTML=events.items.length ? events.items.map(item=>
      '<tr><td>'+esc(item.happened_at)+'</td><td>'+esc(item.device_id)+'</td>'+
      '<td>'+esc(item.status_code)+'</td><td>'+esc(item.work_code)+(item.work_label?' · '+esc(item.work_label):'')+
      '</td><td>'+esc(item.verification_code)+'</td></tr>').join('') :
      '<tr><td colspan="5">No device events for this period.</td></tr>';
  }catch(error){
    $('daily-rows').innerHTML='<tr><td colspan="4">Could not load this employee’s monthly records.</td></tr>';
    toast(error.message,true);
  }
}
async function loadActivities(){
  const token=++activityRequest;
  const params=new URLSearchParams({
    month:$('activity-month').value||currentMonth(),
    category:$('activity-category').value,
    q:$('activity-search').value.trim()
  });
  $('activity-rows').innerHTML='<tr><td colspan="7" class="table-empty">Loading activity logs…</td></tr>';
  try{
    const data=await api('/api/activities/monitor?'+params);
    if(token!==activityRequest||currentPage!=='activities')return;
    const counts=data.summary;
    $('activity-counts').innerHTML=
      '<span><b>'+counts.employees+'</b> employees</span>'+
      '<span><b>'+counts.aja+'</b> AJA scans</span>'+
      '<span><b>'+counts.travel_orders+'</b> Travel Order scans</span>';
    $('activity-note').textContent=data.note;
    $('activity-rows').innerHTML=data.items.length?data.items.map(item=>{
      const instant=item.happened_at||'';
      const badge=item.category==='AJA'?'activity-aja':'activity-travel';
      return '<tr><td class="id-cell">'+esc(item.employee_code)+'</td>'+
        '<td class="employee-name-cell">'+esc(item.display_name||'Name not synchronized')+'</td>'+
        '<td><span class="activity-badge '+badge+'">'+esc(item.category)+'</span></td>'+
        '<td class="date-cell">'+esc(instant.slice(0,10))+'</td>'+
        '<td class="date-cell">'+esc(instant.slice(11,19))+'</td>'+
        '<td><span class="code-pill">'+esc(item.work_code)+'</span></td>'+
        '<td><button class="text-link row-action" type="button" data-monitor-employee="'+
          esc(item.employee_code)+'">View attendance <span aria-hidden="true">→</span></button></td></tr>';
    }).join(''):'<tr><td colspan="7" class="table-empty">No device-classified AJA or Travel Order scans found for these filters.</td></tr>';
  }catch(error){
    if(token!==activityRequest)return;
    $('activity-rows').innerHTML='<tr><td colspan="7" class="table-empty">Unable to load activity logs.</td></tr>';
    toast(error.message,true);
  }
}
async function viewActivityEmployee(code){
  $('employee-search').value=code;
  $('register-month').value=$('activity-month').value||currentMonth();
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
    $('lan-connector').textContent=sync.connector_available?'Available (local file)':'Unavailable';
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
    $('code-rows').innerHTML=codes.items.length?codes.items.map(row=>
      '<tr><td>'+esc(row.device_id)+'</td><td><span class="code-pill">'+esc(row.work_code)+'</span></td>'+
      '<td>'+esc(row.activity_type)+'</td><td>'+esc(row.label||'Unmapped')+'</td>'+
      '<td>'+Number(row.scan_count||0)+'</td>'+
      '<td>'+(session.role==='admin'?'<button class="text-link" type="button" data-map-code="'+
      esc(row.device_id)+'|'+esc(row.work_code)+'">Edit label</button>':'')+'</td></tr>'
    ).join(''):'<tr><td colspan="6">Import a biometric log to discover device work codes.</td></tr>';
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
}
async function processRoster(previewOnly){
  const file=$('roster-file').files[0];
  if (!file){toast('Select a staff file first.',true);return;}
  if (file.name.toLowerCase().includes('fp10')){toast('Do not upload fingerprint templates.',true);return;}
  if (!previewOnly && !rosterPreviewOkay){toast('Preview the staff file first.',true);return;}
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
}
function openCodeEditor(device,code){
  $('code-device').value=device;
  $('code-number').value=code;
  $('code-label').value='';
  $('code-activity').value='Unclassified';
  $('code-dialog').showModal();
}
async function saveCode(event){
  event.preventDefault();
  const device=$('code-device').value,code=$('code-number').value;
  try{
    await api('/api/work-codes/'+encodeURIComponent(device)+'/'+encodeURIComponent(code),{
      method:'PUT',body:JSON.stringify({label:$('code-label').value,activity_type:$('code-activity').value})
    });
    $('code-dialog').close();toast('Local code mapping saved. K14 device unchanged.');loadDevice();
  }catch(error){toast(error.message,true);}
}
async function initialize(){
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      stopDeviceRefresh();
    }else if(deviceRefreshAllowed()){
      startDeviceRefresh();
      void refreshDeviceStatus({quiet:true,fresh:true});
    }
  });
  $('today').textContent=new Intl.DateTimeFormat('en-PH',{
    day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Manila'
  }).format(new Date());
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
  $('logout').addEventListener('click',async()=>{
    try{await api('/api/logout',{method:'POST'});session=null;showLogin();}
    catch(error){toast(error.message,true);}
  });
  document.querySelectorAll('[data-page],[data-go]').forEach(node=>
    node.addEventListener('click',()=>navigate(node.dataset.page||node.dataset.go)));
  $('employee-filter').addEventListener('submit',e=>{
    e.preventDefault();registerPage=1;$('employee-detail').classList.add('hidden');selectedEmployee=null;activeDtr=null;loadRegister();
  });
  $('register-prev').addEventListener('click',()=>{registerPage--;renderRegister();});
  $('register-next').addEventListener('click',()=>{registerPage++;renderRegister();});
  $('open-profile').addEventListener('click',()=>openProfile());
  $('register-from-attendance').addEventListener('click',()=>openProfile());
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
    $('employee-detail').classList.add('hidden');selectedEmployee=null;activeDtr=null;
    $('attendance-register-panel').classList.remove('hidden');
  });
  $('detail-month').addEventListener('change',loadDetail);
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
  $('close-code').addEventListener('click',()=>$('code-dialog').close());
  $('code-form').addEventListener('submit',saveCode);
  try{session=await api('/api/me');showApp();}
  catch(_){session=null;showLogin();}
}
document.addEventListener('DOMContentLoaded',initialize);
