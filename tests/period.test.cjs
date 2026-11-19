'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const C=require('../insight-core.js');
const tx=(date,amount,type='expense',category='食費')=>({id:date+amount,title:'店舗',date,amount,type,category,source:'手入力'});
test('picked-month is independent of the shared month and handles Gregorian leap years',()=>{
  assert.deepEqual(C.bounds('picked-month','2026-11','2026-11-19',[],{month:'2024-02'}),['2024-02-01','2024-02-29']);
  assert.deepEqual(C.bounds('month','2026-11','2026-11-19',[],{month:'2024-02'}),['2026-11-01','2026-11-30']);
  for(const [m,d] of [['1900-02','28'],['2000-02','29'],['2100-02','28'],['9999-12','31']])assert.deepEqual(C.monthRange(m),[m+'-01',m+'-'+d]);
  for(const m of ['1899-12','0000-01','10000-01','2025-13','2024-00','2024-1','2024-01-01',null,1]){assert.equal(C.validMonth(m),false);assert.throws(()=>C.monthRange(m),RangeError)}
});
test('ISO week year is the Thursday year, ranges include the Monday and Sunday',()=>{
  for(const [code,first,last] of [['2015-W53','2015-12-28','2016-01-03'],['2019-W01','2018-12-31','2019-01-06'],['2020-W01','2019-12-30','2020-01-05'],['2020-W53','2020-12-28','2021-01-03'],['2024-W09','2024-02-26','2024-03-03'],['2025-W01','2024-12-30','2025-01-05'],['2026-W53','2026-12-28','2027-01-03']]){
    assert.deepEqual(C.weekRange(code),[first,last]);assert.deepEqual(C.bounds('week','2026-01','2026-01-01',[],{week:code}),[first,last]);
    for(let i=C.day(first);i<=C.day(last);i++)assert.equal(C.weekOf(C.stamp(i)),code);
  }
});
test('validate ISO identifiers, nonexistent week 53, and last partial week without clipping',()=>{
  for(const code of ['2021-W53','2014-W53','2024-W54','2020-W00','2019-W1','2020W01','1899-W52','10000-W01','9999-W52',null])assert.throws(()=>C.weekRange(code),RangeError);
  assert.deepEqual(C.weekLimits,{min:'1900-W01',max:'9999-W51',minDate:'1900-01-01',maxDate:'9999-12-26'});
  assert.deepEqual(C.weekRange(C.weekLimits.min),['1900-01-01','1900-01-07']);assert.deepEqual(C.weekRange(C.weekLimits.max),['9999-12-20','9999-12-26']);
  for(const d of ['2023-02-29','1899-12-31','9999-12-27','9999-12-31','not-a-date'])assert.throws(()=>C.weekOf(d),RangeError);
  assert.equal(C.shiftWeek('1900-W01',-1),null);assert.equal(C.shiftWeek('9999-W51',1),null);assert.throws(()=>C.shiftWeek('2024-W01',.5),RangeError);
  assert.equal(C.shiftWeek('2015-W53',1),'2016-W01');assert.equal(C.shiftWeek('2021-W01',-1),'2020-W53');
});
test('400-year Gregorian cycle: 20871 consecutive seven-day weeks and exactly 71 week-53 years',()=>{
  const first=C.weekRange('2000-W01')[0],end=C.weekRange('2400-W01')[0];let n=0,long=0;
  for(let start=C.day(first);start<C.day(end);start+=7){const code=C.weekOf(C.stamp(start+3));assert.deepEqual(C.weekRange(code),[C.stamp(start),C.stamp(start+6)]);n++;if(code.endsWith('W53'))long++}
  assert.equal(n,20871);assert.equal(long,71);
});
test('all inclusive bounds feed summary, previous-week comparison, calendar daily map and report bins',()=>{
  const rows=[tx('2024-12-22',999),tx('2024-12-23',18),tx('2024-12-29',22),tx('2024-12-30',35),tx('2025-01-01',10,'expense','交通'),tx('2025-01-02',123,'income','給与'),tx('2025-01-03',999,'transfer','振替'),tx('2025-01-05',5),tx('2025-01-06',777)];
  const [a,b]=C.weekRange(C.weekOf('2025-01-01')),r=C.aggregate(rows,a,b,'食費'),all=C.aggregate(rows,a,b);
  assert.deepEqual([r.prevA,r.prevB,r.days,r.prev,r.total,r.income,all.total,all.income,r.period.length],['2024-12-23','2024-12-29',7,40,40,0,50,123,5]);assert.deepEqual([...r.daily.keys()],['2024-12-30','2025-01-05']);assert.equal(C.series(r.daily,a,b).bins.length,7);assert.equal(C.series(r.daily,a,b).bins.reduce((sum,d)=>sum+d.spend,0),40);
});

