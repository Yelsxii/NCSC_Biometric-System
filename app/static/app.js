'use strict';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/static/icons.svg#' + name.replace(/[^a-z]/g, '') + '"></use></svg>';
let session = null;
let currentPage = 'overview';
let toastTimer;
let punchOffset = 0;
let punchRequest = 0;
let selectedFile = null;
let fileVersion = 0;
let previewReady = false;
let importBusy = false;
let pendingVoid = null;
let activityRequest = 0;
let monitorRequest = 0;
let employeeRequest = 0;
let registryRequest = 0;
let staffRows = [];
let workRows = [];
let rosterFile = null;
let rosterReady = false;
let rosterBusy = false;
let rosterVersion = 0;
const pageSize = 25;
const pages = {
  overview: ['Overview', 'Attendance records and official activities.'],
  attendance: ['Attendance logs', 'Filter source scans by employee or date.'],
  imports: ['USB imports', 'Import original attendance scans; use Excel reports for staff names.'],
  staff: ['Staff & work codes', 'Staff database linked to biometric IDs and device work codes.'],
  fieldwork: ['Activity references', 'Existing AJA, fieldwork and travel orders.'],
  dtr: ['DTR monitoring', 'Check daily scans alongside existing activity references.']
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

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (session?.csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', session.csrf);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response;
  try { response = await fetch(path, {credentials:'same-origin', ...options, headers}); }
  catch (_) { throw new Error('Cannot reach the local server. Start the application, then retry.'); }
  let result;
  try { result = await response.json(); } catch (_) { result = {}; }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login') && !path.endsWith('/me')) {
      session = null; showAuth();
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
  $('import-error').classList.add('hidden'); $('import-error').textContent = '';
  $('view-imported').classList.add('hidden'); $('report-staff').classList.add('hidden');
}
function showAuth() {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('login-view').classList.remove('hidden'); $('workspace').classList.add('hidden');
  $('login-form').reset(); $('fieldwork-form').reset(); $('filter-form').reset(); resetFile();
  $('login-error').classList.add('hidden'); $('login-help-text').classList.add('hidden');
  $('login-password').type = 'password';
  $('toggle-password').setAttribute('aria-label', 'Show password');
  $('toggle-password').setAttribute('aria-pressed', 'false');
  pendingVoid = null; activityRequest++; monitorRequest++; employeeRequest++; registryRequest++;
  staffRows = []; workRows = []; $('staff-rows').innerHTML = ''; $('work-code-items').innerHTML = '';
  $('staff-form').reset(); $('work-code-form').reset(); $('staff-search').value = '';
  $('staff-file').value = ''; rosterFile = null; rosterReady = false; rosterVersion++;
  $('roster-preview').innerHTML = '';
  for (const id of ['staff-error','staff-save-error','work-save-error','roster-error']) { $(id).textContent = ''; $(id).classList.add('hidden'); }
  $('void-form').reset(); $('dtr-filter').reset(); $('dtr-rows').innerHTML = '';
  $('dtr-employee').innerHTML = '<option value="">Choose employee ID</option>';
  $('known-employees').innerHTML = ''; $('legacy-items').innerHTML = '';
  $('legacy-activities').classList.add('hidden');
  $('dtr-summary').textContent = 'Choose an employee and month to compare with the office DTR.';
  $('punch-rows').innerHTML = ''; $('fieldwork-items').innerHTML = ''; $('recent-imports').innerHTML = '';
  $('activity-chart').innerHTML = '';
  for (const key of ['scans','employees','imports','activities']) $('metric-' + key).textContent = '—';
  $('toast').classList.add('hidden');
  document.title = 'NCSC | Biometric Attendance';
  $('login-username').focus({preventScroll:true});
}
function showWorkspace() {
  $('login-form').reset();
  $('login-view').classList.add('hidden'); $('workspace').classList.remove('hidden');
  $('account').textContent = session.username;
  $('account-avatar').textContent = session.username.slice(0, 1).toUpperCase();
  $('account-role').textContent = session.role === 'admin' ? 'Administrator' : 'Reviewer';
  $('logout').innerHTML = icon('logout') + ' Sign out';
  const canWrite = session.role === 'admin';
  $('preview-btn').disabled = !canWrite;
  $('fieldwork-form').querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = !canWrite; });
  $('import-access-note').classList.toggle('hidden', canWrite);
  for (const id of ['open-staff-import','add-staff','add-work-code','preview-staff','import-staff']) $(id).disabled = !canWrite;
  $('import-staff').disabled = true;
  resetFile();
  $('dtr-month').value = new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Manila'}).slice(0,7);
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
  $('page-description').textContent = pages[page][1];
  $('heading-action').classList.toggle('hidden', page === 'imports' || page === 'fieldwork' || page === 'staff');
  $('main-content').scrollTop = 0;
  history.replaceState(null, '', '#' + page);
  document.title = pages[page][0] + ' | NCSC Attendance';
  if (page === 'overview') loadOverview();
  if (page === 'attendance') { punchOffset = 0; loadPunches(); }
  if (page === 'fieldwork') { loadFieldwork(); loadEmployees(); }
  if (page === 'dtr') loadEmployees(true);
  if (page === 'staff') loadRegistry();
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
    for (const key of ['scans','employees','imports','activities']) $('metric-' + key).textContent = Number(result.totals[key] || 0).toLocaleString();
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
    $('punch-rows').innerHTML = result.items.length ? result.items.map(item => '<tr><td><strong>' + escapeHtml(item.display_name || 'Name not imported') + '</strong><span class="scan-day">ID: ' + escapeHtml(item.employee_code) + '</span></td><td><span class="scan-date">' + escapeHtml(localDate(item.happened_at)) + ' <strong>' + escapeHtml(item.happened_at.slice(11)) + '</strong></span><span class="scan-day">' + dayLabel(item.happened_at) + ' · Manila time</span></td><td>' + escapeHtml(item.device_id) + '</td><td><span class="tag blue-tag">' + escapeHtml(item.status_code) + '</span></td><td>' + escapeHtml(item.verification_code) + '</td><td>' + escapeHtml(item.work_code) + (item.work_label ? ' · ' + escapeHtml(item.work_label) : '<span class="scan-day">Unmapped</span>') + '</td></tr>').join('') : '<tr><td colspan="6">No matching scans. Try another employee ID or date range.</td></tr>';
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
  if (!/\.(dat|txt|xls)$/i.test(file.name)) { showInlineError('import-error', 'Choose a .dat/.txt attendance log or .xls report.'); return; }
  if (!file.size || file.size > 2 * 1024 * 1024) { showInlineError('import-error', 'Choose a nonempty file up to 2 MB.'); return; }
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
  $('import-error').classList.add('hidden');
  importBusy = true; $('preview-btn').disabled = true; $('import-submit').disabled = true;
  $('preview-btn').textContent = previewOnly ? 'Reading file…' : 'Saving records…';
  try {
    const result = await api(previewOnly ? '/api/imports/preview' : '/api/imports', {method:'POST', body:data});
    if (context !== session || version !== fileVersion) return;
    const output = $('preview-output'); output.classList.remove('hidden');
    if (previewOnly && result.format === 'report') {
      previewReady = false; $('report-staff').classList.remove('hidden');
      output.innerHTML = '<h3>Excel report preview</h3><div class="preview-grid">' + previewStat('Employee IDs in report', result.employees) + previewStat('Report period', result.period) + '</div><ul class="report-sheets">' + result.sheets.map(s => '<li>' + escapeHtml(s.name) + ' · ' + Number(s.rows) + ' rows</li>').join('') + '</ul><p class="inline-help">This Excel report can supply staff names. Select Import staff names from this report. To import attendance scans, choose the original _attlog.dat file.</p>';
    } else if (previewOnly) {
      previewReady = !result.already_imported;
      output.innerHTML = '<h3>Source log preview</h3><div class="preview-grid">' + previewStat('Scan records', result.rows.toLocaleString()) + previewStat('Employee IDs', result.employees) + previewStat('First scan', result.earliest) + previewStat('Last scan', result.latest) + '</div><p class="inline-help">' + (result.already_imported ? 'This exact file has already been imported.' : 'Nothing saved yet. Review the details, then select Import records.') + '<br>Raw status codes: ' + result.codes.map(escapeHtml).join(', ') + '</p>';
    } else {
      previewReady = false;
      output.innerHTML = '<h3>Import complete</h3><div class="preview-grid">' + previewStat('New scans', result.inserted.toLocaleString()) + previewStat('Duplicates skipped', result.duplicates.toLocaleString()) + '</div><p class="inline-help">Original K14 scans remain unchanged. Open Attendance logs to review your records.</p>';
      $('view-imported').classList.remove('hidden');
      toast('Attendance imported successfully.'); loadOverview();
    }
  } catch (error) {
    if (context === session && version === fileVersion) { previewReady = false; $('preview-output').classList.add('hidden'); showInlineError('import-error', error.message); }
  } finally {
    importBusy = false; $('preview-btn').innerHTML = icon('eye') + ' Preview file';
    $('preview-btn').disabled = session?.role !== 'admin';
    $('import-submit').disabled = !previewReady;
  }
}

