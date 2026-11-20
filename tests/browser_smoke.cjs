/* Headless end-to-end smoke test with fictional staff/attendance only. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
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
    QA_PASSWORD:password, QA_PORT:String(port)
  };
  const python = process.env.TEST_PYTHON ||
    join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const server = spawn(python,['-u','-c',`
import os, uvicorn
from app.db import initialize, connect
from app.security import hash_password
initialize()
with connect() as con:
    con.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')",
                ('qa-admin',hash_password(os.environ['QA_PASSWORD'])))
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
    await page.screenshot({path:join(root,'docs/login-preview.png'),animations:'disabled'});
    await page.locator('#login-username').fill('qa-admin');
    await page.locator('#login-password').fill(password);
    await page.locator('#login-submit').click();
    await page.locator('#workspace:not(.hidden)').waitFor();
    await page.locator('#metric-employees').filter({hasText:/^0$/}).waitFor();

    // Import a fictional K14 log; no real employee data or fingerprint templates.
    await page.locator('[data-page="device"]').click();
    await page.locator('#lan-sync').filter({hasText:/Not active/}).waitFor();
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
    await page.locator('#usb-result').filter({hasText:/Imported 3 new scans/}).waitFor();

    // Import a fictional roster: staff appears by name in the monthly register.
    const roster=Buffer.from('employee_code,display_name,department\n1,Sample One,Sample Section\n2,Sample Two,Sample Section\n');
    await page.locator('#roster-file').setInputFiles({
      name:'fictional.csv',mimeType:'text/csv',buffer:roster
    });
    await page.locator('#roster-preview').click();
    await page.locator('#roster-result').filter({hasText:/Preview: 2 staff/}).waitFor();
    await page.locator('#roster-form button[type="submit"]').click();
    await page.locator('#roster-result').filter({hasText:/Roster updated: 2 staff/}).waitFor();

    // Existing official order: November 23 and 24; no fake scans.
    await page.locator('[data-page="activities"]').click();
    await page.locator('#activity-employee').fill('1');
    await page.locator('#activity-type').selectOption('Travel Order');
    await page.locator('#activity-reference').fill('DEMO-TO-001');
    await page.locator('#activity-purpose').fill('Official assignment');
    await page.locator('#activity-start').fill('2026-11-23T00:00');
    await page.locator('#activity-end').fill('2026-11-25T00:00');
    await page.locator('#activity-form button[type="submit"]').click();
    await page.locator('#activity-rows').getByText('DEMO-TO-001').waitFor();

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
    await page.locator('[data-page="overview"]').click();
    await page.screenshot({path:join(root,'docs/dashboard-preview.png'),animations:'disabled'});

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
