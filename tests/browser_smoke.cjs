/* Headless end-to-end smoke test with fictional staff/attendance only. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, renameSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const net = require('node:net');

(async () => {
  const root = resolve(__dirname, '..');
  const tmp = mkdtempSync(join(tmpdir(), 'ncsc-records-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const password = randomBytes(23).toString('hex');
  const env = {
    ...process.env,
    SECRET_KEY:randomBytes(40).toString('hex'),
    DATABASE_PATH:join(tmp,'test.sqlite3'),
    QA_PASSWORD:password, QA_PORT:String(port),
    K14_ATTENDANCE_SYNC_ENABLED:'false',
    K14_CONNECTOR_DB:join(tmp,'connector.sqlite3'),
    K14_HOST:'192.168.254.201',
    K14_LAN_PROBE_ENABLED:'false'
  };
  const python = process.env.TEST_PYTHON ||
    join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const server = spawn(python,['-u','-c',`
import os, sqlite3, uvicorn
from app.db import initialize, connect
from app.security import hash_password
initialize()
with connect() as con:
    con.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')",
                ('qa-admin',hash_password(os.environ['QA_PASSWORD'])))
with sqlite3.connect(os.environ['K14_CONNECTOR_DB']) as con:
    con.execute('''CREATE TABLE attendance_raw (
        device_ip TEXT, employee_id TEXT, punch_time_local TEXT,
        device_status TEXT, device_punch_type TEXT, received_at_utc TEXT,
        PRIMARY KEY(device_ip,employee_id,punch_time_local,device_status,device_punch_type))''')
    con.executemany('INSERT INTO attendance_raw VALUES(?,?,?,?,?,?)', [
        ('192.168.254.201','1','2026-11-03 08:00:00','2','5','2026-11-23 03:00:00'),
        ('192.168.254.201','1','2026-11-03 08:00:01','2','5','2026-11-23 03:00:00')])
uvicorn.run('app.main:app',host='127.0.0.1',port=int(os.environ['QA_PORT']),log_level='error')
`],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let stderr='';
  server.stderr.on('data',data=>stderr+=data);
  server.on('error',error=>stderr+=error.message);
  let browser;
  try {
    const base='http://127.0.0.1:'+port;
    let ready=false;
    for(let i=0;i<90;i++){
      try{if((await fetch(base)).ok){ready=true;break;}}catch(_){}
      await new Promise(r=>setTimeout(r,110));
    }
    assert.ok(ready,'Server did not start: '+stderr);
    browser=await chromium.launch({headless:true,
      ...(process.env.TEST_CHROMIUM?{executablePath:process.env.TEST_CHROMIUM}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    mkdirSync(join(root,'docs'),{recursive:true});
    await page.goto(base);
    await page.locator('#login-view:not(.hidden)').waitFor();
    await page.locator('.login-story').waitFor();
    assert.equal(await page.locator('.login-story-photo').count(),1);
    assert.equal(await page.locator('.fingerprint-mark').count(),1);
    const desktopBrand=await page.evaluate(()=>{
      const fp=document.querySelector('.login-brand-row .fingerprint-mark');
      const seal=document.querySelector('.login-brand-row .mobile-seal');
      const leftLogo=document.querySelector('.login-story-brand .seal').getBoundingClientRect();
      const leftName=document.querySelector('.login-story-brand .eyebrow').getBoundingClientRect();
      return {fingerprint:getComputedStyle(fp).visibility,
        mobileSeal:getComputedStyle(seal).visibility,
        leftLogoWidth:leftLogo.width,
        nameToRight:leftName.left>=leftLogo.right,
        leftLogoVisible:leftLogo.width>0};
    });
    assert.equal(desktopBrand.fingerprint,'visible');
    assert.equal(desktopBrand.mobileSeal,'hidden');
    assert.ok(desktopBrand.leftLogoWidth>=108);
    assert.ok(desktopBrand.nameToRight);
    await page.screenshot({path:join(root,'docs/login-preview.png'),animations:'disabled'});

    await page.setViewportSize({width:390,height:800});
    // The logo swap deliberately transitions visibility/opacity over 220 ms.
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.login-brand-row .fingerprint-mark')).visibility==='hidden');
    const mobileBrand=await page.evaluate(()=>{
      const fp=document.querySelector('.login-brand-row .fingerprint-mark');
      const seal=document.querySelector('.login-brand-row .mobile-seal');
      return {fingerprint:getComputedStyle(fp).visibility,
        mobileSeal:getComputedStyle(seal).visibility,
        sealWidth:seal.getBoundingClientRect().width};
    });
    assert.equal(mobileBrand.fingerprint,'hidden');
    assert.equal(mobileBrand.mobileSeal,'visible');
    assert.ok(mobileBrand.sealWidth>=72);
    await page.screenshot({path:join(root,'docs/mobile-login-preview.png'),animations:'disabled'});
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#login-username').fill('qa-admin');
    await page.locator('#login-password').fill(password);
    await page.locator('#login-submit').click();
    await page.locator('#workspace:not(.hidden)').waitFor();
    await page.locator('[data-page="employees"].active').waitFor();
    assert.equal(await page.locator('[data-page]').count(),3);
    assert.equal(await page.locator('[data-page="overview"]').count(),0);
    assert.equal(await page.locator('#page-description').count(),0);

    assert.equal(await page.locator('#register-rows').locator('tr').count(),1);
    assert.equal(await page.locator('thead').first().getByText('Last scan').count(),0);
    assert.equal(await page.locator('thead').first().getByText('Scans this month').count(),0);
    assert.equal(await page.locator('#add-staff').count(),0);
    // USB recovery is a modal next to View records, not an embedded form.
    await page.locator('#open-attendance-import').click();
    await page.locator('#attendance-import-dialog[open]').waitFor();
    await page.screenshot({path:join(root,'docs/import-modal-preview.png'),animations:'disabled'});
    const attlog=Buffer.from(
      '1\t2026-11-03 08:00:00\t1\t0\t1\t0\n'+
      '1\t2026-11-03 17:00:00\t1\t1\t1\t0\n'+
      '2\t2026-11-04 08:30:00\t1\t0\t1\t0\n');
    await page.locator('#usb-file').setInputFiles({
      name:'fictional_attlog.dat',mimeType:'application/octet-stream',buffer:attlog
    });
    await page.locator('#usb-preview').click();
    await page.locator('#usb-result').filter({hasText:/Preview: 3 scans/}).waitFor();
    await page.locator('#usb-form button[type="submit"]').click();
    await page.locator('#usb-result').filter({hasText:/Merge complete · 3 new scans added/}).waitFor();

    // Overlapping backup contains 3 old events + one new event. Do not double-count.
    const overlap=Buffer.concat([attlog,Buffer.from(
      '2\t2026-11-04 10:30:00\t1\t0\t1\t101\n'+
      '1\t2026-11-05 12:35:00\t1\t0\t1\t102\n')]);
    await page.locator('#usb-file').setInputFiles({
      name:'overlap_attlog.dat',mimeType:'application/octet-stream',buffer:overlap
    });
    await page.locator('#usb-preview').click();
    await page.locator('#usb-result').filter({hasText:/Preview: 5 scans/}).waitFor();
    await page.locator('#usb-form button[type="submit"]').click();
    await page.locator('#usb-result').filter({hasText:/Merge complete · 2 new scans added · 3 duplicate scans skipped/}).waitFor();

    await page.locator('#close-attendance-import').click();
    await page.locator('#attendance-import-dialog').waitFor({state:'hidden'});
    await page.locator('[data-page="staff"]').click();
    assert.equal(await page.locator('#staff-rows').count(),0);
    assert.equal(await page.locator('#staff-form').count(),0);
    await page.screenshot({path:join(root,'docs/users-codes-preview.png'),animations:'disabled'});
    await page.locator('#connection-details summary').click();
    await page.locator('#lan-sync').filter({hasText:/Off · Manual reads available/}).waitFor();
    assert.equal(await page.locator('#lan-ip').textContent(),'192.168.254.201');
    assert.equal(await page.locator('#lan-connector').textContent(),'Available (local file)');
    assert.equal(await page.locator('#lan-total-records').textContent(),'5');
    assert.equal(await page.locator('#probe-lan').isDisabled(),true);
    await page.locator('#sync-connector').click();
    await page.locator('#lan-sync-result').filter({hasText:'Success — 1 new record'}).waitFor();
    assert.equal(await page.locator('#lan-total-records').textContent(),'6');
    assert.equal(await page.locator('#lan-new-records').textContent(),'1');
    await page.locator('#sync-connector:enabled').waitFor();
    await page.locator('#sync-connector').click();
    await page.locator('#lan-sync-result').filter({hasText:'Success — No new records'}).waitFor();
    assert.equal(await page.locator('#lan-new-records').textContent(),'0');
    const lastSuccess=await page.locator('#lan-last-sync').textContent();
    // A missing source affects this attempt, not the existing attendance.
    await page.locator('#sync-connector:enabled').waitFor();
    renameSync(env.K14_CONNECTOR_DB,join(tmp,'offline.sqlite3'));
    await page.locator('#sync-connector').click();
    await page.locator('#lan-sync-result').filter({hasText:'Error'}).waitFor();
    assert.equal(await page.locator('#lan-last-sync').textContent(),lastSuccess);
    assert.equal(await page.locator('#lan-total-records').textContent(),'6');
    assert.equal(await page.locator('#lan-sync-error').textContent(),'Connector database was not found.');
    await page.locator('#sync-connector:enabled').waitFor();
    renameSync(join(tmp,'offline.sqlite3'),env.K14_CONNECTOR_DB);
    await page.locator('#sync-connector').click();
    await page.locator('#lan-sync-result').filter({hasText:'Success — No new records'}).waitFor();
    await page.screenshot({path:join(tmp,'connector-diagnostics.png'),animations:'disabled'});

    // A background importer changes real synthetic data while this page stays
    // open. Status must update by GET polling, keeping the editor untouched.
    await page.locator('[data-map-code="1|101"]').click();
    await page.locator('#code-label').fill('Unsaved live-refresh check');
    const liveUrl=page.url();
    let manualReads=0;
    const countManual=request=>{
      if(request.method()==='POST' && new URL(request.url()).pathname==='/api/device/sync')manualReads++;
    };
    page.on('request',countManual);
    const imported=spawnSync(python,['-c',`
import os, sqlite3
from app.k14_sync import run_sync
from app.db import connect
with sqlite3.connect(os.environ['K14_CONNECTOR_DB']) as con:
    con.execute('INSERT INTO attendance_raw VALUES(?,?,?,?,?,?)',
                ('192.168.254.201','1','2026-11-03 08:00:02','2','5','2026-11-23 03:01:00'))
assert run_sync(None, manual=True)['records_inserted'] == 1
with connect() as con:
    con.execute("UPDATE k14_sync_runs SET finished_at='2026-11-23 15:01:00' WHERE id=(SELECT MAX(id) FROM k14_sync_runs)")
`],{cwd:root,env,encoding:'utf8'});
    assert.equal(imported.status,0,imported.stderr);
    await page.locator('#lan-total-records').filter({hasText:/^7$/}).waitFor();
    await page.locator('#lan-last-sync').filter({hasText:'2026-11-23 15:01:00'}).waitFor();
    assert.equal(await page.locator('#lan-sync-result').textContent(),'Success — 1 new record');
    assert.equal(page.url(),liveUrl);
    assert.equal(manualReads,0);
    assert.equal(await page.locator('#code-dialog').getAttribute('open'),'');
    assert.equal(await page.locator('#code-label').inputValue(),'Unsaved live-refresh check');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'code-label');
    page.off('request',countManual);
    await page.locator('#close-code').click();

    // Import a fictional roster: staff appears by name in the monthly register.
    const roster=Buffer.from('employee_code,display_name,department\n1,Sample One,Sample Section\n2,Sample Two,Sample Section\n');
    await page.locator('#open-user-import').click();
    await page.locator('#user-import-dialog[open]').waitFor();
    await page.locator('#roster-file').setInputFiles({
      name:'fictional.csv',mimeType:'text/csv',buffer:roster
    });
    await page.locator('#roster-preview').click();
    await page.locator('#roster-result').filter({hasText:/Preview: 2 staff/}).waitFor();
    await page.locator('#roster-form button[type="submit"]').click();
    await page.locator('#roster-result').filter({hasText:/User sync complete: 2 staff/}).waitFor();
    await page.locator('#close-user-import').click();

    // Code 101 can be displayed as AJA in the local registry.
    await page.locator('[data-map-code="1|101"]').click();
    await page.locator('#code-label').fill('AJA device event');
    await page.locator('#code-activity').selectOption('AJA');
    await page.locator('#code-form button[type="submit"]').click();
    await page.locator('#code-rows').getByText('AJA device event').waitFor();
    await page.locator('[data-map-code="1|102"]').click();
    await page.locator('#code-label').fill('Travel Order scan');
    await page.locator('#code-activity').selectOption('Travel Order');
    await page.locator('#code-form button[type="submit"]').click();
    await page.locator('#code-rows').getByText('Travel Order scan').waitFor();

    // Create one pre-existing official TO reference through the authorized API,
    // not through a second filing UI (which no longer exists).
    const result=await page.evaluate(async () => {
      const response=await fetch('/api/activities',{
        method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
        body:JSON.stringify({employee_code:'1',category:'Travel Order',
          reference:'DEMO-TO-001',purpose:'Official assignment',
          start_at:'2026-11-23T00:00',end_at:'2026-11-25T00:00'})
      });
      return {status:response.status,data:await response.json()};
    });
    assert.equal(result.status,201,JSON.stringify(result));

    await page.locator('[data-page="activities"]').click();
    await page.locator('#activity-month').fill('2026-11');
    await page.locator('#activity-filter button[type="submit"]').click();
    await page.locator('#activity-rows .activity-aja').waitFor();
    await page.locator('#activity-rows .activity-travel').waitFor();
    assert.equal((await page.locator('#activity-rows').textContent()).includes('DEMO-TO-001'),false);
    assert.equal(await page.locator('#activity-rows tr').count(),2);
    assert.equal(await page.locator('#activity-form').count(),0);
    await page.screenshot({path:join(root,'docs/activity-monitoring-preview.png'),animations:'disabled'});
    await page.locator('#activity-category').selectOption('Travel Order');
    await page.locator('#activity-filter button[type="submit"]').click();
    await page.locator('#activity-rows .activity-travel').waitFor();
    assert.equal(await page.locator('#activity-rows tr').count(),1);
    assert.equal((await page.locator('#activity-rows').textContent()).includes('DEMO-TO-001'),false);

    await page.locator('[data-page="employees"]').click();
    await page.locator('#register-month').fill('2026-11');
    await page.locator('#employee-filter button[type="submit"]').click();
    await page.locator('#register-rows').getByText('Sample One').waitFor();
    await page.locator('[data-employee="1"]').last().click();
    await page.locator('#employee-detail:not(.hidden)').waitFor();
    await page.locator('#detail-name').filter({hasText:'Sample One'}).waitFor();
    await page.locator('#daily-rows .pill-to').first().waitFor();
    assert.ok((await page.locator('#daily-rows').textContent()).includes('Official Travel'));
    await page.locator('#preview-dtr').click();
    await page.locator('#dtr-dialog[open]').waitFor();
    assert.equal(await page.locator('#print-sheet .dtr-table tbody tr').count(),30);
    assert.ok((await page.locator('#print-sheet').textContent()).includes('OFFICIAL TRAVEL'));
    assert.ok((await page.locator('#print-sheet').textContent()).includes('REVIEW COPY'));
    await page.screenshot({path:join(root,'docs/dtr-preview.png'),animations:'disabled'});
    await page.locator('#close-dtr').click();
    await page.screenshot({path:join(root,'docs/employee-records-preview.png'),animations:'disabled'});
    await page.locator('#back-to-register').click();
    await page.screenshot({path:join(root,'docs/attendance-preview.png'),animations:'disabled'});

    // No unintended horizontal overflow on a normal phone viewport.
    await page.setViewportSize({width:390,height:800});
    await page.locator('[data-page="employees"]').click();
    await page.screenshot({path:join(root,'docs/mobile-records-preview.png'),animations:'disabled'});
    const width = await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:window.innerWidth}));
    assert.ok(width.document<=width.viewport+1,'Horizontal overflow: '+JSON.stringify(width));
    assert.deepEqual(errors,[],'Unhandled browser errors: '+errors.join(' | '));
    console.log('NCSC records-first browser smoke passed.');
  } finally {
    if(browser) await browser.close();
    server.kill('SIGTERM');
    rmSync(tmp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
