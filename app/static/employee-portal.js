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
let timeTarget=null,hour=8,period='AM';
function timeDisplay(value){
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value||''))return '';
  const [h,m]=value.split(':').map(Number);
  return String(h%12||12).padStart(2,'0')+':'+String(m).padStart(2,'0')+' '+(h<12?'AM':'PM');
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
    if(timeNames.includes(key)){
      const trigger=$(key+'-trigger');
      $(key+'-display').textContent=rendered||'Select time';
      trigger.classList.toggle('empty',!rendered);
      if(rendered)trigger.removeAttribute('aria-invalid');
    }
  }
  $('aja-progress').value=count;
  $('aja-completion').textContent=count+' of 6';
}
function refreshTimePicker(){
  for(const button of $('aja-hours').querySelectorAll('button'))button.setAttribute('aria-pressed',String(Number(button.dataset.hour)===hour));
  for(const button of timePicker.querySelectorAll('[data-period]'))button.setAttribute('aria-pressed',String(button.dataset.period===period));
}
function closeTimePicker(restore=false){
  const trigger=timeTarget?$(timeTarget+'-trigger'):null;
  if(trigger)trigger.setAttribute('aria-expanded','false');
  timeTarget=null;
  if(timePicker.open)timePicker.close();
  if(restore&&trigger)trigger.focus({preventScroll:true});
}
function openTimePicker(target){
  if(timeTarget===target&&timePicker.open){closeTimePicker(true);return;}
  closeTimePicker();
  timeTarget=target;
  const existing=$(target).value;
  if(timeDisplay(existing)){
    const [h,m]=existing.split(':').map(Number);
    hour=h%12||12;period=h<12?'AM':'PM';$('aja-minute').value=String(m).padStart(2,'0');
  }else{hour=8;period='AM';$('aja-minute').value='00';}
  $('aja-time-title').textContent=$(target+'-label').textContent.replace('*','').trim();
  $('aja-time-error').classList.add('hidden');
  refreshTimePicker();
  const trigger=$(target+'-trigger'),r=trigger.getBoundingClientRect(),gap=5,margin=8;
  // Shared month-picker styling; position the non-modal dialog beside its trigger.
  timePicker.style.left='0px';timePicker.style.top='0px';
  timePicker.show();
  const width=timePicker.offsetWidth,height=timePicker.offsetHeight;
  const below=window.innerHeight-r.bottom-gap-margin,above=r.top-gap-margin;
  const up=height>below&&above>below;
  timePicker.style.left=Math.max(margin,Math.min(r.left,window.innerWidth-width-margin))+'px';
  timePicker.style.top=Math.max(margin,Math.min(up?r.top-gap-height:r.bottom+gap,window.innerHeight-height-margin))+'px';
  trigger.setAttribute('aria-expanded','true');
  $('aja-hours').querySelector('[aria-pressed=true]')?.focus({preventScroll:true});
}
function applyTime(clear=false){
  if(!timeTarget)return;
  const minute=$('aja-minute').value.trim();
  if(!clear&&(!/^\d{1,2}$/.test(minute)||Number(minute)>59)){
    $('aja-time-error').classList.remove('hidden');$('aja-minute').focus();return;
  }
  const target=$(timeTarget),h=hour%12+(period==='PM'?12:0);
  target.value=clear?'':String(h).padStart(2,'0')+':'+String(Number(minute)).padStart(2,'0');
  closeTimePicker(true);
  target.dispatchEvent(new Event('input',{bubbles:true}));
}
for(let h=1;h<=12;h++){
  const button=document.createElement('button');button.type='button';button.dataset.hour=String(h);button.textContent=String(h).padStart(2,'0');
  button.addEventListener('click',()=>{hour=h;refreshTimePicker();});
  $('aja-hours').append(button);
}
for(const button of timePicker.querySelectorAll('[data-period]'))button.addEventListener('click',()=>{period=button.dataset.period;refreshTimePicker();});
for(const target of timeNames)$(target+'-trigger').addEventListener('click',()=>openTimePicker(target));
for(const [id,delta] of [['aja-minute-minus',-1],['aja-minute-plus',1]])$(id).addEventListener('click',()=>{
  const current=Number($('aja-minute').value)||0;
  $('aja-minute').value=String((current+delta+60)%60).padStart(2,'0');$('aja-time-error').classList.add('hidden');
});
$('aja-minute').addEventListener('input',()=>{$('aja-minute').value=$('aja-minute').value.replace(/\D/g,'').slice(0,2);$('aja-time-error').classList.add('hidden');});
$('aja-minute').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyTime();}});
$('aja-time-apply').addEventListener('click',()=>applyTime());
$('aja-time-clear').addEventListener('click',()=>applyTime(true));
$('aja-time-close').addEventListener('click',()=>closeTimePicker(true));
document.addEventListener('pointerdown',event=>{
  if(timeTarget&&!timePicker.contains(event.target)&&!$(timeTarget+'-trigger').contains(event.target)&&!event.target.closest('[data-time-target]'))closeTimePicker();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&timePicker.open){event.preventDefault();closeTimePicker(true);}});
timePicker.addEventListener('cancel',event=>{event.preventDefault();closeTimePicker(true);});
window.addEventListener('resize',()=>closeTimePicker());
document.querySelector('.aja-form-body').addEventListener('scroll',()=>closeTimePicker(),{passive:true});
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
$('aja-form').addEventListener('reset',()=>{closeTimePicker();clearPreview();queueMicrotask(identity);for(const target of timeNames)$(target+'-trigger').removeAttribute('aria-invalid');setError('aja-error','');$('aja-submit').disabled=false;});
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
    if(!timeDisplay($(target).value)){
      setError('aja-error','Choose both departure and return times.');
      $(target+'-trigger').setAttribute('aria-invalid','true');$(target+'-trigger').focus();return;
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
