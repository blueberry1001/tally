'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const V = require('../portable-view.js');
const base = () => V.defaults('2024-02');
const custom = {expense:['旅費'],income:['配当']};
const clone = o => JSON.parse(JSON.stringify(o));
const invalid = change => {const x=base();change(x);assert.throws(()=>V.validate(x,custom));};

test('defaults are fresh, canonical, deterministic, and require a valid explicit month',()=>{
  assert.deepEqual(base(),{version:1,month:'2024-02',trendMonths:6,home:{kind:'month',type:'expense'},analysis:{type:'expense',view:'map',preset:'month',limit:3,category:''},mapLayout:null});
  const x=base(), y=V.validate(x);assert.deepEqual(y,x);y.home.kind='year';assert.equal(x.home.kind,'month');assert.equal(base().home.kind,'month');
  for(const m of [undefined,'','1899-12','2024-13','2024-2','2024-02-01',true])assert.throws(()=>V.defaults(m));
});
test('active custom endpoints, picked month, ISO week, optional view anchors and layout round trip immutably',()=>{
  const x=base();x.trendMonths=12;x.home={kind:'custom',type:'expense',a:'2024-02-29',b:'2024-02-29'};
  Object.assign(x.analysis,{type:'income',view:'calendar',preset:'week',limit:10,category:'配当',week:'2020-W53',weekDay:'2021-01-03',cal:'2021-01'});x.mapLayout={height:160.5,width:.75};
  const before=clone(x),out=V.validate(x,custom);assert.deepEqual(out,before);assert.deepEqual(x,before);
  for(const k of ['analysis','home','mapLayout'])assert.notEqual(out[k],x[k]);assert.deepEqual(V.validate(out,custom),out);
  Object.assign(x.analysis,{view:'heat',preset:'picked-month',month:'9999-12',heatYear:1900});for(const k of ['week','weekDay','cal'])delete x.analysis[k];
  assert.deepEqual(V.validate(x,custom),x);delete x.analysis.month;Object.assign(x.analysis,{preset:'custom',a:'1900-01-01',b:'9999-12-31',heatYear:9999});assert.deepEqual(V.validate(x,custom),x);
});
test('incompatible categories and unsafe registry names do not use the active ledger catalog',()=>{
  const x=base();x.analysis.category='旅費';assert.equal(V.validate(x,custom).analysis.category,'旅費');assert.throws(()=>V.validate(x));
  for(const v of ['配当','給与','振替','toString','未登録','<svg onload=alert(1)>',null,0,{},[]])invalid(y=>{y.analysis.category=v;});
  assert.throws(()=>V.validate(base(),{expense:['constructor'],income:[]}));
});
test('required properties, exact types, version and layout bounds are strict, without coercion or clamping',()=>{
  for(const k of Object.keys(base()))invalid(x=>{delete x[k];});
  for(const v of [0,2,'1',null,true])invalid(x=>{x.version=v;});
  for(const [parent,field,values] of [['','trendMonths',[0,'6',7]],['home','kind',['picked-month','7',null]],['home','type',['transfer','Income']],['analysis','view',['heatmap','list']],['analysis','preset',['30',{}]],['analysis','limit',[1,'5',NaN]]]){
    for(const v of values)invalid(x=>{(parent?x[parent]:x)[field]=v;});
  }
  for(const v of [undefined,false,[],{}, {width:0,height:200},{width:1.1,height:960},{width:'1',height:180},{width:NaN,height:180},{width:1,height:Infinity},{width:1,height:159.99},{width:1,height:960.1},{width:1,height:'180'}])invalid(x=>{x.mapLayout=v;});
  for(const height of [160,960]){const x=base();x.mapLayout={width:1,height};assert.deepEqual(V.validate(x),x);}
});
test('reject inactive or missing anchors, reversed/nonexistent dates and invalid week/year boundaries',()=>{
  for(const obj of ['home','analysis']){
    for(const pair of [{},{a:'2024-02-01'},{b:'2024-02-01'},{a:'2024-02-30',b:'2024-03-01'},{a:'2024-02-03',b:'2024-02-02'}])invalid(x=>Object.assign(x[obj],{[obj==='home'?'kind':'preset']:'custom'},pair));
    invalid(x=>Object.assign(x[obj],{a:'2024-02-01',b:'2024-02-29'}));
  }
  for(const fields of [{preset:'picked-month'},{preset:'picked-month',month:'1899-12'},{month:'2024-05'},{weekDay:'2024-11-03'},
    {preset:'week',week:'2024-W01'},{preset:'week',weekDay:'2024-01-02'},{preset:'week',week:'2021-W53',weekDay:'2021-12-31'},
    {preset:'week',week:'2020-W53',weekDay:'2021-01-04'},{cal:'2024-01'},{view:'calendar',cal:'2025-00'},
    {heatYear:2024},{view:'heat',heatYear:'2024'},{view:'heat',heatYear:2024.5},{view:'heat',heatYear:1899},{view:'heat',heatYear:10000}])invalid(x=>Object.assign(x.analysis,fields));
});
test('reject raw storage dumps, reserved keys, unexpected nested objects, getters and prototype injection',()=>{
  for(const name of ['__proto__','constructor','prototype','localStorage','sessionStorage','tally.local.v1','tally.view.v1','heatAnchor','rows','token','onclick']){
    for(const target of ['root','home','analysis','mapLayout'])invalid(x=>{x.mapLayout={width:.5,height:240};Object.defineProperty(target==='root'?x:x[target],name,{value:'payload',enumerable:true});});
  }
  let invoked=false;invalid(x=>Object.defineProperty(x.analysis,'category',{enumerable:true,get(){invoked=true;return '食費';}}));assert.equal(invoked,false);
  invalid(x=>{x.home=Object.create(x.home);});invalid(x=>{x.analysis[Symbol('override')]=true;});invalid(x=>Object.defineProperty(x,'secret',{value:1}));
  assert.throws(()=>V.validate(Object.create({version:1})));assert.equal(Object.hasOwn(Object.prototype,'payload'),false);
});
test('browser export works without a ledger, storage, a DOM, or Node globals',()=>{
  const win={},ctx=vm.createContext({window:win});for(const file of ['preferences.js','insight-core.js','portable-view.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  const x=base();x.analysis.category='配当';x.analysis.type='income';assert.deepEqual(clone(win.TallyPortableView.validate(x,custom)),x);assert.deepEqual(clone(win.TallyPortableView.defaults('2024-02')),base());
});