// Characterize the period controls without a browser, external libraries, or real storage.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'..','explorer.js'),'utf8');
function ui(store=new Map(),nativeWeek=true){
  const elements=new Map(),buttons=[],get=id=>elements.get(id),fake=(id='',value='')=>({id,value,dataset:{},classList:{remove(){},add(){}},focus(){},setCustomValidity(txt){this.message=txt},reportValidity(){},querySelectorAll(){return[]}});
  function parse(markup){for(const tag of markup.matchAll(/<(?:[a-z]+)\b([^>]+)>/gi)){const a=tag[1],mid=/\bid="([^"]+)"/.exec(a),val=/\bvalue="([^"]*)"/.exec(a),ap=/\bdata-(ap|at)="([^"]+)"/.exec(a);let el=mid?make(mid[1],val?.[1]||''):fake();if(ap){el.dataset[ap[1]]=ap[2];buttons.push(el)}}}
  function make(id,val){const el=fake(id,val);let html='';Object.defineProperty(el,'innerHTML',{get(){return html},set(v){html=v;if(id==='page'){elements.clear();buttons.length=0;elements.set('page',el)}parse(v)}});elements.set(id,el);return el}
  make('page','');const rows=[tx('2024-02-29',42),tx('2024-12-30',19),tx('2025-01-01',100),tx('2025-01-05',65),tx('2025-01-06',111)];
  const app={month:'2026-11',demo:true},capture={};const win={TallyReportCore:C,TallyUI:{$:q=>get(q.slice(1)),today:'2026-11-19',icon:()=>'',dialog(title,markup){capture.open=true;parse(markup);get('tm-period-kind').value=/<option value="([^"]+)" selected>/.exec(markup)?.[1]||''},close(){capture.open=false}},Ledger:{escape:String,yen:n=>'¥'+n,categories:()=>['食費','交通'],rows:()=>rows,isDemo:()=>app.demo,month:()=>app.month},TallyMap:{render(root,rs,opts){capture.dates=rs.map(r=>r.date);capture.cat=opts.category;capture.period=opts.onPeriod;capture.label=opts.periodLabel;return()=>{}}}};
  const document={querySelectorAll:q=>buttons.filter(el=>Object.hasOwn(el.dataset,q.slice(6,-1))),createElement:()=>{let type='',value='';return {set type(v){type=v==='week'&&!nativeWeek?'text':v},get type(){return type},set value(v){value=type==='week'&&v==='bad'?'':v},get value(){return value}}}};
  vm.runInNewContext(script,{window:win,document,sessionStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}});const render=()=>win.TallyExplorer();render();
  return {app,get,render,capture,click:(kind,val)=>buttons.find(b=>b.dataset[kind]===val).onclick(),change:(id,value)=>{const el=get(id);assert.ok(el,id);el.value=value;el.onchange({target:el})},range:()=>[get('ax-from').value,get('ax-to').value]};
}
test('picked month and week survive rerender, navigation/shared-month changes, and tab reload',()=>{
  const store=new Map(),p=ui(store);p.click('ap','picked-month');p.change('ax-picked-month','2024-02');assert.deepEqual(p.range(),['2024-02-01','2024-02-29']);assert.deepEqual(p.capture.dates,['2024-02-29']);
  p.click('ap','week');p.change('ax-week','2025-W01');p.change('ax-category','食費');assert.deepEqual(p.capture.dates,['2024-12-30','2025-01-01','2025-01-05']);assert.equal(p.capture.cat,'食費');p.click('at','report');p.app.month='2012-07';p.render();assert.deepEqual(p.range(),['2024-12-30','2025-01-05']);assert.ok(p.get('ax-content').innerHTML.includes('取引名別の支出'));
  let q=ui(store);assert.deepEqual(q.range(),p.range());assert.ok(q.get('ax-content').innerHTML.includes('取引名別の支出'));q.click('at','map');assert.equal(q.capture.cat,'食費');q.click('ap','picked-month');assert.equal(q.get('ax-picked-month').value,'2024-02');q.click('ap','month');assert.deepEqual(q.range(),['2026-11-01','2026-11-30']);q.app.month='2024-03';q.render();assert.deepEqual(q.range(),['2024-03-01','2024-03-31']);
});
test('Android-style date fallback, previous/next week, rejection and per-workspace isolation',()=>{
  const store=new Map(),p=ui(store,false);p.click('ap','week');assert.equal(p.get('ax-week'),undefined);p.change('ax-week-day','2021-01-01');assert.deepEqual(p.range(),['2020-12-28','2021-01-03']);p.get('ax-wnext').onclick();assert.equal(p.get('ax-week-day').value,'2021-01-08');p.get('ax-wprev').onclick();assert.equal(p.get('ax-week-day').value,'2021-01-01');
  p.change('ax-week-day','9999-12-31');assert.ok(p.get('ax-period-error').textContent);assert.deepEqual(p.range(),['2020-12-28','2021-01-03']);p.app.demo=false;p.render();assert.equal(p.get('ax-week-day'),undefined);p.app.demo=true;p.render();assert.deepEqual(p.range(),['2020-12-28','2021-01-03']);p.click('at','calendar');const h=p.get('ax-content').innerHTML;assert.ok(h.includes('data-day="2021-01-03"  '));assert.ok(h.includes('data-day="2021-01-04" disabled'));
});

