'use strict';

// NCSC Attendance Hub — all API requests remain same-origin.
const $ = (id) => document.getElementById(id);
let session = null;
let currentPage = 'overview';
let toastTimer;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

function toast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = error ? 'toast error' : 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 4400);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (session && session.csrf && options.method && options.method.toUpperCase() !== 'GET') {
    headers.set('X-CSRF-Token', session.csrf);
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  let result;
  try { result = await response.json(); } catch (_) { result = {}; }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login')) {
      session = null;
      showAuth();
    }
    let detail = result.detail || 'Request failed (' + response.status + ')';
    if (Array.isArray(detail)) detail = detail.map(x => x.msg).join('; ');
    throw new Error(String(detail));
  }
  return result;
}

function showAuth() {
  $('login-view').classList.remove('hidden');
  $('workspace').classList.add('hidden');
  $('login-password').value = '';
}

function showWorkspace() {
  $('login-view').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('account').textContent = session.username;
  navigate('overview');
}

function navigate(page) {
  currentPage = page;
  const names = { overview: 'Overview', attendance: 'Attendance Logs', imports: 'USB Imports', staff: 'Staff Directory', workcodes: 'Work Codes', fieldwork: 'AJA / Fieldwork' };
  document.querySelectorAll('[data-view]').forEach(section => {
    section.classList.toggle('hidden', section.dataset.view !== page);
  });
  document.querySelectorAll('[data-page]').forEach(button => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  $('page-heading').textContent = names[page] || 'Overview';
  $('current-location').textContent = (names[page] || 'Overview').toUpperCase();
  if (page === 'overview') loadOverview();
  if (page === 'attendance') loadPunches();
  if (page === 'fieldwork') loadFieldwork();
  if (page === 'staff') loadStaff();
  if (page === 'workcodes') loadWorkCodes();
}

async function loadOverview() {
  try {
    const result = await api('/api/overview');
    for (const key of ['scans', 'staff', 'imports', 'pending']) {
      $('metric-' + key).textContent = Number(result.totals[key] || 0).toLocaleString();
    }
    if (!result.recent_imports.length) {
      $('recent-imports').innerHTML = '<div class="empty">No attendance files imported yet.</div>';
    } else {
      $('recent-imports').innerHTML = result.recent_imports.map(item =>
        '<div class="import-row"><div><strong>' + escapeHtml(item.original_name) +
        '</strong><span>' + escapeHtml(item.imported_at) + ' · ' + item.total_records +
        ' rows</span></div><b>+' + item.inserted_records + ' new</b></div>'
      ).join('');
    }
  } catch (error) { toast(error.message, true); }
}

async function loadPunches() {
  const employee = $('filter-id').value.trim();
  try {
    const result = await api('/api/punches?limit=100&employee_code=' + encodeURIComponent(employee));
    const body = $('punch-rows');
    body.innerHTML = result.items.length ? result.items.map(item =>
      '<tr><td>' + escapeHtml(item.employee_code) + '</td><td>' +
      escapeHtml(item.happened_at) + '</td><td>' + escapeHtml(item.device_id) +
      '</td><td><span class="tag">' + escapeHtml(item.status_code) +
      '</span></td><td>' + escapeHtml(item.verification_code) +
      '</td><td>' + escapeHtml(item.work_code) + (item.work_code_label ? ' · ' + escapeHtml(item.work_code_label) : '') + '</td></tr>'
    ).join('') : '<tr><td colspan="6">No matching attendance scans found.</td></tr>';
  } catch (error) { toast(error.message, true); }
}

async function handleImport(previewOnly) {
  const file = $('attendance-file').files[0];
  if (!file) { toast('Choose an attendance log first.', true); return; }
  if (file.size > 2 * 1024 * 1024) { toast('File exceeds 2 MB.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  const output = $('preview-output');
  try {
    const result = await api(previewOnly ? '/api/imports/preview' : '/api/imports', {
      method: 'POST', body: formData
    });
    output.classList.remove('hidden');
    if (previewOnly) {
      output.textContent = 'PREVIEW ONLY (nothing saved)\n' +
        'Records: ' + result.rows + '\nEmployees: ' + result.employees +
        '\nRange: ' + result.earliest + ' to ' + result.latest +
        '\nRaw status codes: ' + result.codes.join(', ') +
        '\nPreviously imported file: ' + (result.already_imported ? 'Yes' : 'No');
    } else {
      output.textContent = 'IMPORT COMPLETE\nNew scans: ' + result.inserted +
        '\nDuplicates skipped: ' + result.duplicates +
        '\nTotal rows processed: ' + result.total;
      toast('Import completed. Original K14 records unchanged.');
    }
  } catch (error) { toast(error.message, true); }
}

async function loadFieldwork() {
  try {
    const result = await api('/api/fieldwork');
    const target = $('fieldwork-items');
    if (!result.items.length) {
      target.innerHTML = '<div class="empty">No AJA / fieldwork entries yet.</div>';
      return;
    }
    target.innerHTML = result.items.map(item => {
      const status = item.status === 'approved' ? 'green' : '';
      const actions = item.status === 'pending'
        ? '<div class="request-buttons"><button class="btn primary" data-decision="approved" data-id="' + item.id +
          '">Approve</button><button class="btn outline" data-decision="rejected" data-id="' + item.id + '">Reject</button></div>'
        : '';
      return '<div class="request"><div class="request-head"><strong>' +
        escapeHtml(item.employee_code) + ' · ' + escapeHtml(item.category) +
        '</strong><span class="tag ' + status + '">' + escapeHtml(item.status) +
        '</span></div><p>' + escapeHtml(item.start_at) + ' – ' + escapeHtml(item.end_at) +
        '<br>' + escapeHtml(item.location) + '<br>' + escapeHtml(item.reason) +
        '</p>' + actions + '</div>';
    }).join('');
  } catch (error) { toast(error.message, true); }
}

async function createFieldwork(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.start_at || !data.end_at) { toast('Select start and end times.', true); return; }
  // Browser datetime-local uses YYYY-MM-DDTHH:mm, which FastAPI accepts.
  try {
    await api('/api/fieldwork', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    toast('Fieldwork request created as pending.');
    loadFieldwork();
  } catch (error) { toast(error.message, true); }
}

async function reviewFieldwork(button) {
  const decision = button.dataset.decision;
  const id = Number(button.dataset.id);
  if (!['approved', 'rejected'].includes(decision) || !Number.isInteger(id)) return;
  if (!window.confirm('Mark request #' + id + ' as ' + decision + '? This decision is audited.')) return;
  button.disabled = true;
  try {
    await api('/api/fieldwork/' + id + '/decision', {
      method: 'POST', body: JSON.stringify({ decision })
    });
    toast('Request ' + decision + '.');
    loadFieldwork();
  } catch (error) { button.disabled = false; toast(error.message, true); }
}


async function loadStaff() {
  try {
    const result = await api('/api/staff');
    $('staff-count').textContent = result.employees.length;
    $('named-staff-count').textContent = result.employees.filter(x => x.device_name).length;
    $('staff-rows').innerHTML = result.employees.length ? result.employees.map(item => (
      '<tr><td>' + escapeHtml(item.employee_code) + '</td><td>' +
      (item.device_name ? escapeHtml(item.device_name) : '<span class="muted">Name not synced</span>') +
      '</td><td><span class="tag ' + (item.origin === 'user_export' ? 'green' : '') + '">' +
      (item.origin === 'user_export' ? 'Device user export' : 'Attendance ID') +
      '</span></td><td>' + escapeHtml(item.last_scan_at || 'No scan imported') + '</td></tr>'
    )).join('') : '<tr><td colspan="4">No staff found. Import user.dat or an attendance log first.</td></tr>';
    $('department-items').innerHTML = result.departments.length ?
      result.departments.map(x => '<span class="department-chip"><b>' + escapeHtml(x.department_code) +
        '</b> ' + escapeHtml(x.device_name) + '</span>').join('') :
      '<div class="empty">No departments synced. Import department.dat to populate.</div>';
  } catch (error) { toast(error.message, true); }
}

async function handleDirectoryImport(previewOnly) {
  const file = $('directory-file').files[0];
  if (!file) { toast('Choose user.dat or department.dat first.', true); return; }
  if (!['user.dat', 'department.dat'].includes(file.name.toLowerCase())) {
    toast('Use only user.dat or department.dat. Do not upload fingerprint templates.', true); return;
  }
  const form = new FormData();
  form.append('file', file);
  try {
    const result = await api(previewOnly ? '/api/device-directory/preview' : '/api/device-directory/import', {
      method: 'POST', body: form
    });
    const box = $('directory-result');
    box.classList.remove('hidden');
    box.textContent = (previewOnly ? 'DIRECTORY PREVIEW (not saved)' : 'DIRECTORY SYNC COMPLETE') +
      '\nType: ' + (result.kind === 'user' ? 'Device users (names + IDs)' : 'Departments') +
      '\nRecords: ' + result.count +
      (previewOnly ? '\nPreviously imported same file: ' + (result.already_imported ? 'Yes' : 'No') : '');
    if (!previewOnly) { toast('Device directory updated locally. The K14 was not changed.'); loadStaff(); }
  } catch (error) { toast(error.message, true); }
}

async function loadWorkCodes() {
  try {
    const result = await api('/api/work-codes');
    $('observed-codes').innerHTML = result.observed.length ? result.observed.map(x => (
      '<div class="code-row"><span class="tag">' + escapeHtml(x.numeric_code) +
      '</span><span>' + x.scan_count + ' attendance scans</span></div>'
    )).join('') : '<div class="empty">No attendance code values yet. Import a scan log first.</div>';
    $('configured-codes').innerHTML = result.configured.length ? result.configured.map(x => (
      '<div class="code-row"><span class="tag green">' + escapeHtml(x.numeric_code) +
      '</span><strong>' + escapeHtml(x.label) + '</strong></div>'
    )).join('') : '<div class="empty">No local labels configured.</div>';
  } catch (error) { toast(error.message, true); }
}

async function saveWorkCode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await api('/api/work-codes', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    toast(result.device_updated ? 'Code saved.' : 'Local code label saved. Device unchanged.');
    loadWorkCodes();
  } catch (error) { toast(error.message, true); }
}

async function initialize() {
  $('today').textContent = new Date().toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', day: 'numeric', month: 'long', year: 'numeric'
  });
  document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));
  document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.go)));
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      session = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('login-username').value,
          password: $('login-password').value
        })
      });
      showWorkspace();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); session = null; showAuth(); }
    catch (error) { toast(error.message, true); }
  });
  $('filter-form').addEventListener('submit', event => { event.preventDefault(); loadPunches(); });
  $('clear-filter').addEventListener('click', () => { $('filter-id').value = ''; loadPunches(); });
  $('attendance-file').addEventListener('change', () => {
    const file = $('attendance-file').files[0];
    $('file-name').textContent = file ? file.name : 'No file chosen';
    $('preview-output').classList.add('hidden');
  });
  $('preview-btn').addEventListener('click', () => handleImport(true));
  $('import-form').addEventListener('submit', event => {
    event.preventDefault();
    handleImport(false);
  });
  $('fieldwork-form').addEventListener('submit', createFieldwork);
  $('directory-file').addEventListener('change', () => {
    $('directory-file-name').textContent = $('directory-file').files[0]?.name || 'No directory file chosen';
    $('directory-result').classList.add('hidden');
  });
  $('directory-preview-btn').addEventListener('click', () => handleDirectoryImport(true));
  $('directory-form').addEventListener('submit', e => { e.preventDefault(); handleDirectoryImport(false); });
  $('refresh-staff').addEventListener('click', loadStaff);
  $('code-form').addEventListener('submit', saveWorkCode);
  $('fieldwork-items').addEventListener('click', event => {
    const button = event.target.closest('[data-decision]');
    if (button) reviewFieldwork(button);
  });
  try { session = await api('/api/me'); showWorkspace(); }
  catch (_) { showAuth(); }
}

document.addEventListener('DOMContentLoaded', initialize);
