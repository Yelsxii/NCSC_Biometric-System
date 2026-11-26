'use strict';
// Category-specific document renderer. The printable frame uses the same
// authenticated monthly attendance snapshot as the employee detail view.
let dtrPreviewData=null;
let dtrPreviewVersion=0;
let dtrDownloadBusy=false;
let dtrZoomMode='fit';
let dtrZoomScale=1;
const DTR_MIN_ZOOM=.25,DTR_MAX_ZOOM=2;
const DTR_NARROW_MM=6.35;
const dtrPaper={a4:{width:'210mm',height:'297mm',w:210,h:297},folio:{width:'215.9mm',height:'330.2mm',w:215.9,h:330.2}};
const dtrSignatory={
  COS:['ATTY. GLAIZA BERNADETH P. PINTO-TADEO','REGIONAL DIRECTOR'],
  Permanent:['ATTY. GLAIZA BERNADETH P. PINTO-TADEO','REGIONAL DIRECTOR'],
  OJT:['DR. MA. ELYZA GRACILDA R. PONCIANO','INTERNSHIP SUPERVISOR'],
  GIP:['DR. MA. ELYZA GRACILDA R. PONCIANO','']
};
function dtrDateLabel(month,day){
  const [year,m]=month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(year,m-1,day)));
}
function dtrLastDay(month){
  const [year,m]=month.split('-').map(Number);
  return new Date(Date.UTC(year,m,0)).getUTCDate();
}
function dtrClock(event,shortHour=false){
  if(!event)return '';
  const t=String(event.happened_at||'').slice(11,16);
  return esc(shortHour?t.replace(/^0/,''):t);
}
function dtrAjaClock(event){
  return event?esc(String(event.time||'').slice(0,5)):'';
}
function dtrPrintRows(data,category,from=1,to=dtrLastDay(data.month)){
  const gip=category==='GIP',metricsCols=gip?1:2;
  const days=new Map(data.days.map(day=>[Number(day.date.slice(-2)),day]));
  const spanFor=n=>{const day=n>=from&&n<=to?days.get(n):null;return 1+(day&&!day.travel_order?(day.aja_periods||[]).length:0);};
  const reportCell=(n,span)=>{
    if(!gip)return '';
    if(n===16){
      const certSpan=Array.from({length:12},(_,i)=>spanFor(i+16)).reduce((a,b)=>a+b,0);
      return '<td class="gip-weekend-cert" rowspan="'+certSpan+'"><div class="gip-cert-title">CERTIFICATION FOR WORK RENDERED ON<br>WEEKENDS/HOLIDAYS</div><div class="gip-cert-body"><p>This is to certify that the intern is authorized and required to report to work on:</p><div class="gip-cert-dates"><span>Date/s:</span><div><i></i><i></i><i></i></div></div><div class="gip-cert-purpose">Purpose:</div></div></td>';
    }
    return n>16&&n<=27?'':'<td class="gip-accomplishment-line" rowspan="'+span+'"></td>';
  };
  return Array.from({length:31},(_,i)=>{
    const n=i+1,day=n>=from&&n<=to?days.get(n):null;
    if(!day)return '<tr><td>'+n+'</td>'+ '<td></td>'.repeat(4+metricsCols)+reportCell(n,1)+'</tr>';
    const periods=day.travel_order?[]:(day.aja_periods||[]);
    const slots=day.display_slots||{};
    const hasEntries=day.has_attendance_entries||Object.values(slots).some(Boolean);
    const weekday=new Date(day.date+'T00:00:00Z').getUTCDay();
    const offday=day.is_weekend||weekday===0||weekday===6||Boolean(day.calendar?.holiday_name);
    const note=day.manual_source?.notes?.find(x=>/\b(?:LEAVE|CTO|WORK SUSPENSION)\b/i.test(x));
    const special=day.travel_order?travelLabel(day):
      (!hasEntries&&!periods.length?((day.calendar?.holiday_name?'HOLIDAY':'')||note||(day.is_weekend?(day.day==='Sat'?'SATURDAY':'SUNDAY'):'')):'');
    const span=periods.length+1,ut=offday?null:day.monitoring?.undertime_seconds;
    // Leave both printed undertime cells empty unless a positive duration exists.
    const showUndertime=Number.isFinite(ut)&&ut>0;
    const total=day.monitoring?.total_seconds;
    const metricCells=gip?'<td rowspan="'+span+'">'+(total==null||(!hasEntries&&!periods.length)?'':esc(durationText(total).slice(0,-3)))+'</td>':
      '<td class="print-undertime" rowspan="'+span+'">'+(!showUndertime?'':Math.floor(ut/3600))+'</td><td class="print-undertime" rowspan="'+span+'">'+(!showUndertime?'':Math.floor(ut%3600/60))+'</td>';
    return '<tr'+(offday?' class="print-offday"':'')+'><td rowspan="'+span+'">'+n+'</td>'+
      (special?'<td colspan="4" class="special-day">'+esc(special)+'</td>':['am_in','am_out','pm_in','pm_out'].map(k=>'<td>'+dtrClock(slots[k],!gip)+'</td>').join(''))+
      metricCells+reportCell(n,span)+'</tr>'+periods.map(p=>'<tr class="print-aja"><td colspan="2">AJA OUT '+dtrAjaClock(p.out)+'</td><td colspan="2">AJA '+(p.in?.origin==='biometric'?'IN':'END')+' '+dtrAjaClock(p.in)+'</td></tr>').join('');
  }).join('');
}
function civilDtrCopy(data,category){
  const signer=dtrSignatory[category],name=esc(String(data.display_name||'').toUpperCase());
  const blankRow='<table class="form-spacer" aria-hidden="true"><tbody><tr>'+'<td></td>'.repeat(7)+'</tr></tbody></table>';
  return '<section class="civil-copy civil-'+category.toLowerCase()+'"><div class="form-number">Civil Service Form No. 48</div>'+
    '<header class="civil-header"><img class="print-seal" src="/static/images/ncsc-seal.jpg" alt="NCSC seal"><div>Republic of the Philippines</div><b class="print-agency">NATIONAL COMMISSION OF SENIOR CITIZENS</b><div>29th Floor, The Upper Class Tower, Corner Scout Reyes, Quezon Ave., Brgy Paligsahan,<br>Quezon City</div><div class="print-email">Email address: ph.ncsc@gmail.com</div></header>'+
    '<h1>DAILY TIME RECORD</h1><div class="print-name">'+name+'</div><div class="name-label">(Name)</div>'+blankRow+
    '<table class="form-meta form-dates"><colgroup><col style="width:27%"><col style="width:33%"><col style="width:7%"><col style="width:33%"></colgroup><tbody>'+
    '<tr><td>For the month of</td><td class="date-value date-start">'+esc(dtrDateLabel(data.month,1))+'</td><td class="date-value">-</td><td class="date-value date-end">'+esc(dtrDateLabel(data.month,dtrLastDay(data.month)))+'</td></tr></tbody></table>'+
    '<table class="form-meta form-schedule"><colgroup><col style="width:60%"><col style="width:21%"><col style="width:19%"></colgroup><tbody>'+
    '<tr><td rowspan="2">Official hours for arrival and departure</td><td>Regular days</td><td></td></tr><tr><td>Saturdays</td><td></td></tr></tbody></table>'+blankRow+
    '<table class="civil-grid"><colgroup><col style="width:8%"><col span="4" style="width:15.5%"><col span="2" style="width:15%"></colgroup><thead><tr><th rowspan="2">Day</th><th colspan="2">A.M.</th><th colspan="2">P.M.</th><th colspan="2">UNDERTIME</th></tr><tr><th>IN</th><th>OUT</th><th>IN</th><th>OUT</th><th>Hours</th><th>Minutes</th></tr></thead><tbody>'+dtrPrintRows(data,category)+'</tbody></table>'+
    '<p class="certification">I certify on my honor that the above is a true and correct report of the hours of work performed, record of which was made daily at the time of arrival and departure from office.</p><div class="signature-line">Signature</div><p class="verification">Verified as to the prescribed office hours:</p><div class="signatory">'+esc(signer[0])+'</div><div class="signatory-role">'+esc(signer[1])+'</div></section>';
}
function gipDtrForm(data,period){
  const last=dtrLastDay(data.month),from=period==='second'?16:1,to=period==='first'?15:last;
  const name=esc(String(data.display_name||'').toUpperCase());
  const department=esc(String(data.department||'').toUpperCase());
  return '<section class="gip-form"><header class="gip-header"><div class="gip-heading">DEPARTMENT OF LABOR AND EMPLOYMENT<br>Regional Office No. 1<br>GOVERNMENT INTERNSHIP PROGRAM</div><div class="gip-revision">GIP RO1 Standard DTR Form<br>Rev 2 - 28 January 2025</div></header>'+
    '<div class="gip-meta"><div class="gip-meta-left"><div class="gip-meta-row"><b>NAME:</b><strong class="gip-name">'+name+'</strong></div><div class="gip-meta-row"><b>PARTNER AGENCY:</b><strong>NATIONAL COMMISSION OF SENIOR CITIZENS - RO1</strong></div><div class="gip-meta-row"><b>OFFICE OF ASSIGNMENT:</b><strong>'+department+'</strong></div></div>'+
    '<div class="gip-meta-right"><div class="gip-meta-row"><b>For the Period:</b><strong class="gip-period">'+esc(dtrDateLabel(data.month,from))+' - '+esc(dtrDateLabel(data.month,to))+'</strong></div><div class="gip-meta-row"><b>LBP Account Number:</b><strong class="gip-account"></strong></div></div></div>'+
    '<table class="gip-grid"><colgroup><col style="width:4.5%"><col span="4" style="width:9%"><col style="width:10.5%"><col style="width:49%"></colgroup><thead>'+
    '<tr><th colspan="6" class="gip-section-title">DAILY TIME RECORD (DTR)</th><th class="gip-section-title">GIP ACCOMPLISHMENT REPORT<br>(Please attach additional sheet, if necessary)</th></tr>'+
    '<tr><th class="gip-days-heading"></th><th colspan="2">MORNING</th><th colspan="2">AFTERNOON</th><th>Daily</th><td></td></tr>'+
    '<tr><th class="gip-days-heading">DAYS</th><th>IN</th><th>OUT</th><th>IN</th><th>OUT</th><th>Total</th><td></td></tr></thead><tbody>'+dtrPrintRows(data,'GIP',from,to)+'</tbody></table>'+
    '<p class="gip-declaration">I hereby certify that the above records are true &amp; correct</p><div class="gip-columns gip-signatures"><div>Prepared By:<div class="gip-signature">'+name+'</div><div>PRINTED NAME AND SIGNATURE OF INTERN</div></div><div>Certified by:<div class="gip-signature">'+esc(dtrSignatory.GIP[0])+'</div><div>PRINTED NAME AND SIGNATURE OF SUPERVISOR</div></div></div>'+
    '<div class="gip-review"><div class="gip-review-title">To be filled-up by FO</div><div class="gip-review-grid"><div class="gip-review-fields"><div><b>Total No. of Working Days:</b><span></span></div><div>No. of Absences:<span></span></div><div>Tardiness:<span></span></div><div class="gip-undertime">Undertime:<span></span></div><div class="gip-total-worked"><b>TOTAL DAYS WORKED</b><span></span></div></div><div class="gip-checked">Checked by:<div></div></div></div></div></section>';
}
function buildDtrDocument(data,category,period,paperKey,version){
  const paper=dtrPaper[paperKey]||dtrPaper.a4;
  const body=category==='GIP'?gipDtrForm(data,period):civilDtrCopy(data,category)+civilDtrCopy(data,category);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DTR - '+esc(data.display_name||'')+' - '+esc(data.month)+'</title><link rel="stylesheet" href="/static/dtr-preview.css?v=6"><style>@page{size:'+paper.width+' '+paper.height+';margin:'+DTR_NARROW_MM+'mm} :root{--paper-width:'+paper.width+';--paper-height:'+paper.height+';--paper-margin:'+DTR_NARROW_MM+'mm;--content-width:'+(paper.w-2*DTR_NARROW_MM)+'mm;--content-height:'+(paper.h-2*DTR_NARROW_MM)+'mm}</style></head><body class="print-document" data-preview-version="'+version+'"><main class="print-content"><div class="print-layout '+(category==='GIP'?'gip-page':'civil-page')+'">'+body+'</div></main></body></html>';
}
function freshDtrFrame(){
  // Replacing the browsing context avoids accumulating iframe history entries
  // when a user changes category, period, or paper size.
  const frame=document.createElement('iframe');
  frame.id='dtr-preview-frame';frame.title='Printable daily time record';frame.hidden=true;frame.setAttribute('scrolling','no');
  frame.addEventListener('load',()=>finishDtrFrame(frame));
  $('dtr-preview-frame').replaceWith(frame);
  return frame;
}
function setDtrPreviewNote(message=''){
  const note=$('dtr-preview-note');
  note.textContent=message;note.hidden=!message;
}
function setDtrActionsReady(ready){
  $('dtr-preview-print').disabled=!ready||dtrDownloadBusy;
  $('dtr-preview-download').disabled=!ready||dtrDownloadBusy;
}
function fitDtrPaper(){
  const canvas=$('dtr-paper-canvas'),frame=$('dtr-preview-frame');
  if(canvas.hidden||frame.hidden)return;
  const stage=canvas.parentElement,paper=dtrPaper[$('dtr-preview-paper').value]||dtrPaper.a4;
  const style=getComputedStyle(stage);
  const available=stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  const availableHeight=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
  const width=Math.ceil(paper.w*96/25.4),height=Math.ceil(paper.h*96/25.4);
  const scale=dtrZoomMode==='fit'?Math.min(1,Math.max(.05,Math.min(available/width,availableHeight/height))):dtrZoomScale;
  dtrZoomScale=scale;
  canvas.style.width=(width*scale)+'px';canvas.style.height=(height*scale)+'px';
  frame.style.width=width+'px';frame.style.height=height+'px';frame.style.transform='scale('+scale+')';
  $('dtr-zoom-value').textContent=Math.round(scale*100)+'%';
  $('dtr-zoom-fit').setAttribute('aria-pressed',String(dtrZoomMode==='fit'));
  $('dtr-zoom-out').disabled=scale<=DTR_MIN_ZOOM;
  $('dtr-zoom-in').disabled=scale>=DTR_MAX_ZOOM;
}
function changeDtrZoom(direction){
  if($('dtr-paper-canvas').hidden)return;
  const stage=$('dtr-paper-canvas').parentElement;
  if(direction===0){
    dtrZoomMode='fit';fitDtrPaper();stage.scrollTop=0;stage.scrollLeft=0;return;
  }
  const old=dtrZoomScale;
  dtrZoomMode='manual';
  dtrZoomScale=Math.min(DTR_MAX_ZOOM,Math.max(DTR_MIN_ZOOM,Math.round((old+direction*.1)*100)/100));
  fitDtrPaper();
  // Keep the viewed region roughly centered while zooming.
  const ratio=dtrZoomScale/old;
  stage.scrollTop=Math.max(0,(stage.scrollTop+stage.clientHeight/2)*ratio-stage.clientHeight/2);
  stage.scrollLeft=Math.max(0,(stage.scrollLeft+stage.clientWidth/2)*ratio-stage.clientWidth/2);
}
function renderDtrPreview(){
  const frame=freshDtrFrame(),category=$('dtr-preview-template').value,period=$('dtr-preview-period').value,paperKey=$('dtr-preview-paper').value;
  const paper=dtrPaper[paperKey]||dtrPaper.a4;
  const version=++dtrPreviewVersion;
  setDtrActionsReady(false);
  $('dtr-preview-period-control').hidden=category!=='GIP';
  $('dtr-paper-canvas').parentElement.scrollTop=0;
  $('dtr-paper-canvas').parentElement.scrollLeft=0;
  setDtrPreviewNote();
  $('dtr-zoom-controls').hidden=true;
  if(!dtrPreviewData||!Object.hasOwn(dtrSignatory,category)){
    frame.hidden=true;$('dtr-paper-canvas').hidden=true;
    setDtrPreviewNote('Select the verified employee category to choose the correct form.');
    return;
  }
  frame.hidden=false;$('dtr-paper-canvas').hidden=false;$('dtr-zoom-controls').hidden=false;
  fitDtrPaper();
  frame.srcdoc=buildDtrDocument(dtrPreviewData,category,period,paperKey,version);
}
function openDtrFormPreview(push=true){
  const data=activeDtr;
  if(!session||!data||data.employee_code!==selectedEmployee||data.month!==$('detail-month').value)return;
  const dialog=$('dtr-preview-dialog');
  if(dialog.open)return;
  dtrPreviewData=data;dtrZoomMode='fit';dtrZoomScale=1;
  const category=Object.hasOwn(dtrSignatory,data.employment_type)?data.employment_type:'';
  $('dtr-preview-template').value=category;
  $('dtr-preview-period').value='first';
  $('dtr-preview-name').textContent=data.display_name||'Employee';
  $('dtr-preview-context').textContent=dtrDateLabel(data.month,1).replace(/ 1,/, '');
  dialog.showModal();
  if(push)history.pushState({ncscDtrPreview:true},'', '#employees/dtr-preview');
  renderDtrPreview();
}
function closeDtrPreview(){
  if(!$('dtr-preview-dialog').open)return;
  if(history.state?.ncscDtrPreview)history.back();
  else $('dtr-preview-dialog').close();
}
function initDtrPreview(){
  const dialog=$('dtr-preview-dialog');
  $('dtr-preview-back').addEventListener('click',closeDtrPreview);
  dialog.addEventListener('cancel',e=>{e.preventDefault();closeDtrPreview();});
  dialog.addEventListener('close',()=>{
    dtrPreviewData=null;dtrPreviewVersion++;freshDtrFrame();
    $('dtr-paper-canvas').hidden=true;setDtrPreviewNote();setDtrActionsReady(false);
    if(history.state?.ncscDtrPreview)history.replaceState(null,'','#employees');
  });
  window.addEventListener('popstate',()=>{
    if(dialog.open&&!history.state?.ncscDtrPreview)dialog.close();
    else if(history.state?.ncscDtrPreview&&!dialog.open){
      if(session&&currentPage==='employees'&&activeDtr&&selectedEmployee)openDtrFormPreview(false);
      else history.replaceState(null,'','#'+(titles[currentPage]?currentPage:'employees'));
    }
  });
  for(const id of ['dtr-preview-template','dtr-preview-period','dtr-preview-paper'])$(id).addEventListener('change',renderDtrPreview);
  new ResizeObserver(fitDtrPaper).observe($('dtr-paper-canvas').parentElement);
  $('dtr-zoom-in').addEventListener('click',()=>changeDtrZoom(1));
  $('dtr-zoom-out').addEventListener('click',()=>changeDtrZoom(-1));
  $('dtr-zoom-fit').addEventListener('click',()=>changeDtrZoom(0));
  $('dtr-preview-download').addEventListener('click',downloadDtrPdf);
  $('dtr-preview-print').addEventListener('click',()=>{
    const frame=$('dtr-preview-frame');
    if(!$('dtr-preview-print').disabled&&dialog.open){frame.contentWindow.focus();frame.contentWindow.print();}
  });
}
function finishDtrFrame(frame){
  const doc=frame.contentDocument;
  if(frame!==$('dtr-preview-frame')||!$('dtr-preview-dialog').open||!doc?.body||doc.body.dataset.previewVersion!==String(dtrPreviewVersion))return;
  // Fit the document including AJA subrows, not the interface, within one
  // physical sheet. No source entries are removed to fit the page.
  const content=doc.querySelector('.print-content'),layout=doc.querySelector('.print-layout');
  const paper=dtrPaper[$('dtr-preview-paper').value]||dtrPaper.a4;
  // Center the complete form vertically, leaving narrow paper margins
  // and a little extra breathing room for even the longest month.
  const available=Math.min(content.clientHeight,(paper.h-2*DTR_NARROW_MM-1)*96/25.4);
  const target=available-8*96/25.4;
  const scale=Math.min(1,target/(layout.getBoundingClientRect().height||1));
  if(scale<1)layout.style.zoom=String(scale);
  fitDtrPaper();
  setDtrActionsReady(true);
}

