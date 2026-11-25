'use strict';
// Category-specific document renderer. The printable frame uses the same
// authenticated monthly attendance snapshot as the employee detail view.
let dtrPreviewData=null;
let dtrPreviewVersion=0;
let dtrDownloadBusy=false;
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
  return Array.from({length:31},(_,i)=>{
    const n=i+1,day=n>=from&&n<=to?days.get(n):null;
    if(!day)return '<tr><td>'+n+'</td>'+ '<td></td>'.repeat(4+metricsCols)+'</tr>';
    const periods=day.travel_order?[]:(day.aja_periods||[]);
    const slots=day.display_slots||{};
    const hasEntries=day.has_attendance_entries||Object.values(slots).some(Boolean);
    const offday=day.is_weekend||Boolean(day.calendar?.holiday_name);
    const note=day.manual_source?.notes?.find(x=>/\b(?:LEAVE|CTO|WORK SUSPENSION)\b/i.test(x));
    const special=day.travel_order?travelLabel(day):
      (!hasEntries&&!periods.length?(day.calendar?.holiday_name||note||(day.is_weekend?(day.day==='Sat'?'SATURDAY':'SUNDAY'):'')):'');
    const span=periods.length+1,ut=offday?null:day.monitoring?.undertime_seconds;
    const total=day.monitoring?.total_seconds;
    const metricCells=gip?'<td rowspan="'+span+'">'+(total==null?'':esc(durationText(total).slice(0,-3)))+'</td>':
      '<td rowspan="'+span+'">'+(ut==null?'':Math.floor(ut/3600))+'</td><td rowspan="'+span+'">'+(ut==null?'':Math.floor(ut%3600/60))+'</td>';
    return '<tr><td rowspan="'+span+'">'+n+'</td>'+
      (special?'<td colspan="4" class="special-day">'+esc(special)+'</td>':['am_in','am_out','pm_in','pm_out'].map(k=>'<td>'+dtrClock(slots[k],!gip)+'</td>').join(''))+
      metricCells+'</tr>'+periods.map(p=>'<tr class="print-aja"><td colspan="2">AJA OUT '+dtrAjaClock(p.out)+'</td><td colspan="2">AJA '+(p.in?.origin==='biometric'?'IN':'END')+' '+dtrAjaClock(p.in)+'</td></tr>').join('');
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
  return '<section class="gip-form"><header class="gip-header">DEPARTMENT OF LABOR AND EMPLOYMENT<br><span>Regional Office No. 1</span><div>GOVERNMENT INTERNSHIP PROGRAM</div></header>'+
    '<div class="gip-meta"><div><p><b>NAME:</b> <strong>'+esc(String(data.display_name||'').toUpperCase())+'</strong></p><p><b>PARTNER AGENCY:</b> <strong>NATIONAL COMMISSION OF SENIOR CITIZENS - RO1</strong></p><p><b>OFFICE OF ASSIGNMENT:</b> <strong>'+esc(String(data.department||'').toUpperCase())+'</strong></p></div><div><p><b>For the Period:</b> <b>'+esc(dtrDateLabel(data.month,from))+' - '+esc(dtrDateLabel(data.month,to))+'</b></p><p><b>LBP Account Number:</b> <span class="blank-field"></span></p></div></div>'+
    '<div class="gip-columns"><div><div class="gip-section-title">DAILY TIME RECORD (DTR)</div><table class="gip-grid"><colgroup><col style="width:11%"><col span="4" style="width:17%"><col style="width:21%"></colgroup><thead><tr><th rowspan="2">DAYS</th><th colspan="2">MORNING</th><th colspan="2">AFTERNOON</th><th>Daily</th></tr><tr><th>IN</th><th>OUT</th><th>IN</th><th>OUT</th><th>Total</th></tr></thead><tbody>'+dtrPrintRows(data,'GIP',from,to)+'</tbody></table></div><div class="gip-report"><div class="gip-section-title">GIP ACCOMPLISHMENT REPORT<br><span>(Please attach additional sheet, if necessary)</span></div><div class="gip-report-blank"></div></div></div>'+
    '<p>I hereby certify that the above records are true &amp; correct</p><div class="gip-columns gip-signatures"><div>Prepared By:<div class="gip-signature">'+esc(String(data.display_name||'').toUpperCase())+'</div><div>PRINTED NAME AND SIGNATURE OF INTERN</div></div><div>Certified by:<div class="gip-signature">'+esc(dtrSignatory.GIP[0])+'</div><div>PRINTED NAME AND SIGNATURE OF SUPERVISOR</div></div></div>'+
    '<div class="gip-columns gip-review"><div><b>To be filled-up by FO</b><p><b>Total No. of Working Days:</b> <span class="blank-field"></span></p><p>No. of Absences: <span class="blank-field"></span></p><p>Tardiness: <span class="blank-field"></span></p><p class="gip-undertime">Undertime: <span class="blank-field"></span></p><b>TOTAL DAYS WORKED <span class="blank-field"></span></b></div><div>Checked by:<div class="gip-signature"></div></div></div></section>';
}
function buildDtrDocument(data,category,period,paperKey,version){
  const paper=dtrPaper[paperKey]||dtrPaper.a4;
  const body=category==='GIP'?gipDtrForm(data,period):civilDtrCopy(data,category)+civilDtrCopy(data,category);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DTR - '+esc(data.display_name||'')+' - '+esc(data.month)+'</title><link rel="stylesheet" href="/static/dtr-preview.css?v=3"><style>@page{size:'+paper.width+' '+paper.height+';margin:'+DTR_NARROW_MM+'mm} :root{--paper-width:'+paper.width+';--paper-height:'+paper.height+';--paper-margin:'+DTR_NARROW_MM+'mm;--content-width:'+(paper.w-2*DTR_NARROW_MM)+'mm;--content-height:'+(paper.h-2*DTR_NARROW_MM)+'mm}</style></head><body class="print-document" data-preview-version="'+version+'"><main class="print-content"><div class="print-layout '+(category==='GIP'?'gip-page':'civil-page')+'">'+body+'</div></main></body></html>';
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
  const width=Math.ceil(paper.w*96/25.4),height=Math.ceil(paper.h*96/25.4);
  const scale=Math.min(1,Math.max(.01,available/width));
  canvas.style.width=(width*scale)+'px';canvas.style.height=(height*scale)+'px';
  frame.style.width=width+'px';frame.style.height=height+'px';frame.style.transform='scale('+scale+')';
}
function renderDtrPreview(){
  const frame=freshDtrFrame(),category=$('dtr-preview-template').value,period=$('dtr-preview-period').value,paperKey=$('dtr-preview-paper').value;
  const paper=dtrPaper[paperKey]||dtrPaper.a4;
  const version=++dtrPreviewVersion;
  setDtrActionsReady(false);
  $('dtr-preview-period-control').hidden=category!=='GIP';
  $('dtr-paper-canvas').parentElement.scrollTop=0;
  setDtrPreviewNote();
  if(!dtrPreviewData||!Object.hasOwn(dtrSignatory,category)){
    frame.hidden=true;$('dtr-paper-canvas').hidden=true;
    setDtrPreviewNote('Select the verified employee category to choose the correct form.');
    return;
  }
  frame.hidden=false;$('dtr-paper-canvas').hidden=false;
  fitDtrPaper();
  frame.srcdoc=buildDtrDocument(dtrPreviewData,category,period,paperKey,version);
}
function openDtrFormPreview(push=true){
  const data=activeDtr;
  if(!session||!data||data.employee_code!==selectedEmployee||data.month!==$('detail-month').value)return;
  const dialog=$('dtr-preview-dialog');
  if(dialog.open)return;
  dtrPreviewData=data;
  const category=Object.hasOwn(dtrSignatory,data.employment_type)?data.employment_type:'';
  $('dtr-preview-template').value=category;
  $('dtr-preview-period').value='first';
  $('dtr-preview-name').textContent=data.display_name||'Employee';
  $('dtr-preview-context').textContent=dtrDateLabel(data.month,1).replace(/ 1,/,',');
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
async function downloadDtrPdf(){
  if(dtrDownloadBusy||$('dtr-preview-download').disabled||!dtrPreviewData)return;
  const frame=$('dtr-preview-frame'),version=dtrPreviewVersion,data=dtrPreviewData;
  const category=$('dtr-preview-template').value,period=$('dtr-preview-period').value;
  const paper=dtrPaper[$('dtr-preview-paper').value]||dtrPaper.a4;
  const button=$('dtr-preview-download');
  const selectors=['dtr-preview-template','dtr-preview-period','dtr-preview-paper'];
  dtrDownloadBusy=true;setDtrActionsReady(false);button.setAttribute('aria-busy','true');
  selectors.forEach(id=>$(id).disabled=true);
  setDtrPreviewNote('Preparing PDF…');
  try{
    const html2pdf=await loadLocalDtrPdf(frame);
    if(version!==dtrPreviewVersion)return;
    const doc=frame.contentDocument;
    const rendered=doc.querySelector('.print-layout');
    const content=rendered.cloneNode(true);
    const fittedWidth=rendered.getBoundingClientRect().width;
    // Capture at the original font sizes. Fit the full rendered form within
    // one physical page afterwards rather than dropping attendance rows.
    content.style.zoom='1';
    const safeName=String(data.display_name||'Employee').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').trim().slice(0,100)||'Employee';
    const filename='DTR - '+safeName+' - '+data.month+' - '+category+(category==='GIP'?' - '+period:'')+'.pdf';
    const opts={filename,margin:DTR_NARROW_MM,image:{type:'png'},enableLinks:false,pagebreak:{mode:[]},
      html2canvas:{scale:3,backgroundColor:'#fff',logging:false,windowWidth:Math.ceil(paper.w*96/25.4),windowHeight:Math.ceil(paper.h*96/25.4)},
      jsPDF:{unit:'mm',format:[paper.w,paper.h],orientation:'portrait',compress:true}};
    const captured=await html2pdf().set(opts).from(content).toCanvas().get('canvas');
    if(version!==dtrPreviewVersion)return;
    const w=paper.w-2*DTR_NARROW_MM,h=paper.h-2*DTR_NARROW_MM;
    const canvas=doc.createElement('canvas');canvas.width=Math.max(1,captured.width);
    // Leave two pixels of rounding tolerance to avoid an extra blank PDF page.
    canvas.height=Math.max(1,Math.floor(canvas.width*h/w)-2);
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    // Match the preview's physical width and fit-to-page scale, then
    // center vertically in the available area rather than top-aligning.
    const physicalWidth=w*96/25.4;
    const scale=Math.min(canvas.width/captured.width,canvas.height/captured.height,
      (fittedWidth/physicalWidth)*canvas.width/captured.width);
    const cw=captured.width*scale,ch=captured.height*scale;
    ctx.drawImage(captured,(canvas.width-cw)/2,(canvas.height-ch)/2,cw,ch);
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
