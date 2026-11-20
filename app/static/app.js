'use strict';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => '<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#' + name.replace(/[^a-z]/g, '') + '"></use></svg>';
let session = null;
let currentPage = 'overview';
let toastTimer;
let punchOffset = 0;
let punchRequest = 0;
let selectedFile = null;
let fileVersion = 0;
let previewReady = false;
let importBusy = false;
let pendingDecision = null;
const pageSize = 25;
const pages = {
  overview: ['Overview', 'YOUR WORKDAY, AT A GLANCE', 'A clear view of your attendance records and official activities.'],
  attendance: ['Attendance logs', 'EVERY SCAN, IN ONE PLACE', 'Browse original device events by employee and date.'],
  imports: ['USB imports', 'FROM DEVICE TO WORKSPACE', 'Preview your files and bring in original attendance records.'],
  fieldwork: ['AJA & fieldwork', 'SERVICE BEYOND THE OFFICE', 'Keep official activities organized, with a clear review trail.']
};

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => { node.outerHTML = icon(node.dataset.icon); });
}
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').className = error ? 'toast error' : 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000);
}
function localDate(value, options = {}) {
  // Raw device strings represent Manila wall time; an explicit offset avoids host timezone shifts.
  let text = String(value).replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T12:00:00';
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text += '+08:00';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-PH', {timeZone:'Asia/Manila', day:'numeric', month:'short', year:'numeric', ...options});
}
function dayLabel(value) {
  return new Date(value.slice(0, 10) + 'T12:00:00+08:00').toLocaleDateString('en-PH', {timeZone:'Asia/Manila', weekday:'short'});
}
function openDialog(id) { if (!$(id).open) $(id).showModal(); }
function openLogin() {
  $('login-error').classList.add('hidden');
  $('login-help-text').classList.add('hidden');
  $('login-password').value = '';
  $('login-password').type = 'password';
  $('toggle-password').setAttribute('aria-label', 'Show password');
  $('toggle-password').setAttribute('aria-pressed', 'false');
  openDialog('login-dialog');
  $('login-username').focus();
}

async function api(path, options = {}) {
  if (session?.demo) return demoResponse(path, options);
  const headers = new Headers(options.headers || {});
  if (session?.csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', session.csrf);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {credentials:'same-origin', ...options, headers});
  let result;
  try { result = await response.json(); } catch (_) { result = {}; }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login') && !path.endsWith('/me')) {
      session = null; showAuth(); openLogin();
    }
    let detail = result.detail || 'Request failed (' + response.status + '). Please try again.';
    if (Array.isArray(detail)) detail = detail.map(x => x.msg).join('; ');
    throw new Error(String(detail));
  }
  return result;
}

function resetFile() {
  selectedFile = null; fileVersion++; previewReady = false;
  $('attendance-file').value = '';
  $('file-name').textContent = 'No file selected';
  $('preview-output').innerHTML = '';
  $('preview-output').classList.add('hidden');
  $('import-submit').disabled = true;
}
function showAuth() {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('login-view').classList.remove('hidden'); $('workspace').classList.add('hidden');
  $('login-form').reset(); $('fieldwork-form').reset(); $('filter-form').reset(); resetFile();
  $('punch-rows').innerHTML = ''; $('fieldwork-items').innerHTML = ''; $('recent-imports').innerHTML = '';
  $('activity-chart').innerHTML = '';
  for (const key of ['scans','employees','imports','pending']) $('metric-' + key).textContent = '—';
  $('toast').classList.add('hidden');
  document.title = 'NCSC | Biometric Attendance';
}
function showWorkspace() {
  $('login-dialog').close(); $('login-form').reset();
  $('login-view').classList.add('hidden'); $('workspace').classList.remove('hidden');
  $('account').textContent = session.demo ? 'Sample preview' : session.username;
  $('account-avatar').textContent = session.demo ? 'P' : session.username.slice(0, 1).toUpperCase();
  $('account-role').textContent = session.demo ? 'Explore the workspace' : session.role === 'admin' ? 'Administrator' : 'Reviewer';
  $('logout').innerHTML = icon('logout') + (session.demo ? ' Exit preview' : ' Sign out');
  $('demo-banner').classList.toggle('hidden', !session.demo);
  const canWrite = session.role === 'admin' && !session.demo;
  $('preview-btn').disabled = !canWrite;
  $('fieldwork-form').querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = !canWrite; });
  $('import-access-note').classList.toggle('hidden', canWrite);
  resetFile();
  const hashPage = location.hash.slice(1);
  navigate(pages[hashPage] ? hashPage : 'overview');
}
function navigate(page) {
  if (!session || !pages[page]) return;
  currentPage = page;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('hidden', el.dataset.view !== page));
  document.querySelectorAll('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
    if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $('page-heading').textContent = pages[page][0]; $('current-location').textContent = pages[page][0];
  $('page-eyebrow').textContent = pages[page][1]; $('page-description').textContent = pages[page][2];
  $('heading-action').classList.toggle('hidden', page === 'imports' || page === 'fieldwork');
  $('main-content').scrollTop = 0;
  history.replaceState(null, '', '#' + page);
  document.title = pages[page][0] + ' | NCSC Attendance';
  if (page === 'overview') loadOverview();
  if (page === 'attendance') { punchOffset = 0; loadPunches(); }
  if (page === 'fieldwork') loadFieldwork();
}

