/* Optional isolated UI check: requires Playwright and its Chromium browser.
 * Run with node tests/browser_smoke.cjs. The app itself does not need Node.js.
 * All accounts and records are temporary fictional test data.
 */
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
  const temp = mkdtempSync(join(tmpdir(), 'ncsc-ui-'));
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const password = randomBytes(24).toString('hex');
  const env = {...process.env, SECRET_KEY:randomBytes(48).toString('hex'), DATABASE_PATH:join(temp,'test.sqlite3'), QA_PASSWORD:password, QA_PORT:String(port)};
  const python = process.env.TEST_PYTHON || join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const server = spawn(python, ['-u','-c', `
import os, uvicorn
from app.db import initialize, connect
from app.security import hash_password
initialize()
with connect() as con:
    con.execute("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')", ('qa-admin',hash_password(os.environ['QA_PASSWORD'])))
uvicorn.run('app.main:app',host='127.0.0.1',port=int(os.environ['QA_PORT']),log_level='error')
`], {cwd:root, env, stdio:['ignore','pipe','pipe']});
  let serverError = '';
  server.stderr.on('data', data => { serverError += data.toString(); });
  server.on('error', error => { serverError += error.message; });
  let browser;
  try {
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let i=0; i<80; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'Test server did not start: ' + serverError);
    browser = await chromium.launch({headless:true, ...(process.env.TEST_CHROMIUM ? {executablePath:process.env.TEST_CHROMIUM} : {})});
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const restored = page.waitForResponse(r => r.url().endsWith('/api/me'));
    await page.goto(base);
    await restored;
    mkdirSync(join(root,'docs'), {recursive:true});
    const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page exceeds viewport width');
    await page.locator('#login-view:not(.hidden)').waitFor();
    const signIn = async () => {
      await page.locator('#login-username').fill('qa-admin');
      await page.locator('#login-password').fill(password);
      await page.locator('#login-submit').click();
      await page.locator('#workspace:not(.hidden)').waitFor();
    };
    await fits();
    assert.equal(await page.locator('.welcome-shell, #explore-demo, #login-dialog').count(),0);
    assert.equal(await page.locator('#workspace').isVisible(),false);
    assert.equal(await page.locator('#login-username').evaluate(el => el === document.activeElement),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#login-view').isVisible(),true);
    await page.screenshot({animations:'disabled',path:join(root,'docs/login-preview.png')});
    await page.locator('#login-help').click();
    await page.locator('#login-help-text:not(.hidden)').waitFor();
    await page.locator('#login-help').click();
    await page.locator('#login-username').fill('qa-admin');
    await page.locator('#login-password').fill('wrong-password');
    await page.locator('#login-submit').click();
    await page.locator('#login-error:not(.hidden)').waitFor();
    assert.match(await page.locator('#login-error').textContent(), /Invalid username/);
    await page.locator('#login-password').fill(password);
    await page.getByRole('button',{name:'Show password',exact:true}).click();
    assert.equal(await page.locator('#login-password').getAttribute('type'),'text');
    await page.getByRole('button',{name:'Hide password',exact:true}).click();
    await page.locator('#login-submit').click();
    await page.locator('#workspace:not(.hidden)').waitFor();
    await page.locator('#metric-scans').filter({hasText:/^0$/}).waitFor();
    await page.locator('[data-page="imports"]').click();
    assert.equal(await page.locator('#import-submit').isEnabled(), false);
    const sample = Buffer.from('DEMO001\t2026-11-03 07:21:07\t1\t0\t1\t0\nDEMO001\t2026-11-03 17:05:45\t1\t4\t1\t0\nDEMO002\t2026-11-04 08:12:00\t1\t0\t1\t0\n');
    await page.locator('#attendance-file').setInputFiles({name:'fictional.txt',mimeType:'text/plain',buffer:sample});
    await page.locator('#preview-btn').click();
    await page.getByRole('heading',{name:'Source log preview'}).waitFor();
    assert.equal(await page.locator('#import-submit').isEnabled(),true);
    await page.locator('#import-submit').click();
    await page.getByRole('heading',{name:'Import complete'}).waitFor();
    await page.locator('#preview-btn').click();
    await page.getByText('This exact file has already been imported.').waitFor();
    assert.equal(await page.locator('#import-submit').isEnabled(),false);
    await page.locator('#attendance-file').setInputFiles(join(root,'tests/fixtures/k14_sample.xls'));
    await page.locator('#preview-btn').click();
    await page.getByRole('heading',{name:'Excel report preview'}).waitFor();
    assert.equal(await page.locator('#import-submit').isEnabled(),false);
    await page.locator('[data-page="attendance"]').click();
    await page.locator('#filter-id').fill('DEMO001');
    await page.locator('#filter-from').fill('2026-11-03');
    await page.locator('#filter-to').fill('2026-11-03');
    await page.getByRole('button',{name:'Apply filters'}).click();
    await page.locator('#punch-count').filter({hasText:'1–2 of 2 records'}).waitFor();
    assert.equal(await page.locator('#punch-rows tr').count(),2);
    await page.locator('[data-page="fieldwork"]').click();
    const form = page.locator('#fieldwork-form');
    await form.locator('[name="employee_code"]').fill('DEMO001');
    await form.locator('[name="category"]').selectOption('Travel Order');
    await form.locator('[name="reference"]').fill('FICTIONAL-TO-001');
    await form.locator('[name="start_at"]').fill('2026-11-20T09:00');
    await form.locator('[name="end_at"]').fill('2026-11-20T16:00');
    await form.locator('[name="purpose"]').fill('Fictional test activity for browser verification');
    await page.locator('#fieldwork-submit').click();
    await page.locator('#fieldwork-items .tag').filter({hasText:'On file'}).waitFor();
    assert.equal(await page.locator('[data-decision], #confirm-decision').count(),0);
    await page.locator('[data-page="dtr"]').click();
    await page.locator('#dtr-month').fill('2026-11');
    await page.locator('#dtr-employee').selectOption('DEMO001');
    await page.getByRole('button',{name:'View daily records'}).click();
    await page.locator('#dtr-summary').filter({hasText:'2 scans across 1 days'}).waitFor();
    assert.equal(await page.locator('#dtr-rows tr').count(),30);
    await page.locator('#dtr-rows').getByText('07:21:07',{exact:true}).waitFor();
    await page.locator('#dtr-rows').getByText('FICTIONAL-TO-001',{exact:false}).waitFor();
    assert.equal(await page.locator('#dtr-rows').getByText('Absent',{exact:true}).count(),0);
    await page.screenshot({animations:'disabled',path:join(root,'docs/monitoring-preview.png'),fullPage:true});
    await page.locator('[data-page="fieldwork"]').click();
    await page.getByRole('button',{name:'Void reference',exact:true}).click();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.locator('#fieldwork-items .tag').textContent(),'On file');
    await page.getByRole('button',{name:'Void reference',exact:true}).click();
    await page.locator('#void-reason').fill('Fictional correction test');
    await page.locator('#confirm-void').click();
    await page.locator('#fieldwork-items .empty').waitFor();
    await page.locator('#activity-status').selectOption('voided');
    await page.locator('#fieldwork-items .tag').filter({hasText:'Voided'}).waitFor();
    await page.reload();
    await page.locator('#workspace:not(.hidden)').waitFor();
    await page.locator('[data-page="overview"]').click();
    await page.locator('#metric-scans').filter({hasText:/^3$/}).waitFor();
    await page.screenshot({animations:'disabled',path:join(root,'docs/dashboard-preview.png'),fullPage:true});
    await page.locator('#logout').click();
    await page.locator('#login-view:not(.hidden)').waitFor();
    assert.equal((await context.request.get(base+'/api/overview')).status(),401);
    for (const width of [768,390,320]) {
      await page.setViewportSize({width,height:844});
      const restore = page.waitForResponse(r => r.url().endsWith('/api/me'));
      await page.reload();
      await restore;
      await page.locator('#login-view:not(.hidden)').waitFor();
      await fits();
      const card = await page.locator('.login-card').boundingBox();
      assert.ok(card.x >= 0 && card.x+card.width <= width, 'Sign-in card exceeds viewport');
      const submit = await page.locator('#login-submit').boundingBox();
      assert.ok(submit.y >= 0 && submit.y+submit.height <= 844, 'Sign-in button exceeds viewport');
      if (width === 390) await page.screenshot({animations:'disabled',path:join(root,'docs/mobile-login-preview.png')});
      await signIn();
      for (const target of ['overview','attendance','imports','fieldwork','dtr']) {
        await page.locator('[data-page="'+target+'"]').click();
        await fits();
      }
      assert.equal(await page.locator('#fieldwork-submit').isEnabled(),true);
      await page.locator('#logout').click();
      await page.locator('#login-view:not(.hidden)').waitFor();
      assert.equal(await page.locator('#login-username').inputValue(),'');
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: direct sign-in without landing/demo, focus and account help, login errors, password visibility, session restore/logout, import preview/dedup, XLS preview, date filters, activity reference recording/void history, daily monitoring, and 1440/768/390/320px layouts.');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(r => { if(server.exitCode !== null) r(); else { server.once('exit',r); setTimeout(r,2000).unref(); } });
    rmSync(temp,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
