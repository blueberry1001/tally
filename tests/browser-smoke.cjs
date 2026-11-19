'use strict';
/* End-to-end smoke test for the standalone, built index.html. No npm install,
 * application server, user's browser profile, or real financial data is used.
 * Run: node tests/browser-smoke.cjs [--screenshot]
 * Optional: CHROME_PATH = absolute path to Chrome or Edge.
 * SQLite only: --url=http://127.0.0.1:PORT/ --test-db. --test-db confirms the server
 * uses a NEW DISPOSABLE test database; the test writes synthetic rows and leaves
 * them in that DB. Never use your application database. No HTTP target by default.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const html = path.join(root, process.argv.includes('--source') ? 'shell.html' : 'index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quote = JSON.stringify;
async function until(check, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.errors = [];
    this.ready = new Promise((yes,no) => {this.ws.onopen=yes; this.ws.onerror=()=>no(new Error('Local DevTools WebSocket connection failed'));});
    this.ws.onmessage = ({data}) => { const m=JSON.parse(String(data)); if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (!m.id || !this.pending.has(m.id)) return; const [ok,fail,timer]=this.pending.get(m.id); clearTimeout(timer); this.pending.delete(m.id); if(m.error) fail(new Error(m.error.message)); else ok(m.result); };
    this.ws.onclose = () => {for(const [, [,fail,timer]] of this.pending){clearTimeout(timer);fail(new Error('CDP connection closed'));} this.pending.clear();};
  }
  call(method,params={},sessionId) {const id=++this.seq; return new Promise((ok,fail)=>{ const timer=setTimeout(()=>{this.pending.delete(id);fail(new Error('CDP timeout: '+method));},7000); this.pending.set(id,[ok,fail,timer]);this.ws.send(JSON.stringify({id,method,params,sessionId})); });}
}
async function run() {
  const cli=process.argv.slice(2), urlArgs=cli.filter(a=>a==='--url'||a.startsWith('--url='));
  if(urlArgs.length>1 || (urlArgs.length!==0)!==cli.includes('--test-db'))throw Error('SQLite mode requires BOTH --url=http://127.0.0.1:PORT/ and --test-db (confirms a fresh disposable DB).');
  let serverUrl=null;
  if(urlArgs.length){const m=/^--url=http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/.exec(urlArgs[0]);if(!m||Number(m[1])>65535||cli.includes('--source'))throw Error('Test URL must be exactly http://127.0.0.1:PORT/ (explicit port, no path/query/credentials); incompatible with --source.');serverUrl=new URL(urlArgs[0].slice(6)).href;}
  if (!serverUrl&&!fs.existsSync(html)) throw new Error('Build index.html before running this test (not found in workspace).');
  const browser = [process.env.CHROME_PATH, path.join(process.env.ProgramFiles || 'C:\\Program Files','Google','Chrome','Application','chrome.exe'),path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe')].find(p=>p&&fs.existsSync(p));
  if (!browser) throw new Error('No Chrome or Edge executable found; set CHROME_PATH.');
  const tempParent=path.resolve(os.tmpdir()), temp=fs.mkdtempSync(path.join(tempParent,'tally-browser-smoke-')); const profile=path.join(temp,'profile'), downloads=path.join(temp,'downloads'); fs.mkdirSync(downloads);
  let cp, stopped=false, launchErr, cdp, sid, stage='browser startup';
  const step = s=>{stage=s;console.log('TEST '+s);};
  try {
    cp=spawn(browser,['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--disable-crash-reporter','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000','about:blank'],{stdio:['ignore','inherit','inherit'],windowsHide:true});
    cp.once('error',err=>{launchErr=err;stopped=true;});cp.once('exit',()=>{stopped=true;});
    const portFile=path.join(profile,'DevToolsActivePort');
    const [port,socketPath] = await until(()=>{if(launchErr)throw launchErr; if(stopped)throw Error(`Browser exited before opening DevTools (exit ${cp.exitCode}).`);if(!fs.existsSync(portFile))return;const parts=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);if(/^\d+$/.test(parts[0])&&parts[1]?.startsWith('/devtools/browser/'))return parts;},'browser DevToolsActivePort',18000);
    cdp=new CDP(`ws://127.0.0.1:${port}${socketPath}`); await cdp.ready;
    const version=await cdp.call('Browser.getVersion');console.log(version.product+'; isolated temp profile');
    await cdp.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank'}); ({sessionId:sid}=await cdp.call('Target.attachToTarget',{targetId,flatten:true}));
    const send=(method,params={})=>cdp.call(method,params,sid);
    const evaluate=async expression=>{const out=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(out.exceptionDetails)throw Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);return out.result.value;};
    const wait=(expr,label)=>until(()=>evaluate(expr),label);
    const click=sel=>evaluate(`document.querySelector(${quote(sel)}).click()`);
    const clickText=t=>evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${quote(t)}).click()`);
    const nav=p=>click(`#navigation [data-page="${p}"]`);
    const action=a=>`button[data-data-action="${a}"]`;
    // Exercise the restore card itself, not just the hidden input. Intercept and dismiss
    // only the synthetic native picker; uploading through CDP still runs its real change handler.
    async function pickBackup(file){
      await send('Page.setInterceptFileChooserDialog',{enabled:true});
      try{await click(action('restore'));await upload('input.mgr-file',file);}finally{await send('Page.setInterceptFileChooserDialog',{enabled:false});}
    }
    async function dataCards(){const expected={import:'CSVをインポート',export:'CSVをエクスポート',backup:'端末引き継ぎ用にエクスポート',restore:'バックアップから復元'};
      const cards=await evaluate(`Array.from(document.querySelectorAll('[data-data-action]'),b=>({key:b.dataset.dataAction,tag:b.tagName,nested:!!b.querySelector('button,a[href],input,select,textarea,[role="button"]'),label:b.innerText}))`);
      assert.equal(cards.length,4);assert.deepEqual(cards.map(c=>c.key).sort(),Object.keys(expected).sort());for(const c of cards){assert.equal(c.tag,'BUTTON',c.key+' card must itself be a button');assert.equal(c.nested,false,c.key+' has a nested interactive control');assert.ok(c.label.includes(expected[c.key]),c.key+' needs visible Japanese label');}
    }
    const upload=async(sel,file)=>{const {root:n}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:n.nodeId,selector:sel});assert.ok(nodeId,`Missing file input: ${sel}`);await send('DOM.setFileInputFiles',{nodeId,files:[file]});};
    const viewport=(width,height,mobile=false)=>send('Emulation.setDeviceMetricsOverride',{width,height,mobile,deviceScaleFactor:1});
    await send('Page.enable');await send('Page.bringToFront');await send('Runtime.enable');await viewport(1440,1000);
    await send('Page.navigate',{url:serverUrl||pathToFileURL(html).href}); await wait(`document.readyState==='complete' && window.Ledger && document.querySelector('.stat-value') !== null`,'built app startup');
    const assertFreshDB=async()=>{assert.equal(await evaluate('location.href'),serverUrl,'refuse a redirected app URL');assert.equal(await evaluate('typeof window.TallyDB?.read'), 'function','SQLite adapter required');const meta=await evaluate(`(()=>{const {revision,state}=TallyDB.read();return [revision,state.rows.length,Object.keys(state.budgets).length,state.goals.length]})()`);assert.deepEqual(meta,[0,0,0,0],'Refusing to modify a non-pristine DB: start a new, dedicated temporary database.');};
    if(serverUrl){step('require explicit disposable SQLite database: real workspace, revision zero and no rows, goals or budgets');await assertFreshDB();}
    else assert.equal(await evaluate('typeof window.TallyDB'),'undefined','standalone test must not load SQLite adapter');
    const modeControls='#actual-mode,#demo-mode,#mode';
    const noModeControls=async()=>assert.equal(await evaluate(`document.querySelectorAll(${quote(modeControls)}).length`),0,'mode controls belong only in Settings → Display');
    async function switchMode(mode){
      await nav('settings');await click('[data-config="display"]');
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#actual-mode,#demo-mode'),b=>b.tagName).sort()`),['BUTTON','BUTTON']);
      await click(`#${mode}-mode`);assert.equal(await evaluate('Ledger.isDemo()'),mode==='demo');
      assert.equal(await evaluate('document.body.dataset.screen'),'settings','switching the displayed ledger must keep Settings open');
      assert.ok(await evaluate(`!!document.querySelector('#actual-mode') && !!document.querySelector('#demo-mode') && !document.querySelector('#dialog').open`),'display controls remain directly accessible after switching');
    }
    step('both new workspaces start in empty actual mode; no global mode, storage badge, or workspace label');
    assert.equal(await evaluate('Ledger.isDemo()'),false);assert.equal(await evaluate('Ledger.rows().length'),0);
    assert.ok(await evaluate(`!document.querySelector('.sidebar .side-bottom,.sidebar .local-icon,#mode') && !/ローカル保存|このブラウザに保存/.test(document.querySelector('.sidebar').textContent)`));
    assert.ok(await evaluate(`!Array.from(document.querySelectorAll('.sidebar,.topbar,.page-heading')).some(n=>n.textContent.includes('ワークスペース'))`));
    assert.ok(await evaluate(`!document.body.innerText.includes('デモ表示中')`));
    for(const p of ['home','analysis','transactions','budgets','data','help']){await nav(p);await noModeControls();}
    await nav('settings');for(const sub of ['colors','rules']){await click(`[data-config="${sub}"]`);await noModeControls();}
    await switchMode('demo');await nav('home');await noModeControls();
    assert.ok(await evaluate(`document.body.innerText.includes('デモ表示中')`));
    const demoID=await evaluate(`document.querySelector('.home-table [data-id]').dataset.id`);
    const markerTitle='デモ限定・実家計に保存しない';await click('.home-table .entry-name button');
    await evaluate(`(()=>{const f=document.querySelector('#entry-form');f.elements.title.value=${quote(markerTitle)};f.requestSubmit()})()`);
    assert.equal(await evaluate(`Ledger.rows().find(r=>r.id===${quote(demoID)})?.title`),markerTitle);
    await switchMode('actual');await nav('home');await noModeControls();
    assert.equal(await evaluate('Ledger.rows().length'),0,'editing a demo transaction must not initialize the actual ledger');
    assert.ok(await evaluate(`!document.body.innerText.includes('デモ表示中')`));
    await switchMode('demo');await nav('home');assert.equal(await evaluate(`Ledger.rows().find(r=>r.id===${quote(demoID)})?.title`),markerTitle);
    assert.equal(await evaluate(`document.querySelectorAll('.sidebar [data-action="import"],#navigation [data-action="import"],#mobile-nav [data-action="import"]').length`),0,'standalone CSV navigation must be removed');
    step('demo renders summary, charts, and recent transactions');assert.equal(await evaluate('Ledger.isDemo()'),true); assert.ok(await evaluate('document.querySelectorAll(".stat-value").length===3 && document.querySelectorAll(".home-table tbody tr").length>0 && !!document.querySelector(".line-chart") && !!document.querySelector(".donut-wrap svg")'));
    if(process.argv.includes('--screenshot')) {await evaluate('document.fonts.ready.then(()=>true)'); const {data}=await send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(__dirname,'dashboard-preview.png'),Buffer.from(data,'base64'));console.log('Saved tests/dashboard-preview.png');}
    step('analysis: all periods, proportional map, per-category Top 3/5/10 and category drill');
    await click('#navigation [data-page="analysis"]');await click('[data-ap="all"]');await click('[data-at="map"]');
    await wait(`document.querySelectorAll('.tm-region').length>1 && document.querySelectorAll('.tm-tile').length>1`,'paint map');
    const expectedResult=await evaluate(`(()=>{const expense=Ledger.rows().filter(r=>r.type==='expense');return {categories:new Set(expense.map(r=>r.category)).size,total:Ledger.yen(expense.reduce((a,r)=>a+r.amount,0))}})()`);
    assert.equal(await evaluate(`document.querySelectorAll('.tm-region').length`),expectedResult.categories);assert.equal(await evaluate(`document.querySelector('.tm-sum strong').textContent`),expectedResult.total);
    for(const limit of [3,5,10]){await clickText('Top '+limit);assert.equal(await evaluate(`Array.from(document.querySelectorAll('.tm-switch')).find(b=>b.textContent==='Top ${limit}').getAttribute('aria-pressed')`),'true');
      const ranked=await evaluate(`Array.from(document.querySelectorAll('.tm-rank-card'),c=>{const name=c.querySelector('.tm-card-title').textContent;const expected=Ledger.rows().filter(r=>r.type==='expense'&&r.category===name).map(r=>r.amount).sort((a,b)=>b-a).slice(0,${limit});return {name,expected,displayed:Array.from(c.querySelectorAll('.tm-rank-amount b'),b=>Number(b.textContent.replace(/[^0-9]/g,'')))}})`);
      assert.equal(ranked.length,expectedResult.categories);for(const c of ranked)assert.deepEqual(c.displayed,c.expected,'rank order/count: '+c.name);
    }
    if(process.argv.includes('--screenshot')){await evaluate('document.fonts.ready.then(()=>true)');const {data}=await send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(__dirname,'analysis-preview.png'),Buffer.from(data,'base64'));console.log('Saved tests/analysis-preview.png');}
    await evaluate(`Array.from(document.querySelectorAll('.tm-legend-btn')).find(b=>b.querySelector('.tm-legend-name').textContent==='食費').click()`);
    assert.equal(await evaluate(`document.querySelector('#ax-category').value`),'食費');assert.equal(await evaluate(`document.querySelectorAll('.tm-region').length`),1);
    await click('.tm-rank-row');assert.equal(await evaluate(`document.querySelector('#entry-form').elements.category.value`),'食費');await click('#modal-close');
    await click('.tm-crumb');assert.equal(await evaluate(`document.querySelector('#ax-category').value`),'');
    step('analysis: picked leap month and ISO week spanning two calendar years');
    const setValue=(selector,value,event='change')=>evaluate(`(()=>{const x=document.querySelector(${quote(selector)});x.value=${quote(value)};x.dispatchEvent(new Event(${quote(event)},{bubbles:true}));})()`);
    const bounds=()=>evaluate(`[document.querySelector('#ax-from').value,document.querySelector('#ax-to').value]`);
    await click('[data-ap="picked-month"]');await setValue('#ax-picked-month','2024-02');assert.deepEqual(await bounds(),['2024-02-01','2024-02-29']);
    await click('[data-ap="week"]');await setValue('#ax-week-day','2025-01-01');assert.deepEqual(await bounds(),['2024-12-30','2025-01-05']);
    const openPeriod=async()=>{await click('.tm-period');assert.ok(await evaluate(`document.querySelector('#dialog').open && !!document.querySelector('#tm-period-form')`));};
    const periodKind=k=>setValue('#tm-period-kind',k);
    const periodApply=async()=>{await click('#tm-period-apply');assert.equal(await evaluate(`document.querySelector('#dialog').open`),false);};
    const val=s=>evaluate(`document.querySelector(${quote(s)}).value`);
    step('period dialog reflects global ISO week; cancel leaves filter and results unchanged');
    await openPeriod();assert.equal(await val('#tm-period-kind'),'week');
    await periodKind('picked-month');await setValue('#tm-period-month','2020-04');await click('#tm-period-cancel');
    assert.equal(await evaluate(`document.querySelector('#dialog').open`),false);assert.deepEqual(await bounds(),['2024-12-30','2025-01-05']);
    await openPeriod();assert.equal(await val('#tm-period-kind'),'week');
    step('period dialog applies calendar month and ISO week to the shared analysis range');
    await periodKind('picked-month');await setValue('#tm-period-month','2020-02');await periodApply();assert.deepEqual(await bounds(),['2020-02-01','2020-02-29']);assert.equal(await val('#ax-picked-month'),'2020-02');
    await openPeriod();await periodKind('week');await setValue('#tm-period-day','2021-01-01');await periodApply();assert.deepEqual(await bounds(),['2020-12-28','2021-01-03']);
    assert.equal(await evaluate(`document.querySelector('[data-ap="week"]').getAttribute('aria-pressed')`),'true');
    const txDates=await evaluate(`Array.from(new Set(Ledger.rows().filter(r=>r.type==='expense').map(r=>r.date))).sort()`);assert.ok(txDates.length>=5);
    const from=txDates[1],to=txDates[3];
    step('treemap custom range uses both inclusive endpoints, including after cancel and empty results');
    await openPeriod();await periodKind('custom');await setValue('#tm-period-from',from);await setValue('#tm-period-to',to);await periodApply();assert.deepEqual(await bounds(),[from,to]);
    assert.equal(await evaluate(`document.querySelector('[data-ap="custom"]').getAttribute('aria-pressed')`),'true');
    const scopedTotal=await evaluate(`Ledger.yen(Ledger.rows().filter(r=>r.type==='expense'&&r.date>=${quote(from)}&&r.date<=${quote(to)}).reduce((n,r)=>n+r.amount,0))`);
    assert.equal(await evaluate(`document.querySelector('.tm-sum strong').textContent`),scopedTotal);
    await openPeriod();assert.equal(await val('#tm-period-kind'),'custom');assert.deepEqual([await val('#tm-period-from'),await val('#tm-period-to')],[from,to]);
    await setValue('#tm-period-from','1901-01-01');await setValue('#tm-period-to','1901-01-02');await periodApply();
    assert.ok(await evaluate(`!!document.querySelector('.tm-empty') && !document.querySelector('.tm-region')`));
    await openPeriod();const periodOptions=await evaluate(`Array.from(document.querySelector('#tm-period-kind').options,x=>x.value)`);for(const k of ['custom','picked-month','week','all','90','year','month'])assert.ok(periodOptions.includes(k),`missing map period ${k}`);
    await periodKind('all');await periodApply();await wait(`document.querySelectorAll('.tm-tile').length>1`,'recover map after empty range');assert.equal(await evaluate(`document.querySelector('.tm-sum strong').textContent`),expectedResult.total);
    const frames=()=>evaluate(`new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))`);
    const sizeKey='tally.treemap.layout.v1';
    const canvasSize=async()=>{await frames();return evaluate(`(()=>{const {width,height}=document.querySelector('.tm-canvas').getBoundingClientRect();return [width,height]})()`);};
    const preset=async p=>{await click(`[data-tm-size="${p}"]`);return canvasSize();};
    const sameSize=(a,b,why)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<=2,`${why}: ${a} vs ${b}`));
    async function dragGrip(grip,dx,dy){const sel=`[data-tm-grip="${grip}"]`;
      await evaluate(`document.querySelector(${quote(sel)}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`);await frames();
      const [x,y,hit]=await evaluate(`(()=>{const e=document.querySelector(${quote(sel)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return [x,y,e.contains(document.elementFromPoint(x,y))]})()`);assert.ok(hit,'pointer must hit '+grip+' grip');
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
      for(const part of [.35,.7,1])await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+dx*part,y:y+dy*part,buttons:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+dx,y:y+dy,button:'left',buttons:0,clickCount:1});return canvasSize();
    }
    step('treemap right, bottom and corner grips resize the intended axes via real mouse pointer events');
    const defaults=await canvasSize();assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-tm-grip]'),e=>e.dataset.tmGrip).sort()`),['bottom','corner','right']);
    const narrower=await dragGrip('right',-80,0);assert.ok(narrower[0]<defaults[0]-20,`right grip shrinks width: ${defaults} → ${narrower}`);assert.ok(Math.abs(narrower[1]-defaults[1])<=2,'right grip preserves height');
    const taller=await dragGrip('bottom',0,70);assert.ok(taller[1]>narrower[1]+20,'bottom grip increases height');assert.ok(Math.abs(taller[0]-narrower[0])<=2,'bottom grip preserves width');
    const diagonal=await dragGrip('corner',-45,-40);assert.ok(diagonal[0]<taller[0]-12&&diagonal[1]<taller[1]-12,'corner changes both dimensions');
    assert.ok(await evaluate(`!!localStorage.getItem(${quote(sizeKey)})`),'pointer size preference persists');
    await click('[data-at="report"]');await click('[data-at="map"]');sameSize(await canvasSize(),diagonal,'map remount retains layout');
    step('treemap size presets adjust layout without changing totals; reset removes stored override and restores geometry');
    const compact=await preset('compact'),wide=await preset('wide');assert.ok(wide[0]>compact[0]+2||wide[1]>compact[1]+2,'wide and compact must visibly differ');
    async function gripKey(grip,key,modifiers=0){await evaluate(`document.querySelector(${quote(`[data-tm-grip="${grip}"]`)}).focus()`);await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,modifiers});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,modifiers:0});return canvasSize();}
    const keyLeft=await gripKey('right','ArrowLeft');sameSize(keyLeft,[wide[0]-8,wide[1]],'keyboard arrow fine step');const keyDown=await gripKey('bottom','ArrowDown',8);sameSize(keyDown,[keyLeft[0],keyLeft[1]+32],'Shift+arrow coarse step');
    assert.equal(await evaluate(`document.querySelector('.tm-sum strong').textContent`),expectedResult.total);sameSize(await preset('reset'),defaults,'reset back to responsive default');assert.equal(await evaluate(`localStorage.getItem(${quote(sizeKey)})`),null);
    step('income analysis preserves period, clears expense category and ranks income by category');
    const flow=type=>click(`[data-flow="${type}"]`),flowOn=type=>evaluate(`document.querySelector('[data-flow="${type}"]').getAttribute('aria-pressed')==='true'`);
    const openAnalysis=spec=>evaluate(`window.TallyOpenAnalysis(${JSON.stringify(spec)})`);
    const statText=()=>evaluate(`document.querySelector('.ax-stat.lead strong').textContent`),mapSum=()=>evaluate(`document.querySelector('.tm-sum strong').textContent`);
    assert.equal(await evaluate(`document.querySelector('#heading').textContent`),'収支を分析');await setValue('#ax-category','食費');const originalRange=await bounds();await flow('income');assert.ok(await flowOn('income'));assert.deepEqual(await bounds(),originalRange);assert.equal(await val('#ax-category'),'');
    assert.deepEqual(await evaluate(`Array.from(document.querySelector('#ax-category').options,o=>o.value).filter(Boolean)`),await evaluate(`Ledger.categories('income')`));
    const incomeOracle=await evaluate(`(()=>{const rs=Ledger.rows().filter(r=>r.type==='income');return {sum:Ledger.yen(rs.reduce((n,r)=>n+r.amount,0)),cats:Array.from(new Set(rs.map(r=>r.category))).sort(),salary:rs.filter(r=>r.category==='給与').map(r=>r.amount).sort((a,b)=>b-a)}})()`);
    assert.equal(await statText(),incomeOracle.sum);assert.equal(await mapSum(),incomeOracle.sum);assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.tm-card-title'),n=>n.textContent).sort()`),incomeOracle.cats);
    for(const n of [3,5,10]){await clickText('Top '+n);const salaryRank=await evaluate(`Array.from(Array.from(document.querySelectorAll('.tm-rank-card')).find(c=>c.querySelector('.tm-card-title').textContent==='給与').querySelectorAll('.tm-rank-amount b'),b=>Number(b.textContent.replace(/[^0-9]/g,'')))`);assert.deepEqual(salaryRank,incomeOracle.salary.slice(0,n));}
    await click('.tm-rank-row');assert.equal(await val('#entry-form [name="type"]'),'income');await click('#modal-close');await setValue('#ax-category','その他収入');assert.equal(await mapSum(),await evaluate('Ledger.yen(0)'));assert.ok(await evaluate(`!!document.querySelector('.tm-empty')`));await flow('expense');assert.deepEqual(await bounds(),originalRange);assert.equal(await val('#ax-category'),'');
    step('analysis: one-day custom range, category selector, calendar details and report drill');
    const transport=await evaluate(`Ledger.rows().filter(r=>r.type==='expense'&&r.category==='交通').sort((a,b)=>b.date.localeCompare(a.date))[0]`);
    await evaluate(`(()=>{const cat=document.querySelector('#ax-category');cat.value='交通';cat.dispatchEvent(new Event('change'));document.querySelector('#ax-from').value=${quote(transport.date)};document.querySelector('#ax-to').value=${quote(transport.date)};document.querySelector('#ax-form').requestSubmit()})()`);
    assert.equal(await evaluate(`document.querySelector('[data-ap="custom"]').getAttribute('aria-pressed')`),'true');
    const expectedDay=await evaluate(`Ledger.rows().filter(r=>r.type==='expense'&&r.category==='交通'&&r.date===${quote(transport.date)})`);
    assert.equal(await evaluate(`document.querySelector('.tm-sum strong').textContent`),await evaluate(`Ledger.yen(${expectedDay.reduce((sum,r)=>sum+r.amount,0)})`));
    await click('[data-at="calendar"]');await click(`[data-day="${transport.date}"]`);assert.equal(await evaluate(`document.querySelector('#dialog').open`),true);assert.equal(await evaluate(`document.querySelectorAll('#ax-detail [data-row]').length`),Math.min(20,expectedDay.length));assert.ok(await evaluate(`document.querySelector('#dialog-title').textContent.includes(${quote(transport.date)})`));await click('#modal-close');
    await click('[data-at="report"]');assert.ok(await evaluate(`!!document.querySelector('[data-bin]') && !!document.querySelector('[data-merchant]')`));await click('[data-merchant]');assert.ok(await evaluate(`document.querySelector('#dialog').open && !!document.querySelector('#ax-detail [data-row]')`));await click('#modal-close');await click('[data-at="map"]');
    step('dashboard week, rolling 30 days, year and staged custom period drive totals, recent rows and analysis links');
    const homeKind=k=>click(`[data-dash-period="${k}"]`),homeBreakdown=k=>click(`[data-dash-flow="${k}"]`),displayRange=()=>evaluate(`document.querySelector('.dash-dates').textContent.replaceAll('/','-').match(/\\d{4}-\\d{2}-\\d{2}/g)`);
    const periodOracle=async(a,b)=>evaluate(`(()=>{const rows=Ledger.rows().filter(r=>r.date>=${quote(a)}&&r.date<=${quote(b)}),su=t=>rows.filter(r=>r.type===t).reduce((n,r)=>n+r.amount,0),i=su('income'),e=su('expense');return {values:[i-e,i,e],ids:rows.map(r=>r.id),income:Ledger.yen(i),expense:Ledger.yen(e),salary:Ledger.yen(rows.filter(r=>r.type==='income'&&r.category==='給与').reduce((n,r)=>n+r.amount,0))}})()`);
    async function checkHomeRange(a,b){assert.deepEqual(await displayRange(),[a,b]);const expect=await periodOracle(a,b);const displayed=await evaluate(`Array.from(document.querySelectorAll('.stat-value'),n=>Number(n.textContent.replace('−','-').replace(/[^0-9-]/g,'')))`);assert.deepEqual(displayed,expect.values);const ids=await evaluate(`Array.from(document.querySelectorAll('.home-table [data-id]'),n=>n.dataset.id)`);assert.equal(ids.length,Math.min(5,expect.ids.length));assert.ok(ids.every(id=>expect.ids.includes(id)));return expect;}
    await nav('home');const today=await evaluate('TallyUI.today');const dayShift=(v,shift)=>new Date(Date.parse(v+'T00:00:00Z')+shift*86400000).toISOString().slice(0,10),monday=dayShift(today,-((new Date(today+'T00:00:00Z').getUTCDay()+6)%7));await homeKind('week');await checkHomeRange(monday,dayShift(monday,6));await homeKind('30');await checkHomeRange(dayShift(today,-29),today);await homeKind('year');const beforeCustom=await displayRange();assert.deepEqual(beforeCustom,[today.slice(0,4)+'-01-01',today]);
    await homeKind('custom');assert.ok(await evaluate(`document.querySelector('#dialog').open && !!document.querySelector('#dash-custom-form')`));await setValue('#dash-from','2001-01-01');await click('#dash-cancel');assert.deepEqual(await displayRange(),beforeCustom);
    const homeDates=await evaluate(`Ledger.rows().filter(r=>r.type==='income'&&r.category==='給与').map(r=>r.date).sort().slice(2,4)`),[homeA,homeB]=homeDates;assert.ok(homeA<homeB);await homeKind('custom');await setValue('#dash-from',homeB);await setValue('#dash-to',homeA);await click('#dash-apply');assert.ok(await evaluate(`document.querySelector('#dialog').open`));assert.deepEqual(await displayRange(),beforeCustom);await setValue('#dash-from',homeA);await setValue('#dash-to',homeB);await click('#dash-apply');assert.equal(await evaluate(`document.querySelector('#dialog').open`),false);const expectedHome=await checkHomeRange(homeA,homeB);
    for(const t of ['expense','income']){await click(`[data-home-flow="${t}"]`);assert.ok(await flowOn(t));assert.deepEqual(await bounds(),homeDates);assert.equal(await mapSum(),expectedHome[t]);await nav('home');assert.deepEqual(await displayRange(),homeDates);}
    await homeBreakdown('income');assert.equal(await evaluate(`document.querySelector('.donut-center b').textContent`),expectedHome.income);await click('[data-home-category="給与"]');assert.ok(await flowOn('income'));assert.equal(await val('#ax-category'),'給与');assert.deepEqual(await bounds(),homeDates);assert.equal(await mapSum(),expectedHome.salary);await nav('home');await checkHomeRange(homeA,homeB);await click('#dash-heat');assert.ok(await flowOn('income'));assert.deepEqual(await bounds(),homeDates);assert.ok(await evaluate(`!!document.querySelector('.grass-panel')`));await nav('home');assert.equal(await evaluate('Ledger.month()'),today.slice(0,7));
    if(process.env.TALLY_HEAT_PREVIEW==='1'&&!serverUrl){
      assert.equal(await evaluate('Ledger.isDemo()'),true,'preview may only contain synthetic demo data');const year=await evaluate(`(()=>{const n=new Map;for(const r of Ledger.rows())if(r.type==='expense'){const k=r.date.slice(0,4);n.set(k,(n.get(k)||0)+1)}return [...n].sort((a,b)=>b[1]-a[1])[0][0]})()`);
      await openAnalysis({type:'expense',a:year+'-01-01',b:year+'-12-31',view:'heat'});await wait(`!!document.querySelector('#ax-content button[data-grass-date]')`,'demo heat preview');await evaluate('document.fonts.ready.then(()=>true)');await frames();const clip=await evaluate(`(()=>{const p=document.querySelector('#ax-content .panel'),r=p.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()`);const {data}=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip});fs.writeFileSync(path.join(__dirname,'heatmap-preview.png'),Buffer.from(data,'base64'));console.log('Saved tests/heatmap-preview.png (demo only)');
      await openAnalysis({type:'expense',a:transport.date,b:transport.date,category:'交通',view:'map'});
    }
    await click('#navigation [data-page="home"]');
    const month=await evaluate('Ledger.month()'),day=month+'-02';
    async function entry(type,title,amount,category){await click('[data-action="add"]');await evaluate(`(()=>{const f=document.querySelector('#entry-form'),e=f.elements; e.type.value=${quote(type)};e.type.dispatchEvent(new Event('change'));e.category.value=${quote(category)};e.title.value=${quote(title)};e.amount.value=${quote(String(amount))};e.date.value=${quote(day)};f.requestSubmit();})()`);assert.equal(await evaluate("document.querySelector('#dialog').open"),false,'valid manual entry should close form');}
    const totals=()=>evaluate('Array.from(document.querySelectorAll(".stat-value"),n=>n.textContent.replace(/[^0-9−-]/g,""))');
    if(serverUrl)await assertFreshDB(); // Recheck immediately before the first write, including after demo edits.
    step('first real entry isolates sample; expense and transfer excluded/included correctly');await entry('income','テスト給与',100000,'給与');assert.equal(await evaluate('Ledger.isDemo()'),false);assert.equal(await evaluate('Ledger.rows().length'),1);assert.equal(await evaluate(`document.querySelector('[data-dash-period="month"]').getAttribute('aria-pressed')`),'true','actual home should not inherit the demo custom range');assert.equal(await evaluate(`document.querySelector('[data-dash-flow="expense"]').getAttribute('aria-pressed')`),'true','actual home should not inherit demo income breakdown');await entry('expense','テスト食費',2500,'食費');await entry('transfer','テストチャージ',4000,'振替');assert.deepEqual(await totals(),['97500','100000','2500']);
    step('edit via recent transactions and persist on reload');await evaluate('Array.from(document.querySelectorAll(".entry-name button")).find(b=>b.textContent==="テスト食費").click()');await evaluate('document.querySelector("#entry-form").elements.amount.value="3000"; document.querySelector("#entry-form").requestSubmit()');assert.deepEqual(await totals(),['97000','100000','3000']);await evaluate('window.__tallyReloadMarker=true');await send('Page.reload');await wait(`!window.__tallyReloadMarker && document.readyState==='complete' && !!document.querySelector('.stat-value')`,'app reload');assert.equal(await evaluate('Ledger.rows().length'),3);assert.deepEqual(await totals(),['97000','100000','3000']);
    step('actual income stats, treemap, calendar and report drill match the salary alone on a mixed-flow day');
    const actualRowsBefore=await evaluate('Ledger.rows()'),monthBefore=await evaluate('Ledger.month()');await openAnalysis({type:'income',a:day,b:day,view:'map'});assert.ok(await flowOn('income'));assert.deepEqual(await bounds(),[day,day]);const salaryYen=await evaluate('Ledger.yen(100000)');assert.equal(await statText(),salaryYen);assert.equal(await mapSum(),salaryYen);assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.tm-rank-name'),n=>n.textContent)`),['テスト給与']);
    async function assertSalaryDrill(selector){await click(selector);assert.equal(await evaluate(`document.querySelector('#dialog').open`),true);assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#ax-detail [data-row] b'),n=>n.textContent)`),['テスト給与']);await click('#modal-close');}
    await click('[data-at="calendar"]');const mixedDay=`[data-day="${day}"]`;assert.ok(await evaluate(`document.querySelector(${quote(mixedDay)}).textContent.includes(${quote(salaryYen)})`));assert.ok(!(await evaluate(`document.querySelector(${quote(mixedDay)}).textContent.includes(Ledger.yen(3000))`)));assert.ok(await evaluate(`parseFloat(document.querySelector(${quote(mixedDay)}).style.getPropertyValue('--heat'))>0`));const calPaint=await evaluate(`getComputedStyle(document.querySelector(${quote(mixedDay)})).backgroundColor`);assert.ok(await evaluate(`document.querySelector(${quote(mixedDay)}).getAttribute('aria-label').includes('収入')`));await assertSalaryDrill(mixedDay);await flow('expense');assert.notEqual(await evaluate(`getComputedStyle(document.querySelector(${quote(mixedDay)})).backgroundColor`),calPaint);await flow('income');
    await click('[data-at="report"]');assert.ok(await evaluate(`!!document.querySelector('.ax-bar-in')&&!document.querySelector('.ax-bar-out')`));await assertSalaryDrill('[data-bin]');await assertSalaryDrill('[data-merchant]');await flow('expense');await click('[data-bin]');assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#ax-detail [data-row] b'),n=>n.textContent)`),['テスト食費']);await click('#modal-close');await click('[data-at="map"]');assert.equal(await mapSum(),await evaluate('Ledger.yen(3000)'));assert.deepEqual(await evaluate('Ledger.rows()'),actualRowsBefore);assert.equal(await evaluate('Ledger.month()'),monthBefore);
    step('compact grass heatmap uses amount per selected flow; active, empty, keyboard and category-filtered days');
    const grass=d=>`button[data-grass-date="${d}"]`,periodStart=day.slice(0,8)+'01',periodEnd=day.slice(0,8)+'04';
    await openAnalysis({type:'income',a:periodStart,b:periodEnd,view:'heat'});assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]:not(:disabled)').length`),4);assert.ok((await evaluate(`document.querySelector('.grass-caption').textContent`)).includes(salaryYen));assert.equal(await evaluate(`document.querySelector(${quote(grass(day))}).dataset.level`),'4');assert.equal(await evaluate(`document.querySelector(${quote(grass(periodStart))}).dataset.level`),'0');
    const grassColor=d=>evaluate(`getComputedStyle(document.querySelector(${quote(grass(d))})).backgroundColor`);assert.notEqual(await grassColor(day),await grassColor(periodStart));const incomeColor=await grassColor(day);await assertSalaryDrill(grass(day));await click(grass(periodStart));assert.equal(await evaluate(`document.querySelectorAll('#ax-detail [data-row]').length`),0);await click('#modal-close');
    await evaluate(`document.querySelector(${quote(grass(periodStart))}).focus()`);await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown'});assert.equal(await evaluate('document.activeElement.dataset.grassDate'),day);assert.equal(await evaluate(`document.querySelectorAll('[data-grass-date][tabindex="0"]').length`),1);
    await setValue('#ax-category','副収入');assert.equal(await evaluate(`document.querySelector(${quote(grass(day))}).dataset.level`),'0');await flow('expense');assert.equal(await evaluate(`document.querySelector(${quote(grass(day))}).dataset.level`),'4');assert.notEqual(await grassColor(day),incomeColor);assert.ok(await evaluate(`document.querySelector('.grass-caption').textContent.includes(Ledger.yen(3000))`));
    step('heatmap clips to selected dates and pages by calendar year across a Sunday, Monday and leap day');
    await openAnalysis({type:'income',a:'2023-12-31',b:'2024-03-01',view:'heat'});await setValue('.grass-years input','2024');assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]:not(:disabled)').length`),61);assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]').length`),366);const gridRow=d=>evaluate(`getComputedStyle(document.querySelector(${quote(grass(d))})).gridRowStart`);assert.equal(await gridRow('2024-01-01'),'1');assert.equal(await gridRow('2024-02-29'),'4');await click('[data-grass-shift="1"]');assert.equal(await val('.grass-years input'),'2025');assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]:not(:disabled)').length`),0);assert.deepEqual(await bounds(),['2023-12-31','2024-03-01']);await setValue('.grass-years input','2024');await click('[data-grass-shift="-1"]');assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]:not(:disabled)').length`),1);assert.equal(await gridRow('2023-12-31'),'7');assert.ok(!(await evaluate(`document.querySelector('[data-grass-shift="-1"]').disabled`)));assert.deepEqual(await bounds(),['2023-12-31','2024-03-01']);await click('.grass-year-all');assert.deepEqual(await bounds(),['2023-01-01','2023-12-31']);assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]').length`),365);await flow('expense');await click('[data-at="map"]');
    step('transaction filtering and category budget');await click('#navigation [data-page="transactions"]');await evaluate(`(()=>{const q=document.querySelector('input[type="search"]');q.value='テスト食費';q.dispatchEvent(new Event('input'));})()`);assert.equal(await evaluate('document.querySelectorAll(".mgr-table tbody tr").length'),1);await click('#navigation [data-page="budgets"]');await evaluate(`document.querySelector('[aria-label="食費の月間予算（円）"]').value='12500';document.querySelector('.mgr-budget-form').requestSubmit()`);assert.equal(await evaluate('Ledger.budgets()["食費"]'),12500);assert.ok(await evaluate(`document.querySelector('.mgr-budget-list').textContent.includes('9,500')`));
    step('budget savings goal persists and does not change transactions');
    await click('#plan-add');await evaluate(`(()=>{const f=document.querySelector('#plan-form');f.elements.title.value='旅行積立テスト';f.elements.target.value='50000';f.elements.saved.value='12500';f.requestSubmit()})()`);
    assert.equal(await evaluate(`document.querySelector('#dialog').open`),false);assert.deepEqual(await evaluate(`Ledger.goals().map(({title,target,saved})=>[title,target,saved])`),[['旅行積立テスト',50000,12500]]);assert.equal(await evaluate(`Ledger.rows().length`),3);
    step('JSON backup downloads and restore requires confirmation');await nav('data');await dataCards();await click(action('export'));const csvFile=await until(()=>fs.readdirSync(downloads).find(n=>n.endsWith('.csv')),'export card download');assert.match(fs.readFileSync(path.join(downloads,csvFile),'utf8'),/テスト給与/);await click(action('backup'));const filename=await until(()=>fs.readdirSync(downloads).find(n=>n.endsWith('.json')),'JSON download');const backup=path.join(downloads,filename);const payload=JSON.parse(fs.readFileSync(backup,'utf8'));assert.equal(payload.rows.length,3);assert.equal(payload.budgets['食費'],12500);await entry('expense','復元で置き換わるテスト',100,'食費');assert.equal(await evaluate('Ledger.rows().length'),4);await pickBackup(backup);await wait(`document.querySelector('#dialog').open && !!document.querySelector('#ok')`,'restore confirmation');assert.equal(await evaluate('Ledger.rows().length'),4);await click('#ok');assert.equal(await evaluate('Ledger.rows().length'),3);
    assert.equal(payload.goals[0].title,'旅行積立テスト');assert.equal(await evaluate('Ledger.goals().length'),1);
    step('legacy v1 restore does not mutate until confirmed and clears unsupported goals');
    const legacy=path.join(temp,'legacy-v1.json');fs.writeFileSync(legacy,JSON.stringify({format:'ledger-backup',version:1,rows:payload.rows,budgets:payload.budgets}),'utf8');
    await pickBackup(legacy);await wait(`document.querySelector('#dialog').open && !!document.querySelector('#ok')`,'legacy confirmation');assert.equal(await evaluate('Ledger.goals().length'),1);await click('#ok');assert.equal(await evaluate('Ledger.goals().length'),0);assert.equal(await evaluate('Ledger.rows().length'),3);assert.equal(await evaluate('Ledger.budgets()["食費"]'),12500);
    step('preview PayPay import; do not mutate before commit; re-import excludes duplicates');const csv=path.join(temp,'sample.csv');fs.writeFileSync(csv,'\uFEFF取引日,出金金額（円）,入金金額（円）,取引内容,取引先,取引番号\r\n'+day+',500,-,支払い,テストカフェ,987000001\r\n'+day+',-,9000,チャージ,テスト銀行,987000002\r\n','utf8');
    async function csvFromCard(file){await nav('data');await click(action('import'));await upload('#import-file',file);}
    async function pickCSV(){await csvFromCard(csv);}
    await pickCSV();await wait(`document.querySelector('#dialog').open && !!document.querySelector('#import-commit') && !document.querySelector('#import-commit').disabled`,'CSV preview');assert.equal(await evaluate('Ledger.rows().length'),3);await click('#import-commit');await wait('Ledger.rows().length===5','CSV commit');const pay=await evaluate(`Ledger.rows().filter(r=>r.source==='PayPay').map(r=>[r.type,r.amount,r.category]).sort()`);assert.deepEqual(pay,[['expense',500,'食費'],['transfer',9000,'振替']]);await pickCSV();await wait(`document.querySelector('#dialog').open && !!document.querySelector('#import-commit') && document.querySelector('#import-commit').disabled && document.querySelector('#dialog').innerText.includes('登録済み 2件')`,'duplicate exclusion feedback and disabled commit');assert.equal(await evaluate('Ledger.rows().length'),5);await evaluate(`if(document.querySelector('#dialog').open)document.querySelector('#dialog').close();Ledger.go('home')`);assert.deepEqual(await totals(),['96500','100000','3500']);
    const rowByTitle=t=>evaluate(`Ledger.rows().find(r=>r.title===${quote(t)})`);
    async function setupBatch(prefix,dest,selector){if(selector) await click(selector);assert.equal(await evaluate(`document.querySelector('#bulk-future').checked`),true,'future-rule opt-in default');assert.equal(await evaluate(`document.querySelector('#bulk-type').value`),'expense');await setValue('#bulk-prefix',prefix,'input');await setValue('#bulk-category',dest);await setValue('#bulk-scope','all');await click('#bulk-preview');}
    step('batch changes one checked existing PayPay row; excludes a different row; future rule saved atomically after confirmation');
    await nav('transactions');const imported=await rowByTitle('テストカフェ');const excluded=await rowByTitle('テスト食費');
    assert.equal(await evaluate(`!!document.querySelector('.mgr-bulk')`),false,'no bulk entrypoint on transactions list');
    // The editor should open batch mode with the actual draft, without saving the edit itself.
    await nav('home');await evaluate(`Array.from(document.querySelectorAll('.entry-name button')).find(b=>b.textContent==='テストカフェ').click()`);await setValue('#entry-form [name=title]','テスト','input');await setValue('#entry-form [name=type]','income');await setValue('#entry-form [name=category]','副収入');await click('#entry-bulk');assert.deepEqual(await evaluate(`[document.querySelector('#bulk-prefix').value,document.querySelector('#bulk-type').value,document.querySelector('#bulk-category').value]`),['テスト','income','副収入']);assert.deepEqual(await rowByTitle('テストカフェ'),imported);await click('#bulk-cancel');
    await nav('settings');assert.ok(await evaluate(`document.querySelector('[data-config="colors"]').getAttribute('aria-pressed')==='true'`),'categories should be default settings subtab');await setupBatch('テスト','日用品','#cfg-bulk');assert.equal(await evaluate(`document.querySelectorAll('.bulk-row').length`),2);
    await evaluate(`Array.from(document.querySelectorAll('.bulk-row')).find(r=>r.querySelector('b').textContent==='テスト食費').querySelector('input').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.bulk-row input:checked').length`),1);await click('#bulk-next');
    assert.deepEqual(await rowByTitle('テストカフェ'),imported);assert.equal(await evaluate('Ledger.rules().length'),0);await click('#bulk-apply');
    assert.deepEqual(await rowByTitle('テストカフェ'),{...imported,category:'日用品'});assert.deepEqual(await rowByTitle('テスト食費'),excluded);
    assert.deepEqual(await evaluate(`Ledger.rules().map(r=>[r.prefix,r.type,r.category])`),[['テスト','expense','日用品']]);
    step('manual entry auto-selects matching category; explicit manual selection survives additional title input');
    async function ruleEntry(title,override){await click('[data-action="add"]');await setValue('#entry-form [name="title"]',title,'input');assert.equal(await evaluate(`document.querySelector('#entry-form').elements.category.value`),'日用品');if(override){await setValue('#entry-form [name="category"]',override);await setValue('#entry-form [name="title"]',title+'駅前','input');assert.equal(await evaluate(`document.querySelector('#entry-form').elements.category.value`),override);}await setValue('#entry-form [name="amount"]','120','input');await setValue('#entry-form [name="date"]',day);await evaluate(`document.querySelector('#entry-form').requestSubmit()`);assert.equal(await evaluate(`document.querySelector('#dialog').open`),false);assert.equal((await rowByTitle(override?title+'駅前':title)).category,override||'日用品');}
    await nav('home');await ruleEntry('テスト用品',null);await ruleEntry('テスト乗車','交通');
    step('create custom expense and income categories on default category tab; reject duplicates');
    const customExpense='検証・愛犬',customIncome='検証・印税';const categories=t=>evaluate(`Ledger.categories(${quote(t)})`);
    const beforeCategories={expense:await categories('expense'),income:await categories('income')};
    async function addCategory(type,name){await click('#cfg-category-add');await setValue('#cfg-category-form [name=type]',type);await setValue('#cfg-category-form [name=name]',name,'input');await evaluate(`document.querySelector('#cfg-category-form').requestSubmit()`);}
    await nav('settings');await click('[data-config="colors"]');await addCategory('expense',customExpense);assert.ok((await categories('expense')).includes(customExpense));assert.ok(!(await categories('income')).includes(customExpense));
    await addCategory('income',customIncome);assert.ok((await categories('income')).includes(customIncome));assert.ok(!(await categories('expense')).includes(customIncome));
    const expenseList=await categories('expense');await addCategory('expense',customExpense);assert.deepEqual(await categories('expense'),expenseList,'duplicate name must not add a second category');if(await evaluate(`document.querySelector('#dialog').open`))await click('#modal-close');
    await nav('home');await entry('income','新規印税',8700,customIncome);assert.equal((await rowByTitle('新規印税')).category,customIncome);
    step('zero-current-match rule targeting custom expense, and narrower prefix wins on subsequent PayPay CSV preview');
    await nav('settings');await click('[data-config="rules"]');await setupBatch('テストカフェ特別',customExpense,'#cfg-bulk');assert.equal(await evaluate(`document.querySelectorAll('.bulk-row').length`),0);await click('#bulk-next');await click('#bulk-apply');assert.equal(await evaluate(`Ledger.rules().length`),2);
    const csv2=path.join(temp,'rule-match.csv'),newTitle='テストカフェ特別店',refundTitle='試験還元先';fs.writeFileSync(csv2,'\uFEFF取引日,出金金額（円）,入金金額（円）,取引内容,取引先,取引番号\r\n'+day+',640,-,支払い,'+newTitle+',987000003\r\n'+day+',-,250,ポイント付与,'+refundTitle+',987000004\r\n','utf8');
    async function ruleCSV(){await csvFromCard(csv2);await wait(`document.querySelector('#dialog').open && !!document.querySelector('#import-commit')`,'rule CSV preview');}
    const nBefore=await evaluate('Ledger.rows().length');await switchMode('demo');assert.ok(await evaluate('Ledger.isDemo()'));assert.ok(!(await categories('expense')).includes(customExpense),'demo has a separate category catalog');
    step('CSV launched in demo previews using actual workspace catalogs/rules; kind change uses correct catalog');
    const catAt=i=>`#import-rows .import-row[data-idx="${i}"] [data-cat]`,kindAt=i=>`#import-rows .import-row[data-idx="${i}"] [data-kind]`;
    await ruleCSV();assert.equal(await evaluate(`document.querySelector(${quote(catAt(0))}).value`),customExpense);assert.ok(await evaluate(`Array.from(document.querySelector(${quote(catAt(1))}).options,o=>o.value).includes(${quote(customIncome)})`));
    await setValue(kindAt(1),'expense');assert.ok(await evaluate(`Array.from(document.querySelector(${quote(catAt(1))}).options,o=>o.value).includes(${quote(customExpense)})`));await setValue(kindAt(1),'income');await setValue(catAt(1),customIncome);assert.ok(await evaluate('Ledger.isDemo()'),'previewing must not commit');
    await click('#import-commit');assert.equal(await evaluate('Ledger.isDemo()'),false);assert.equal((await rowByTitle(newTitle)).category,customExpense);assert.equal((await rowByTitle(refundTitle)).category,customIncome);assert.ok((await rowByTitle(newTitle)).key);
    await ruleCSV();assert.ok(await evaluate(`document.querySelector('#import-commit').disabled && document.querySelector('#dialog').innerText.includes('登録済み 2件')`));await click('#modal-close');assert.equal(await evaluate('Ledger.rows().length'),nBefore+2);
    step('custom category budget and analytics; custom color persists after reload and drives donut and legend');
    await nav('budgets');await setValue(`[aria-label="${customExpense}の月間予算（円）"]`,'5000','input');await evaluate(`document.querySelector('.mgr-budget-form').requestSubmit()`);assert.equal(await evaluate(`Ledger.budgets()[${quote(customExpense)}]`),5000);
    await nav('analysis');await flow('expense');await click('[data-ap="all"]');await click('[data-at="map"]');await setValue('#ax-category',customExpense);assert.equal(await evaluate(`document.querySelector('.tm-sum strong').textContent`),await evaluate(`Ledger.yen(640)`));assert.ok(await evaluate(`document.querySelector('.tm-rank-card').textContent.includes(${quote(newTitle)})`));
    const paint='#155aab',customPaint='#1a743b';await nav('settings');await click('[data-config="colors"]');await setValue('[data-color="食費"]',paint,'input');await setValue(`[data-color="${customExpense}"]`,customPaint,'input');await click('#cfg-save');assert.equal(await evaluate(`Ledger.colors()['食費']`),paint);
    await evaluate(`window.__reloadPalette=true`);await send('Page.reload');await wait(`!window.__reloadPalette && document.readyState==='complete' && !!document.querySelector('.donut-wrap')`,'palette reload');
    // A fresh bootstrap is for data persistence only; select the temporary home filters explicitly.
    await homeKind('month');await setValue('#month',month);await homeBreakdown('expense');
    assert.ok((await categories('expense')).includes(customExpense));assert.ok((await categories('income')).includes(customIncome));assert.equal(await evaluate(`Ledger.colors()['食費']`),paint);assert.equal(await evaluate(`Ledger.rules().length`),2);
    for(const [cat,color,rgb] of [['食費',paint,'rgb(21, 90, 171)'],[customExpense,customPaint,'rgb(26, 116, 59)']]){assert.equal(await evaluate(`Array.from(document.querySelectorAll('.donut-wrap circle')).find(c=>c.querySelector('title')?.textContent.startsWith(${quote(cat+'：')})).getAttribute('stroke').toLowerCase()`),color);assert.equal(await evaluate(`getComputedStyle(Array.from(document.querySelectorAll('.cat-name')).find(c=>c.textContent===${quote(cat)}).querySelector('.swatch')).backgroundColor`),rgb);}
    step('v4 download contains custom catalogs, custom budget, colors and rules; v1/v2 reset settings and v3 restores built-ins');
    // Configure the source *after* the last bootstrap. Test the same-session UI,
    // not whether another browser/tab happens to persist an individual temporary filter.
    assert.equal(await evaluate('Ledger.isDemo()'),false);
    const sourceMonth=month==='2033-09'?'2033-10':'2033-09',sourceFrom=dayShift(day,-1),sourceTo=dayShift(day,1);
    await nav('home');await homeKind('month');await setValue('#month',sourceMonth);await click('[data-range="12"]');await homeKind('custom');await setValue('#dash-from',sourceFrom);await setValue('#dash-to',sourceTo);await click('#dash-apply');await homeBreakdown('income');
    await openAnalysis({type:'expense',a:day,b:day,category:customExpense,view:'map'});await clickText('Top 10');const sourceSize=await preset('compact');
    const storedLayout=()=>evaluate(`JSON.parse(localStorage.getItem(${quote(sizeKey)}))`);
    async function visibleViews(){
      await nav('home');const home=await evaluate(`({month:document.querySelector('#month').value,trend:TallyUI.range(),kind:document.querySelector('[data-dash-period][aria-pressed=true]').dataset.dashPeriod,type:document.querySelector('[data-dash-flow][aria-pressed=true]').dataset.dashFlow})`);home.dates=await displayRange();
      await nav('analysis');const analysis=await evaluate(`({type:document.querySelector('button[data-flow][aria-pressed=true]').dataset.flow,view:document.querySelector('[data-at][aria-pressed=true]').dataset.at,preset:document.querySelector('[data-ap][aria-pressed=true]').dataset.ap,category:document.querySelector('#ax-category').value,top:document.querySelector('.tm-switch[aria-pressed=true]')?.textContent||null})`);analysis.dates=await bounds();
      return {home,analysis,layout:await storedLayout()};
    }
    const ledgerState=()=>evaluate(`({rows:Ledger.rows(),budgets:Ledger.budgets(),goals:Ledger.goals(),colors:Ledger.colors(),rules:Ledger.rules(),customCategories:Ledger.customCategories()})`);
    const sourceViews=await visibleViews(),sourceData=await ledgerState();
    assert.deepEqual(sourceViews.home,{month:sourceMonth,trend:12,kind:'custom',type:'income',dates:[sourceFrom,sourceTo]});assert.deepEqual(sourceViews.analysis,{type:'expense',view:'map',preset:'custom',category:customExpense,top:'Top 10',dates:[day,day]});assert.ok(sourceViews.layout?.width>0&&sourceViews.layout.height>0);
    const freshDownloads=path.join(temp,'upgraded-downloads');fs.mkdirSync(freshDownloads);await cdp.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:freshDownloads});
    await nav('data');await click(action('backup'));const file4=path.join(freshDownloads,await until(()=>fs.readdirSync(freshDownloads).find(n=>n.endsWith('.json')),'v4 JSON download'));const latest=JSON.parse(fs.readFileSync(file4,'utf8'));
    assert.equal(latest.version,4);assert.deepEqual(latest.customCategories,{expense:[customExpense],income:[customIncome]});assert.equal(latest.colors['食費'],paint);assert.equal(latest.colors[customExpense],customPaint);assert.equal(latest.budgets[customExpense],5000);assert.deepEqual(latest.rules,await evaluate('Ledger.rules()'));assert.equal(latest.rules.length,2);assert.ok(latest.rules.some(r=>r.category===customExpense));
    assert.equal(path.extname(file4).toLowerCase(),'.json');assert.equal(await evaluate(`document.querySelector('#dialog').open`),false,'one click should download the transfer JSON without opening another dialog');
    const vs=latest.viewSettings;assert.ok(vs,'newly exported v4 JSON includes optional viewSettings');assert.equal(vs.version,1);assert.equal(vs.month,sourceMonth);assert.equal(vs.trendMonths,12);assert.deepEqual([vs.home.kind,vs.home.type,vs.home.a,vs.home.b],['custom','income',sourceFrom,sourceTo]);assert.deepEqual([vs.analysis.type,vs.analysis.view,vs.analysis.preset,vs.analysis.limit,vs.analysis.category,vs.analysis.a,vs.analysis.b],['expense','map','custom',10,customExpense,day,day]);assert.deepEqual(vs.mapLayout,sourceViews.layout);
    async function stageRestore(file){await nav('data');await pickBackup(file);await wait(`document.querySelector('#dialog').open && !!document.querySelector('#ok')`,'settings restore confirmation');}
    async function restoreFile(file){await stageRestore(file);await click('#ok');}
    async function assertDefaultCatalog(){assert.deepEqual(await categories('expense'),beforeCategories.expense);assert.deepEqual(await categories('income'),beforeCategories.income);}
    async function assertRestoredCustom(){assert.ok((await categories('expense')).includes(customExpense));assert.ok((await categories('income')).includes(customIncome));assert.equal((await rowByTitle(newTitle)).category,customExpense);assert.equal((await rowByTitle(refundTitle)).category,customIncome);assert.equal((await rowByTitle('新規印税')).category,customIncome);assert.equal(await evaluate(`Ledger.budgets()[${quote(customExpense)}]`),5000);assert.deepEqual(await evaluate(`[Ledger.colors(),Ledger.rules()]`),[latest.colors,latest.rules]);assert.deepEqual(await rowByTitle('テストカフェ'),{...imported,category:'日用品'});}
    // Use genuinely old built-in-only data for the compatibility fixtures; never strip the catalog from a v4 row.
    const writeLegacy=(v,piece)=>{const f=path.join(temp,`compat-${v}.json`);fs.writeFileSync(f,JSON.stringify({format:'ledger-backup',version:v,rows:payload.rows,budgets:payload.budgets,...piece}),'utf8');return f;};
    await restoreFile(legacy);await assertDefaultCatalog();assert.deepEqual(await evaluate('[Ledger.colors(),Ledger.rules(),Ledger.goals()]'),[{},[],[]]);await restoreFile(file4);await assertRestoredCustom();
    const old2=writeLegacy(2,{goals:payload.goals});await restoreFile(old2);await assertDefaultCatalog();assert.deepEqual(await evaluate('[Ledger.colors(),Ledger.rules(),Ledger.goals()]'),[{},[],payload.goals]);assert.equal(await evaluate('Ledger.rows().length'),payload.rows.length);
    const oldRule={prefix:'旧ルール',type:'expense',category:'交通'},old3=writeLegacy(3,{goals:payload.goals,colors:{'交通':'#495a6b'},rules:[oldRule]});await restoreFile(old3);await assertDefaultCatalog();assert.deepEqual(await evaluate('[Ledger.colors(),Ledger.rules()]'),[{'交通':'#495a6b'},[oldRule]]);await restoreFile(file4);await assertRestoredCustom();
    step('transfer round trip: optional v4 viewSettings is strict, stages with the ledger and updates live controls on confirm');
    // Prepare distinct records, catalogs, colors and rules in the same disposable destination.
    await restoreFile(old3);const destCat='引継ぎ前の支出';await nav('settings');await click('[data-config="colors"]');await addCategory('expense',destCat);await nav('home');await entry('expense','置換前だけにある明細',555,destCat);
    const destMonth=sourceMonth==='2020-04'?'2020-05':'2020-04';await nav('home');await homeKind('month');await setValue('#month',destMonth);await click('[data-range="6"]');await homeBreakdown('expense');
    await openAnalysis({type:'income',a:day,b:day,category:'給与',view:'map'});await click('[data-ap="picked-month"]');await setValue('#ax-picked-month',month);await clickText('Top 3');await preset('reset');await click('[data-at="report"]');
    const destData=await ledgerState(),destViews=await visibleViews();assert.notDeepEqual(destData,sourceData);assert.equal(destViews.home.month,destMonth);assert.equal(destViews.home.kind,'month');assert.equal(destViews.home.trend,6);assert.equal(destViews.analysis.type,'income');assert.equal(destViews.analysis.category,'給与');assert.equal(destViews.analysis.preset,'picked-month');assert.equal(destViews.analysis.view,'report');assert.equal(destViews.layout,null);
    const fixture=(name,obj)=>{const f=path.join(temp,name+'.json');fs.writeFileSync(f,JSON.stringify(obj),'utf8');return f;};
    await stageRestore(file4);assert.deepEqual(await ledgerState(),destData,'confirmation must not mutate the ledger');await click('#cancel');assert.deepEqual(await ledgerState(),destData);assert.deepEqual(await visibleViews(),destViews,'cancel keeps all destination view settings');
    const malformed=fixture('malformed-transfer-view',{...latest,viewSettings:{...vs,trendMonths:11}});
    await nav('data');await evaluate(`document.querySelector('#toast').textContent=''`);await pickBackup(malformed);await wait(`document.querySelector('#toast').textContent.trim()!=='' || document.querySelector('#dialog').open`,'invalid view settings verdict');assert.equal(await evaluate(`document.querySelector('#dialog').open`),false,'malformed viewSettings must not fall through to confirmation');assert.deepEqual(await ledgerState(),destData);assert.deepEqual(await visibleViews(),destViews);
    // Old v4 has valid records/colors/rules but no portable filters at all. Keep
    // the destination category built-in so its selection remains valid after the restore.
    for(const [version,f] of [[1,legacy],[2,old2],[3,old3]]){await restoreFile(f);assert.deepEqual(await visibleViews(),destViews,`v${version} without optional settings preserves compatible destination controls`);}
    const oldV4={...latest};delete oldV4.viewSettings;await restoreFile(fixture('v4-without-view-settings',oldV4));await assertRestoredCustom();assert.deepEqual(await ledgerState(),sourceData);assert.deepEqual(await visibleViews(),destViews,'omitted optional settings must leave destination preferences untouched');
    await restoreFile(fixture('destination-v4-without-view-settings',{format:'ledger-backup',version:4,...destData}));assert.deepEqual(await ledgerState(),destData);assert.deepEqual(await visibleViews(),destViews);
    await restoreFile(file4);assert.deepEqual(await ledgerState(),sourceData);await assertRestoredCustom();assert.deepEqual(await visibleViews(),sourceViews,'restore must update already-open app state without reloading');sameSize(await canvasSize(),sourceSize,'restored map renders at the exported size');await nav('home');await homeKind('month');assert.equal(await evaluate(`document.querySelector('[data-range="12"]').getAttribute('aria-pressed')`),'true');
    step('help search filters and restores guide topics');await nav('help');const guides=await evaluate(`document.querySelectorAll('#guide-results details').length`);assert.ok(guides>0);
    await setValue('#guide-search','NO-MATCH-e2e-80513','input');assert.equal(await evaluate(`document.querySelectorAll('#guide-results details').length`),0);
    await setValue('#guide-search','PayPay','input');assert.ok(await evaluate(`document.querySelectorAll('#guide-results details[open]').length>0`));await setValue('#guide-search','','input');assert.equal(await evaluate(`document.querySelectorAll('#guide-results details').length`),guides);
    step('wide desktop map preference fits a 390px mobile viewport; all presets stay bounded and usable');
    await nav('analysis');await click('[data-at="map"]');await click('[data-ap="all"]');await preset('wide');await viewport(390,844,true);
    async function withinMobile(){await frames();const v=await evaluate(`(()=>{const b=document.querySelector('.tm-canvas').getBoundingClientRect();return {left:b.left,right:b.right,scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth}})()`);assert.equal(v.width,390);assert.ok(v.scroll<=391&&v.left>=-1&&v.right<=391,`map overflows mobile: ${JSON.stringify(v)}`);}
    await withinMobile();for(const p of ['compact','wide','reset']){await preset(p);await withinMobile();}
    await openPeriod();assert.equal(await val('#tm-period-kind'),'all');await click('#tm-period-cancel');
    step('annual income heatmap on a 390px viewport stays inside the page, including the final day');
    await openAnalysis({type:'income',a:'2024-01-01',b:'2024-12-31',view:'heat'});await frames();assert.equal(await evaluate(`document.querySelectorAll('button[data-grass-date]').length`),366);const heatLayout=await evaluate(`(()=>{const p=document.querySelector('.grass-port');return {width:document.documentElement.scrollWidth,port:p.clientWidth,board:p.scrollWidth,viewport:document.documentElement.clientWidth}})()`);assert.equal(heatLayout.viewport,390);assert.ok(heatLayout.width<=391&&heatLayout.port>0&&heatLayout.board>=heatLayout.port,JSON.stringify(heatLayout));await evaluate(`document.querySelector(${quote(grass('2024-12-31'))}).scrollIntoView({block:'nearest',inline:'nearest'})`);await click(grass('2024-12-31'));assert.ok(await evaluate(`document.querySelector('#dialog').open`));await click('#modal-close');await click('[data-at="map"]');
    step('390px mobile viewport fits all seven pages, including settings, help and the analysis map');for(const p of ['home','transactions','analysis','budgets','data','settings','help']){await click(`#mobile-nav [data-page="${p}"]`);const v=await evaluate('({scroll:document.documentElement.scrollWidth, viewport:document.documentElement.clientWidth,nav:getComputedStyle(document.querySelector("#mobile-nav")).display})');assert.equal(v.viewport,390,`${p} viewport`);assert.ok(v.scroll<=391,`${p} overflows: ${v.scroll}px`);assert.notEqual(v.nav,'none');}
    step('mobile navigation is immediately interactive with reduced-motion enabled');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.ok(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
    // Pointer hit testing rather than element.click(): a transition overlay cannot mask an unresponsive nav.
    for(const p of ['settings','data','home']){const selector=`#mobile-nav [data-page="${p}"]`,pt=await evaluate(`(()=>{const b=document.querySelector(${quote(selector)}),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`);assert.ok(pt.hit,`navigation is occluded: ${p}`);const {x,y:yPos}=pt;await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y:yPos});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y:yPos});await wait(`document.body.dataset.screen===${quote(p)}`,`pointer navigation to ${p}`);}
    assert.deepEqual(cdp.errors,[],'Uncaught browser application errors');console.log('PASS all browser smoke checks');
  } catch(e){e.message=`[${stage}] ${e.message}`;throw e;}
  finally {if(cdp?.ws.readyState===WebSocket.OPEN){try{await cdp.call('Browser.close');}catch{}cdp.ws.close();} if(cp && !stopped){try{await until(()=>stopped,'browser exit',1800);}catch{cp.kill();}}
    // Remove only this process's unique mkdtemp child, never an externally supplied path.
    if(path.dirname(path.resolve(temp))===tempParent && /^tally-browser-smoke-[a-zA-Z0-9]+$/.test(path.basename(temp))){try{fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:180});}catch{console.warn('Temporary profile remains at:',temp);}} }
}
run().catch(e=>{console.error(e.stack || e.message);process.exitCode=1;});