test('map-local dates stage changes and refuse reversed bounds; no-data and category selection share the same period',()=>{
  const p=ui();p.click('ap','all');p.change('ax-category','食費');const original=p.range();p.capture.period();assert.equal(p.get('tm-period-kind').value,'all');p.get('tm-period-kind').value='custom';p.get('tm-period-from').value='2025-01-10';p.get('tm-period-to').value='2025-01-06';
  const submit=()=>p.get('tm-period-form').onsubmit({preventDefault(){}});submit();assert.deepEqual(p.range(),original);assert.equal(p.capture.open,true);assert.match(p.get('tm-period-preview').textContent,/開始日/);p.get('tm-period-cancel').onclick();assert.equal(p.capture.open,false);assert.deepEqual(p.range(),original);
  p.capture.period();p.get('tm-period-kind').value='custom';p.get('tm-period-from').value='2025-01-05';p.get('tm-period-to').value='2025-01-06';submit();assert.deepEqual(p.capture.dates,['2025-01-05','2025-01-06']);assert.equal(p.capture.cat,'食費');assert.equal(p.capture.label,'2025/01/05 〜 2025/01/06');assert.equal(p.app.month,'2026-11');
  p.capture.period();p.get('tm-period-kind').value='picked-month';p.get('tm-period-month').value='2012-02';submit();assert.deepEqual(p.range(),['2012-02-01','2012-02-29']);assert.equal(p.capture.dates.length,0);p.capture.period();p.get('tm-period-kind').value='week';p.get('tm-period-day').value='2025-01-02';submit();assert.equal(p.capture.label,'2024/12/30 〜 2025/01/05');assert.equal(p.get('ax-week').value,'2025-W01');
});