function loadLocalDtrPdf(frame){
  const win=frame.contentWindow,doc=frame.contentDocument;
  if(typeof win.html2pdf==='function')return Promise.resolve(win.html2pdf);
  return new Promise((resolve,reject)=>{
    const script=doc.createElement('script');
    script.src='/static/vendor/html2pdf.bundle.min.js';
    script.onload=()=>typeof win.html2pdf==='function'?resolve(win.html2pdf):reject(new Error('PDF renderer unavailable.'));
    script.onerror=()=>{script.remove();reject(new Error('Could not load local PDF renderer.'));};
    doc.head.appendChild(script);
  });
}
// Use the final preview's own paper coordinates for both the captured form
// and the decoded logos. Do not measure the temporary html2pdf overlay:
// its layout/zoom can differ from the visible form.
async function buildDtrDownloadCanvas(frame,html2pdf,opts,paper){
  const doc=frame.contentDocument;
  const rendered=doc.querySelector('.print-layout');
  const page=doc.querySelector('.print-content');
  const sources=Array.from(rendered.querySelectorAll('.print-seal'));
  await Promise.all(sources.map(img=>img.decode()));
  if(sources.some(img=>!img.naturalWidth||!img.naturalHeight))throw new Error('NCSC seal unavailable.');
  const pageRect=page.getBoundingClientRect(),formRect=rendered.getBoundingClientRect();
  if(!pageRect.width||!pageRect.height||!formRect.width||!formRect.height)throw new Error('Print layout unavailable.');
  const relativeBox=rect=>({x:(rect.left-pageRect.left)/pageRect.width,
    y:(rect.top-pageRect.top)/pageRect.height,w:rect.width/pageRect.width,h:rect.height/pageRect.height});
  const form=relativeBox(formRect);
  const seals=sources.map(source=>({source,...relativeBox(source.getBoundingClientRect())}));
  const content=rendered.cloneNode(true);
  content.style.zoom='1';
  // Preserve each reserved image box, but avoid the clone's unreliable
  // image loading. Both seals are drawn onto the FINAL page, not the
  // temporary capture, with normalized paper-relative coordinates.
  content.querySelectorAll('.print-seal').forEach(img=>{img.style.visibility='hidden';});
  const worker=html2pdf().set(opts).from(content).toContainer();
  const container=await worker.get('container');
  const overlay=container.parentElement;
  let captured;
  try{captured=await worker.toCanvas().get('canvas');}
  finally{if(overlay?.isConnected)overlay.remove();}
  if(!captured.width||!captured.height)throw new Error('Empty PDF capture.');
  const w=paper.w-2*DTR_NARROW_MM,h=paper.h-2*DTR_NARROW_MM;
  const canvas=doc.createElement('canvas');
  canvas.width=Math.round(w*96/25.4*3);
  // Avoid a one-pixel overflow producing a second PDF page.
  canvas.height=Math.max(1,Math.floor(canvas.width*h/w)-2);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  const W=canvas.width,H=canvas.height;
  ctx.drawImage(captured,form.x*W,form.y*H,form.w*W,form.h*H);
  for(const box of seals){
    const bw=box.w*W,bh=box.h*H;
    const scale=Math.min(bw/box.source.naturalWidth,bh/box.source.naturalHeight);
    const iw=box.source.naturalWidth*scale,ih=box.source.naturalHeight*scale;
    ctx.drawImage(box.source,box.x*W+(bw-iw)/2,box.y*H+(bh-ih)/2,iw,ih);
  }
  return canvas;
}
async function downloadDtrPdf(){
  if(dtrDownloadBusy||$('dtr-preview-download').disabled||!dtrPreviewData)return;
  const frame=$('dtr-preview-frame'),version=dtrPreviewVersion,data=dtrPreviewData;
  const category=$('dtr-preview-template').value,period=$('dtr-preview-period').value;
  const paper=dtrPaper[$('dtr-preview-paper').value]||dtrPaper.a4;
  const button=$('dtr-preview-download');
  const selectors=['dtr-preview-template','dtr-preview-period','dtr-preview-paper'];
  dtrDownloadBusy=true;setDtrActionsReady(false);button.setAttribute('aria-busy','true');
  selectors.forEach(id=>$(id).disabled=true);
  setDtrPreviewNote();
  try{
    const html2pdf=await loadLocalDtrPdf(frame);
    if(version!==dtrPreviewVersion)return;
    const safeName=String(data.display_name||'Employee').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').trim().slice(0,100)||'Employee';
    const filename='DTR - '+safeName+' - '+data.month+' - '+category+(category==='GIP'?' - '+period:'')+'.pdf';
    const opts={filename,margin:DTR_NARROW_MM,image:{type:'png'},enableLinks:false,pagebreak:{mode:[]},
      html2canvas:{scale:3,backgroundColor:'#fff',logging:false,windowWidth:Math.ceil(paper.w*96/25.4),windowHeight:Math.ceil(paper.h*96/25.4)},
      jsPDF:{unit:'mm',format:[paper.w,paper.h],orientation:'portrait',compress:true}};
    const canvas=await buildDtrDownloadCanvas(frame,html2pdf,opts,paper);
    if(version!==dtrPreviewVersion)return;
    await html2pdf().set(opts).from(canvas).save();
    if(version===dtrPreviewVersion)setDtrPreviewNote();
  }catch(error){
    if(version===dtrPreviewVersion)setDtrPreviewNote('PDF download failed. Use Print and choose Save as PDF, or try downloading again.');
  }finally{
    dtrDownloadBusy=false;button.removeAttribute('aria-busy');
    selectors.forEach(id=>$(id).disabled=false);
    const current=$('dtr-preview-frame');
    if($('dtr-preview-dialog').open&&!current.hidden&&current.contentDocument?.body?.dataset.previewVersion===String(dtrPreviewVersion))setDtrActionsReady(true);
  }
}
