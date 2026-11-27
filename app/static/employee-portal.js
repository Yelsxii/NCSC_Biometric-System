'use strict';
const $=id=>document.getElementById(id);
let account=null, pdfUrl=null, epoch=0, zoom=1, fit=true, previewPages=[], previewIndex=0;
function setError(id,message){
  const node=$(id);node.textContent=message;node.classList.toggle('hidden',!message);
}
const clockDate=new Intl.DateTimeFormat('en-PH',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Manila'});
const clockTime=new Intl.DateTimeFormat('en-PH',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true,timeZone:'Asia/Manila'});
function updateWorkspaceClock(){
  const now=new Date();
  $('today').textContent=clockDate.format(now);
  $('live-time').textContent=clockTime.format(now);
  $('live-time').setAttribute('datetime',now.toISOString());
}
updateWorkspaceClock();window.setInterval(updateWorkspaceClock,1000);
$('toggle-password').addEventListener('click',()=>{
  const input=$('login-password'),btn=$('toggle-password'),visible=input.type==='password';
  input.type=visible?'text':'password';
  btn.setAttribute('aria-pressed',String(visible));
  btn.setAttribute('aria-label',visible?'Hide password':'Show password');
});
async function call(path,body){
  const headers={};
  if(body!==undefined){headers['Content-Type']='application/json';if(account?.csrf)headers['X-CSRF-Token']=account.csrf;}
  const r=await fetch('/api/employee-portal/'+path,{method:body===undefined?'GET':'POST',headers,credentials:'same-origin',...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const detail=Array.isArray(data.detail)?data.detail.map(x=>x.msg).join('; '):data.detail;throw Error(detail||'Request failed.');}
  return data;
}
function clearPreview(){
  epoch++;
  if($('dtr-preview-dialog').open)$('dtr-preview-dialog').close();
  if(pdfUrl)URL.revokeObjectURL(pdfUrl);
  pdfUrl=null;previewPages=[];previewIndex=0;$('aja-paper').removeAttribute('src');
}
const ajaForm=$('aja-form'),timePicker=$('aja-time-picker');
const timeNames=['departure','return_time'];
let dates=[], scheduleMode='same', committedDateMode='single';
const dailyTimes=new Map();
let timeTarget=null,hour=8,minute=0,period='AM';
function timeDisplay(value){
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value||''))return '';
  const [h,m]=value.split(':').map(Number);
  return String(h%12||12).padStart(2,'0')+':'+String(m).padStart(2,'0')+' '+(h<12?'AM':'PM');
}
function parseTypedTime(value){
  const raw=String(value||'').trim().toUpperCase();
  let m=raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  let h,min;
  if(m){
    h=Number(m[1]);min=Number(m[2]||0);
    if(h<1||h>12||min>59)return '';
    h=h%12+(m[3]==='PM'?12:0);
  }else{
    m=raw.match(/^(\d{1,2}):(\d{2})$/);
    if(!m)return '';
    h=Number(m[1]);min=Number(m[2]);
    if(h>23||min>59)return '';
  }
  return String(h).padStart(2,'0')+':'+String(min).padStart(2,'0');
}
function syncTypedTime(target,normalize=false){
  const input=$(target+'-display'),raw=input.value.trim(),parsed=parseTypedTime(raw);
  $(target).value=parsed;
  if(normalize&&parsed)input.value=timeDisplay(parsed);
  if(normalize||input.hasAttribute('aria-invalid')){
    if(raw&&!parsed)input.setAttribute('aria-invalid','true');
    else input.removeAttribute('aria-invalid');
  }
  input.setCustomValidity(raw&&!parsed?'Enter a valid time, e.g. 8:30 AM or 13:30.':'');
  return parsed;
}
function activeTimeTargets(){
  return scheduleMode==='individual'&&dates.length>1?dates.flatMap(day=>['departure-'+day,'return_time-'+day]):timeNames;
}
function dateLabel(iso,short=false){
  return new Intl.DateTimeFormat('en-US',{month:short?'short':'long',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(iso+'T00:00:00Z'));
}
function collectDays(){
  return dates.map(date=>{
    const suffix=scheduleMode==='individual'&&dates.length>1?'-'+date:'';
    return {date,departure:$('departure'+suffix)?.value||'',return_time:$('return_time'+suffix)?.value||''};
  });
}
function tripDuration(departure,returnTime){
  if(!timeDisplay(departure)||!timeDisplay(returnTime)||returnTime<=departure)return '';
  const mins=value=>{const [h,m]=value.split(':').map(Number);return h*60+m;};
  const total=mins(returnTime)-mins(departure),h=Math.floor(total/60),m=total%60;
  return [h?h+'h':'',m?m+'m':''].filter(Boolean).join(' ');
}
function expectedForms(days){
  if(!days.length)return 0;
  const consecutive=days.every((day,i)=>!i||Date.parse(day.date)-Date.parse(days[i-1].date)===86400000);
  const identical=days.every(day=>day.departure===days[0].departure&&day.return_time===days[0].return_time);
  return consecutive&&identical?1:days.length;
}
function updateSummary(){
  const values=Object.fromEntries(new FormData(ajaForm)),days=collectDays();
  const individual=scheduleMode==='individual'&&dates.length>1;
  let count=Number(dates.length>0);
  const dateValues=$('summary-dates');
  const labels=dates.length?(committedDateMode==='range'?[rangeLabel(dates[0],dates.at(-1))]:dates.map(d=>dateLabel(d,true))):[];
  dateValues.replaceChildren();
  if(!labels.length){
    const empty=document.createElement('span');empty.className='aja-ticket-date-empty';empty.textContent='—';dateValues.append(empty);
  }else for(const label of labels){
    const chip=document.createElement('span');chip.className='aja-ticket-date-chip';chip.textContent=label;dateValues.append(chip);
  }
  for(const key of ['origin','destination','purpose']){
    const value=String(values[key]||'').trim();
    if(value)count++;
    const summary=$('summary-'+key);if(summary)summary.textContent=value||'—';
  }
  for(const key of timeNames){
    const complete=days.length>0&&days.every(day=>timeDisplay(day[key]));
    if(complete)count++;
    $('summary-'+key).textContent=timeDisplay($(key).value)||'—';
  }
  $('aja-summary-shared').classList.toggle('hidden',individual);
  $('aja-summary-individual').classList.toggle('hidden',!individual);
  const dateCount=$('aja-ticket-date-count');
  dateCount.textContent=dates.length+' '+(dates.length===1?'day':'days');dateCount.classList.toggle('hidden',!dates.length);
  $('aja-ticket-duration').textContent=tripDuration($('departure').value,$('return_time').value)||'—';
  const formCount=expectedForms(days);
  const schedulesReady=days.length>0&&days.every(day=>tripDuration(day.departure,day.return_time));
  $('aja-ticket-forms').textContent=schedulesReady?(formCount===1?'1 form expected':formCount+' forms expected'):'—';
  $('aja-summary-days').replaceChildren();
  if(individual)for(const day of days){
    const row=document.createElement('div');row.className='aja-daily-summary';
    const label=document.createElement('strong');label.textContent=dateLabel(day.date,true);
    const value=document.createElement('span');value.textContent=(timeDisplay(day.departure)||'—')+' → '+(timeDisplay(day.return_time)||'—');
    const duration=document.createElement('small');duration.textContent=tripDuration(day.departure,day.return_time)||'—';
    row.append(label,value,duration);$('aja-summary-days').append(row);
  }
  $('aja-progress').value=count;
  $('aja-completion').textContent=count+' of 6';
}
function bindTimeInput(target){
  const input=$(target+'-display');
  $(target+'-trigger').addEventListener('click',()=>openTimePicker(target));
  input.addEventListener('input',()=>syncTypedTime(target));
  input.addEventListener('blur',()=>{syncTypedTime(target,true);updateSummary();});
  input.addEventListener('invalid',()=>input.setAttribute('aria-invalid','true'));
}
function captureDailyTimes(){
  for(const day of dates)if($('departure-'+day)){
    dailyTimes.set(day,timeNames.map(key=>$(key+'-'+day+'-display').value));
  }
}
function renderSchedules(){
  const individual=scheduleMode==='individual'&&dates.length>1;
  $('aja-schedule-options').classList.toggle('hidden',dates.length<2);
  $('aja-shared-times').classList.toggle('hidden',individual);
  for(const key of timeNames)$(key+'-display').disabled=individual;
  for(const b of ajaForm.querySelectorAll('[data-schedule-mode]'))b.setAttribute('aria-pressed',String(b.dataset.scheduleMode===scheduleMode));
  const host=$('aja-individual-times');host.replaceChildren();host.classList.toggle('hidden',!individual);
  if(!individual)return;
  for(const day of dates){
    const row=document.createElement('div');row.className='aja-daily-row';
    const title=document.createElement('strong');title.textContent=dateLabel(day,true);row.append(title);
    const pair=document.createElement('div');pair.className='aja-time-row';
    timeNames.forEach((key,i)=>{
      const clone=$(key+'-display').closest('.aja-time-field').cloneNode(true);
      const target=key+'-'+day;
      clone.querySelectorAll('[id]').forEach(el=>{el.id=el.id.replace(key,target);});
      clone.querySelector('label').htmlFor=target+'-display';
      const input=clone.querySelector('.aja-time-input');input.disabled=false;input.value=dailyTimes.get(day)?.[i]??$(key+'-display').value;input.removeAttribute('aria-invalid');
      const hidden=clone.querySelector('input[type=hidden]');hidden.removeAttribute('name');hidden.value='';
      const button=clone.querySelector('button');button.dataset.timeTarget=target;button.setAttribute('aria-expanded','false');button.setAttribute('aria-label',(i?'Choose return time for ':'Choose departure time for ')+dateLabel(day,true));
      pair.append(clone);row.append(pair);host.append(row);bindTimeInput(target);syncTypedTime(target);
    });
  }
}
function formChanged(){
  clearPreview();updateSummary();setError('aja-error','');$('aja-submit').disabled=false;
}
function rangeLabel(first,last){
  const a=new Date(first+'T00:00:00Z'),b=new Date(last+'T00:00:00Z');
  if(a.getUTCFullYear()===b.getUTCFullYear()&&a.getUTCMonth()===b.getUTCMonth()){
    return new Intl.DateTimeFormat('en-US',{month:'short',timeZone:'UTC'}).format(a)+' '+a.getUTCDate()+'–'+b.getUTCDate()+', '+a.getUTCFullYear();
  }
  if(a.getUTCFullYear()===b.getUTCFullYear()){
    const fmt=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
    return fmt.format(a)+' – '+fmt.format(b)+', '+b.getUTCFullYear();
  }
  return dateLabel(first,true)+' – '+dateLabel(last,true);
}
function commitDates(next,mode=committedDateMode){
  captureDailyTimes();dates=[...new Set(next)].sort();
  committedDateMode=dates.length<2?'single':mode==='range'?'range':'multiple';
  if(dates.length<2)scheduleMode='same';
  const display=$('aja-date-display'),chips=$('aja-selected-dates');
  display.textContent=dates.length===1?dateLabel(dates[0]):dates.length?dates.length+' dates selected':'Select date/s';
  display.classList.toggle('aja-date-placeholder',!dates.length);
  display.hidden=dates.length>1;
  $('aja-date-trigger').removeAttribute('aria-invalid');
  chips.replaceChildren();
  function addChip(label,remove,accessibleLabel){
    const chip=document.createElement('button');chip.type='button';chip.className='aja-date-chip';
    const name=document.createElement('span');name.textContent=label;
    const x=document.createElement('span');x.textContent='×';x.className='aja-chip-remove';x.setAttribute('aria-hidden','true');
    chip.append(name,x);chip.setAttribute('aria-label',accessibleLabel);chip.addEventListener('click',event=>{event.stopPropagation();remove();$('aja-date-trigger').focus({preventScroll:true});});chips.append(chip);
  }
  if(committedDateMode==='range'&&dates.length>1){
    addChip(rangeLabel(dates[0],dates.at(-1)),()=>commitDates([]),'Remove selected date range');
  }else if(dates.length>1)for(const date of dates){
    addChip(dateLabel(date,true),()=>commitDates(dates.filter(d=>d!==date),'multiple'),'Remove '+dateLabel(date));
  }
  renderSchedules();formChanged();
}
const calendar=$('aja-date-picker');
let draftDates=[],dateMode='single',rangeStart=null,calendarMonth=new Date();
function isoDay(d){return d.toISOString().slice(0,10);}
function calendarRender(message=''){
  const y=calendarMonth.getUTCFullYear(),m=calendarMonth.getUTCMonth();
  $('aja-month-label').textContent=new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(calendarMonth);
  const grid=$('aja-calendar-days');grid.replaceChildren();
  const first=new Date(Date.UTC(y,m,1)).getUTCDay(),last=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  for(let n=0;n<first;n++)grid.append(document.createElement('span'));
  for(let n=1;n<=last;n++){
    const date=isoDay(new Date(Date.UTC(y,m,n))),b=document.createElement('button');b.type='button';b.textContent=n;
    b.setAttribute('aria-label',dateLabel(date));b.setAttribute('aria-pressed',String(draftDates.includes(date)));
    b.addEventListener('click',()=>selectDate(date));grid.append(b);
  }
  calendar.querySelectorAll('[data-date-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.dateMode===dateMode)));
  $('aja-calendar-status').textContent=message||(draftDates.length+' date'+(draftDates.length===1?'':'s')+' selected');
}
function selectDate(date){
  if(dateMode==='single')draftDates=[date];
  else if(dateMode==='multiple'){
    if(draftDates.includes(date))draftDates=draftDates.filter(d=>d!==date);
    else if(draftDates.length>=14){calendarRender('Maximum 14 dates per filing.');return;}
    else draftDates=[...draftDates,date].sort();
  }else if(!rangeStart){rangeStart=date;draftDates=[date];}
  else{
    const a=new Date([rangeStart,date].sort()[0]+'T00:00:00Z'),b=new Date([rangeStart,date].sort()[1]+'T00:00:00Z');
    const length=Math.round((b-a)/86400000)+1;
    if(length>14){calendarRender('Select a range of up to 14 days.');return;}
    draftDates=Array.from({length},(_,i)=>isoDay(new Date(a.getTime()+i*86400000)));rangeStart=null;
  }
  calendarRender(dateMode==='range'&&rangeStart?'Choose the end date.':'');
}
function placeCalendar(){
  if(!calendar.matches(':popover-open'))return;
  const r=$('aja-date-control').getBoundingClientRect();
  calendar.style.left=Math.max(8,Math.min(r.left,innerWidth-calendar.offsetWidth-8))+'px';
  calendar.style.top=(r.bottom+5)+'px';
  calendar.style.maxHeight=Math.max(40,innerHeight-r.bottom-13)+'px';
}
function closeCalendar(restore=false){
  if(calendar.matches(':popover-open'))calendar.hidePopover();
  $('aja-date-trigger').setAttribute('aria-expanded','false');
  document.querySelector('.aja-form-body').style.removeProperty('--aja-picker-space');
  if(restore)$('aja-date-trigger').focus({preventScroll:true});
}
$('aja-date-trigger').addEventListener('click',()=>{
  if(calendar.matches(':popover-open')){closeCalendar(true);return;}
  closeTimePicker();draftDates=[...dates];rangeStart=null;
  dateMode=committedDateMode;
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  calendarMonth=new Date((dates[0]||today).slice(0,7)+'-01T00:00:00Z');
  calendarRender();calendar.style.maxHeight='';calendar.showPopover();
  const body=document.querySelector('.aja-form-body'),extra=Math.max(0,Math.ceil(calendar.offsetHeight-(innerHeight-$('aja-date-control').getBoundingClientRect().bottom-13)));
  if(extra){body.style.setProperty('--aja-picker-space',extra+'px');body.scrollTop+=extra;}
  placeCalendar();$('aja-date-trigger').setAttribute('aria-expanded','true');
});
$('aja-date-control').addEventListener('click',e=>{if(!e.target.closest('button'))$('aja-date-trigger').click();});
calendar.querySelectorAll('[data-date-mode]').forEach(b=>b.addEventListener('click',()=>{
  const next=b.dataset.dateMode;
  if(next!==dateMode){
    rangeStart=null;
    if(next==='single'&&draftDates.length>1)draftDates=draftDates.slice(0,1);
    if(next==='range'&&draftDates.length>1){
      const span=Math.round((Date.parse(draftDates.at(-1))-Date.parse(draftDates[0]))/86400000)+1;
      if(span!==draftDates.length)draftDates=[];
    }
  }
  dateMode=next;calendarRender();
}));
for(const [id,delta] of [['aja-month-prev',-1],['aja-month-next',1]])$(id).addEventListener('click',()=>{
  calendarMonth=new Date(Date.UTC(calendarMonth.getUTCFullYear(),calendarMonth.getUTCMonth()+delta,1));calendarRender();
});
$('aja-date-clear').addEventListener('click',()=>{draftDates=[];rangeStart=null;calendarRender();});
$('aja-date-apply').addEventListener('click',()=>{if(dateMode==='range'&&rangeStart){calendarRender('Choose the end date or switch to Single.');return;}closeCalendar(true);commitDates(draftDates,dateMode);});
$('aja-date-close').addEventListener('click',()=>closeCalendar(true));
calendar.addEventListener('cancel',e=>{e.preventDefault();closeCalendar(true);});
document.addEventListener('pointerdown',e=>{if(calendar.matches(':popover-open')&&!calendar.contains(e.target)&&!$('aja-date-control').contains(e.target))closeCalendar();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&calendar.matches(':popover-open')){e.preventDefault();closeCalendar(true);}});
document.querySelector('.aja-form-body').addEventListener('scroll',placeCalendar,{passive:true});
window.addEventListener('resize',()=>closeCalendar());
ajaForm.querySelectorAll('[data-schedule-mode]').forEach(b=>b.addEventListener('click',()=>{
  closeTimePicker();captureDailyTimes();scheduleMode=b.dataset.scheduleMode;renderSchedules();formChanged();
}));
function refreshTimePicker(){
  for(const button of $('aja-hours').querySelectorAll('button'))button.setAttribute('aria-pressed',String(Number(button.dataset.hour)===hour));
  for(const button of $('aja-minutes').querySelectorAll('button'))button.setAttribute('aria-pressed',String(Number(button.dataset.minute)===minute));
  for(const button of timePicker.querySelectorAll('[data-period]'))button.setAttribute('aria-pressed',String(button.dataset.period===period));
}
function closeTimePicker(restore=false){
  const trigger=timeTarget?$(timeTarget+'-trigger'):null;
  if(trigger)trigger.setAttribute('aria-expanded','false');
  timeTarget=null;
  if(timePicker.matches(':popover-open'))timePicker.hidePopover();
  document.querySelector('.aja-form-body').style.removeProperty('--aja-picker-space');
  if(restore&&trigger)trigger.focus({preventScroll:true});
}
function placeTimePicker(){
  if(!timeTarget||!timePicker.matches(':popover-open'))return;
  const trigger=$(timeTarget+'-display'),r=trigger.getBoundingClientRect(),gap=5,margin=8;
  timePicker.style.left=Math.max(margin,Math.min(r.left,window.innerWidth-timePicker.offsetWidth-margin))+'px';
  timePicker.style.top=(r.bottom+gap)+'px';
  timePicker.style.maxHeight=Math.max(40,window.innerHeight-r.bottom-gap-margin)+'px';
}
function centerTimeChoice(list){
  const selected=list.querySelector('[aria-pressed=true]');
  if(selected)list.scrollTop=Math.max(0,selected.offsetTop-list.firstElementChild.offsetTop-(list.clientHeight-selected.offsetHeight)/2);
}
function openTimePicker(target){
  if(timeTarget===target&&timePicker.matches(':popover-open')){closeTimePicker(true);return;}
  closeTimePicker();closeCalendar();
  timeTarget=target;
  const existing=$(target).value;
  if(timeDisplay(existing)){
    const [h,m]=existing.split(':').map(Number);
    hour=h%12||12;minute=m;period=h<12?'AM':'PM';
  }else{hour=8;minute=0;period='AM';}
  $('aja-time-title').textContent=$(target+'-label').textContent.replace('*','').trim();
  refreshTimePicker();
  const trigger=$(target+'-trigger'),body=document.querySelector('.aja-form-body'),gap=5,margin=8;
  timePicker.style.left='0px';timePicker.style.top='0px';timePicker.style.maxHeight='';
  timePicker.showPopover();
  const height=timePicker.offsetHeight,below=window.innerHeight-trigger.getBoundingClientRect().bottom-gap-margin;
  // Keep the picker below the field. If the viewport is short, create
  // temporary scrolling room and raise the field rather than flipping above.
  if(below<height){
    const extra=Math.ceil(height-below);
    body.style.setProperty('--aja-picker-space',extra+'px');
    body.scrollTop+=extra;
  }
  placeTimePicker();
  trigger.setAttribute('aria-expanded','true');
  centerTimeChoice($('aja-hours'));centerTimeChoice($('aja-minutes'));
  $('aja-hours').querySelector('[aria-pressed=true]')?.focus({preventScroll:true});
}
function applyTime(clear=false){
  if(!timeTarget)return;
  const target=$(timeTarget),h=hour%12+(period==='PM'?12:0);
  target.value=clear?'':String(h).padStart(2,'0')+':'+String(minute).padStart(2,'0');
  const display=$(timeTarget+'-display');display.value=timeDisplay(target.value);display.setCustomValidity('');display.removeAttribute('aria-invalid');
  closeTimePicker(true);
  target.dispatchEvent(new Event('input',{bubbles:true}));
}
for(const [list,key,start,end] of [['aja-hours','hour',1,12],['aja-minutes','minute',0,59]]){
  for(let n=start;n<=end;n++){
    const button=document.createElement('button');button.type='button';button.dataset[key]=String(n);button.textContent=String(n).padStart(2,'0');
    button.addEventListener('click',()=>{if(key==='hour')hour=n;else minute=n;refreshTimePicker();});
    $(list).append(button);
  }
}
for(const button of timePicker.querySelectorAll('[data-period]'))button.addEventListener('click',()=>{period=button.dataset.period;refreshTimePicker();});
for(const target of timeNames)bindTimeInput(target);
$('aja-time-apply').addEventListener('click',()=>applyTime());
$('aja-time-clear').addEventListener('click',()=>applyTime(true));
$('aja-time-close').addEventListener('click',()=>closeTimePicker(true));
document.addEventListener('pointerdown',event=>{
  if(timeTarget&&!timePicker.contains(event.target)&&!$(timeTarget+'-trigger').contains(event.target)&&!event.target.closest('[data-time-target]'))closeTimePicker();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&timePicker.matches(':popover-open')){event.preventDefault();closeTimePicker(true);}});
