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
const titles = {
  employees:'Employee Attendance',
  activities:'AJA / Travel Orders',
  staff:'Staff Management'
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
  $('register-month').value=currentMonth();
  $('detail-month').value=currentMonth();
  $('activity-month').value=currentMonth();
  navigate('employees');
}
function navigate(page){
  if (!session || !titles[page]) return;
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
  if (page==='employees') return loadRegister();
  if (page==='activities') return loadActivities();
  if (page==='staff') return loadDevice();
}
async function loadRegister(){
  const serial=++requestSerial;
  const month=$('register-month').value||currentMonth();
  const q=$('employee-search').value.trim();
  $('register-rows').innerHTML='<tr><td colspan="4" class="table-empty">Loading attendance register…</td></tr>';
  try {
    const result=await api('/api/employee-register?'+new URLSearchParams({month,q}));
    if (serial!==requestSerial||currentPage!=='employees') return;
    lastEmployeeRows=result.items;
    $('register-count').textContent=result.items.length+' employee'+(result.items.length===1?'':'s')+' found';
    $('register-rows').innerHTML=result.items.length?result.items.map(row=>
      '<tr class="click-row" tabindex="0" role="button" data-employee="'+esc(row.employee_code)+'">'+
      '<td class="id-cell">'+esc(row.employee_code)+'</td>'+
      '<td class="employee-name-cell">'+esc(row.display_name||'Name not synchronized')+'</td>'+
      '<td>'+esc(row.department||'—')+'</td>'+
      '<td><button type="button" class="text-link row-action" data-employee="'+esc(row.employee_code)+'">View attendance <span aria-hidden="true">→</span></button></td>'+
      '</tr>'
    ).join(''):'<tr><td colspan="4" class="table-empty">No employees found. Try a different name, ID, or month.</td></tr>';
  }catch(error){
    $('register-rows').innerHTML='<tr><td colspan="4" class="table-empty">Unable to load employee attendance.</td></tr>';
    toast(error.message,true);
  }
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
  await loadDetail();
  $('employee-detail').scrollIntoView({block:'start',behavior:'smooth'});
}
function fullDayTravel(day){
  // The activity is an existing office reference, not proof of credited hours.
  const from=day.date+' 00:00:00';
  const to=new Date(day.date+'T12:00:00+08:00');
  to.setUTCDate(to.getUTCDate()+1);
  const end=to.toISOString().slice(0,10)+' 00:00:00';
  return day.activities.some(a=>
    a.category==='Travel Order' && a.start_at<=from && a.end_at>=end);
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
function buildDtrSheet(){
  if (!activeDtr) return;
  const fmt=new Intl.DateTimeFormat('en-PH',{year:'numeric',month:'long',timeZone:'Asia/Manila'});
  const monthName=fmt.format(new Date(activeDtr.month+'-15T12:00:00+08:00'));
  const rows=activeDtr.days.map(day=>{
    const travel=day.activities.filter(x=>x.category==='Travel Order');
    const aja=day.activities.filter(x=>x.category==='AJA');
    const other=day.activities.filter(x=>x.category!=='Travel Order'&&x.category!=='AJA');
    // No conversion of an unidentified K14 scan into official AM/PM slots.
    const remarks=travel.length
      ?'OFFICIAL TRAVEL'+(travel[0].reference?' · '+travel[0].reference:'')
      :aja.length
        ?'AJA '+aja.map(x=>x.start_at.slice(11,16)+'–'+x.end_at.slice(11,16)).join(', ')
        :other.length
          ?other.map(x=>x.category).join(', ')
          :day.scans.length?'Scans: '+day.scans.map(x=>x.happened_at.slice(11,16)).join(', '):'';
    const full=travel.length>0;
    return '<tr class="'+(full?'to-row':'')+'"><td>'+esc(day.date.slice(8))+'</td>'+
      '<td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>'+
      '<td>'+esc(remarks)+'</td></tr>';
  }).join('');
  $('print-sheet').innerHTML=
    '<header class="dtr-header"><small>REPUBLIC OF THE PHILIPPINES</small><p>Civil Service Form No. 48 · Review layout</p>'+
    '<h2>DAILY TIME RECORD</h2></header>'+
    '<div class="dtr-keyline"><div><span>Name: <b>'+esc(selectedName)+'</b></span><span>Employee ID: '+esc(selectedEmployee)+'</span></div>'+
    '<div><span>Month: '+esc(monthName)+'</span><span>Office: NCSC</span></div></div>'+
    '<table class="dtr-table"><thead><tr><th rowspan="2">Day</th><th colspan="2">AM</th><th colspan="2">PM</th>'+
    '<th colspan="2">Undertime</th><th rowspan="2">Remarks / reference</th></tr>'+
    '<tr><th>In</th><th>Out</th><th>In</th><th>Out</th><th>Hours</th><th>Min.</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table>'+
    '<div class="dtr-warning"><b>REVIEW COPY — NOT AN OFFICIAL CERTIFIED DTR.</b> Original device scans are not yet verified as AM/PM In or Out. Blank cells are intentional. Official Travel references are displayed instead of fabricated clock times. HR must validate activity coverage, attendance codes, undertime rules, signatures and the approved Form 48 template before certification.</div>'+
    '<div class="dtr-footer"><div>Employee signature / certification</div><div>Authorized official / verifier</div></div>';
}
function openDtr(print=false){
  if (!selectedEmployee || !activeDtr){toast('Open an employee record first.',true);return;}
  buildDtrSheet();
  if (!$('dtr-dialog').open) $('dtr-dialog').showModal();
  if (print) window.print();
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
async function loadDevice(){
  try{
    const data=await api('/api/device/status');
    $('lan-ip').textContent=data.host;
    $('lan-port').textContent=data.port;
    $('lan-sync').textContent=data.sync_enabled?'Enabled':'Not active';
    $('lan-badge').textContent=data.sync_enabled?'Connected':'Not synchronized';
    $('lan-message').textContent=data.message;
    $('probe-lan').disabled=session.role!=='admin';
    const codes=await api('/api/work-codes');
    $('code-rows').innerHTML=codes.items.length?codes.items.map(row=>
      '<tr><td>'+esc(row.device_id)+'</td><td><span class="code-pill">'+esc(row.work_code)+'</span></td>'+
      '<td>'+esc(row.activity_type)+'</td><td>'+esc(row.label||'Unmapped')+'</td>'+
      '<td>'+Number(row.scan_count||0)+'</td>'+
      '<td>'+(session.role==='admin'?'<button class="text-link" type="button" data-map-code="'+
      esc(row.device_id)+'|'+esc(row.work_code)+'">Edit label</button>':'')+'</td></tr>'
    ).join(''):'<tr><td colspan="6">Import a biometric log to discover device work codes.</td></tr>';
  }catch(error){toast(error.message,true);}
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
    e.preventDefault();$('employee-detail').classList.add('hidden');selectedEmployee=null;activeDtr=null;loadRegister();
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
    $('employee-filter').scrollIntoView({block:'start',behavior:'smooth'});
  });
  $('detail-month').addEventListener('change',loadDetail);
  $('preview-dtr').addEventListener('click',()=>openDtr(false));
  $('export-dtr').addEventListener('click',()=>openDtr(true));
  $('close-dtr').addEventListener('click',()=>$('dtr-dialog').close());
  $('print-dtr').addEventListener('click',()=>window.print());
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
