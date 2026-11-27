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
    assert.equal(await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().width),252,'Expanded desktop sidebar accommodates the full agency name');
    assert.equal(await page.locator('.sidebar .nav-icon').first().evaluate(el=>getComputedStyle(el).width),'22px');
    assert.equal(await page.locator('#logout-sidebar svg').evaluate(el=>getComputedStyle(el).width),'22px');
    assert.equal(await page.locator('#logout-sidebar').evaluate(el=>getComputedStyle(el).textTransform),'none');
    assert.equal(await page.locator('.sidebar .brand img').evaluate(el=>el.getBoundingClientRect().width),58);
    assert.equal(await page.locator('.sidebar .brand strong').innerText(),'NATIONAL COMMISSION\nOF SENIOR CITIZENS');
    assert.equal(await page.locator('.sidebar .brand .brand-region').count(),0);
    assert.ok(await page.locator('.sidebar .brand').evaluate(el=>{
      const label=el.querySelector('strong'),country=el.querySelector('.brand-country');
      return label.scrollWidth<=label.clientWidth && country.scrollWidth<=country.clientWidth;
    }),'Agency name and country label fit the desktop sidebar');
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
      return {accentContent:getComputedStyle(nav,'::before').content,activeHalo:getComputedStyle(nav,'::before').backgroundImage,activeShadow:getComputedStyle(nav).boxShadow,
        glow:getComputedStyle(icon).filter, iconColor:getComputedStyle(icon).color,
        activeBackground:getComputedStyle(nav).backgroundColor,
        iconStroke:getComputedStyle(icon).strokeWidth,
        timeLeft:time.getBoundingClientRect().left,dateLeft:date.getBoundingClientRect().left,
        clockLeft:clock.getBoundingClientRect().left,
        signoutLabel:getComputedStyle(document.querySelector('#logout-sidebar span')).display};
    });
    assert.ok(compactChrome.activeHalo.includes('radial-gradient') && compactChrome.activeHalo.includes('109, 167, 255'),'Selected item has a subtle blue inner halo');
    assert.ok(compactChrome.activeShadow.includes('76, 137, 255') && compactChrome.activeShadow.includes('52, 112, 235'),'Selected item has a narrow blue outer halo');
    assert.ok(compactChrome.activeShadow.includes('0px 0px 4px 1px') && compactChrome.activeShadow.includes('0px 0px 8px 0px'),'Blue glow stays close to the selected edge');
    assert.ok(compactChrome.glow.includes('drop-shadow'),'Selected icon has a subtle blue glow');
    assert.equal(compactChrome.iconColor,'rgb(36, 104, 213)');
    assert.equal(compactChrome.activeBackground,'rgb(244, 247, 252)');
    assert.equal(compactChrome.iconStroke,'2px');
    assert.ok(Math.abs(compactChrome.timeLeft-compactChrome.dateLeft)<=1,'Time aligns with left edge of calendar row');
    const clockGlass=await page.locator('.workspace-clock').evaluate(el=>{
      const style=getComputedStyle(el);
      return {background:style.backgroundImage,blur:style.backdropFilter,
        shadow:style.boxShadow,dateColor:getComputedStyle(el.querySelector('.clock-date')).color,
        timeColor:getComputedStyle(el.querySelector('.clock-time')).color};
    });
    assert.ok(clockGlass.background.includes('linear-gradient') && clockGlass.blur.includes('blur(4px)'));
    assert.ok(clockGlass.shadow.includes('inset'));
    assert.equal(clockGlass.dateColor,'rgb(64, 91, 128)');
    assert.equal(clockGlass.timeColor,'rgb(20, 46, 85)');
    assert.equal(compactChrome.signoutLabel,'none');
    await page.locator('#logout-sidebar').hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.signout-arrow')).transform!=='none');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.signout-door')).transform!=='none');
    assert.equal(await page.locator('.signout-frame').evaluate(el=>getComputedStyle(el).transform),'none','The door frame must remain stationary');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.signout-arrow').evaluate(el=>getComputedStyle(el).transform),'none');
    assert.equal(await page.locator('.signout-door').evaluate(el=>getComputedStyle(el).transform),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const glassPane=await page.locator('.sidebar').evaluate(el=>{
      const pane=getComputedStyle(el,'::before');
      return {base:getComputedStyle(el).backgroundImage,glass:pane.backgroundImage,filter:pane.backdropFilter,pointerEvents:pane.pointerEvents,border:pane.borderTopWidth};
    });
    assert.ok(glassPane.base.includes('radial-gradient'));
    assert.ok(glassPane.glass.includes('linear-gradient'));
    assert.ok(glassPane.filter.includes('blur(5px)'));
    const reflection=await page.locator('.sidebar').evaluate(el=>{
      const sheen=getComputedStyle(el,'::after');
      return {image:sheen.backgroundImage,pointerEvents:sheen.pointerEvents};
    });
    assert.ok(reflection.image.includes('linear-gradient'));
    assert.equal(reflection.pointerEvents,'none');
    assert.equal(glassPane.pointerEvents,'none');
    assert.equal(glassPane.border,'1px');
    const railLayout=await page.locator('.sidebar').evaluate(el=>({
      width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,
      viewportHeight:innerHeight,labelDisplay:getComputedStyle(el.querySelector('.nav-item>span')).display
    }));
    assert.ok(railLayout.width>=65 && railLayout.width<=67 && railLayout.height>=railLayout.viewportHeight-24);
    const railInsets=await page.locator('.sidebar').evaluate(el=>{
      const rail=el.getBoundingClientRect(),nav=el.querySelector('.nav-item').getBoundingClientRect();
      return {left:nav.left-rail.left,right:rail.right-nav.right};
    });
    assert.ok(railInsets.left>=9 && railInsets.right>=9,'Collapsed buttons retain breathing room');
    const lightGlass=await page.locator('#attendance-register-panel').evaluate(el=>{
      const style=getComputedStyle(el);
      return {background:style.backgroundColor,gradient:style.backgroundImage,blur:style.backdropFilter};
    });
    assert.equal(lightGlass.background,'rgb(234, 241, 250)');
    assert.equal(lightGlass.gradient,'none','Attendance surface must not show diagonal gradients');
    const overviewSurface=await page.locator('#attendance-register-panel .live-overview').evaluate(el=>{const s=getComputedStyle(el);return [s.backgroundColor,s.backgroundImage];});
    assert.deepEqual(overviewSurface,['rgb(237, 243, 251)','none'],'Overview retains a uniform soft blue surface');
    assert.equal(lightGlass.blur,'none','Static glass panel avoids full-panel backdrop sampling');
    const pairedFrame=await page.locator('.content-shell').evaluate(el=>{
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
      const sidebar=document.querySelector('.sidebar'),rail=sidebar.getBoundingClientRect();
      const outer=document.querySelector('#workspace'),shell=outer.getBoundingClientRect();
      const header=el.querySelector('.topbar').getBoundingClientRect();
      return {topInset:rect.top-rail.top,bottomInset:rail.bottom-rect.bottom,
        outerTop:rail.top-shell.top,outerLeft:rail.left-shell.left,outerBottom:shell.bottom-rail.bottom,
        gutter:rect.left-rail.right,rightInset:shell.right-rect.right,
        outerRadius:parseFloat(getComputedStyle(outer).borderTopLeftRadius),
        railRadius:parseFloat(getComputedStyle(sidebar).borderTopLeftRadius),radius:style.borderTopLeftRadius,
        blur:style.backdropFilter,gradient:style.backgroundImage,
        headerInside:header.top>=rect.top && header.right<=rect.right};
    });
    assert.ok(Math.abs(pairedFrame.topInset)<=1 && Math.abs(pairedFrame.bottomInset)<=1,'Both glass frames align inside their shared shell');
    assert.ok(pairedFrame.outerTop>=3 && pairedFrame.outerLeft>=3 && pairedFrame.outerBottom>=3 && pairedFrame.rightInset>=3,'Visible outer glass surrounds both panels');
    assert.ok(pairedFrame.gutter>=4 && pairedFrame.outerRadius>pairedFrame.railRadius && pairedFrame.radius==='11px','Rounded panels are separated by a smooth glass gutter');
    assert.ok(pairedFrame.blur==='none' && pairedFrame.gradient.includes('radial-gradient'),'Static workspace glass avoids full-screen backdrop filtering');
    assert.ok(pairedFrame.headerInside,'Topbar belongs inside the right glass frame');
    const glassTints=await page.evaluate(()=>{
      const outer=getComputedStyle(document.querySelector('#workspace'));
      const header=getComputedStyle(document.querySelector('.topbar'));
      return {outer:outer.backgroundImage,header:header.backgroundImage,tint:header.backgroundColor,wave:getComputedStyle(document.querySelector('.topbar'),'::before').backgroundImage};
    });
    assert.ok(glassTints.outer.includes('radial-gradient') && glassTints.outer.includes('linear-gradient'),'Outer shell retains layered glass reflections');
    assert.equal(glassTints.header,'none','Restored uniform topbar tint');
    assert.equal(glassTints.wave,'none','No decorative wave');
    assert.equal(glassTints.tint,'rgb(228, 236, 247)','Topbar tint stays even and opaque');
    assert.equal(railLayout.labelDisplay,'none');
    assert.equal(await page.locator('.sidebar .nav-icon').first().evaluate(el=>getComputedStyle(el).width),'24px');
    assert.equal(await page.locator('#logout-sidebar svg').evaluate(el=>getComputedStyle(el).width),'24px');
    const menuHover=page.locator('[data-page="profiles"]');
    await page.mouse.move(0,0);
    await page.waitForFunction(()=>{
      const el=document.querySelector('[data-page="profiles"]');
      return getComputedStyle(el).color==='rgb(240, 245, 252)' &&
        getComputedStyle(el.querySelector('.nav-icon')).color==='rgb(228, 237, 249)';
    });
    await menuHover.hover();
    await page.waitForFunction(()=>{
      const el=document.querySelector('[data-page="profiles"]');
      const icon=getComputedStyle(el.querySelector('.nav-icon'));
      return icon.transform!=='none' && icon.filter!=='none' &&
        getComputedStyle(el).backgroundColor==='rgba(220, 235, 255, 0.16)' &&
        getComputedStyle(el).borderTopColor==='rgba(0, 0, 0, 0)' &&
        icon.color==='rgb(255, 128, 159)' && icon.filter.includes('1.5px') && !icon.filter.includes('8px');
    });
    assert.equal(await menuHover.getAttribute('aria-current'),null,'Hover must not select a page');
    assert.equal(await page.locator('[data-page="employees"]').getAttribute('aria-current'),'page');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await menuHover.locator('.nav-icon').evaluate(el=>getComputedStyle(el).transform),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const selectedNav=page.locator('[data-page="employees"]');
    const beforeHover=await selectedNav.boundingBox();
    await selectedNav.hover();
    await page.waitForFunction(()=>{
      const el=document.querySelector('[data-page="employees"]');
      const s=getComputedStyle(el),icon=getComputedStyle(el.querySelector('.nav-icon'));
      return s.backgroundColor==='rgb(255, 255, 255)' && s.color==='rgb(23, 54, 94)' && icon.color==='rgb(29, 110, 229)';
    });
    const hoverEdges=await selectedNav.evaluate(el=>{
      const s=getComputedStyle(el);
      return {widths:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],
        colors:[s.borderTopColor,s.borderRightColor,s.borderBottomColor,s.borderLeftColor],
        clip:s.backgroundClip,shadow:s.boxShadow};
    });
    assert.deepEqual(hoverEdges.widths,['1px','1px','1px','1px']);
    assert.equal(new Set(hoverEdges.colors).size,1,'Hover border remains consistent on all edges');
    assert.equal(hoverEdges.clip,'padding-box');
    assert.ok(!hoverEdges.shadow.includes('inset'),'Selected highlight has no heavy inset border');
    assert.deepEqual(await selectedNav.boundingBox(),beforeHover,'Hover does not move or resize the selected card');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-page="employees"]'),'::after').visibility==='visible');
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#workspace:not(.hidden)').waitFor();
    await page.locator('[data-page="employees"].active').waitFor();
    const desktopActive=await page.locator('[data-page="employees"].active').evaluate(el=>({shadow:getComputedStyle(el).boxShadow,border:getComputedStyle(el).borderTopColor}));
    assert.ok(desktopActive.shadow.includes('0px 0px 3px 0px inset') && desktopActive.shadow.includes('0px 0px 6px 0px inset'),'Desktop active glow remains close to the inner edge');
    assert.ok(!desktopActive.shadow.includes('0px 0px 0px 1px'),'Desktop selected item has no solid blue ring');
    assert.equal(desktopActive.border,'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('[data-page]').count(),4);
    assert.equal(await page.locator('[data-page="overview"]').count(),0);
    assert.equal(await page.locator('#page-description').count(),0);

    assert.equal(await page.locator('#register-rows').locator('tr').count(),1);
    assert.equal(await page.locator('thead').first().getByText('Last scan').count(),0);
    assert.equal(await page.locator('thead').first().getByText('Scans this month').count(),0);
    const headerStyles=await page.locator('#attendance-register-panel .attendance-directory th').evaluateAll(nodes=>nodes.map(el=>{
      const s=getComputedStyle(el);return {color:s.color,background:s.backgroundColor,gradient:s.backgroundImage,position:s.position,weight:s.fontWeight};
    }));
    assert.equal(headerStyles.length,6);
    assert.ok(headerStyles.every(s=>s.color==='rgb(58, 82, 117)' && s.background==='rgb(223, 232, 243)' && s.gradient==='none' && s.position==='sticky' && s.weight==='600'),'Muted, flat glass header with consistent semibold labels and sticky action heading');
    assert.equal(await page.locator('#add-staff').count(),0);
    assert.equal(await page.locator('#register-from-attendance').count(),0);
    assert.equal(await page.locator('#attendance-register-panel .pagination').count(),0);
    assert.equal(await page.locator('#register-count').textContent(),'1 employee');
    assert.ok(await page.evaluate(()=>{
      const row=document.querySelector('#register-rows tr');
      const count=document.querySelector('.kpi-all strong').firstChild;
      renderRegister();
      return row===document.querySelector('#register-rows tr') && count===document.querySelector('.kpi-all strong').firstChild;
    }),'Unchanged live refresh retains existing rows and KPI text nodes');
    assert.deepEqual(await page.evaluate(()=>['Alex M. Rivera','Rivera, Alex M.','Alex Rivera Jr.','Alex Rivera, Jr.','Alex','', 'Name not synchronized','Émile D. Reyes'].map(registerInitials)),['AR','AR','AR','AR','A','—','—','ÉR']);
    const highlightedRow=page.locator('#register-rows tr').first();
    await highlightedRow.locator('td').nth(1).hover();
    await page.waitForFunction(()=>{
      const row=document.querySelector('#register-rows tr');
      return getComputedStyle(row).backgroundColor==='rgb(219, 231, 247)' &&
        getComputedStyle(row.querySelector('.directory-action-cell')).backgroundColor==='rgb(219, 231, 247)' &&
        getComputedStyle(row.querySelector('.employee-name-cell strong')).color==='rgb(18, 87, 186)' &&
        getComputedStyle(row.querySelector('.name-avatar')).backgroundColor==='rgb(175, 205, 245)' &&
        getComputedStyle(row.querySelector('.name-avatar')).color==='rgb(21, 76, 153)';
    });
    await page.locator('#employee-search').hover();
    assert.equal(await page.locator('.live-kpi').count(),6);
    assert.equal(await page.locator('.live-kpi .sculpted-accent').count(),0);
    assert.equal(await page.locator('.live-kpi .status-ring').count(),0);
    await page.locator('#employee-search').hover();
    assert.equal(await page.locator('.live-kpi[aria-pressed=true]').count(),1);
    assert.equal(await page.locator('.kpi-all').getAttribute('aria-pressed'),'true');
    const cardStyles=await page.locator('.live-kpi').evaluateAll(nodes=>nodes.map(el=>({height:el.offsetHeight,background:getComputedStyle(el).backgroundImage})));
    assert.ok(cardStyles.every(s=>s.height<=67),'Desktop KPI cards remain compact');
    assert.ok(await page.locator('.live-kpi').evaluateAll(nodes=>nodes.every(el=>getComputedStyle(el).backdropFilter==='none')),'Animated cards do not sample a live backdrop');
    assert.ok(cardStyles.every(s=>s.background===cardStyles[0].background),'All KPI surfaces stay neutral, including the selected card');
    assert.equal(await page.locator('.kpi-all').evaluate(el=>getComputedStyle(el).borderTopColor),'rgba(0, 0, 0, 0)');
    const kpiLayout=await page.locator('.live-kpi').evaluateAll(nodes=>nodes.every(el=>{
      const icon=el.querySelector('.kpi-icon').getBoundingClientRect(),label=el.querySelector('.kpi-text').getBoundingClientRect();
      return icon.right<=label.left && label.top<icon.bottom && label.bottom>icon.top;
    }));
    assert.ok(kpiLayout,'Icon on the left; label and count beside it');
    const iconGlass=await page.locator('.live-kpi .kpi-icon').evaluateAll(nodes=>nodes.map(el=>{
      const style=getComputedStyle(el),light=getComputedStyle(el,'::before');
      const inner=getComputedStyle(el,'::after');
      return {color:style.color,surface:style.backgroundImage,spots:light.backgroundImage,blur:light.filter,outerBorder:style.borderTopWidth,innerBorder:inner.borderTopWidth,innerInset:inner.top,innerBlur:inner.backdropFilter,outerTint:style.backgroundColor,innerTint:inner.backgroundColor};
    }));
    assert.deepEqual(iconGlass.map(x=>x.color),['rgb(82, 126, 185)','rgb(54, 126, 103)','rgb(66, 109, 169)','rgb(172, 73, 98)','rgb(149, 110, 32)','rgb(98, 91, 153)'],'Every icon uses its own status color, even when not selected');
    assert.ok(iconGlass.every(x=>x.surface==='none' && (x.spots.match(/radial-gradient\(/g)||[]).length===5 && x.blur==='blur(4px)'),'Icon glass uses scattered radial lights rather than a directional gradient');
    assert.ok(iconGlass.every(x=>x.outerBorder==='0px' && x.innerBorder==='0px' && x.innerInset==='1.5px' && x.innerBlur==='none'),'Two borderless nested glass layers');
    assert.ok(iconGlass.every(x=>x.outerTint.startsWith('rgba(110, 139, 178,') && x.innerTint.startsWith('rgba(255, 255, 255,') && x.outerTint!==x.innerTint),'Separate translucent tints distinguish the two layers without borders');
    assert.equal(await page.locator('.kpi-all strong').evaluate(el=>getComputedStyle(el).color),'rgb(40, 102, 190)','Default selection retains its vivid count');
    assert.equal(await page.locator('.kpi-all strong').evaluate(el=>getComputedStyle(el).textShadow),'none');
    const directions=await page.locator('.kpi-in .kpi-icon svg, .kpi-out .kpi-icon svg').evaluateAll(nodes=>nodes.map(el=>Array.from(el.querySelectorAll('path'),p=>p.getAttribute('d'))));
    assert.equal(directions.length,2);
    assert.equal(directions[0][0],'M12 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7','Sign-in doorway has no inward-facing stubs that collide with the arrow');
    assert.equal(directions[1][0],'M12 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7','Sign-out uses a clean left-side doorway open to the right');
    assert.equal(directions[0][2],'m11 8 5 4-5 4','Inward arrow has clearance from the doorway');
    assert.equal(directions[1][1],'M8 12h13','Sign-out arrow extends rightward out of the doorway');
    assert.equal(directions[1][2],'m16 8 5 4-5 4','Outward arrowhead points right with clearance from the doorway');
    const doorSizes=await page.locator('.kpi-in .kpi-icon svg path:first-child, .kpi-out .kpi-icon svg path:first-child').evaluateAll(nodes=>nodes.map(el=>({width:el.getBBox().width,height:el.getBBox().height})));
    assert.deepEqual(doorSizes,[{width:9,height:16},{width:9,height:16}],'The two half rectangles are exact mirrored dimensions');
    await page.locator('.kpi-in').click();
    await page.locator('#employee-search').hover();
    await page.waitForFunction(()=>{
      const a=document.querySelector('.kpi-in'),b=document.querySelector('.kpi-out');
      const r1=a.querySelector('svg path').getBoundingClientRect(),r2=b.querySelector('svg path').getBoundingClientRect();
      return Math.abs(new DOMMatrix(getComputedStyle(a).transform).m11-1.12)<.001
        && Math.abs(r1.width-r2.width)<.1 && Math.abs(r1.height-r2.height)<.1;
    });
    await page.locator('.kpi-all').click();
    await page.locator('#employee-search').hover();
    await page.waitForFunction(()=>Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.kpi-in')).transform).m11-1)<.001);
    const glyphStyles=await page.locator('.live-kpi .kpi-icon svg').evaluateAll(nodes=>nodes.map(el=>{
      const s=getComputedStyle(el);return {stroke:s.strokeWidth,opacity:s.opacity,glow:s.filter};
    }));
    assert.ok(glyphStyles.every(x=>parseFloat(x.stroke)===1.9 && x.opacity==='1' && x.glow.includes('drop-shadow')),'Crisp icon strokes with a gentle status-colored glow');
    const motion=await page.locator('.kpi-missing').evaluate(el=>({
      card:getComputedStyle(el).transitionDuration,
      count:getComputedStyle(el.querySelector('strong')).transitionDuration,
      glow:getComputedStyle(el,'::before').transitionProperty,
      icon:getComputedStyle(el.querySelector('.kpi-icon svg')).transitionDuration,
      filter:getComputedStyle(el).backdropFilter
    }));
    assert.equal(motion.card,'0.34s');
    assert.equal(motion.count,'0.3s');
    assert.equal(motion.glow,'opacity');
    assert.equal(motion.icon,'0s','Glow filter itself stays static during motion');
    assert.equal(motion.filter,'none');
    const hoverKpi=page.locator('.kpi-missing');
    await hoverKpi.hover();
    await page.waitForFunction(()=>{
      const el=document.querySelector('.kpi-missing');
      const style=getComputedStyle(el),count=getComputedStyle(el.querySelector('strong'));
      return count.textShadow==='none' && count.color==='rgb(192, 46, 85)' && Math.abs(new DOMMatrix(style.transform).m42)<.1 && Math.abs(new DOMMatrix(style.transform).m11-1.06)<.001;
    });
    await hoverKpi.click();
    await page.locator('#employee-search').hover();
    await page.waitForFunction(()=>{
      const selected=document.querySelector('.live-kpi[aria-pressed=true]');
      const previous=document.querySelector('.kpi-all');
      return selected?.classList.contains('kpi-missing') && previous.getAttribute('aria-pressed')==='false'
        && getComputedStyle(selected.querySelector('strong')).color==='rgb(192, 46, 85)'
        && getComputedStyle(previous.querySelector('strong')).color==='rgb(27, 46, 78)'
        && Math.abs(new DOMMatrix(getComputedStyle(selected).transform).m42)<.1
        && Math.abs(new DOMMatrix(getComputedStyle(selected).transform).m11-1.12)<.001
        && Math.abs(new DOMMatrix(getComputedStyle(previous).transform).m42)<.1
        && Math.abs(new DOMMatrix(getComputedStyle(previous).transform).m11-1)<.01
        && getComputedStyle(selected.querySelector('strong')).textShadow==='none';
    });
    assert.equal(await page.locator('.live-kpi[aria-pressed=true]').count(),1);
    const expandedLayout=await page.evaluate(()=>{
      const selected=document.querySelector('.live-kpi[aria-pressed=true]'),r=selected.getBoundingClientRect();
      const strip=selected.parentElement.getBoundingClientRect();
      return {contained:r.top>=strip.top&&r.bottom<=strip.bottom,
        clearOfNeighbors:[selected.previousElementSibling,selected.nextElementSibling].filter(Boolean).every(el=>{const n=el.getBoundingClientRect();return n.right<=r.left+.5||n.left>=r.right-.5;})};
    });
    assert.ok(expandedLayout.contained&&expandedLayout.clearOfNeighbors,'Active KPI has room to expand without clipping or overlapping adjacent cards');
    const centeredZoom=await page.evaluate(()=>{
      const selected=document.querySelector('.kpi-missing').getBoundingClientRect();
      const normal=document.querySelector('.kpi-all').getBoundingClientRect();
      const top=normal.top-selected.top,bottom=selected.bottom-normal.bottom;
      return {top,bottom};
    });
    assert.ok(centeredZoom.top>3 && centeredZoom.bottom>3 && Math.abs(centeredZoom.top-centeredZoom.bottom)<.2,'Selected KPI expands equally above and below the unselected cards');
    await page.locator('.kpi-all').click();
    await page.locator('#employee-search').hover();
    await page.waitForFunction(()=>{
      const all=new DOMMatrix(getComputedStyle(document.querySelector('.kpi-all')).transform);
      const old=new DOMMatrix(getComputedStyle(document.querySelector('.kpi-missing')).transform);
      return Math.abs(all.m42)<.1 && Math.abs(all.m11-1.12)<.001 && Math.abs(old.m42)<.1 && Math.abs(old.m11-1)<.01;
    });
    assert.equal(await page.locator('.live-kpi .ring-label').count(),0);
    assert.ok((await page.locator('.kpi-all').getAttribute('aria-label')).includes('employees'));
    assert.equal(await page.locator('.live-kpi-strip').evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');
    assert.equal(await page.locator('#live-as-of').count(),0);
    assert.equal(await page.locator('[data-live-count="all"]').textContent(),'1');
    assert.equal(await page.locator('#register-rows .live-status').count(),1);
    assert.deepEqual(await page.evaluate(()=>['No entry','Timed in','On AJA','OPERATIONS DIVISION','OFFICE OF THE REGIONAL DIRECTOR','HR and ADMINISTRATION — REGION I'].map(displayTitle)),['No Entry','Timed In','On AJA','Operations Division','Office Of The Regional Director','HR And Administration — Region I']);
    assert.equal(await page.locator('#attendance-register-panel .directory-status').count(),1);
    assert.ok(await page.locator('#attendance-register-panel th').allTextContents().then(labels=>labels.includes('Live Status')&&labels.includes('Last Update')));
    const kpiPositions=await page.locator('.live-kpi').evaluateAll(nodes=>nodes.map(el=>el.offsetTop));
    assert.ok(kpiPositions.every(y=>Math.abs(y-kpiPositions[0])<1),'KPI cards stay in a single row');
    await page.locator('[data-live-filter="all"]').click();
    assert.equal(await page.locator('[data-live-filter="all"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#register-rows .name-avatar').count(),1);
    await page.locator('#employee-search').hover();
    await page.waitForFunction(()=>{
      const avatar=document.querySelector('#register-rows .name-avatar');
      return getComputedStyle(avatar).backgroundColor==='rgb(219, 232, 250)';
    });
    const avatarStyle=await page.locator('#register-rows .name-avatar').first().evaluate(el=>{
      const s=getComputedStyle(el);
      return {border:s.borderTopWidth,gradient:s.backgroundImage,shadow:s.boxShadow,blur:s.backdropFilter,before:getComputedStyle(el,'::before').content,after:getComputedStyle(el,'::after').content};
    });
    assert.deepEqual(avatarStyle,{border:'0px',gradient:'none',shadow:'none',blur:'none',before:'none',after:'none'},'Flat pastel avatar without glass layers');
    assert.ok(await page.locator('#register-rows .register-identity').first().evaluate(el=>el.querySelector('.name-avatar').getBoundingClientRect().right<=el.querySelector('strong').getBoundingClientRect().left),'Avatar and name stay aligned');
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
    const readMonthTriggerStyle=async selector=>page.locator(selector).evaluate(el=>{const s=getComputedStyle(el);return {height:s.height,background:s.backgroundColor,border:s.borderTopWidth,radius:s.borderTopLeftRadius,color:s.color,fontSize:s.fontSize,fontWeight:s.fontWeight,padding:s.padding,gap:s.gap};});
    const registerMonthStyle=await readMonthTriggerStyle('#register-month-trigger');
    await page.locator('#register-month-trigger').click();
    await page.locator('#attendance-month-picker[open]').waitFor();
    const desktopPicker=await page.locator('#attendance-month-picker').boundingBox();
    assert.ok(desktopPicker.width<=217 && desktopPicker.height<=220,'Desktop month picker should be compact');
    await page.setViewportSize({width:620,height:820});
    const narrowPicker=await page.locator('#attendance-month-picker').boundingBox();
    assert.ok(narrowPicker.width<=217 && narrowPicker.height<=220,'Narrow month picker should also be compact');
    assert.equal(await page.locator('#month-picker-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),4);
    await page.locator('#month-picker-title').hover();
    await page.waitForFunction(()=>[...document.querySelectorAll('#month-picker-grid button[aria-pressed="false"]')].every(el=>getComputedStyle(el,'::after').opacity==='0'));
    const hoverMonth=page.locator('#month-picker-grid button[aria-pressed="false"]').first();
    await hoverMonth.hover();
    await page.waitForFunction(()=>{const el=document.querySelector('#month-picker-grid button:hover:not([aria-pressed="true"])');if(!el)return false;const accent=getComputedStyle(el,'::after');return accent.width==='16px'&&accent.height==='2px'&&accent.opacity==='1';});
    await page.locator('#month-picker-title').hover();
    await page.waitForFunction(()=>[...document.querySelectorAll('#month-picker-grid button[aria-pressed="false"]')].every(el=>getComputedStyle(el,'::after').opacity==='0'));
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#month-year-value').waitFor();
    const pickerYear=Number(await page.locator('#month-year-value').textContent());
    for(let y=pickerYear;y>2026;y--)await page.locator('#month-year-prev').click();
    for(let y=pickerYear;y<2026;y++)await page.locator('#month-year-next').click();
    const monthBeforeYearJump=await page.locator('#register-month').inputValue();
    await page.locator('#month-year-trigger').click();
    await page.locator('#month-year-grid').waitFor({state:'visible'});
    assert.equal(await page.locator('#month-picker-grid').isVisible(),false);
    assert.equal(await page.locator('#month-year-value').textContent(),'2026');
    assert.equal(await page.locator('#month-picker-close,#month-picker-current').count(),0);
    assert.equal(await page.locator('#month-year-grid button').count(),12);
    await page.locator('#month-year-prev').click();
    assert.equal(await page.locator('#month-year-value').textContent(),'2026');
    await page.locator('[data-year-value="2014"]').click();
    assert.equal(await page.locator('#month-year-value').textContent(),'2014');
    assert.equal(await page.locator('#register-month').inputValue(),monthBeforeYearJump);
    await page.locator('#month-year-trigger').click();
    await page.locator('#month-year-next').click();
    await page.locator('[data-year-value="2026"]').click();
    assert.equal(await page.locator('#month-year-grid').isVisible(),false);
    await page.locator('[data-month-value="2026-11"]').click();
    assert.equal(await page.locator('#register-month').inputValue(),'2026-11');
    assert.match(await page.locator('#register-month-trigger').textContent(),/November 2026/);
    await page.locator('#register-rows .row-action').first().waitFor();
    await page.locator('#register-rows').getByText('Sample One').waitFor();
    await page.locator('[data-employee="1"]').last().click();
    await page.locator('#employee-detail:not(.hidden)').waitFor();
    await page.locator('#detail-name').filter({hasText:'Sample One'}).waitFor();
    await page.locator('#section-name').hover();
    assert.deepEqual(await readMonthTriggerStyle('#detail-month-trigger'),registerMonthStyle,'Both reporting month triggers must share the same visual styling');
    await page.locator('#detail-month-trigger').click();
    await page.locator('#attendance-month-picker[open]').waitFor();
    assert.equal(await page.locator('[data-month-value="2026-11"]').getAttribute('aria-pressed'),'true');
    await page.locator('#month-year-trigger').click();
    assert.equal(await page.locator('[data-year-value="2026"]').getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#attendance-month-picker[open]').isVisible());
    assert.equal(await page.locator('#month-year-grid').isVisible(),false);
    await page.locator('#month-picker-title').hover();
    await page.waitForFunction(()=>{const el=document.querySelector('#month-picker-grid button[aria-pressed="true"]');if(!el)return false;const accent=getComputedStyle(el,'::after');return accent.width==='16px'&&accent.height==='2px'&&accent.opacity==='1';});
    assert.equal(await page.locator('#month-picker-grid button.is-current:not([aria-pressed=true])').evaluateAll(nodes=>nodes.every(el=>getComputedStyle(el,'::after').opacity==='0'&&getComputedStyle(el).backgroundColor==='rgb(246, 248, 252)')),true);
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
    assert.equal(await travelDay.locator('.monitor-remark.remark-travel').textContent(),'Travel Order');
    assert.equal(await travelDay.locator('.remark-travel').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(231, 217, 250)');
    await travelDay.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#review-time-section').isVisible(),false);
    assert.equal(await page.locator('#review-reference').inputValue(),'DEMO-TO-001');
    await page.locator('#review-reference').fill('DEMO-TO-002');
    await page.locator('#save-day-review').click();
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await travelDay.getByText('TRAVEL ORDER NO.: DEMO-TO-002',{exact:true}).waitFor();
    assert.equal(await page.locator('#daily-rows tr').count(),30);
    const unworkedHoliday=page.locator('#daily-rows [data-date="2026-11-01"]');
    assert.equal(await unworkedHoliday.locator('.day-activities .remark-holiday').textContent(),"All Saints' Day");
    assert.equal(await unworkedHoliday.locator('td.time-slot').count(),1);
    assert.equal(await unworkedHoliday.locator('td.slot-calendar.slot-holiday[colspan="4"] .calendar-status').textContent(),"ALL SAINTS' DAY");
    assert.deepEqual(await unworkedHoliday.locator('.undertime-value').allTextContents(),['—','—']);
    assert.equal(await unworkedHoliday.locator('.dtr-date').getAttribute('title'),"All Saints' Day");
    const unworkedWeekend=page.locator('#daily-rows [data-date="2026-11-08"]');
    assert.equal(await unworkedWeekend.locator('.day-activities .remark-weekend').textContent(),'Sunday');
    assert.equal(await unworkedWeekend.locator('td.time-slot').count(),1);
    assert.equal(await unworkedWeekend.locator('td.slot-calendar.slot-neutral[colspan="4"] .calendar-status').textContent(),'SUNDAY');
    assert.deepEqual(await unworkedWeekend.locator('.undertime-value').allTextContents(),['—','—']);
    assert.equal(await unworkedWeekend.locator('.dtr-date.calendar-weekend').getAttribute('title'),'Sunday');
    assert.equal(await page.locator('#print-dtr').count(),0);
    assert.equal(await page.locator('#export-dtr').count(),0);
    assert.equal(await page.locator('#detail-events').count(),0);
    assert.equal(await page.locator('#detail-id').count(),0);
    assert.equal(await page.locator('#employee-detail table').count(),1);
    const ajaLayouts=await page.evaluate(()=>{
      const slots=times=>Object.fromEntries(['am_in','am_out','pm_in','pm_out'].map((key,i)=>[key,times[i]?{happened_at:'2026-11-12 '+times[i],origin:'manual_sheet'}:null]));
      const make=(times,from,to,covered=[])=>({date:'2026-11-12',day:'Thu',calendar:{},slots:{},tone:'aja',has_attendance_entries:true,
        display_slots:slots(times),aja_covered_slots:covered,aja_periods:[{out:{time:from,origin:'manual_sheet'},in:{time:to,origin:'manual_sheet'},review:false}],monitoring:{}});
      const complete=make(['08:40:00','12:30:00','12:33:00','17:40:00'],'14:28:00','14:45:00');
      const covered=make(['07:40:28','08:07:00',null,null],'08:07:00','18:00:00',['pm_in','pm_out']);
      const morning=make(['07:40:00','12:00:00','13:00:00','17:00:00'],'09:01:00','10:51:00');
      const spanning=make(['07:40:00','12:00:00','13:00:00','17:00:00'],'10:21:00','13:02:00');
      const cells=day=>{const t=document.createElement('table');t.innerHTML='<tbody><tr>'+attendanceTimeCells(day)+'</tr></tbody>';return [...t.querySelectorAll('td')].map(td=>({aja:td.classList.contains('slot-aja'),text:td.textContent,covered:td.classList.contains('slot-aja-covered'),span:td.colSpan}));};
      const print=day=>{const t=document.createElement('table');t.innerHTML='<tbody>'+dtrPrintRows({month:'2026-11',days:[day]},'COS')+'</tbody>';return {extra:[...t.querySelectorAll('.print-aja')].map(tr=>tr.textContent),coverage:[...t.querySelectorAll('.print-aja-coverage')].map(td=>[td.textContent,td.colSpan]),inline:[...t.querySelectorAll('.print-aja-inline-note')].map(td=>[td.dataset.slot,td.textContent]),regular:[...(t.querySelector('.print-aja-inline-note')?.closest('tr')?.querySelectorAll('.print-regular-clock')||[])].map(el=>[el.textContent,el.parentElement.rowSpan]),topAligned:[...(t.querySelector('.print-aja-inline-note')?.closest('tr')?.querySelectorAll('.print-regular-clock')||[])].map(el=>el.parentElement.classList.contains('print-aja-clock-cell')),rows:t.rows.length};};
      return {complete:cells(complete),covered:cells(covered),morning:cells(morning),spanning:cells(spanning),completePrint:print(complete),morningPrint:print(morning),spanningPrint:print(spanning),coveredPrint:print(covered)};
    });
    assert.deepEqual(ajaLayouts.complete.map(x=>x.aja),[false,false,true,false]);
    assert.deepEqual(ajaLayouts.morning.map(x=>x.aja),[true,false,false,false]);
    assert.deepEqual(ajaLayouts.spanning.map(x=>x.aja),[true,true,true,false]);
    assert.equal(ajaLayouts.spanning[3].text,'17:00:00');
    assert.equal(ajaLayouts.complete[2].text,'12:33:00AJA coverage');
    assert.equal(ajaLayouts.complete[3].text,'17:40:00');
    assert.deepEqual(ajaLayouts.covered.map(x=>x.aja),[false,true,true]);
    assert.equal(ajaLayouts.covered[2].covered,true);
    assert.equal(ajaLayouts.covered[2].span,2);
    assert.equal(ajaLayouts.covered[2].text,'AJA COVERAGEUntil 18:00');
    assert.deepEqual(ajaLayouts.completePrint.extra,[]);
    assert.deepEqual(ajaLayouts.completePrint.inline,[['pm_in','AJA14:28-14:45']]);
    assert.deepEqual(ajaLayouts.completePrint.regular,[['8:40',1],['12:30',1],['12:33',1],['17:40',1]]);
    assert.equal(ajaLayouts.completePrint.rows,31);
    assert.deepEqual(ajaLayouts.completePrint.topAligned,[false,false,true,false]);
    assert.deepEqual(ajaLayouts.morningPrint.topAligned,[true,false,false,false]);
    assert.deepEqual(ajaLayouts.spanningPrint.topAligned,[true,true,true,false]);
    assert.deepEqual(ajaLayouts.morningPrint.extra,[]);
    assert.deepEqual(ajaLayouts.morningPrint.inline,[['am_in','AJA09:01-10:51']]);
    assert.deepEqual(ajaLayouts.morningPrint.regular,[['7:40',1],['12:00',1],['13:00',1],['17:00',1]]);
    assert.deepEqual(ajaLayouts.spanningPrint.extra,[]);
    assert.deepEqual(ajaLayouts.spanningPrint.inline,[['am_in','AJA10:21-13:02'],['am_out','AJA'],['pm_in','AJA']]);
    assert.deepEqual(ajaLayouts.spanningPrint.regular,[['7:40',1],['12:00',1],['13:00',1],['17:00',1]]);
    assert.equal(ajaLayouts.spanningPrint.rows,31);
    assert.deepEqual(ajaLayouts.coveredPrint.extra,[]);
    assert.deepEqual(ajaLayouts.coveredPrint.coverage,[['AJA 08:07-18:00',2]]);
    assert.equal(ajaLayouts.coveredPrint.rows,31);
    const originalMonth=await page.locator('#detail-month').inputValue();
    await page.locator('#dtr-form-preview').click();
    await page.locator('#dtr-preview-dialog[open]').waitFor();
    assert.equal(await page.locator('#dtr-preview-template').count(),0,'The category must not be selectable');
    const actualCategory=await page.evaluate(()=>assignedDtrCategory(activeDtr));
    assert.equal(await page.locator('#dtr-preview-category').textContent(),actualCategory||'Not Set');
    if(!actualCategory){
      assert.ok(await page.locator('#dtr-preview-print').isDisabled());
      assert.ok(await page.locator('#dtr-preview-download').isDisabled());
      assert.ok(await page.locator('#dtr-preview-note').isVisible());
    }
    await page.locator('#dtr-preview-back').click();
    await page.locator('#dtr-preview-dialog').waitFor({state:'hidden'});
    // Use synthetic category assignments in this browser test only; no HR records are changed.
    const openAssignedCategory=async category=>{
      await page.evaluate(category=>{
        const original=activeDtr;
        try{activeDtr={...original,employment_type:category};openDtrFormPreview();}
        finally{activeDtr=original;}
      },category);
      await page.locator('#dtr-preview-dialog[open]').waitFor();
      assert.equal(await page.locator('#dtr-preview-category').textContent(),category);
      assert.equal(await page.locator('#dtr-preview-category').getAttribute('data-category'),category);
    };
    await openAssignedCategory('COS');
    await page.locator('#dtr-preview-print:not(:disabled)').waitFor();
    const printable=page.frameLocator('#dtr-preview-frame');
    assert.equal(await printable.locator('.civil-copy').count(),2);
    assert.equal(await page.locator('#dtr-preview-note').isVisible(),false);
    assert.ok(await page.locator('#dtr-preview-download').isEnabled());
    assert.equal(await page.locator('.export-preview-stage').evaluate(el=>getComputedStyle(el).scrollbarColor),'rgb(184, 198, 221) rgba(0, 0, 0, 0)');
    assert.equal(await printable.locator('html').evaluate(el=>getComputedStyle(el).overflow),'hidden');
    assert.equal(await printable.locator('.civil-copy h1').first().evaluate(el=>getComputedStyle(el).fontSize),'22.6667px');
    assert.equal(await printable.locator('.print-name').first().evaluate(el=>getComputedStyle(el).fontSize),'17.3333px');
    assert.equal(await printable.locator('.print-seal').count(),2);
    assert.ok(await printable.locator('.print-seal').first().evaluate(async img=>{await img.decode();return img.naturalWidth>0;}));
    assert.ok((await printable.locator('.civil-copy').first().locator('.special-day').allTextContents()).includes('HOLIDAY'));
    assert.ok(!(await printable.locator('.civil-copy').first().locator('.special-day').allTextContents()).includes("All Saints' Day"));
    assert.ok((await printable.locator('.print-offday .print-undertime').allTextContents()).every(v=>v===''));
    assert.deepEqual(await page.evaluate(()=>{
      const cases=[0,null,900,4500];
      const days=cases.map((ut,i)=>({date:'2026-11-0'+(i+3),day:['Tue','Wed','Thu','Fri'][i],calendar:{},has_attendance_entries:true,display_slots:{},monitoring:{undertime_seconds:ut}}));
      return ['COS','Permanent','OJT'].map(category=>{
        const el=document.createElement('table');
        el.innerHTML='<tbody>'+dtrPrintRows({month:'2026-11',days},category)+'</tbody>';
        return Array.from(el.querySelectorAll('.print-undertime'),td=>td.textContent);
      });
    }),Array.from({length:3},()=>['','','','','0','15','1','15']),'Printed zero and unavailable undertime stay blank; positive durations remain visible');
    assert.deepEqual(await page.evaluate(()=>{
      const day={date:'2026-11-07',day:'Sat',is_weekend:true,calendar:{},has_attendance_entries:true,display_slots:{am_in:{happened_at:'2026-11-07T08:00:00'}},monitoring:{undertime_seconds:3600}};
      const el=document.createElement('table');el.innerHTML='<tbody>'+dtrPrintRows({month:'2026-11',days:[day]},'COS')+'</tbody>';
      return Array.from(el.querySelectorAll('.print-offday .print-undertime'),td=>td.textContent);
    }),['','']);
    assert.equal(await page.locator('#dtr-zoom-controls').evaluate(el=>getComputedStyle(el).position),'absolute');
    const toolbarWidth=await page.locator('.export-preview-toolbar').evaluate(el=>el.getBoundingClientRect().width);
    const initialPaper=await page.locator('#dtr-paper-canvas').evaluate(el=>el.getBoundingClientRect().width);
    await page.locator('#dtr-zoom-in').click();
    assert.ok(await page.locator('#dtr-paper-canvas').evaluate(el=>el.getBoundingClientRect().width)>initialPaper);
    assert.equal(await page.locator('.export-preview-toolbar').evaluate(el=>el.getBoundingClientRect().width),toolbarWidth);
    await page.locator('#dtr-zoom-fit').click();
    assert.ok(Math.abs(await page.locator('#dtr-paper-canvas').evaluate(el=>el.getBoundingClientRect().width)-initialPaper)<2);
    assert.equal(await page.locator('#dtr-zoom-fit').getAttribute('aria-pressed'),'true');
    // Exercise the actual renderer, not just preview images. Both original
    // seals must have visible red and blue pixels inside the final page boxes.
    const sealCheck=await page.evaluate(async()=>{
      const frame=document.getElementById('dtr-preview-frame'),doc=frame.contentDocument,paper=dtrPaper.a4;
      const pdf=await loadLocalDtrPdf(frame);
      const opts={margin:DTR_NARROW_MM,image:{type:'png'},enableLinks:false,pagebreak:{mode:[]},
        html2canvas:{scale:3,backgroundColor:'#fff',logging:false,windowWidth:Math.ceil(paper.w*96/25.4),windowHeight:Math.ceil(paper.h*96/25.4)},
        jsPDF:{unit:'mm',format:[paper.w,paper.h],orientation:'portrait',compress:true}};
      const canvas=await buildDtrDownloadCanvas(frame,pdf,opts,paper);
      const p=doc.querySelector('.print-content').getBoundingClientRect(),ctx=canvas.getContext('2d');
      return Array.from(doc.querySelectorAll('.print-seal'),img=>{
        const r=img.getBoundingClientRect(),x=Math.max(0,Math.floor((r.left-p.left)/p.width*canvas.width)),y=Math.max(0,Math.floor((r.top-p.top)/p.height*canvas.height));
        const w=Math.max(1,Math.floor(r.width/p.width*canvas.width)),h=Math.max(1,Math.floor(r.height/p.height*canvas.height));
        const pixels=ctx.getImageData(x,y,w,h).data;
        let red=0,blue=0;
        for(let i=0;i<pixels.length;i+=4){const [r,g,b]=[pixels[i],pixels[i+1],pixels[i+2]];if(r>120&&r>g*1.5&&r>b*1.4)red++;if(b>90&&b>r*1.4&&b>g*1.15)blue++;}
        return {red,blue};
      });
    });
    assert.equal(sealCheck.length,2);
    assert.ok(sealCheck.every(s=>s.red>20&&s.blue>20),'Both PDF logo boxes contain the original red and blue seal');
    const downloadPromise=page.waitForEvent('download',{timeout:60000});
    await page.locator('#dtr-preview-download').click();
    const downloaded=await downloadPromise;
    const pdfBytes=require('node:fs').readFileSync(await downloaded.path());
    assert.equal(pdfBytes.subarray(0,5).toString(),'%PDF-');
    assert.equal((pdfBytes.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,1);
    await page.locator('#dtr-preview-download:not(:disabled)').waitFor();
    assert.equal(await page.locator('#dtr-preview-note').isVisible(),false);
    assert.equal(await printable.locator('.civil-copy h1').first().textContent(),'DAILY TIME RECORD');
    const printTypography=await printable.locator('.civil-copy').first().evaluate(el=>{
      const style=sel=>{const s=getComputedStyle(el.querySelector(sel));return [s.fontWeight,s.fontStyle,s.fontSize]};
      return {nameLabel:style('.name-label'),certification:style('.certification'),signature:style('.signature-line'),verification:style('.verification'),role:style('.signatory-role'),signatory:style('.signatory')};
    });
    assert.deepEqual(printTypography.nameLabel,['700','italic','10.6667px']);
    assert.deepEqual(printTypography.certification,['400','italic','10.6667px']);
    assert.deepEqual(printTypography.signature,['400','normal','10.6667px']);
    assert.deepEqual(printTypography.verification,['400','italic','10.6667px']);
    assert.deepEqual(printTypography.role,['700','italic','10.6667px']);
    assert.deepEqual(printTypography.signatory,['700','normal','14.6667px']);
    assert.equal(await printable.locator('.print-evidence').count(),0);
    assert.ok(await printable.locator('.print-content').evaluate(el=>{
      const paper=el.getBoundingClientRect(),form=el.querySelector('.print-layout').getBoundingClientRect();
      return form.top>paper.top+8 && Math.abs((form.top-paper.top)-(paper.bottom-form.bottom))<3;
    }),'Form is vertically centered inside the narrow page margins');
    assert.equal(await printable.locator('.signatory-role').first().textContent(),'REGIONAL DIRECTOR');
    await page.locator('#dtr-preview-back').click();
    await page.locator('#dtr-preview-dialog').waitFor({state:'hidden'});
    await openAssignedCategory('OJT');
    await printable.locator('.signatory-role').first().filter({hasText:'INTERNSHIP SUPERVISOR'}).waitFor();
    await page.locator('#dtr-preview-back').click();
    await page.locator('#dtr-preview-dialog').waitFor({state:'hidden'});
    await openAssignedCategory('GIP');
    await printable.locator('.gip-form').waitFor();
    await page.locator('#dtr-preview-print:not(:disabled)').waitFor();
    assert.equal(await printable.locator('.civil-copy').count(),0);
    assert.equal(await printable.locator('.gip-grid').count(),1);
    assert.equal(await printable.locator('.gip-weekend-cert').count(),1);
    assert.equal(await printable.locator('.gip-cert-dates i').count(),3);
    assert.equal(await printable.locator('.gip-accomplishment-line').count(),19);
    assert.ok(Number(await printable.locator('.gip-weekend-cert').getAttribute('rowspan'))>=12);
    assert.equal(await printable.locator('.gip-account').textContent(),'');
    assert.equal(await printable.locator('.gip-review-title').textContent(),'To be filled-up by FO');
    assert.equal(await printable.locator('.gip-grid tbody tr:not(.print-aja)').count(),31);
    await page.locator('#dtr-preview-paper').selectOption('folio');
    await page.locator('#dtr-preview-print:not(:disabled)').waitFor();
    await page.locator('#dtr-preview-period').selectOption('second');
    await page.locator('#dtr-preview-print:not(:disabled)').waitFor();
    await page.locator('#dtr-preview-back').click();
    await page.locator('#dtr-preview-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#detail-month').inputValue(),originalMonth);
    assert.ok(await page.locator('#employee-detail').isVisible());
    await page.locator('#dtr-form-preview').click();
    await page.locator('#dtr-preview-dialog[open]').waitFor();
    await page.mouse.click(1,1);
    await page.locator('#dtr-preview-dialog').waitFor({state:'hidden'});
    assert.ok(!await page.evaluate(()=>history.state?.ncscDtrPreview),'Backdrop dismissal clears preview history');
    await page.locator('#dtr-form-preview').click();
    await page.locator('#dtr-preview-dialog[open]').waitFor();
    await page.goBack();
    await page.locator('#dtr-preview-dialog').waitFor({state:'hidden'});
    assert.ok(await page.locator('#employee-detail').isVisible());
    assert.equal(await page.locator('.page-heading').count(),0);
    assert.equal(await page.locator('.breadcrumb-home').count(),0);
    const day=page.locator('#daily-rows [data-date="2026-11-02"]');
    assert.equal(await day.locator('.slot-holiday').count(),4); // Four real scans retain the national holiday cell color
    assert.equal(await day.locator('td.slot-calendar').count(),0);
    assert.equal(await day.locator('td.time-slot:not([colspan])').count(),4);
    assert.equal(await day.locator('.time-value').count(),4);
    await day.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    await page.locator('#review-regular-label').click();
    assert.ok(await page.locator('#day-review-dialog[open]').isVisible(),'Click inside must not dismiss');
    await page.locator('#clock-am-in').hover();
    await page.mouse.down();
    await page.mouse.move(1,1,{steps:5});
    await page.mouse.up();
    assert.ok(await page.locator('#day-review-dialog[open]').isVisible(),'Dragging from inside must not dismiss');
    await page.evaluate(()=>document.getElementById('save-day-review').disabled=true);
    await page.mouse.click(1,1);
    assert.ok(await page.locator('#day-review-dialog[open]').isVisible(),'Pending save blocks backdrop dismissal');
    await page.evaluate(()=>document.getElementById('save-day-review').disabled=false);
    await page.mouse.click(1,1);
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await day.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#day-review-dialog details').count(),0);
    assert.equal(await page.locator('#review-time-section > .review-field-section').count(),3);
    assert.equal(await page.locator('#day-review-heading').evaluate(el=>getComputedStyle(el.parentElement).clip),'rect(0px, 0px, 0px, 0px)');
    const closeStyle=await page.locator('#close-day-review').evaluate(el=>{const s=getComputedStyle(el);return {radius:s.borderTopLeftRadius,width:s.width,height:s.height};});
    assert.deepEqual(closeStyle,{radius:'50%',width:'32px',height:'32px'});
    const sectionSpacing=await page.locator('#review-time-section > .review-field-section').evaluateAll(sections=>sections.map(el=>{const s=getComputedStyle(el);return {border:s.borderTopWidth,paddingTop:s.paddingTop};}));
    assert.ok(sectionSpacing.every(s=>s.border==='0px'&&s.paddingTop==='10px'),'Sections retain spacing without divider lines');
    assert.equal(await page.locator('#review-regular-label').evaluate(el=>getComputedStyle(el,'::after').content),'none');
    assert.equal(await page.locator('#clock-am-in').inputValue(),'07:30:07');
    await page.locator('[data-clock-pick="am-in"]').click();
    await page.locator('#clock-picker').waitFor();
    const editorActionStyles=await page.evaluate(()=>['clock-picker-clear','clock-picker-apply','cancel-day-review','save-day-review'].map(id=>{const s=getComputedStyle(document.getElementById(id));return {height:s.height,minHeight:s.minHeight,padding:s.padding,borderRadius:s.borderTopLeftRadius,fontSize:s.fontSize,fontWeight:s.fontWeight,background:s.backgroundColor,color:s.color};}));
    assert.deepEqual(editorActionStyles[0],editorActionStyles[2],'Clear and Cancel must use identical action styles');
    assert.deepEqual(editorActionStyles[1],editorActionStyles[3],'Apply and Save must use identical action styles');
    assert.equal(editorActionStyles[0].height,editorActionStyles[1].height,'Picker action buttons must have equal heights');
    await page.locator('#picker-minute').fill('31');
    assert.equal(await page.locator('[data-clock-minute], .clock-picker-quick').count(),0);
    await page.locator('#clock-picker-apply').click();
    assert.equal(await page.locator('#clock-am-in').inputValue(),'07:31:07');
    assert.equal(await page.locator('#review-reason-field').count(),0,'Time corrections do not require a reason field');
    await page.locator('#clock-am-in').fill('07:30:07');
    assert.equal(await page.locator('#review-reason-field').count(),0);
    assert.equal(await page.locator('#review-ut-hours').inputValue(),'');
    assert.equal(await page.locator('#review-ut-minutes').inputValue(),'');
    assert.ok(await page.locator('#review-ut-hours').isDisabled());
    assert.ok(await page.locator('#review-ut-minutes').isDisabled());
    await page.screenshot({path:join(root,'docs/attendance-editor-preview.png'),animations:'disabled'});
    await page.locator('#save-day-review').click();
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await day.locator('.time-value').filter({hasText:'07:30'}).waitFor();
    assert.equal(await day.locator('.time-value').count(),4);
    assert.equal(await day.locator('.time-code').count(),0);
    assert.match(await day.locator('.time-slot').first().getAttribute('title'),/Work code 0/);
    assert.match(await day.locator('.time-value').first().textContent(),/^\d{2}:\d{2}:\d{2}$/);
    assert.equal(await day.locator('.undertime-value').first().textContent(),'—');
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
    assert.equal(await filled.locator('.daily-total-value').textContent(),'08:00:00');
    assert.equal(await filled.locator('.monitor-remark').textContent(),'Complete');
    assert.equal(await filled.locator('.remark-complete').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(207, 234, 219)');
    const originalUndertime=await page.evaluate(()=>activeDtr.days.find(d=>d.date==='2026-11-06').review.undertime_minutes);
    await filled.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#review-ut-hours').inputValue(),'0');
    assert.equal(await page.locator('#review-ut-minutes').inputValue(),'0');
    const clockHeight=await page.locator('#clock-am-in').evaluate(el=>el.getBoundingClientRect().height);
    assert.ok(clockHeight<=31,'Attendance clock inputs should stay compact');
    const saveRequest=page.waitForRequest(req=>req.method()==='PUT'&&req.url().includes('/api/attendance/')&&req.url().endsWith('/2026-11-06'));
    await page.locator('#save-day-review').click();
    assert.equal((await saveRequest).postDataJSON().undertime_minutes,originalUndertime,'Unchanged effective undertime must not create a new manual override');
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await page.locator('#section-name').hover();
    assert.equal(await page.locator('[data-date="2026-11-09"] .remark-overtime').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(211, 228, 252)');
    assert.equal(await page.locator('[data-date="2026-11-09"] .overtime-value').textContent(),'01:00:00');
    const earned=page.locator('[data-date="2026-11-09"] .overtime-value');
    assert.ok(await earned.evaluate(el=>el.classList.contains('duration-positive')));
    const late=page.locator('[data-date="2026-11-10"] .undertime-value');
    assert.equal(await late.evaluateAll(nodes=>nodes.filter(el=>el.classList.contains('duration-positive')).length),2);
    assert.equal(await filled.locator('.undertime-value.duration-muted').count(),2);
    assert.equal(await day.locator('.undertime-value.duration-muted').count(),2);
    assert.deepEqual(await page.evaluate(()=>[durationText(28815),durationText(65),durationText(0),durationText(null),durationText(90061)]),['08:00:15','00:01:05','00:00:00','—','25:01:01']);
    assert.equal((await page.locator('#dtr-form-preview').innerText()).trim(),'Export DTR');
    assert.equal(await page.locator('[data-date="2026-11-10"] .monitor-remark').textContent(),'Undertime');
    const corrected=page.locator('[data-date="2026-11-10"]');
    await corrected.locator('[data-edit-day]').click();
    await page.locator('#day-review-dialog[open]').waitFor();
    await page.locator('#clock-pm-out').fill('17:30:00');
    assert.equal(await page.locator('#review-reason-field').count(),0);
    await page.locator('#save-day-review').click();
    await page.locator('#day-review-dialog').waitFor({state:'hidden'});
    await corrected.locator('.remark-complete').waitFor();
    assert.deepEqual(await corrected.locator('.undertime-value.duration-muted').allTextContents(),['0','00']);
    assert.equal(await corrected.locator('.daily-total-value').textContent(),'08:00:00');
    assert.equal(await corrected.locator('.monitor-remark').textContent(),'Complete');
    const headerAlignment=await page.evaluate(()=>{
      const name=document.querySelector('#detail-name').getBoundingClientRect();
      const month=document.querySelector('#detail-month-trigger').getBoundingClientRect();
      const back=document.querySelector('#back-to-register').getBoundingClientRect();
      const category=document.querySelector('#detail-category').getBoundingClientRect();
      const title=document.querySelector('#section-name').getBoundingClientRect();
      const department=document.querySelector('#detail-department').getBoundingClientRect();
      const exportButton=document.querySelector('#dtr-form-preview').getBoundingClientRect();
      const nameLine=document.querySelector('.sheet-name-line').getBoundingClientRect();
      return {departmentLeft:department.left,departmentRight:department.right,categoryRight:category.right,exportLeft:exportButton.left,exportBottom:exportButton.bottom,monthBottom:month.bottom,nameLineBottom:nameLine.bottom,nameLeft:name.left,monthLeft:month.left,backLeft:back.left,backRight:back.right,
        categoryLeft:category.left,nameRight:name.right,categoryTop:category.top,nameTop:name.top,
        categoryRadius:getComputedStyle(document.querySelector('#detail-category .tag')).borderTopLeftRadius,
        monthHeight:month.height,backHeight:back.height,backBottom:back.bottom,
        backTop:back.top,nameBottom:name.bottom,monthTop:month.top,titleLeft:title.left,titleTop:title.top,titleBottom:title.bottom,
        backBorder:getComputedStyle(document.querySelector('#back-to-register')).borderTopWidth,
        backBackground:getComputedStyle(document.querySelector('#back-to-register')).backgroundColor,
        nameLabelRemoved:document.querySelector('.sheet-identity .metadata-label')===null,
        labelHidden:document.querySelector('.month-inline .sr-only')!==null};
    });
    assert.ok(headerAlignment.backRight<=headerAlignment.titleLeft,'Back arrow sits left of the page title');
    assert.ok(headerAlignment.categoryLeft>=headerAlignment.nameRight,'Category must sit next to employee name');
    assert.ok(Math.abs(headerAlignment.categoryTop-headerAlignment.nameTop)<=12,'Category and name should share a row');
    assert.equal(headerAlignment.categoryRadius,'999px');
    assert.ok(headerAlignment.backTop<headerAlignment.titleBottom && headerAlignment.backBottom>headerAlignment.titleTop,'Back arrow and page title share a row');
    assert.ok(Math.abs(headerAlignment.nameLeft-headerAlignment.monthLeft)<=2,'Month aligns to the employee name');
    assert.ok(headerAlignment.departmentLeft>=headerAlignment.categoryRight,'Department follows the category in the employee identity');
    assert.equal(await page.locator('.sheet-classification > #detail-category').count(),1);
    assert.equal(await page.locator('.sheet-classification > #detail-department').count(),1);
    assert.equal(await page.locator('.sheet-classification').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
    assert.ok(headerAlignment.departmentRight<=headerAlignment.exportLeft,'Department remains in the left identity group');
    assert.ok(Math.abs(headerAlignment.exportBottom-headerAlignment.monthBottom)<=2,'Export aligns with the reporting month');
    assert.ok(headerAlignment.monthTop-headerAlignment.nameLineBottom<=8,'Month sits below the grouped employee identity');
    const departmentIndependent=await page.evaluate(()=>{
      const dept=document.querySelector('#detail-department');
      const month=document.querySelector('#detail-month-trigger');
      const nameLine=document.querySelector('.sheet-name-line');
      const before=month.getBoundingClientRect().top-nameLine.getBoundingClientRect().bottom;
      const original=dept.textContent;
      dept.textContent='A long department name '.repeat(20);
      const after=month.getBoundingClientRect().top-nameLine.getBoundingClientRect().bottom;
      dept.textContent=original;
      return {before,after};
    });
    assert.ok(departmentIndependent.before<=8 && Math.abs(departmentIndependent.after-departmentIndependent.before)<=1,'Month keeps consistent spacing below the identity when department wraps');
    assert.equal(headerAlignment.backBorder,'0px');
    assert.equal(headerAlignment.backBackground,'rgb(220, 231, 246)');
    assert.ok(headerAlignment.nameLabelRemoved,'Redundant employee-name label removed');
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
      const month=document.querySelector('#detail-month-trigger').getBoundingClientRect();
      const nameLine=document.querySelector('.sheet-name-line').getBoundingClientRect();
      const panel=document.querySelector('.attendance-sheet').getBoundingClientRect();
      return {identityTop:identity.top,personnelTop:personnel.top,identityRight:identity.right,
        personnelLeft:personnel.left,identityBottom:identity.bottom,personnelBottom:personnel.bottom,
        monthTop:month.top,nameLineBottom:nameLine.bottom,panelRight:panel.right,viewport:innerWidth};
    });
    assert.ok(Math.abs(compactHeader.identityTop-compactHeader.personnelTop)<=2,'Identity and export remain in the same header grid at split width');
    assert.ok(compactHeader.identityRight<=compactHeader.personnelLeft+2,'Employee identity and export cannot overlap');
    assert.ok(compactHeader.monthTop-compactHeader.nameLineBottom<=8,'Month follows the identity directly even at split width');
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
    await page.locator('#back-to-register').waitFor({state:'hidden'});
    await page.screenshot({path:join(root,'docs/attendance-preview.png'),animations:'disabled'});

    // Complete an existing identity without replacing its attendance or ID.
    await page.locator('[data-page="profiles"]').click();
    await page.locator('#profile-rows [data-profile-more="1"]').click();
    await page.locator('#profile-menu-edit').click();
    await page.locator('#profile-dialog[open]').waitFor();
    assert.equal(await page.locator('#profile-id').getAttribute('readonly'),'');
    assert.equal(await page.locator('#profile-id').isVisible(),false);
    assert.equal(await page.locator('#profile-id-display').textContent(),'1');
    await page.locator('#profile-first').fill('Sample');
    await page.locator('#profile-middle').fill('A.');
    await page.locator('#profile-last').fill('One');
    await page.locator('#profile-type-trigger').click();
    await page.locator('#profile-type-menu:popover-open').waitFor();
    await page.waitForFunction(()=>document.querySelector('#profile-type-menu').dataset.direction==='down');
    assert.equal(await page.locator('#profile-middle').getAttribute('placeholder'),null);
    assert.equal(await page.locator('#profile-middle').getAttribute('required'),'');
    assert.equal(await page.locator('.profile-id-fixed').count(),0);
    await page.locator('#profile-type-trigger').click();
    await page.locator('#profile-type-menu:popover-open').waitFor({state:'detached'});
    assert.equal(await page.locator('#profile-type-trigger').getAttribute('aria-expanded'),'false');
    await page.locator('#profile-type-trigger').click();
    await page.locator('#profile-type-menu:popover-open').getByRole('option',{name:'Permanent',exact:true}).click();
    assert.equal(await page.locator('#profile-type-trigger').getAttribute('data-category'),'Permanent');
    await page.locator('#profile-type-trigger').hover();
    await page.mouse.move(1,1);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#profile-type-trigger')).backgroundColor==='rgb(196, 233, 255)');
    await page.locator('#profile-department-trigger').click();
    await page.locator('#profile-department-menu:popover-open').getByRole('option',{name:'Operations Division (OPS)',exact:true}).click();
    assert.equal(await page.locator('#profile-position').count(),0);
    assert.equal(await page.locator('#profile-confirm').count(),0);
    await page.locator('#profile-middle').fill('');
    await page.locator('#save-profile').click();
    await page.locator('#profile-middle-error').filter({hasText:'Middle name is required.'}).waitFor();
    assert.equal(await page.locator('#profile-middle').getAttribute('aria-invalid'),'true');
    await page.locator('#profile-middle').fill('A.');
    await page.locator('#profile-middle-error').waitFor({state:'hidden'});
    assert.equal(await page.locator('#profile-middle').getAttribute('aria-invalid'),null);
    await page.locator('#save-profile').click();
    await page.locator('#profile-dialog').waitFor({state:'hidden'});
    await page.locator('#profile-rows').getByText('Permanent',{exact:true}).waitFor();

    // Register a new approved ID and preserve a duplicate attempt as an error.
    await page.locator('#open-profile').click();
    await page.locator('#profile-id').fill('25');
    await page.locator('#profile-first').fill('Example');
    await page.locator('#profile-middle').fill('A.');
    await page.locator('#profile-last').fill('Employee');
    await page.locator('#profile-type-trigger').click();
    await page.locator('#profile-type-menu').getByRole('option',{name:'COS',exact:true}).click();
    await page.locator('#profile-department-trigger').click();
    await page.locator('#profile-department-menu').getByRole('option',{name:'Administrative and Finance Section (AFS)',exact:true}).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.screenshot({path:join(root,'docs/employee-registration-preview.png'),animations:'disabled'});
    await page.locator('#save-profile').click();
    await page.locator('#profile-dialog').waitFor({state:'hidden'});
    await page.locator('[data-profile-more="25"]').waitFor();
    await page.locator('#open-profile').click();
    await page.locator('#profile-id').fill('25');
    await page.locator('#profile-first').fill('Wrong duplicate');
    await page.locator('#profile-middle').fill('A.');
    await page.locator('#profile-last').fill('Name');
    await page.locator('#profile-type-trigger').click();
    await page.locator('#profile-type-menu').getByRole('option',{name:'COS',exact:true}).click();
    await page.locator('#profile-department-trigger').click();
    await page.locator('#profile-department-menu').getByRole('option',{name:'Administrative and Finance Section (AFS)',exact:true}).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#save-profile').click();
    await page.locator('#profile-error').filter({hasText:/already has a profile/}).waitFor();
    await page.locator('#cancel-profile').click();

    // Fictional profiles fill the scrollable list, exercising category tabs without pagination.
    const seeded=await page.evaluate(async()=>{
      for(let i=30;i<43;i++){
        const response=await fetch('/api/employee-profiles',{
          method:'POST',credentials:'same-origin',
          headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
          body:JSON.stringify({employee_code:String(i),first_name:'Sample '+i,middle_name:'A.',last_name:'Employee',
            employment_type:['COS','Permanent','GIP','OJT'][i%4],department:'Sample Office',
            position:'Example designation',sync_authorized:true,device_enrollment_confirmed:true})
        });
        if(response.status!==201)return response.text();
      }
      return 'ok';
    });
    assert.equal(seeded,'ok');
    await page.evaluate(()=>loadProfiles());
    await page.locator('#profile-total-badge').filter({hasText:/^16$/}).waitFor();
    assert.equal(await page.locator('#profile-rows tr').count(),16);
    assert.equal(await page.locator('#profile-next').count(),0);
    await page.locator('[data-profile-more="25"]').click();
    await page.locator('#profile-action-menu:popover-open').waitFor();
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#profile-menu-delete').click();
    await page.locator('[data-profile-more="25"]').waitFor({state:'detached'});
    await page.locator('#profile-archive-toggle').click();
    await page.locator('[data-profile-more="25"]').click();
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#profile-menu-delete').click();
    await page.locator('[data-profile-more="25"]').waitFor({state:'detached'});
    await page.locator('#profile-archive-toggle').click();
    await page.locator('[data-profile-more="25"]').waitFor();
    await page.screenshot({path:join(root,'docs/employee-profiles-preview.png'),animations:'disabled'});
    await page.locator('[data-profile-category="GIP"]').click();
    await page.locator('#profile-rows .tag-gip').first().waitFor();
    assert.equal(await page.locator('#profile-rows .tag-cos').count(),0);

    const layout=await page.evaluate(()=>({
      buttonHeight:document.querySelector('#open-profile').getBoundingClientRect().height,
      scrollbar:getComputedStyle(document.querySelector('#main-content')).scrollbarWidth,
      pageHeight:document.documentElement.scrollHeight,viewport:window.innerHeight
    }));
    assert.ok(layout.buttonHeight<=39);
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
