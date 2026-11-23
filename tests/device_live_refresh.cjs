/* Execute the actual UI script with controlled requests, time, and DOM state.
 * No browser, office file, or device is used by these behavior checks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const source = readFileSync(join(root, 'app/static/app.js'), 'utf8');
const html = readFileSync(join(root, 'app/index.html'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ok:status < 400,status,json:async()=>data});
function statusData(stamp = '2026-11-23 13:25:23', total = 4986) {
  return {host:'192.168.254.201',port:4370,probe_enabled:false,sync_enabled:true,
    message:'Local connector database',attendance_sync:{enabled:true,interval_seconds:60,
      connector_available:true,connector_message:'Available (local file)',
      total_imported:total,last_success_at:stamp,last_inserted:0,
      latest_result:'Success — No new records',last_error:''}};
}

async function app() {
  const timers = new Map(), listeners = new Map(), calls = [], elements = new Map();
  let nextTimer = 0, reloads = 0;
  const document = {hidden:false,activeElement:null,
    getElementById:id=>elements.get(id),querySelectorAll:()=>[],
    addEventListener:(name,fn)=>listeners.set(name,fn)};
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    const classes = new Set();
    elements.set(id, {id,textContent:'',innerHTML:'',value:'',disabled:false,
      classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),
        contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)},
      addEventListener(){},setAttribute(){},reset(){},focus(){document.activeElement=this;}});
  }
  const state = {data:statusData(),statusFetch:null,postFetch:null,registerFetch:null,detailFetch:null};
  const context = vm.createContext({document,console,Headers,FormData,AbortController,URLSearchParams,
    window:{history:{replaceState(){}},location:{reload(){reloads++;}}},
    setTimeout:(fn,delay)=>{timers.set(++nextTimer,{fn,delay});return nextTimer;},
    clearTimeout:id=>timers.delete(id),
    fetch:async(path,options)=>{
      calls.push({path,...options});
      if(path==='/api/device/status')
        return state.statusFetch ? state.statusFetch(options) : response(state.data);
      if(path==='/api/device/sync')
        return state.postFetch ? state.postFetch(options) : response({records_inserted:0});
      if(path==='/api/me')return response({username:'synthetic-admin',role:'admin',csrf:'test'});
      if(path==='/api/work-codes')return response({items:[]});
      if(path.startsWith('/api/employee-register?'))return state.registerFetch?state.registerFetch():response({items:[]});
      if(path.startsWith('/api/dtr/monitor?'))return state.detailFetch?state.detailFetch():response(detailData());
      throw new Error('Unexpected request: '+path);
    }});
  vm.runInContext(source,context);
  await vm.runInContext('initialize()',context);
  await settle();
  const run = code=>vm.runInContext(code,context);
  const statusCalls=()=>calls.filter(x=>x.path==='/api/device/status');
  const tick=async(delay=5000)=>{
    const timer=[...timers].find(([,x])=>x.delay===delay);
    if(!timer)return false;
    timers.delete(timer[0]);timer[1].fn();await settle();return true;
  };
  return {state,calls,elements,timers,document,run,statusCalls,tick,
    reloads:()=>reloads,
    visible:async value=>{document.hidden=!value;listeners.get('visibilitychange')();await settle();}};
}

test('diagnostics update after a background import without reload, POST, or editor changes', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  assert.equal(ui.statusCalls().length,1);
  ui.elements.get('code-label').value='Unsaved administrator label';
  ui.elements.get('code-label').focus();
  ui.elements.get('code-rows').innerHTML='Existing work-code rows';
  ui.state.data=statusData('2026-11-23 13:26:23',4987);
  ui.state.data.attendance_sync.last_inserted=1;
  ui.state.data.attendance_sync.latest_result='Success — 1 new record';
  assert.equal(await ui.tick(),true);
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:26:23');
  assert.equal(ui.elements.get('lan-total-records').textContent,'4,987');
  assert.equal(ui.elements.get('lan-sync').textContent,'On · every 60 seconds');
  assert.equal(ui.elements.get('code-label').value,'Unsaved administrator label');
  assert.equal(ui.document.activeElement.id,'code-label');
  assert.equal(ui.elements.get('code-rows').innerHTML,'Existing work-code rows');
  assert.equal(ui.calls.filter(x=>x.path==='/api/work-codes').length,1);
  assert.equal(ui.calls.filter(x=>(x.method||'GET')!=='GET').length,0);
  assert.equal(ui.reloads(),0);
});

test('hidden tabs pause requests and refresh immediately on return', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  await ui.visible(false);
  assert.equal(await ui.tick(),false);
  assert.equal(ui.statusCalls().length,1);
  ui.state.data=statusData('2026-11-23 13:27:23');
  await ui.visible(true);
  assert.equal(ui.statusCalls().length,2);
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:27:23');
  assert.equal(await ui.tick(),true);
  assert.equal(ui.statusCalls().length,3);
});

test('leaving the page or logging out cancels refreshes; re-entry starts one timer', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  await ui.run("navigate('employees')");
  assert.equal(await ui.tick(),false);
  await ui.run("navigate('staff')");
  ui.run('startDeviceRefresh();startDeviceRefresh()');
  assert.equal([...ui.timers.values()].filter(x=>x.delay===5000).length,1);
  ui.run('session=null;showLogin()');
  assert.equal(await ui.tick(),false);
});

test('slow status requests never overlap', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  let finish;
  ui.state.statusFetch=()=>new Promise(resolve=>{finish=resolve;});
  await ui.tick();
  assert.equal(ui.statusCalls().length,2);
  assert.equal(await ui.tick(),false);
  ui.run('refreshDeviceStatus({quiet:true})');
  await settle();
  assert.equal(ui.statusCalls().length,2);
  finish(response(statusData('2026-11-23 13:28:23')));
  await settle();
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:28:23');
  assert.equal([...ui.timers.values()].filter(x=>x.delay===5000).length,1);
});

test('late responses from an old page cannot repaint diagnostics', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  let finish,signal;
  ui.state.statusFetch=options=>{
    signal=options.signal;
    return new Promise(resolve=>{finish=resolve;});
  };
  await ui.tick();
  await ui.run("navigate('employees')");
  assert.equal(signal.aborted,true);
  finish(response(statusData('2099-01-01 00:00:00')));
  await settle();
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:25:23');
  assert.equal(await ui.tick(),false);
});

test('temporary failures keep the last result, retry quietly, and recover', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  ui.state.statusFetch=()=>Promise.reject(new Error('offline'));
  await ui.tick();
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:25:23');
  assert.match(ui.elements.get('lan-live-status').textContent,/Retrying automatically/);
  assert.equal(ui.elements.get('toast').textContent,'');
  ui.state.statusFetch=null;
  ui.state.data=statusData('2026-11-23 13:29:23');
  await ui.tick();
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:29:23');
  assert.match(ui.elements.get('lan-live-status').textContent,/updates automatically/);
});

test('session expiration stops polling and returns to login', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  ui.state.statusFetch=()=>response({detail:'Sign in required'},401);
  await ui.tick();
  assert.equal(ui.run('session'),null);
  assert.equal(ui.elements.get('workspace').classList.contains('hidden'),true);
  assert.equal(await ui.tick(),false);
});

test('a hung request times out, preserves the display, and retries', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  let signal;
  ui.state.statusFetch=options=>{
    signal=options.signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{
      const error=new Error('Timed out');error.name='AbortError';reject(error);
    }));
  };
  await ui.tick();
  const timeout=[...ui.timers].find(([,x])=>x.delay===15000);
  assert.ok(timeout);
  ui.timers.delete(timeout[0]);timeout[1].fn();await settle();
  assert.equal(signal.aborted,true);
  assert.equal(ui.elements.get('lan-last-sync').textContent,'2026-11-23 13:25:23');
  assert.match(ui.elements.get('lan-live-status').textContent,/Retrying automatically/);
  ui.state.statusFetch=null;
  await ui.tick();
  assert.equal(ui.statusCalls().length,3);
});

test('live status does not re-enable the manual button during an import', async()=>{
  const ui=await app();
  await ui.run("navigate('staff')");
  let finish;
  ui.state.postFetch=()=>new Promise(resolve=>{finish=resolve;});
  const manual=ui.run('syncConnector()');
  await settle();
  assert.equal(ui.elements.get('sync-connector').disabled,true);
  await ui.tick();
  assert.equal(ui.elements.get('sync-connector').disabled,true);
  finish(response({records_inserted:0}));
  await manual;
  assert.equal(ui.elements.get('sync-connector').disabled,false);
});

function detailData(time='08:00:07', month='2026-11'){
  const event={id:1,happened_at:month+'-02 '+time,work_code:'0',status_code:'9'};
  return {display_name:'Synthetic Employee',department:'Test Unit',employment_type:'COS',month,
    days:[{date:month+'-02',day:'Mon',tone:'entry',is_future:false,is_weekend:false,
      slots:{am_in:event,am_out:null,pm_in:null,pm_out:null},scans:[event],unassigned_count:0,
      calendar:{holiday_name:'',version:0},display_activities:[],daily_total_seconds:null,
      review:{version:1,undertime_minutes:null,remark:'',activity_type:'',activity_reference:''}}]};
}

test('monthly attendance updates quietly and retains the table scroll position',async()=>{
  const ui=await app();
  await ui.run("openEmployee('1')");
  ui.elements.get('daily-table-wrap').scrollTop=230;
  ui.state.detailFetch=()=>response(detailData('08:01:09'));
  assert.equal(await ui.tick(10000),true);
  assert.match(ui.elements.get('daily-rows').innerHTML,/08:01/);
  assert.equal(ui.elements.get('daily-table-wrap').scrollTop,230);
  assert.equal(ui.calls.filter(x=>(x.method||'GET')!=='GET').length,0);
  assert.equal(ui.reloads(),0);
});

test('attendance refresh pauses for an open editor and while the tab is hidden',async()=>{
  const ui=await app();
  await ui.run("openEmployee('1')");
  const before=ui.calls.filter(x=>x.path.startsWith('/api/dtr/monitor?')).length;
  ui.document.querySelectorAll=selector=>selector==='dialog[open]'?[{}]:[];
  ui.elements.get('review-remark').value='Unsaved review';
  await ui.tick(10000);
  assert.equal(ui.calls.filter(x=>x.path.startsWith('/api/dtr/monitor?')).length,before);
  assert.equal(ui.elements.get('review-remark').value,'Unsaved review');
  await ui.visible(false);
  assert.equal(await ui.tick(10000),false);
  ui.document.querySelectorAll=()=>[];
  await ui.visible(true);
  assert.equal(ui.calls.filter(x=>x.path.startsWith('/api/dtr/monitor?')).length,before+1);
});

test('late monthly responses cannot replace another month or a closed employee view',async()=>{
  const ui=await app();
  await ui.run("openEmployee('1')");
  let finish;
  ui.state.detailFetch=()=>new Promise(resolve=>{finish=resolve;});
  await ui.tick(10000);
  ui.elements.get('detail-month').value='2026-12';
  ui.elements.get('daily-rows').innerHTML='New month display';
  finish(response(detailData('09:00:00')));await settle();
  assert.equal(ui.elements.get('daily-rows').innerHTML,'New month display');
  await ui.run("navigate('staff')");
  assert.equal(await ui.tick(10000),false);
});

test('attendance refresh retains evidence through temporary errors and retries',async()=>{
  const ui=await app();
  await ui.run("openEmployee('1')");
  const before=ui.elements.get('daily-rows').innerHTML;
  ui.state.detailFetch=()=>{throw new Error('Temporary connection failure');};
  await ui.tick(10000);
  assert.equal(ui.elements.get('daily-rows').innerHTML,before);
  ui.state.detailFetch=()=>response(detailData('08:02:10'));
  await ui.tick(10000);
  assert.match(ui.elements.get('daily-rows').innerHTML,/08:02/);
});