function renderChart(days) {
  if (!days?.length) {
    $('activity-chart').innerHTML = '<div class="empty">Import an attendance file to see daily scan activity.</div>';
    $('chart-period').textContent = 'Latest seven days of imported records'; return;
  }
  const max = Math.max(...days.map(d => d.scans), 1);
  $('chart-period').textContent = localDate(days[0].date + ' 12:00:00') + ' – ' + localDate(days.at(-1).date + ' 12:00:00');
  $('activity-chart').innerHTML = '<div class="chart-bars" role="img" aria-label="' + escapeHtml(days.map(d => d.date + ': ' + d.scans + ' scans').join('; ')) + '">' + days.map(d => '<div class="chart-column"><div class="chart-bar-track"><div class="chart-bar" style="--bar-height:' + Math.max(1, Math.round(d.scans / max * 82)) + '%"><span class="chart-value">' + Number(d.scans) + '</span></div></div><span class="chart-date">' + dayLabel(d.date) + '</span></div>').join('') + '</div>';
}
async function loadOverview() {
  const context = session;
  try {
    const result = await api('/api/overview');
    if (context !== session) return;
    for (const key of ['scans','employees','imports','pending']) $('metric-' + key).textContent = Number(result.totals[key] || 0).toLocaleString();
    $('nav-pending').textContent = Number(result.totals.pending);
    $('nav-pending').classList.toggle('hidden', !result.totals.pending);
    renderChart(result.daily_scans);
    $('recent-imports').className = '';
    $('recent-imports').innerHTML = result.recent_imports.length ? result.recent_imports.map(item => '<div class="import-row"><span class="file-icon">' + icon('file') + '</span><div><strong>' + escapeHtml(item.original_name) + '</strong><small>' + escapeHtml(localDate(item.imported_at + 'Z')) + ' · ' + Number(item.total_records).toLocaleString() + ' rows processed</small></div><b>+' + Number(item.inserted_records).toLocaleString() + ' new scans</b></div>').join('') : '<div class="empty">No imports yet. Choose USB imports to preview your first attendance file.</div>';
  } catch (error) { if (context === session) toast(error.message, true); }
}
async function loadPunches() {
  const context = session; const requestId = ++punchRequest;
  const params = new URLSearchParams({limit:pageSize, offset:punchOffset, employee_code:$('filter-id').value.trim()});
  if ($('filter-from').value) params.set('date_from', $('filter-from').value);
  if ($('filter-to').value) params.set('date_to', $('filter-to').value);
  $('punch-rows').innerHTML = '<tr><td colspan="6">Loading attendance records…</td></tr>';
  $('prev-punches').disabled = true; $('next-punches').disabled = true;
  try {
    const result = await api('/api/punches?' + params);
    if (context !== session || requestId !== punchRequest) return;
    $('punch-rows').innerHTML = result.items.length ? result.items.map(item => '<tr><td>' + escapeHtml(item.employee_code) + '</td><td><span class="scan-date">' + escapeHtml(localDate(item.happened_at)) + ' <strong>' + escapeHtml(item.happened_at.slice(11)) + '</strong></span><span class="scan-day">' + dayLabel(item.happened_at) + ' · Manila time</span></td><td>' + escapeHtml(item.device_id) + '</td><td><span class="tag blue-tag">' + escapeHtml(item.status_code) + '</span></td><td>' + escapeHtml(item.verification_code) + '</td><td>' + escapeHtml(item.work_code) + '</td></tr>').join('') : '<tr><td colspan="6">No matching scans. Try another employee ID or date range.</td></tr>';
    $('punch-count').textContent = result.total ? (punchOffset + 1) + '–' + (punchOffset + result.items.length) + ' of ' + result.total.toLocaleString() + ' records · Raw device codes' : '0 matching records';
    $('prev-punches').disabled = punchOffset === 0; $('next-punches').disabled = punchOffset + pageSize >= result.total;
  } catch (error) {
    if (context !== session || requestId !== punchRequest) return;
    $('punch-rows').innerHTML = '<tr><td colspan="6">Records could not be loaded. Adjust your filters and try again.</td></tr>';
    $('punch-count').textContent = 'Unable to load records'; toast(error.message, true);
  }
}

