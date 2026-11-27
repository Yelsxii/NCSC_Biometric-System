'use strict';
const $=id=>document.getElementById(id);
let account=null, pdfUrl=null, epoch=0, zoom=1, fit=true;
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
  pdfUrl=null;$('aja-paper').removeAttribute('src');
}
const ajaForm=$('aja-form'),timePicker=$('aja-time-picker');
const timeNames=['departure','return_time'];
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
function updateSummary(){
  const values=Object.fromEntries(new FormData(ajaForm));
  let count=0;
  for(const key of ['dates','origin','destination','purpose',...timeNames]){
    const value=String(values[key]||'').trim();
    const rendered=timeNames.includes(key)?timeDisplay(value):value;
    if(rendered)count++;
    const summary=$('summary-'+key);
    if(summary)summary.textContent=rendered||'—';
    // Preserve the user's text and cursor while typing. The canonical
    // hidden value alone drives the summary and PDF payload.
  }
  $('aja-progress').value=count;
  $('aja-completion').textContent=count+' of 6';
}
function refreshTimePicker(){
  for(const button of $('aja-hours').querySelectorAll('button'))button.setAttribute('aria-pressed',String(Number(button.dataset.hour)===hour));
  for(const button of $('aja-minutes').querySelectorAll('button'))button.setAttribute('aria-pressed',String(Number(button.dataset.minute)===minute));
  for(const button of timePicker.querySelectorAll('[data-period]'))button.setAttribute('aria-pressed',String(button.dataset.period===period));
}
function closeTimePicker(restore=false){
  const trigger=timeTarget?$(timeTarget+'-trigger'):null;
  if(trigger)trigger.setAttribute('aria-expanded','false');
  timeTarget=null;
  if(timePicker.open)timePicker.close();
  document.querySelector('.aja-form-body').style.removeProperty('--aja-picker-space');
  if(restore&&trigger)trigger.focus({preventScroll:true});
}
function placeTimePicker(){
  if(!timeTarget||!timePicker.open)return;
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
  if(timeTarget===target&&timePicker.open){closeTimePicker(true);return;}
  closeTimePicker();
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
  timePicker.show();
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
for(const target of timeNames){
  const input=$(target+'-display');
  $(target+'-trigger').addEventListener('click',()=>openTimePicker(target));
  input.addEventListener('input',()=>syncTypedTime(target));
  input.addEventListener('blur',()=>{syncTypedTime(target,true);updateSummary();});
  input.addEventListener('invalid',()=>{input.setAttribute('aria-invalid','true');});
}
$('aja-time-apply').addEventListener('click',()=>applyTime());
$('aja-time-clear').addEventListener('click',()=>applyTime(true));
$('aja-time-close').addEventListener('click',()=>closeTimePicker(true));
document.addEventListener('pointerdown',event=>{
  if(timeTarget&&!timePicker.contains(event.target)&&!$(timeTarget+'-trigger').contains(event.target)&&!event.target.closest('[data-time-target]'))closeTimePicker();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&timePicker.open){event.preventDefault();closeTimePicker(true);}});
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
$('aja-form').addEventListener('reset',()=>{closeTimePicker();clearPreview();queueMicrotask(()=>{for(const target of timeNames){$(target).value='';const input=$(target+'-display');input.value='';input.setCustomValidity('');input.removeAttribute('aria-invalid');}identity();});for(const target of timeNames)$(target+'-trigger').removeAttribute('aria-invalid');setError('aja-error','');$('aja-submit').disabled=false;});
$('aja-form').addEventListener('input',()=>{clearPreview();updateSummary();setError('aja-error','');$('aja-submit').disabled=false;});
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
  closeTimePicker();
  for(const target of timeNames){
    if(!syncTypedTime(target,true)){
      setError('aja-error','Enter valid departure and return times.');
      $(target+'-display').setAttribute('aria-invalid','true');$(target+'-display').focus();return;
    }
  }
  clearPreview();const token=epoch;
  $('aja-submit').disabled=true;setError('aja-error','');
  try{
    const data=await call('aja/preview',Object.fromEntries(new FormData(e.target)));
    if(token!==epoch)return;
    const bytes=Uint8Array.from(atob(data.pdf),c=>c.charCodeAt(0));
    pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    $('aja-paper').src='data:image/png;base64,'+data.preview;
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
