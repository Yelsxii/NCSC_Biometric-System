'use strict';
const $=id=>document.getElementById(id);
let account=null, pdfUrl=null, epoch=0, zoom=1, fit=true;
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
  if($('aja-preview-dialog').open)$('aja-preview-dialog').close();
  if(pdfUrl)URL.revokeObjectURL(pdfUrl);
  pdfUrl=null;$('aja-paper').removeAttribute('src');
}
function identity(){
  $('employee-name').value=account?.name||'';
  $('employee-position').value=account?.position||'';
  $('employee-department').value=account?.department||'';
}
function show(user){
  clearPreview();account=user;$('employee-login').hidden=!!user;$('employee-workspace').hidden=!user;
  $('aja-form').reset();identity();$('employee-top-name').textContent=user?.name||'';
  $('aja-error').textContent='';$('aja-submit').disabled=false;
}
$('employee-login-form').addEventListener('submit',async e=>{
  e.preventDefault();$('login-error').textContent='';const b=e.target.querySelector('button');b.disabled=true;
  try{const data=await call('login',Object.fromEntries(new FormData(e.target)));e.target.reset();show(data);}
  catch(err){$('login-error').textContent=err.message;}finally{b.disabled=false;}
});
$('employee-logout').addEventListener('click',async()=>{try{await call('logout',{});show(null);}catch(err){$('aja-error').textContent=err.message;}});
$('aja-form').addEventListener('reset',()=>{clearPreview();queueMicrotask(identity);$('aja-error').textContent='';$('aja-submit').disabled=false;});
$('aja-form').addEventListener('input',()=>{clearPreview();$('aja-submit').disabled=false;});
function applyZoom(){
  const stage=$('aja-stage');
  if(!$('aja-preview-dialog').open)return;
  const width=816,height=1248;
  if(fit)zoom=Math.min((stage.clientWidth-34)/width,(stage.clientHeight-74)/height,1);
  zoom=Math.max(.12,zoom);
  $('aja-paper').style.width=Math.round(width*zoom)+'px';
  $('aja-paper').style.height=Math.round(height*zoom)+'px';
  $('aja-zoom').textContent=Math.round(zoom*100)+'%';
  $('aja-fit').setAttribute('aria-pressed',String(fit));
}
$('aja-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!account)return;clearPreview();const token=epoch;
  $('aja-submit').disabled=true;$('aja-error').textContent='';
  try{
    const data=await call('aja/preview',Object.fromEntries(new FormData(e.target)));
    if(token!==epoch)return;
    const bytes=Uint8Array.from(atob(data.pdf),c=>c.charCodeAt(0));
    pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    $('aja-paper').src='data:image/png;base64,'+data.preview;
    $('aja-preview-name').textContent=account.name;
    fit=true;$('aja-preview-dialog').showModal();requestAnimationFrame(applyZoom);
  }catch(err){if(token===epoch)$('aja-error').textContent=err.message;}
  finally{if(token===epoch)$('aja-submit').disabled=false;}
});
$('aja-close').addEventListener('click',()=>$('aja-preview-dialog').close());
$('aja-minus').addEventListener('click',()=>{fit=false;zoom=Math.max(.12,zoom-.15);applyZoom();});
$('aja-plus').addEventListener('click',()=>{fit=false;zoom=Math.min(2,zoom+.15);applyZoom();});
$('aja-fit').addEventListener('click',()=>{fit=true;applyZoom();});
window.addEventListener('resize',()=>{if(fit)applyZoom();});
$('aja-download').addEventListener('click',()=>{if(pdfUrl){const a=document.createElement('a');a.href=pdfUrl;a.download='AJA-OB.pdf';a.click();}});
$('aja-print').addEventListener('click',()=>{if(pdfUrl)window.open(pdfUrl,'_blank','noopener');});
call('me').then(show).catch(()=>show(null));