function chooseFile(file) {
  resetFile();
  if (!file) return;
  if (!/\.(dat|txt|xls)$/i.test(file.name)) { toast('Choose a .dat, .txt, or .xls file.', true); return; }
  if (!file.size || file.size > 2 * 1024 * 1024) { toast('Choose a nonempty file up to 2 MB.', true); return; }
  selectedFile = file; $('file-name').textContent = file.name;
}
function previewStat(label, value) {
  return '<div class="preview-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
}
async function handleImport(previewOnly) {
  if (importBusy) return;
  if (!selectedFile) { toast('Choose an attendance file first.', true); return; }
  if (!previewOnly && !previewReady) { toast('Preview the selected source log before importing.', true); return; }
  const context = session; const version = fileVersion;
  const data = new FormData(); data.append('file', selectedFile);
  importBusy = true; $('preview-btn').disabled = true; $('import-submit').disabled = true;
  $('preview-btn').textContent = previewOnly ? 'Reading file…' : 'Saving records…';
  try {
    const result = await api(previewOnly ? '/api/imports/preview' : '/api/imports', {method:'POST', body:data});
    if (context !== session || version !== fileVersion) return;
    const output = $('preview-output'); output.classList.remove('hidden');
    if (previewOnly && result.format === 'report') {
      previewReady = false;
      output.innerHTML = '<h3>Excel report preview</h3><div class="preview-grid">' + previewStat('Employee IDs in report', result.employees) + previewStat('Report period', result.period) + '</div><ul class="report-sheets">' + result.sheets.map(s => '<li>' + escapeHtml(s.name) + ' · ' + Number(s.rows) + ' rows</li>').join('') + '</ul><p class="inline-help">Report preview only. Nothing was saved. Use the original _attlog.dat file to import exact source scans.</p>';
    } else if (previewOnly) {
      previewReady = !result.already_imported;
      output.innerHTML = '<h3>Source log preview</h3><div class="preview-grid">' + previewStat('Scan records', result.rows.toLocaleString()) + previewStat('Employee IDs', result.employees) + previewStat('First scan', result.earliest) + previewStat('Last scan', result.latest) + '</div><p class="inline-help">' + (result.already_imported ? 'This exact file has already been imported.' : 'Nothing saved yet. Review the details, then select Import records.') + '<br>Raw status codes: ' + result.codes.map(escapeHtml).join(', ') + '</p>';
    } else {
      previewReady = false;
      output.innerHTML = '<h3>Import complete</h3><div class="preview-grid">' + previewStat('New scans', result.inserted.toLocaleString()) + previewStat('Duplicates skipped', result.duplicates.toLocaleString()) + '</div><p class="inline-help">Original K14 scans remain unchanged. Open Attendance logs to review your records.</p>';
      toast('Attendance imported successfully.'); loadOverview();
    }
  } catch (error) {
    if (context === session && version === fileVersion) { previewReady = false; $('preview-output').classList.add('hidden'); toast(error.message, true); }
  } finally {
    importBusy = false; $('preview-btn').innerHTML = icon('eye') + ' Preview file';
    $('preview-btn').disabled = session?.role !== 'admin' || Boolean(session?.demo);
    $('import-submit').disabled = !previewReady;
  }
}

