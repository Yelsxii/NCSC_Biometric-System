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
    assert.equal(await page.locator('#account').count(),0);
    assert.ok(await page.locator('#logout-sidebar').isVisible());
    assert.equal(await page.locator('#logout-sidebar span').textContent(),'Sign out');
    const navTypography=await page.locator('.sidebar .nav-item > span').first().evaluate(el=>({size:getComputedStyle(el).fontSize,casing:getComputedStyle(el).textTransform}));
    assert.equal(navTypography.size,'12px');
    assert.equal(navTypography.casing,'none');
    assert.equal(await page.locator('.sidebar .nav-icon').first().evaluate(el=>getComputedStyle(el).width),'22px');
    assert.equal(await page.locator('#logout-sidebar svg').evaluate(el=>getComputedStyle(el).width),'22px');
    assert.equal(await page.locator('#logout-sidebar').evaluate(el=>getComputedStyle(el).textTransform),'none');
    assert.equal(await page.locator('.sidebar .brand img').evaluate(el=>el.getBoundingClientRect().width),48);
    assert.equal(await page.locator('.topbar #logout').count(),0);
    assert.equal(await page.locator('.sidebar-footer').count(),0);
    assert.match(await page.locator('#live-time').textContent(),/\d{1,2}:\d{2}:\d{2}/);
    const initialClock=await page.locator('#live-time').textContent();
    await page.waitForFunction(previous=>document.querySelector('#live-time').textContent!==previous,initialClock);
    await page.setViewportSize({width:620,height:820});
    assert.ok(await page.locator('#logout-sidebar').isVisible());
    assert.equal(await page.locator('.topbar #logout').count(),0);
    const compactChrome=await page.evaluate(()=>{
      const nav=document.querySelector('.nav-item.active');
      const icon=nav.querySelector('.nav-icon');
      const clock=document.querySelector('.workspace-clock');
      const date=document.querySelector('.clock-date-row');
      const time=document.querySelector('#live-time');
      return {accentContent:getComputedStyle(nav,'::before').content,activeHalo:getComputedStyle(nav).backgroundImage,
        glow:getComputedStyle(icon).filter, iconColor:getComputedStyle(icon).color,
        activeBackground:getComputedStyle(nav).backgroundColor,
        iconStroke:getComputedStyle(icon).strokeWidth,
        timeLeft:time.getBoundingClientRect().left,dateLeft:date.getBoundingClientRect().left,
        clockLeft:clock.getBoundingClientRect().left,
        signoutLabel:getComputedStyle(document.querySelector('#logout-sidebar span')).display};
    });
    assert.equal(compactChrome.accentContent,'none','No vertical accent bar');
    assert.ok(compactChrome.activeHalo.includes('radial-gradient'),'Selected icon has a localized red halo');
    assert.notEqual(compactChrome.glow,'none');
    assert.equal(compactChrome.iconColor,'rgb(255, 137, 155)');
    assert.equal(compactChrome.activeBackground,'rgb(11, 29, 57)');
    assert.equal(compactChrome.iconStroke,'2px');
    assert.ok(Math.abs(compactChrome.timeLeft-compactChrome.dateLeft)<=1,'Time aligns with left edge of calendar row');
    assert.equal(compactChrome.signoutLabel,'none');
    await page.locator('#logout-sidebar').hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.signout-arrow')).transform!=='none');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.signout-door')).transform!=='none');
    assert.equal(await page.locator('.signout-frame').evaluate(el=>getComputedStyle(el).transform),'none','The door frame must remain stationary');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.signout-arrow').evaluate(el=>getComputedStyle(el).transform),'none');
    assert.equal(await page.locator('.signout-door').evaluate(el=>getComputedStyle(el).transform),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const railLayout=await page.locator('.sidebar').evaluate(el=>({
      width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,
      viewportHeight:innerHeight,labelDisplay:getComputedStyle(el.querySelector('.nav-item>span')).display
    }));
    assert.ok(railLayout.width<=64 && railLayout.height>=railLayout.viewportHeight-1);
    assert.equal(railLayout.labelDisplay,'none');
    assert.equal(await page.locator('.sidebar .nav-icon').first().evaluate(el=>getComputedStyle(el).width),'24px');
    assert.equal(await page.locator('#logout-sidebar svg').evaluate(el=>getComputedStyle(el).width),'24px');
    const menuHover=page.locator('[data-page="profiles"]');
    await menuHover.hover();
    await page.waitForFunction(()=>{
      const el=document.querySelector('[data-page="profiles"]');
      const icon=getComputedStyle(el.querySelector('.nav-icon'));
      return icon.transform!=='none' && icon.filter!=='none' &&
        getComputedStyle(el).backgroundColor==='rgb(32, 57, 99)';
    });
    assert.equal(await menuHover.getAttribute('aria-current'),null,'Hover must not select a page');
    assert.equal(await page.locator('[data-page="employees"]').getAttribute('aria-current'),'page');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await menuHover.locator('.nav-icon').evaluate(el=>getComputedStyle(el).transform),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('[data-page="employees"]').hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-page="employees"]'),'::after').visibility==='visible');
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#workspace:not(.hidden)').waitFor();
    await page.locator('[data-page="employees"].active').waitFor();
    assert.equal(await page.locator('[data-page]').count(),4);
    assert.equal(await page.locator('[data-page="overview"]').count(),0);
    assert.equal(await page.locator('#page-description').count(),0);

    assert.equal(await page.locator('#register-rows').locator('tr').count(),1);
    assert.equal(await page.locator('thead').first().getByText('Last scan').count(),0);
    assert.equal(await page.locator('thead').first().getByText('Scans this month').count(),0);
    assert.equal(await page.locator('#add-staff').count(),0);
    assert.equal(await page.locator('#register-from-attendance').count(),0);
    assert.equal(await page.locator('#attendance-register-panel .pagination').count(),0);
    assert.equal(await page.locator('#register-count').textContent(),'1 employee');
    assert.equal(await page.locator('#register-rows .name-avatar').count(),0);
    assert.equal(await page.locator('#register-rows [data-edit-profile]').count(),0);
    await page.locator('#register-rows .directory-action-cell .row-action').first().waitFor();
    assert.equal(await page.locator('#register-rows .row-action').first().evaluate(el=>getComputedStyle(el).textDecorationLine),'none');
    assert.notEqual(await page.locator('#register-rows .directory-action-cell').first().evaluate(el=>getComputedStyle(el).boxShadow),'none');
    const actionCell=page.locator('#register-rows .directory-action-cell').first();
    const desktopAction=await actionCell.boundingBox();
    assert.ok(desktopAction.width>=145 && desktopAction.width<=165,'Desktop action rail should be compact');
    await page.setViewportSize({width:620,height:820});
    const narrowAction=await actionCell.boundingBox();
    assert.ok(narrowAction.width>=125 && narrowAction.width<=160,'Narrow action rail retains its proportional layout');
    await page.setViewportSize({width:1440,height:900});
    assert.equal(await page.locator('#attendance-register-panel .panel-header').count(),0);
    assert.equal(await page.locator('#employee-filter button[type="submit"]').count(),0);
    await page.locator('#employee-search').fill('zzzz-no-match');
    await page.locator('#register-rows').getByText('No employees found.').waitFor();
    await page.locator('#employee-search').fill('s');
    await page.locator('#register-rows .row-action').first().waitFor();
    await page.locator('#clear-employee-search').click();
    assert.equal(await page.locator('#employee-search').inputValue(),'');
    await page.locator('#register-rows .row-action').first().waitFor();
    // USB recovery remains a separate modal.
    const importButton=page.locator('#open-attendance-import');
    await importButton.hover();
    await page.waitForFunction(()=>{
      const button=document.querySelector('#open-attendance-import');
      const icon=button.querySelector('svg');
      const styles=getComputedStyle(icon);
      return getComputedStyle(button).color==='rgb(255, 255, 255)' &&
        styles.color==='rgb(255, 255, 255)' && styles.stroke==='rgb(255, 255, 255)';
    });
    await importButton.click();
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

    // Additional fictional daily punches exercise the DTR slot editor.
    const dailySeed=await page.evaluate(async()=>{
      const body=new FormData();
      body.append('file',new File([
        '1\t2026-11-02 07:30:07\t1\t9\t1\t0\n'+
        '1\t2026-11-02 12:00:11\t1\t9\t1\t0\n'+
        '1\t2026-11-02 13:00:13\t1\t9\t1\t0\n'+
        '1\t2026-11-02 17:00:17\t1\t9\t1\t0\n'
      ],'fictional-day.dat'));
      return (await fetch('/api/imports',{method:'POST',headers:{'X-CSRF-Token':session.csrf},body})).status;
    });
    assert.equal(dailySeed,200);
    await page.locator('[data-page="employees"]').click();
    await page.locator('#register-month-trigger').click();
    await page.locator('#attendance-month-picker[open]').waitFor();
    const desktopPicker=await page.locator('#attendance-month-picker').boundingBox();
    assert.ok(desktopPicker.width<=217 && desktopPicker.height<=220,'Desktop month picker should be compact');
    await page.setViewportSize({width:620,height:820});
    const narrowPicker=await page.locator('#attendance-month-picker').boundingBox();
    assert.ok(narrowPicker.width<=217 && narrowPicker.height<=220,'Narrow month picker should also be compact');
    assert.equal(await page.locator('#month-picker-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),4);
    const currentAccent=await page.locator('#month-picker-grid .is-current').evaluateAll(nodes=>nodes.map(el=>{
      const accent=getComputedStyle(el,'::after');
      return {width:accent.width,height:accent.height};
    }));
    assert.ok(currentAccent.every(accent=>accent.width==='14px'&&accent.height==='2px'),'Current month uses a compact coral light strip');
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#month-year-value').waitFor();
    const pickerYear=Number(await page.locator('#month-year-value').textContent());
    for(let y=pickerYear;y>2026;y--)await page.locator('#month-year-prev').click();
    for(let y=pickerYear;y<2026;y++)await page.locator('#month-year-next').click();
    await page.locator('[data-month-value="2026-11"]').click();
    assert.equal(await page.locator('#register-month').inputValue(),'2026-11');
    assert.match(await page.locator('#register-month-trigger').textContent(),/November 2026/);
    await page.locator('#register-rows .row-action').first().waitFor();
    await page.locator('#register-rows').getByText('Sample One').waitFor();
    await page.locator('[data-employee="1"]').last().click();
    await page.locator('#employee-detail:not(.hidden)').waitFor();
    await page.locator('#detail-name').filter({hasText:'Sample One'}).waitFor();
    await page.locator('#detail-month-trigger').click();
    await page.locator('#attendance-month-picker[open]').waitFor();
    assert.equal(await page.locator('[data-month-value="2026-11"]').getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Escape');
    await page.locator('#attendance-month-picker').waitFor({state:'hidden'});
    await page.locator('#daily-rows .slot-travel .travel-status').first().waitFor();
    assert.ok((await page.locator('#daily-rows').textContent()).includes('Travel Order'));
    assert.equal(await page.locator('#daily-table-wrap colgroup col').count(),13);
    assert.equal(await page.locator('#daily-rows .unassigned-count').count(),0);
    assert.equal(await page.locator('#daily-table-wrap th.travel-column').count(),0);
    assert.equal(await page.locator('#attendance-month-status').count(),0);
    const travelDay=page.locator('#daily-rows [data-date="2026-11-23"]');
    assert.equal(await travelDay.locator('td.slot-travel[colspan="4"]').count(),1);
    assert.equal(await travelDay.locator('td.slot-travel[colspan="2"]').count(),0);
    assert.equal(await travelDay.locator('.time-value').count(),0);
    await travelDay.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#review-time-section').isVisible(),false);
    assert.equal(await page.locator('#review-reference').inputValue(),'DEMO-TO-001');
    await page.locator('#review-reference').fill('DEMO-TO-002');
    await page.locator('#save-day-review').click();
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await travelDay.getByText('Travel Order No.: DEMO-TO-002',{exact:true}).waitFor();
    assert.equal(await page.locator('#daily-rows tr').count(),30);
    assert.equal(await page.locator('#print-dtr').count(),0);
    assert.equal(await page.locator('#export-dtr').count(),0);
    assert.equal(await page.locator('#detail-events').count(),0);
    assert.equal(await page.locator('#detail-id').count(),0);
    assert.equal(await page.locator('#employee-detail table').count(),1);
    assert.equal(await page.locator('.page-heading').count(),0);
    assert.equal(await page.locator('.breadcrumb-home').count(),0);
    const day=page.locator('#daily-rows [data-date="2026-11-02"]');
    assert.equal(await day.locator('.slot-holiday').count(),4); // Four real scans retain the national holiday cell color
    assert.equal(await day.locator('.time-value').count(),4);
    await day.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#day-review-dialog details').count(),0);
    assert.equal(await page.locator('#clock-am-in').inputValue(),'07:30:07');
    await page.locator('[data-clock-pick="am-in"]').click();
    await page.locator('#clock-picker').waitFor();
    await page.locator('#picker-minute').fill('31');
    await page.locator('#clock-picker-apply').click();
    assert.equal(await page.locator('#clock-am-in').inputValue(),'07:31:07');
    assert.equal(await page.locator('#review-reason-field').isVisible(),true);
    await page.locator('#clock-am-in').fill('07:30:07');
    assert.equal(await page.locator('#review-reason-field').isVisible(),false);
    await page.locator('#review-ut-hours').fill('0');
    await page.locator('#review-ut-minutes').fill('0');
    await page.screenshot({path:join(root,'docs/attendance-editor-preview.png'),animations:'disabled'});
    await page.locator('#save-day-review').click();
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await day.locator('.time-value').filter({hasText:'07:30'}).waitFor();
    assert.equal(await day.locator('.time-value').count(),4);
    assert.equal(await day.locator('.time-code').count(),0);
    assert.match(await day.locator('.time-slot').first().getAttribute('title'),/Work code 0/);
    assert.match(await day.locator('.time-value').first().textContent(),/^\d{2}:\d{2}:\d{2}$/);
    assert.equal(await day.locator('.undertime-value').first().textContent(),'0');
    const compact=await day.boundingBox();
    assert.ok(compact.height<=43,'Daily rows should stay compact: '+compact.height);
    assert.equal(await page.locator('#open-calendar').count(),0);
    await page.locator('[data-date="2026-11-30"].day-holiday').waitFor();
    // Manual source slots fill gaps; original biometric boundaries stay exact.
    const boundaries=await page.evaluate(async()=>{
      const body=new FormData();
      body.append('file',new File(['1\t2026-11-06 08:00:07\t1\t9\t1\t0\n1\t2026-11-06 17:00:11\t1\t9\t1\t0\n'],'fictional-boundaries.dat'));
      return (await fetch('/api/imports',{method:'POST',headers:{'X-CSRF-Token':session.csrf},body})).status;
    });
    assert.equal(boundaries,200);
    const manualPackage={format:'ncsc-manual-dtr-v1',source:{id:'fictional-workbook',title:'Fictional manual DTR'},people:[{
      key:'sample-one',name:'Sample One',sheet:'SAMPLE_ONE',rows:[
        {row:7,values:['2026-11-06','Friday','08:00','12:00','13:00','17:00',null,null,8/24,0,0,'Complete']},
        {row:8,values:['2026-11-09','Monday','08:00','12:00','13:00','18:00',null,null,9/24,0,1/24,'Complete']},
        {row:9,values:['2026-11-10','Tuesday','08:30','12:00','13:00','17:00',null,null,7.5/24,.5/24,0,'Undertime']}
      ]}]};
    assert.equal(await page.locator('#open-manual-dtr').count(),0);
    const importResult=await page.evaluate(async packet=>{
      const form=new FormData();form.append('file',new File([JSON.stringify(packet)],'fictional-manual.json',{type:'application/json'}));
      form.append('mapping',JSON.stringify({'sample-one':'1'}));
      const headers={'X-CSRF-Token':session.csrf};
      const preview=await fetch('/api/manual-dtr/preview',{method:'POST',headers,body:form});
      if(!preview.ok)return {status:preview.status};
      form.append('preview_token',(await preview.json()).preview_token);
      const imported=await fetch('/api/manual-dtr/import',{method:'POST',headers,body:form});
      return {status:imported.status};
    },manualPackage);
    assert.equal(importResult.status,200);
    // The attendance screen reflects source reconciliation on its normal live refresh.
    await page.locator('[data-date="2026-11-06"] [data-origin="manual_sheet"]').first().waitFor({timeout:15000});
    await page.screenshot({path:join(root,'docs/manual-dtr-preview.png'),animations:'disabled'});
    const filled=page.locator('[data-date="2026-11-06"]');
    await filled.locator('[data-origin="manual_sheet"]').first().waitFor();
    assert.equal(await filled.locator('[data-origin="biometric"]').count(),2);
    assert.equal(await filled.locator('[data-origin="manual_sheet"]').count(),2);
    assert.equal(await filled.locator('.daily-total-value').textContent(),'8:00');
    assert.equal(await filled.locator('.monitor-remark').textContent(),'Complete');
    assert.equal(await page.locator('[data-date="2026-11-09"] .overtime-value').textContent(),'1:00');
    assert.equal(await page.locator('[data-date="2026-11-10"] .monitor-remark').textContent(),'Undertime');
    const headerAlignment=await page.evaluate(()=>{
      const name=document.querySelector('#detail-name').getBoundingClientRect();
      const month=document.querySelector('#detail-month-trigger').getBoundingClientRect();
      const back=document.querySelector('#back-to-register').getBoundingClientRect();
      const category=document.querySelector('#detail-category').getBoundingClientRect();
      return {nameLeft:name.left,monthLeft:month.left,backLeft:back.left,backRight:back.right,
        categoryLeft:category.left,nameRight:name.right,categoryTop:category.top,nameTop:name.top,
        categoryRadius:getComputedStyle(document.querySelector('#detail-category .tag')).borderTopLeftRadius,
        monthHeight:month.height,backHeight:back.height,
        labelHidden:document.querySelector('.month-inline .sr-only')!==null};
    });
    assert.ok(Math.abs(headerAlignment.nameLeft-headerAlignment.backLeft)<=2,'Employee name must return to the left edge');
    assert.ok(headerAlignment.categoryLeft>=headerAlignment.nameRight,'Category must sit next to employee name');
    assert.ok(Math.abs(headerAlignment.categoryTop-headerAlignment.nameTop)<=12,'Category and name should share a row');
    assert.equal(headerAlignment.categoryRadius,'999px');
    assert.ok(headerAlignment.backRight<headerAlignment.monthLeft,'Back arrow precedes month');
    assert.ok(Math.abs(headerAlignment.monthHeight-headerAlignment.backHeight)<=2,'Navigation controls align vertically');
    assert.ok(headerAlignment.labelHidden,'Month label is available to assistive technology only');
    const detailStyle=await page.evaluate(()=>({
      buttonBorder:getComputedStyle(document.querySelector('.edit-day')).borderTopWidth,
      buttonDecoration:getComputedStyle(document.querySelector('.edit-day')).textDecorationLine,
      dotRadius:getComputedStyle(document.querySelector('.legend-entry'),'::before').borderRadius,
      dotGlow:getComputedStyle(document.querySelector('.legend-entry'),'::before').boxShadow,
      actionPosition:getComputedStyle(document.querySelector('#daily-table-wrap .day-action')).position,
      actionShadow:getComputedStyle(document.querySelector('#daily-table-wrap .day-action')).boxShadow,
      actionBackground:getComputedStyle(document.querySelector('#daily-table-wrap .day-action')).backgroundColor
    }));
    assert.equal(detailStyle.buttonBorder,'0px');
    assert.equal(detailStyle.buttonDecoration,'none');
    assert.equal(detailStyle.dotRadius,'50%');
    assert.notEqual(detailStyle.dotGlow,'none');
    assert.equal(detailStyle.actionPosition,'sticky');
    assert.notEqual(detailStyle.actionShadow,'none');
    assert.equal(detailStyle.actionBackground,'rgb(255, 255, 255)');
    await page.screenshot({path:join(root,'docs/employee-records-preview.png'),animations:'disabled'});
    const previousViewport=page.viewportSize();
    await page.setViewportSize({width:1150,height:850});
    const fit=await page.locator('#daily-table-wrap').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    if(fit.width>=960)assert.ok(fit.scroll<=fit.width+2,'Attendance columns should fit when space permits');
    await page.setViewportSize(previousViewport);
    await page.setViewportSize({width:500,height:800});
    const compactHeader=await page.evaluate(()=>{
      const identity=document.querySelector('.sheet-identity').getBoundingClientRect();
      const personnel=document.querySelector('.sheet-personnel').getBoundingClientRect();
      const filters=document.querySelector('.sheet-filters').getBoundingClientRect();
      const panel=document.querySelector('.attendance-sheet').getBoundingClientRect();
      return {identityTop:identity.top,personnelTop:personnel.top,identityRight:identity.right,
        personnelLeft:personnel.left,identityBottom:identity.bottom,personnelBottom:personnel.bottom,
        filtersTop:filters.top,panelRight:panel.right,viewport:innerWidth};
    });
    assert.ok(Math.abs(compactHeader.identityTop-compactHeader.personnelTop)<=2,'Department must not consume a separate header row at split width');
    assert.ok(compactHeader.identityRight<=compactHeader.personnelLeft+2,'Name and department cannot overlap');
    assert.ok(compactHeader.filtersTop-Math.max(compactHeader.identityBottom,compactHeader.personnelBottom)<=12,'Compact controls should follow the header without empty space');
    assert.ok(compactHeader.panelRight<=compactHeader.viewport+1,'Panel must remain inside the window');
    await page.setViewportSize({width:390,height:800});
    const rail = await page.locator('#daily-table-wrap').evaluate(el=>{
      el.scrollLeft=el.scrollWidth;
      const row=el.querySelector('tbody tr');
      const action=row.querySelector('.day-action').getBoundingClientRect();
      const remark=row.querySelector('.day-activities').getBoundingClientRect();
      const wrap=el.getBoundingClientRect();
      const result={remarkRight:remark.right,actionLeft:action.left,actionRight:action.right,wrapRight:wrap.right};
      el.scrollLeft=0;
      return result;
    });
    assert.ok(rail.remarkRight<=rail.actionLeft+2,'Remarks must be readable when scrolled to the right');
    assert.ok(rail.actionRight<=rail.wrapRight+2,'Action rail must remain in the table');
    assert.ok((await page.locator('#detail-month-trigger').boundingBox()).width>=150,'Mobile reporting month must fit its full label');
    await page.screenshot({path:join(root,'docs/mobile-attendance-preview.png'),animations:'disabled'});
    await day.locator('[data-edit-day]').click();
    const dayPopup=await page.locator('#day-review-dialog').boundingBox();
    const daySave=await page.locator('#save-day-review').boundingBox();
    assert.ok(dayPopup.x>=0 && dayPopup.x+dayPopup.width<=391);
    assert.ok(daySave.y+daySave.height<=800);
    await page.locator('#cancel-day-review').click();
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#back-to-register').click();
    await page.screenshot({path:join(root,'docs/attendance-preview.png'),animations:'disabled'});

    // Complete an existing identity without replacing its attendance or ID.
    await page.locator('[data-page="profiles"]').click();
    await page.locator('#profile-rows [data-edit-profile="1"]').click();
    await page.locator('#profile-dialog[open]').waitFor();
    assert.equal(await page.locator('#profile-id').getAttribute('readonly'),'');
    await page.locator('#profile-first').fill('Sample');
    await page.locator('#profile-last').fill('One');
    await page.locator('#profile-type').selectOption('Permanent');
    await page.locator('#profile-position').fill('Records Analyst');
    await page.locator('#profile-confirm').check();
    await page.locator('#save-profile').click();
    await page.locator('#profile-dialog').waitFor({state:'hidden'});
    await page.locator('#profile-rows').getByText('Permanent',{exact:true}).waitFor();

    // Register a new approved ID and preserve a duplicate attempt as an error.
    await page.locator('#open-profile').click();
    await page.locator('#profile-id').fill('25');
    await page.locator('#profile-first').fill('Example');
    await page.locator('#profile-last').fill('Employee');
    await page.locator('#profile-type').selectOption('COS');
    await page.locator('#profile-department').fill('Sample Office');
    await page.locator('#profile-confirm').check();
    await page.screenshot({path:join(root,'docs/employee-registration-preview.png'),animations:'disabled'});
    await page.locator('#save-profile').click();
    await page.locator('#profile-dialog').waitFor({state:'hidden'});
    await page.locator('[data-edit-profile="25"]').waitFor();
    await page.locator('#open-profile').click();
    await page.locator('#profile-id').fill('25');
    await page.locator('#profile-first').fill('Wrong duplicate');
    await page.locator('#profile-last').fill('Name');
    await page.locator('#profile-type').selectOption('COS');
    await page.locator('#profile-confirm').check();
    await page.locator('#save-profile').click();
    await page.locator('#profile-error').filter({hasText:/already has a profile/}).waitFor();
    await page.locator('#cancel-profile').click();

    // Fictional profiles fill the list, exercising category tabs and pagination.
    const seeded=await page.evaluate(async()=>{
      for(let i=30;i<43;i++){
        const response=await fetch('/api/employee-profiles',{
          method:'POST',credentials:'same-origin',
          headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
          body:JSON.stringify({employee_code:String(i),first_name:'Sample '+i,last_name:'Employee',
            employment_type:['COS','Permanent','GIP','OJT'][i%4],department:'Sample Office',
            position:'Example designation',sync_authorized:true,device_enrollment_confirmed:true})
        });
        if(response.status!==201)return response.text();
      }
      return 'ok';
    });
    assert.equal(seeded,'ok');
    await page.locator('#profile-search').fill('');
    await page.locator('#profile-filter button[type="submit"]').click();
    await page.locator('#profile-total-badge').filter({hasText:/^16$/}).waitFor();
    assert.equal(await page.locator('#profile-rows tr').count(),15);
    await page.locator('#profile-next').click();
    await page.locator('#profile-page').filter({hasText:'Page 2 of 2'}).waitFor();
    assert.equal(await page.locator('#profile-rows tr').count(),1);
    await page.locator('#profile-prev').click();
    await page.locator('#profile-page').filter({hasText:'Page 1 of 2'}).waitFor();
    await page.screenshot({path:join(root,'docs/employee-profiles-preview.png'),animations:'disabled'});
    await page.locator('[data-profile-category="GIP"]').click();
    await page.locator('#profile-rows .tag-gip').first().waitFor();
    assert.equal(await page.locator('#profile-rows .tag-cos').count(),0);

    const layout=await page.evaluate(()=>({
      buttonHeight:document.querySelector('#open-profile').getBoundingClientRect().height,
      scrollbar:getComputedStyle(document.querySelector('#main-content')).scrollbarWidth,
      pageHeight:document.documentElement.scrollHeight,viewport:window.innerHeight
    }));
    assert.ok(layout.buttonHeight<=35);
    assert.equal(layout.scrollbar,'none');
    assert.ok(layout.pageHeight<=layout.viewport+1);

    // Keep long popup forms usable on mobile with an accessible visible footer.
    await page.setViewportSize({width:390,height:800});
    await page.locator('#open-profile').click();
    const popup=await page.locator('#profile-dialog').boundingBox();
    const save=await page.locator('#save-profile').boundingBox();
    assert.ok(popup.x>=0 && popup.x+popup.width<=391);
    assert.ok(save.y+save.height<=800);
    await page.screenshot({path:join(root,'docs/mobile-registration-preview.png'),animations:'disabled'});
    await page.locator('#cancel-profile').click();

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