timePicker.addEventListener('cancel',event=>{event.preventDefault();closeTimePicker(true);});
window.addEventListener('resize',()=>closeTimePicker());
document.querySelector('.aja-form-body').addEventListener('scroll',placeTimePicker,{passive:true});
function identity(){
  $('employee-name').textContent=account?.name||'—';
  $('employee-position').textContent=account?.position||'—';
  $('employee-department').textContent=account?.department||'—';
  $('aja-avatar').textContent=account?.name?.split(',').map(part=>part.trim()[0]||'').join('').toUpperCase()||'—';
  updateSummary();
}
function show(user){
  clearPreview();account=user;$('login-view').classList.toggle('hidden',!!user);$('workspace').classList.toggle('hidden',!user);
  $('aja-form').reset();identity();
  setError('aja-error','');$('aja-submit').disabled=false;
}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();setError('login-error','');const b=$('login-submit');b.disabled=true;
  try{const data=await call('login',Object.fromEntries(new FormData(e.target)));e.target.reset();show(data);}
  catch(err){setError('login-error',err.message);}finally{b.disabled=false;}
});
$('logout-sidebar').addEventListener('click',async()=>{try{await call('logout',{});show(null);}catch(err){setError('aja-error',err.message);}});
$('aja-form').addEventListener('reset',()=>{
  closeTimePicker();closeCalendar();clearPreview();
  queueMicrotask(()=>{
    dates=[];dailyTimes.clear();scheduleMode='same';
    for(const target of timeNames){$(target).value='';const input=$(target+'-display');input.value='';input.disabled=false;input.setCustomValidity('');input.removeAttribute('aria-invalid');}
    commitDates([]);identity();
  });
});
$('aja-form').addEventListener('input',formChanged);
function showPreviewPage(index){
  if(!previewPages.length)return;
  previewIndex=Math.max(0,Math.min(previewPages.length-1,index));
  $('aja-paper').src='data:image/png;base64,'+previewPages[previewIndex];
  $('aja-page-nav').classList.toggle('hidden',previewPages.length<2);
  $('aja-page-count').textContent=(previewIndex+1)+' / '+previewPages.length;
  $('aja-page-prev').disabled=previewIndex===0;$('aja-page-next').disabled=previewIndex===previewPages.length-1;
  $('aja-stage').scrollTop=0;requestAnimationFrame(applyZoom);
}
$('aja-page-prev').addEventListener('click',()=>showPreviewPage(previewIndex-1));
$('aja-page-next').addEventListener('click',()=>showPreviewPage(previewIndex+1));
function applyZoom(){
  const stage=$('aja-stage');
  if(!$('dtr-preview-dialog').open)return;
  const width=816,height=1248;
  if(fit)zoom=Math.min((stage.clientWidth-34)/width,(stage.clientHeight-74)/height,1);
  zoom=Math.max(.12,zoom);
  $('aja-paper').style.width=Math.round(width*zoom)+'px';
  $('aja-paper').style.height=Math.round(height*zoom)+'px';
  $('dtr-zoom-value').textContent=Math.round(zoom*100)+'%';
  $('dtr-zoom-fit').setAttribute('aria-pressed',String(fit));
}
$('aja-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!account)return;
  closeTimePicker();closeCalendar();
  if(!dates.length){setError('aja-error','Select at least one official business date.');$('aja-date-trigger').setAttribute('aria-invalid','true');$('aja-date-trigger').focus();return;}
  for(const target of activeTimeTargets()){
    if(!syncTypedTime(target,true)){
      setError('aja-error','Enter valid departure and return times.');$(target+'-display').setAttribute('aria-invalid','true');$(target+'-display').focus();return;
    }
  }
  const days=collectDays(),bad=days.find(day=>day.return_time<=day.departure);
  if(bad){setError('aja-error','Return must be after departure on '+dateLabel(bad.date,true)+'. Overnight trips require HR review.');return;}
  const values=Object.fromEntries(new FormData(e.target));
  const payload={days,origin:values.origin,destination:values.destination,purpose:values.purpose};
  clearPreview();const token=epoch;
  $('aja-submit').disabled=true;setError('aja-error','');
  try{
    const data=await call('aja/preview',payload);
    if(token!==epoch)return;
    const bytes=Uint8Array.from(atob(data.pdf),c=>c.charCodeAt(0));
    pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    previewPages=data.previews||[data.preview];showPreviewPage(0);
    $('dtr-preview-context').textContent=account.name;
    fit=true;$('dtr-preview-dialog').showModal();requestAnimationFrame(applyZoom);
  }catch(err){if(token===epoch)setError('aja-error',err.message);}
  finally{if(token===epoch)$('aja-submit').disabled=false;}
});
$('dtr-preview-back').addEventListener('click',()=>$('dtr-preview-dialog').close());
$('dtr-zoom-out').addEventListener('click',()=>{fit=false;zoom=Math.max(.12,zoom-.15);applyZoom();});
$('dtr-zoom-in').addEventListener('click',()=>{fit=false;zoom=Math.min(2,zoom+.15);applyZoom();});
$('dtr-zoom-fit').addEventListener('click',()=>{fit=true;applyZoom();});
window.addEventListener('resize',()=>{if(fit)applyZoom();});
$('dtr-preview-download').addEventListener('click',()=>{if(pdfUrl){const a=document.createElement('a');a.href=pdfUrl;a.download='AJA-OB.pdf';a.click();}});
$('dtr-preview-print').addEventListener('click',()=>{if(pdfUrl)window.open(pdfUrl,'_blank','noopener');});
call('me').then(show).catch(()=>show(null));