async function loadFieldwork() {
  const context = session;
  try {
    const result = await api('/api/fieldwork');
    if (context !== session) return;
    const filter = $('request-status').value;
    const items = result.items.filter(item => filter === 'all' || item.status === filter);
    $('fieldwork-items').innerHTML = items.length ? items.map(item => {
      const actions = item.status === 'pending' && context.role === 'admin' && !context.demo ? '<div class="request-buttons"><button class="btn primary" data-decision="approved" data-id="' + Number(item.id) + '">Approve</button><button class="btn outline" data-decision="rejected" data-id="' + Number(item.id) + '">Reject</button></div>' : '';
      return '<div class="request"><div class="request-head"><strong>' + escapeHtml(item.employee_code) + '<span> · ' + escapeHtml(item.category) + '</span></strong><span class="tag ' + escapeHtml(item.status) + '">' + escapeHtml(item.status[0].toUpperCase() + item.status.slice(1)) + '</span></div><p class="request-location">' + icon('pin') + escapeHtml(item.location) + '</p><p class="request-time">' + escapeHtml(localDate(item.start_at)) + ' ' + escapeHtml(item.start_at.slice(11,16)) + ' – ' + escapeHtml(localDate(item.end_at)) + ' ' + escapeHtml(item.end_at.slice(11,16)) + '</p><p>' + escapeHtml(item.reason) + '</p>' + actions + '</div>';
    }).join('') : '<div class="empty">No ' + (filter === 'all' ? '' : escapeHtml(filter) + ' ') + 'activity requests found.</div>';
  } catch (error) { if (context === session) toast(error.message, true); }
}
async function createFieldwork(event) {
  event.preventDefault(); const form = event.currentTarget;
  const context = session;
  const data = Object.fromEntries(new FormData(form));
  if (data.end_at <= data.start_at) { toast('End must be later than start.', true); return; }
  $('fieldwork-submit').disabled = true;
  try {
    await api('/api/fieldwork', {method:'POST', body:JSON.stringify(data)});
    if (context !== session) return;
    form.reset(); $('request-status').value = 'all'; toast('Official activity created as pending.');
    loadFieldwork(); loadOverview();
  } catch (error) { toast(error.message, true); }
  finally { $('fieldwork-submit').disabled = session?.role !== 'admin' || Boolean(session?.demo); }
}
function reviewFieldwork(button) {
  pendingDecision = {id:Number(button.dataset.id), decision:button.dataset.decision};
  if (!['approved','rejected'].includes(pendingDecision.decision) || !Number.isInteger(pendingDecision.id)) return;
  $('decision-heading').textContent = pendingDecision.decision === 'approved' ? 'Approve this activity?' : 'Reject this activity?';
  $('decision-message').textContent = 'Request #' + pendingDecision.id + ' will be marked as ' + pendingDecision.decision + '.';
  $('confirm-decision').textContent = pendingDecision.decision === 'approved' ? 'Approve activity' : 'Reject activity';
  openDialog('decision-dialog');
}
async function confirmDecision() {
  if (!pendingDecision) return;
  const context = session;
  const decision = {...pendingDecision};
  $('confirm-decision').disabled = true;
  try {
    await api('/api/fieldwork/' + decision.id + '/decision', {method:'POST', body:JSON.stringify({decision:decision.decision})});
    if (context !== session) return;
    $('decision-dialog').close(); toast('Activity ' + decision.decision + '.'); pendingDecision = null;
    loadFieldwork(); loadOverview();
  } catch (error) { toast(error.message, true); }
  finally { $('confirm-decision').disabled = false; }
}

// This isolated read-only preview never sends fictional records to the API or stores them.
function demoResponse(path, options) {
  if (options.method && options.method !== 'GET') throw new Error('Sign in to manage office records. This preview is read-only.');
  const url = new URL(path, location.origin);
  const dates = ['2026-11-13','2026-11-14','2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19'];
  const counts = [20,0,0,24,22,24,21];
  const punches = dates.flatMap((date, d) => Array.from({length:counts[d]}, (_, i) => ({id:d*30+i, employee_code:'DEMO' + String(i % 12 + 1).padStart(3,'0'), happened_at:date + (i < 12 ? ' 07:' + String(30+i).padStart(2,'0') + ':00' : ' 17:' + String(5+i).padStart(2,'0') + ':00'), device_id:'1', status_code:i < 12 ? '0' : '4', verification_code:'1', work_code:'0'}))).sort((a,b) => b.happened_at.localeCompare(a.happened_at));
  if (url.pathname === '/api/overview') return {totals:{scans:punches.length, employees:12, imports:2, pending:2}, daily_scans:dates.map((date,i) => ({date, scans:counts[i]})), recent_imports:[{id:2,original_name:'sample_november.txt',total_records:67,inserted_records:67,imported_at:'2026-11-19 02:15:00'}, {id:1,original_name:'sample_week_two.txt',total_records:44,inserted_records:44,imported_at:'2026-11-16 01:30:00'}]};
  if (url.pathname === '/api/punches') {
    const filtered = punches.filter(p => (!url.searchParams.get('employee_code') || p.employee_code === url.searchParams.get('employee_code')) && (!url.searchParams.get('date_from') || p.happened_at.slice(0,10) >= url.searchParams.get('date_from')) && (!url.searchParams.get('date_to') || p.happened_at.slice(0,10) <= url.searchParams.get('date_to')));
    const offset = Number(url.searchParams.get('offset') || 0);
    return {items:filtered.slice(offset, offset + pageSize), total:filtered.length};
  }
  if (url.pathname === '/api/fieldwork') return {items:[{id:3,employee_code:'DEMO003',category:'Fieldwork',location:'Sample regional assignment',reason:'Fictional example: coordination for a senior citizens activity.',start_at:'2026-11-20 09:00:00',end_at:'2026-11-20 16:00:00',status:'pending'}, {id:2,employee_code:'DEMO008',category:'AJA',location:'Sample satellite office',reason:'Fictional example: official off-site assignment.',start_at:'2026-11-19 08:00:00',end_at:'2026-11-19 17:00:00',status:'pending'}, {id:1,employee_code:'DEMO001',category:'Official Business',location:'Sample partner office',reason:'Fictional example: inter-agency coordination meeting.',start_at:'2026-11-18 09:00:00',end_at:'2026-11-18 12:00:00',status:'approved'}]};
  throw new Error('This action requires sign in.');
}