async function loadFieldwork() {
  const context = session; const requestId = ++activityRequest;
  try {
    const result = await api('/api/activities');
    if (context !== session || requestId !== activityRequest) return;
    const filter = $('activity-status').value;
    const items = result.items.filter(item => filter === 'all' || item.status === filter);
    $('fieldwork-items').innerHTML = items.length ? items.map(item => {
      const action = item.status === 'recorded' && context.role === 'admin' ? '<button class="text-button" type="button" data-void="' + Number(item.id) + '">Void reference</button>' : '';
      return '<div class="request"><div class="request-head"><strong>' + escapeHtml(item.employee_code) + '<span> · ' + escapeHtml(item.category) + '</span></strong><span class="tag ' + (item.status === 'recorded' ? 'blue-tag' : '') + '">' + (item.status === 'recorded' ? 'On file' : 'Voided') + '</span></div><p class="request-time">' + escapeHtml(localDate(item.start_at)) + ' ' + escapeHtml(item.start_at.slice(11,16)) + ' – ' + escapeHtml(localDate(item.end_at)) + ' ' + escapeHtml(item.end_at.slice(11,16)) + '</p><p><strong>' + escapeHtml(item.reference) + '</strong></p><p>' + escapeHtml(item.purpose) + '</p>' + (item.void_reason ? '<p>Correction: ' + escapeHtml(item.void_reason) + '</p>' : '') + action + '</div>';
    }).join('') : '<div class="empty">No ' + (filter === 'voided' ? 'voided ' : '') + 'references on file.</div>';
    $('legacy-activities').classList.toggle('hidden', !result.legacy_items.length);
    $('legacy-items').innerHTML = result.legacy_items.map(item => '<div class="request"><strong>' + escapeHtml(item.employee_code) + ' · ' + escapeHtml(item.category) + '</strong><p>Previous status: ' + escapeHtml(item.status) + '</p><p>' + escapeHtml(localDate(item.start_at)) + ' – ' + escapeHtml(localDate(item.end_at)) + '</p><p>' + escapeHtml(item.location) + ' · ' + escapeHtml(item.reason) + '</p></div>').join('');
  } catch (error) { if (context === session && requestId === activityRequest) toast(error.message, true); }
}
async function createFieldwork(event) {
  event.preventDefault(); const form = event.currentTarget;
  const context = session;
  const data = Object.fromEntries(new FormData(form));
  if (data.end_at <= data.start_at) { toast('End must be later than start.', true); return; }
  if (!data.reference.trim() && !data.purpose.trim()) { toast('Enter an existing reference or a short DTR note.', true); return; }
  $('fieldwork-submit').disabled = true;
  try {
    await api('/api/activities', {method:'POST', body:JSON.stringify(data)});
    if (context !== session) return;
    form.reset(); $('activity-status').value = 'recorded'; toast('Reference saved. No new approval needed.');
    loadFieldwork(); loadOverview(); loadEmployees();
  } catch (error) { if (context === session) toast(error.message, true); }
  finally { $('fieldwork-submit').disabled = session?.role !== 'admin'; }
}
function openVoid(button) {
  pendingVoid = Number(button.dataset.void);
  if (!Number.isInteger(pendingVoid) || pendingVoid < 1) return;
  $('void-form').reset(); openDialog('void-dialog');
}
async function voidReference(event) {
  event.preventDefault();
  if (!pendingVoid) return;
  const context = session; const id = pendingVoid;
  $('confirm-void').disabled = true;
  try {
    await api('/api/activities/' + id + '/void', {method:'POST', body:JSON.stringify({reason:$('void-reason').value})});
    if (context !== session) return;
    $('void-dialog').close(); pendingVoid = null; toast('Reference voided. History retained.');
    loadFieldwork(); loadOverview();
  } catch (error) { if (context === session) toast(error.message, true); }
  finally { $('confirm-void').disabled = false; }
}
async function loadEmployees(openMonitor = false) {
  const context = session; const requestId = ++employeeRequest;
  try {
    const result = await api('/api/employees');
    if (context !== session || requestId !== employeeRequest) return;
    const selected = $('dtr-employee').value;
    $('known-employees').innerHTML = result.staff.map(item => '<option value="' + escapeHtml(item.employee_code) + '">' + escapeHtml(item.display_name) + '</option>').join('');
    $('dtr-employee').innerHTML = '<option value="">Choose employee ID</option>' + result.staff.map(item => '<option value="' + escapeHtml(item.employee_code) + '">' + escapeHtml(item.display_name ? item.display_name + ' · ' + item.employee_code : item.employee_code) + '</option>').join('');
    if (result.items.includes(selected)) $('dtr-employee').value = selected;
    else if (openMonitor && result.items.length) $('dtr-employee').value = result.items[0];
    if (openMonitor && currentPage === 'dtr') loadMonitor();
  } catch (error) { if (context === session && requestId === employeeRequest) toast(error.message, true); }
}
async function loadMonitor() {
  const context = session; const requestId = ++monitorRequest;
  const employee = $('dtr-employee').value; const month = $('dtr-month').value;
  $('dtr-rows').innerHTML = '<tr><td colspan="4">' + (employee ? 'Loading daily records…' : 'No employee selected. Import scans or add an existing reference first.') + '</td></tr>';
  $('dtr-summary').textContent = 'Choose an employee and month to compare with the office DTR.';
  if (!employee || !month) return;
  try {
    const result = await api('/api/dtr/monitor?' + new URLSearchParams({employee_code:employee, month}));
    if (context !== session || requestId !== monitorRequest) return;
    $('dtr-summary').textContent = (result.display_name ? result.display_name + ' · ' : '') + employee + ' · ' + month + ' · Scans: ' + result.summary.scans + ' · Days with scans: ' + result.summary.days_with_scans + ' · References: ' + result.summary.activity_records;
    $('dtr-rows').innerHTML = result.days.map(day => {
      const scans = day.scans.length ? '<div class="scan-times">' + day.scans.map(scan => '<span class="scan-time" title="' + escapeHtml('Device ' + scan.device_id + ' · Status ' + scan.status_code + ' · Verify ' + scan.verification_code + ' · Work code ' + scan.work_code + (scan.work_label ? ' · ' + scan.work_label : ' (unmapped)')) + '">' + escapeHtml(scan.happened_at.slice(11)) + (scan.work_label ? '<small class="scan-work-label">' + escapeHtml(scan.work_label) + '</small>' : '') + '</span>').join('') + '</div>' : '—';
      const references = day.activities.length ? day.activities.map(item => '<div class="monitor-reference"><strong>' + escapeHtml(item.category) + (item.reference ? ' · ' + escapeHtml(item.reference) : '') + '</strong><span>' + escapeHtml(item.purpose) + '</span></div>').join('') : '—';
      const label = day.coverage === 'scans' ? 'Device scans' : day.coverage === 'reference_only' ? 'Reference only' : 'No records';
      return '<tr><td><strong>' + escapeHtml(day.date.slice(8)) + '</strong><span class="scan-day">' + escapeHtml(day.day) + '</span></td><td>' + scans + '</td><td>' + references + '</td><td><span class="tag ' + (day.coverage === 'no_records' ? '' : 'blue-tag') + '">' + label + '</span></td></tr>';
    }).join('');
  } catch (error) {
    if (context !== session || requestId !== monitorRequest) return;
    $('dtr-rows').innerHTML = '<tr><td colspan="4">Daily records could not be loaded. Try again.</td></tr>'; toast(error.message, true);
  }
}

