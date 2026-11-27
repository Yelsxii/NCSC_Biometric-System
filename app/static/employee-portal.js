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
function identity(){
  $('employee-name').value=account?.name||'';
  $('employee-position').value=account?.position||'';
  $('employee-department').value=account?.department||'';
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
$('aja-form').addEventListener('reset',()=>{clearPreview();queueMicrotask(identity);setError('aja-error','');$('aja-submit').disabled=false;});
$('aja-form').addEventListener('input',()=>{clearPreview();$('aja-submit').disabled=false;});
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
  e.preventDefault();if(!account)return;clearPreview();const token=epoch;
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
