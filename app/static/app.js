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
  overview:['Overview','Attendance records and official activity monitoring'],
  employees:['Employee Records','Monthly scan history, AJA references and DTR preview'],
  activities:['Official Activities','Existing AJA and Travel Order records'],
  device:['Device & Imports','Connection status, USB backup and work-code mapping']
};
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
  $('login-username').focus();
}
function showApp(){
  $('login-view').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('account').textContent=session.username;
  $('register-month').value=currentMonth();
  $('detail-month').value=currentMonth();
  navigate('overview');
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
  $('section-name').textContent=titles[page][0];
  $('page-title').textContent=titles[page][0];
  $('page-description').textContent=titles[page][1];
  document.title=titles[page][0]+' | NCSC Records';
  window.history.replaceState(null,'','#'+page);
  if (page==='overview') loadOverview();
  if (page==='employees') loadRegister();
  if (page==='activities') loadActivities();
  if (page==='device') loadDevice();
}
async function loadOverview(){
  try{
    const data=await api('/api/overview');
    for (const key of ['employees','scans','activities','imports'])
      $('metric-'+key).textContent=Number(data.totals[key]||0).toLocaleString();
    $('recent-imports').innerHTML=data.recent_imports.length
      ?data.recent_imports.slice(0,5).map(row=>
        '<div><span>'+esc(row.original_name)+'</span><b>'+esc(row.inserted_records)+' scans</b></div>').join('')
      :'<span>No USB imports recorded.</span>';
    const lan=await api('/api/device/status');
    $('overview-device-status').textContent=lan.sync_enabled?'Automatic synchronization enabled':'LAN sync not yet active';
    $('overview-device-note').textContent='Configured '+lan.host+':'+lan.port+' · USB fallback available';
  }catch(error){toast(error.message,true);}
}
async function loadRegister(){
  const serial=++requestSerial;
  const month=$('register-month').value||currentMonth();
  const q=$('employee-search').value.trim();
  $('register-rows').innerHTML='<tr><td colspan="6">Loading employee register…</td></tr>';
  try{
    const result=await api('/api/employee-register?'+new URLSearchParams({month,q}));
    if (serial!==requestSerial || currentPage!=='employees') return;
    lastEmployeeRows=result.items;
    $('register-count').textContent=result.items.length+' employees · '+month+' · Actual scans only';
    $('register-rows').innerHTML=result.items.length ? result.items.map(row=>
      '<tr class="click-row" tabindex="0" role="button" data-employee="'+esc(row.employee_code)+'">'+
      '<td>'+esc(row.employee_code)+'</td><td><b>'+esc(row.display_name||'Name not synchronized')+'</b></td>'+
      '<td>'+esc(row.department||'—')+'</td><td>'+Number(row.scan_count)+'</td>'+
      '<td>'+esc(row.last_scan||'No scans this month')+'</td>'+
      '<td><button type="button" class="text-link" data-employee="'+esc(row.employee_code)+'">Open record →</button></td></tr>'
    ).join(''):'<tr><td colspan="6">No matching employees. Check the month or USB roster import.</td></tr>';
  }catch(error){$('register-rows').innerHTML='<tr><td colspan="6">Unable to load employee records.</td></tr>';toast(error.message,true);}
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
  try{
    const data=await api('/api/activities');
    $('activity-rows').innerHTML=data.items.length ? data.items.map(item=>
      '<tr><td>'+esc(item.employee_code)+'</td><td>'+esc(item.category)+'</td>'+
      '<td>'+esc(item.start_at)+' → '+esc(item.end_at)+'</td>'+
      '<td>'+esc(item.reference||item.purpose||'—')+'</td>'+
      '<td>'+esc(item.status)+'</td>'+
      '<td>'+(item.status==='recorded'&&session.role==='admin'?
      '<button class="text-link" type="button" data-void="'+Number(item.id)+'">Void</button>':'')+'</td></tr>'
    ).join(''):'<tr><td colspan="6">No activity records. Existing approved documents can be referenced here.</td></tr>';
  }catch(error){toast(error.message,true);}
}
async function submitActivity(event){
  event.preventDefault();
  const values={
    employee_code:$('activity-employee').value.trim(),
    category:$('activity-type').value,
    reference:$('activity-reference').value.trim(),
    purpose:$('activity-purpose').value.trim(),
    start_at:$('activity-start').value,
    end_at:$('activity-end').value
  };
  try{
    await api('/api/activities',{method:'POST',body:JSON.stringify(values)});
    $('activity-form').reset();
    toast('Existing office activity reference recorded.');
    loadActivities();
  }catch(error){toast(error.message,true);}
}
async function voidActivity(id){
  if (!Number.isInteger(id)) return;
  const reason=window.prompt('Reason for voiding this reference (minimum 3 characters):');
  if (reason===null) return;
  if (reason.trim().length<3){toast('Enter a reason of at least 3 characters.',true);return;}
  try{await api('/api/activities/'+id+'/void',{method:'POST',body:JSON.stringify({reason:reason.trim()})});
    toast('Reference voided. Original audit history retained.');loadActivities();
  }catch(error){toast(error.message,true);}
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
      '<tr><td>'+esc(row.device_id)+'</td><td><b>'+esc(row.work_code)+'</b></td>'+
      '<td>'+esc(row.label||'Unmapped')+'</td><td>'+esc(row.activity_type)+'</td>'+
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
    if (previewOnly){
      usbPreviewOkay=result.format==='source'&&!result.already_imported;
      output.textContent=result.format==='report'
        ?'Excel report preview only. It cannot create raw scan events. Use the staff import for names.'
        :'Preview: '+result.rows+' scans · '+result.employees+' IDs · '+result.earliest+' to '+result.latest+
         (result.already_imported?' · File already imported':'');
    }else{
      output.textContent='Imported '+result.inserted+' new scans; '+result.duplicates+' duplicate records ignored.';
      usbPreviewOkay=false;
      toast('Attendance import completed.');
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
    output.textContent=(previewOnly?'Preview':'Roster updated')+': '+result.total+
      ' staff · New '+result.counts.new+' · Fill '+result.counts.fill+
      ' · Conflicts '+result.counts.conflict+' (not overwritten)';
    if(!previewOnly){rosterPreviewOkay=false;toast('Staff directory synchronized from file.');}
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
  $('activity-form').addEventListener('submit',submitActivity);
  $('activity-rows').addEventListener('click',e=>{
    const node=e.target.closest('[data-void]');if(node)voidActivity(Number(node.dataset.void));
  });
  $('usb-file').addEventListener('change',()=>{usbPreviewOkay=false;$('usb-result').classList.add('hidden');});
  $('usb-preview').addEventListener('click',()=>processUsb(true));
  $('usb-form').addEventListener('submit',e=>{e.preventDefault();processUsb(false);});
  $('roster-file').addEventListener('change',()=>{rosterPreviewOkay=false;$('roster-result').classList.add('hidden');});
  $('roster-preview').addEventListener('click',()=>processRoster(true));
  $('roster-form').addEventListener('submit',e=>{e.preventDefault();processRoster(false);});
  $('probe-lan').addEventListener('click',probeDevice);
  $('code-rows').addEventListener('click',e=>{
    const node=e.target.closest('[data-map-code]');if(!node)return;
    const [device,code]=node.dataset.mapCode.split('|');openCodeEditor(device,code);
  });
  $('close-code').addEventListener('click',()=>$('code-dialog').close());
  $('code-form').addEventListener('submit',saveCode);
  if(session?.role!=='admin'){
    document.querySelectorAll('#activity-form input,#activity-form select,#activity-form button,#usb-form button,#roster-form button')
      .forEach(el=>el.disabled=true);
  }
  try{session=await api('/api/me');showApp();}
  catch(_){session=null;showLogin();}
}
document.addEventListener('DOMContentLoaded',initialize);