function showInlineError(id, message) {
  $(id).textContent = message; $(id).classList.remove('hidden');
}
function renderStaff() {
  const query = $('staff-search').value.trim().toLowerCase();
  const rows = staffRows.filter(item => (item.employee_code + ' ' + item.display_name).toLowerCase().includes(query));
  $('staff-rows').innerHTML = rows.length ? rows.map(item => '<tr><td>' + escapeHtml(item.employee_code) + '</td><td><strong>' + escapeHtml(item.display_name || 'Name not imported') + '</strong></td><td>' + escapeHtml(item.department || '—') + '</td><td>' + (session?.role === 'admin' ? '<button class="text-button" type="button" data-staff-edit="' + escapeHtml(item.employee_code) + '">Edit</button>' : '') + '</td></tr>').join('') : '<tr><td colspan="4">No staff found. Import a staff report or attendance log to get started.</td></tr>';
}
async function loadRegistry() {
  const context = session; const requestId = ++registryRequest;
  $('staff-error').classList.add('hidden');
  $('staff-rows').innerHTML = '<tr><td colspan="4">Loading staff…</td></tr>';
  try {
    const [employees, codes] = await Promise.all([api('/api/employees'), api('/api/work-codes')]);
    if (context !== session || requestId !== registryRequest) return;
    staffRows = employees.staff; workRows = codes.items; renderStaff();
    $('work-code-items').innerHTML = workRows.length ? workRows.map(item => '<div class="request"><div class="request-head"><strong>' + escapeHtml(item.work_code) + ' · ' + escapeHtml(item.label || 'Unmapped') + '</strong>' + (context.role === 'admin' ? '<button class="text-button" type="button" data-work-device="' + escapeHtml(item.device_id) + '" data-work-code="' + escapeHtml(item.work_code) + '">Map code</button>' : '') + '</div><p>Device ' + escapeHtml(item.device_id) + ' · ' + Number(item.scan_count) + ' scans · ' + escapeHtml(item.activity_type) + '</p></div>').join('') : '<div class="empty">No work codes yet. Import attendance to see the codes recorded in scans.</div>';
  } catch (error) {
    if (context !== session || requestId !== registryRequest) return;
    $('staff-rows').innerHTML = ''; $('work-code-items').innerHTML = '';
    showInlineError('staff-error', error.message);
  }
}
function editStaff(code = '') {
  const item = staffRows.find(row => row.employee_code === code);
  $('staff-form').reset(); $('staff-save-error').classList.add('hidden');
  $('staff-code').value = code; $('staff-code').readOnly = !!code;
  $('staff-name').value = item?.display_name || '';
  $('staff-department').value = item?.department || '';
  openDialog('staff-dialog');
}
async function saveStaff(event) {
  event.preventDefault(); const context = session;
  $('save-staff').disabled = true; $('staff-save-error').classList.add('hidden');
  try {
    await api('/api/employees/' + encodeURIComponent($('staff-code').value.trim()), {method:'PUT',body:JSON.stringify({display_name:$('staff-name').value,department:$('staff-department').value})});
    if (context !== session) return;
    $('staff-dialog').close(); toast('Staff details saved.'); loadRegistry(); loadOverview();
  } catch (error) { if (context === session) showInlineError('staff-save-error', error.message); }
  finally { $('save-staff').disabled = false; }
}
function editWorkCode(device = '', code = '') {
  const item = workRows.find(row => row.device_id === device && row.work_code === code);
  $('work-code-form').reset(); $('work-save-error').classList.add('hidden');
  $('work-device').value = device; $('work-code').value = code;
  $('work-device').readOnly = !!device; $('work-code').readOnly = !!device;
  $('work-label').value = item?.label || ''; $('work-type').value = item?.activity_type || 'Unclassified';
  openDialog('work-code-dialog');
}
async function saveWorkCode(event) {
  event.preventDefault(); const context = session;
  $('save-work-code').disabled = true; $('work-save-error').classList.add('hidden');
  try {
    await api('/api/work-codes/' + encodeURIComponent($('work-device').value.trim()) + '/' + encodeURIComponent($('work-code').value.trim()), {method:'PUT',body:JSON.stringify({label:$('work-label').value,activity_type:$('work-type').value})});
    if (context !== session) return;
    $('work-code-dialog').close(); toast('Work code mapping saved.'); loadRegistry();
  } catch (error) { if (context === session) showInlineError('work-save-error', error.message); }
  finally { $('save-work-code').disabled = false; }
}
function setRosterFile(file) {
  rosterFile = file || null; rosterVersion++; rosterReady = false;
  $('roster-selected').textContent = file ? 'Selected: ' + file.name : 'No staff file selected';
  $('import-staff').disabled = true; $('roster-preview').innerHTML = ''; $('roster-preview').classList.add('hidden');
  $('roster-error').classList.add('hidden');
}
function openStaffImport(file = null) {
  $('staff-file').value = ''; setRosterFile(file); openDialog('staff-import-dialog');
}
async function uploadRoster(previewOnly) {
  if (rosterBusy) return;
  if (!rosterFile) { showInlineError('roster-error', 'Choose the K14 .xls report or a staff CSV first.'); return; }
  if (!previewOnly && !rosterReady) return;
  const context = session; const version = rosterVersion;
  const data = new FormData(); data.append('file', rosterFile);
  rosterBusy = true; $('preview-staff').disabled = true; $('import-staff').disabled = true;
  $('roster-error').classList.add('hidden');
  try {
    const result = await api('/api/employees/import' + (previewOnly ? '/preview' : ''), {method:'POST',body:data});
    if (context !== session || version !== rosterVersion) return;
    rosterReady = previewOnly && result.counts.new + result.counts.fill > 0;
    $('roster-preview').classList.remove('hidden');
    const counts = result.counts;
    $('roster-preview').innerHTML = '<p class="inline-help">' + (previewOnly ? 'Preview: ' : 'Import complete: ') + Number(counts.new) + ' new · ' + Number(counts.fill) + ' fill missing details · ' + Number(counts.unchanged) + ' unchanged · ' + Number(counts.conflict) + ' conflicts skipped.</p>';
    if (previewOnly) {
      $('roster-preview').innerHTML += '<div class="table-scroll"><table><thead><tr><th>Device ID</th><th>Staff name</th><th>Result</th></tr></thead><tbody>' + result.items.map(item => '<tr><td>' + escapeHtml(item.employee_code) + '</td><td>' + escapeHtml(item.display_name) + (item.change === 'conflict' ? '<span class="scan-day">Existing: ' + escapeHtml(item.existing_name) + '</span>' : '') + '</td><td>' + escapeHtml(item.change) + '</td></tr>').join('') + '</tbody></table></div><p class="table-foot">Preview shows up to 100 of ' + Number(result.total) + ' staff. Conflicts keep the existing details; use Edit after checking the correct ID.</p>';
    } else {
      $('roster-preview').innerHTML += '<p>Names saved to the local database. Attendance scans are unchanged.</p>';
      loadRegistry(); loadOverview();
    }
  } catch (error) {
    if (context !== session || version !== rosterVersion) return;
    rosterReady = false; showInlineError('roster-error', error.message);
  } finally {
    rosterBusy = false; $('preview-staff').disabled = session?.role !== 'admin'; $('import-staff').disabled = !rosterReady || session?.role !== 'admin';
  }
}