async function initialize() {
  hydrateIcons();
  $('today').textContent = new Date().toLocaleDateString('en-PH', {timeZone:'Asia/Manila',day:'numeric',month:'long',year:'numeric'});
  $('copyright-year').textContent = new Date().getFullYear();
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-login')) openLogin();
    if (button.hasAttribute('data-help')) openDialog('help-dialog');
    if (button.dataset.close) $(button.dataset.close).close();
    if (button.dataset.page || button.dataset.go) navigate(button.dataset.page || button.dataset.go);
    if (button.dataset.decision) reviewFieldwork(button);
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      const box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
    });
  });
  $('login-dialog').addEventListener('close', () => { $('login-password').value = ''; });
  $('toggle-password').addEventListener('click', () => {
    const reveal = $('login-password').type === 'password';
    $('login-password').type = reveal ? 'text' : 'password';
    $('toggle-password').setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    $('toggle-password').setAttribute('aria-pressed', String(reveal));
  });
  $('login-help').addEventListener('click', () => $('login-help-text').classList.toggle('hidden'));
  $('explore-demo').addEventListener('click', () => { session = {username:'preview',role:'preview',demo:true}; showWorkspace(); });
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-submit').disabled = true; $('login-submit').textContent = 'Signing in…'; $('login-error').classList.add('hidden');
    try {
      // A preview session has no API credentials and cannot intercept actual sign-in.
      const prior = session; if (prior?.demo) session = null;
      try { session = await api('/api/login', {method:'POST',body:JSON.stringify({username:$('login-username').value,password:$('login-password').value})}); }
      catch (error) { session = prior; throw error; }
      showWorkspace();
    } catch (error) { $('login-error').textContent = error.message; $('login-error').classList.remove('hidden'); }
    finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Sign in to workspace'; }
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { if (!session?.demo) await api('/api/logout', {method:'POST'}); session = null; showAuth(); }
    catch (error) { toast(error.message, true); }
    finally { $('logout').disabled = false; }
  });
  $('filter-form').addEventListener('submit', event => { event.preventDefault(); punchOffset = 0; loadPunches(); });
  $('clear-filter').addEventListener('click', () => { $('filter-form').reset(); punchOffset = 0; loadPunches(); });
  $('prev-punches').addEventListener('click', () => { punchOffset = Math.max(0,punchOffset-pageSize); loadPunches(); });
  $('next-punches').addEventListener('click', () => { punchOffset += pageSize; loadPunches(); });
  $('attendance-file').addEventListener('change', () => chooseFile($('attendance-file').files[0]));
  $('preview-btn').addEventListener('click', () => handleImport(true));
  $('import-form').addEventListener('submit', event => { event.preventDefault(); handleImport(false); });
  $('attendance-file').addEventListener('focus', () => $('drop-area').classList.add('drag-over'));
  $('attendance-file').addEventListener('blur', () => $('drop-area').classList.remove('drag-over'));
  $('drop-area').addEventListener('dragover', event => { event.preventDefault(); $('drop-area').classList.add('drag-over'); });
  $('drop-area').addEventListener('dragleave', () => $('drop-area').classList.remove('drag-over'));
  $('drop-area').addEventListener('drop', event => { event.preventDefault(); $('drop-area').classList.remove('drag-over'); chooseFile(event.dataTransfer.files[0]); });
  $('fieldwork-form').addEventListener('submit', createFieldwork);
  $('request-status').addEventListener('change', loadFieldwork);
  $('confirm-decision').addEventListener('click', confirmDecision);
  window.addEventListener('hashchange', () => { if (session && pages[location.hash.slice(1)]) navigate(location.hash.slice(1)); });
  try { const restored = await api('/api/me'); if (!session?.demo) { session = restored; showWorkspace(); } }
  catch (_) { if (!session?.demo) showAuth(); }
}
document.addEventListener('DOMContentLoaded', initialize);