async function initialize() {
  hydrateIcons();
  $('today').textContent = new Date().toLocaleDateString('en-PH', {timeZone:'Asia/Manila',day:'numeric',month:'long',year:'numeric'});
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-help')) openDialog('help-dialog');
    if (button.dataset.close) $(button.dataset.close).close();
    if (button.id === 'view-imported') $('filter-form').reset();
    if (button.dataset.page || button.dataset.go) navigate(button.dataset.page || button.dataset.go);
    if (button.dataset.void) openVoid(button);
    if (button.dataset.staffEdit) editStaff(button.dataset.staffEdit);
    if (button.dataset.workDevice) editWorkCode(button.dataset.workDevice, button.dataset.workCode);
    if (button.id === 'report-staff') openStaffImport(selectedFile);
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      const box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
    });
  });
  $('toggle-password').addEventListener('click', () => {
    const reveal = $('login-password').type === 'password';
    $('login-password').type = reveal ? 'text' : 'password';
    $('toggle-password').setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    $('toggle-password').setAttribute('aria-pressed', String(reveal));
  });
  $('login-help').addEventListener('click', () => $('login-help-text').classList.toggle('hidden'));
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-submit').disabled = true; $('login-submit').textContent = 'Signing in…'; $('login-error').classList.add('hidden');
    try {
      session = await api('/api/login', {method:'POST',body:JSON.stringify({username:$('login-username').value,password:$('login-password').value})});
      showWorkspace();
    } catch (error) { $('login-error').textContent = error.message; $('login-error').classList.remove('hidden'); }
    finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Sign in'; }
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('/api/logout', {method:'POST'}); session = null; showAuth(); }
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
  $('open-staff-import').addEventListener('click', () => openStaffImport());
  $('staff-file').addEventListener('change', () => setRosterFile($('staff-file').files[0]));
  $('preview-staff').addEventListener('click', () => uploadRoster(true));
  $('import-staff').addEventListener('click', () => uploadRoster(false));
  $('add-staff').addEventListener('click', () => editStaff());
  $('add-work-code').addEventListener('click', () => editWorkCode());
  $('staff-form').addEventListener('submit', saveStaff);
  $('work-code-form').addEventListener('submit', saveWorkCode);
  $('staff-search').addEventListener('input', renderStaff);
  $('activity-status').addEventListener('change', loadFieldwork);
  $('void-form').addEventListener('submit', voidReference);
  $('dtr-filter').addEventListener('submit', event => { event.preventDefault(); loadMonitor(); });
  $('dtr-employee').addEventListener('change', loadMonitor);
  $('dtr-month').addEventListener('change', loadMonitor);
  window.addEventListener('hashchange', () => { if (session && pages[location.hash.slice(1)]) navigate(location.hash.slice(1)); });
  try { session = await api('/api/me'); showWorkspace(); }
  catch (_) { session = null; showAuth(); }
}
document.addEventListener('DOMContentLoaded', initialize);
