const assert = require('node:assert/strict');
const {test} = require('node:test');
const {groupExpenses,squarify,bucket,render}=require('../treemap.js');
const tx=(id,value,category='食費',type='expense',date='2026-03-01')=>({id,amount:value,type,category,date,title:'購入 '+id});

test('group only positive integer expenses; stable order, no source mutation',()=>{
  const rows=[tx('z',20),tx('x',10,'交通'),tx('c',20),tx('n',20,'食費','expense','2026-03-04'),tx('i',100,'給与','income'),tx('t',400,'交通','transfer'),tx('bad',-10),tx('bad2',NaN),null];
  const before=JSON.stringify(rows);const groups=groupExpenses(rows);assert.deepEqual(groups.map(c=>[c.name,c.value]),[['食費',60],['交通',10]]);assert.deepEqual(groups[0].items.map(d=>d.row.id),['n','c','z']);assert.equal(JSON.stringify(rows),before);
  assert.equal(groupExpenses([tx('x',1,'__proto__')])[0].name,'__proto__');
});
test('squarified layout conserves area, stays bounded and has no overlaps on narrow/wide canvases',()=>{
  let s=14;const rnd=()=>((s=(s*1664525+1013904223)>>>0)/4294967296);
  for (const [w,h] of [[390,346],[1224,370],[80,900],[1,1],[243.7,195.2]]) {
    for(let n=1;n<65;n+=4){const input=Array.from({length:n},(_,i)=>({value:Math.max(1,Math.floor(rnd()**4*20000)),i})),total=input.reduce((s,d)=>s+d.value,0);const rects=squarify(input,w,h);assert.equal(rects.length,n);
      for (let i=0;i<n;i++){const a=rects[i];assert.ok(a.width>0&&a.height>0&&a.x>=0&&a.y>=0&&a.x+a.width<=w+1e-7&&a.y+a.height<=h+1e-7);assert.ok(Math.abs(a.width*a.height/(w*h)-a.item.value/total)<1e-8);
        for(const b of rects.slice(i+1)){const ox=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),oy=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);assert.ok(ox<1e-7||oy<1e-7)} }
    }
  }
  assert.deepEqual(squarify([{value:0},{value:-1},{value:NaN}],20,20),[]);assert.deepEqual(squarify([{value:1}],0,20),[]);
});
test('square weights produce compact square tiles; no mutation, stable ties',()=>{
  const a=[{value:1,id:1},{value:1,id:2},{value:1,id:3},{value:1,id:4}];const r=squarify(a,100,100);assert.deepEqual(r.map(x=>x.item.id),[1,2,3,4]);assert.ok(r.every(x=>x.width===50&&x.height===50));
});
test('small transactions bounded into a single accessible bundle without losing count or yen',()=>{
  const items=groupExpenses(Array.from({length:5000},(_,i)=>tx(i,i===0?200000:1)))[0].items;
  for(const scoped of [true,false]){const parts=bucket(items,400*300,scoped);assert.ok(parts.length<82);assert.equal(parts[0].row.amount,200000);assert.equal(parts.filter(d=>d.rest).length,1);assert.equal(parts.flatMap(d=>d.rest||[d]).length,5000);assert.equal(parts.reduce((s,d)=>s+d.value,0),204999)}
});
// Minimal DOM harness: checks markup text/callbacks without jsdom or browser installs.
class El {
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.events={};this.style={setProperty(k,v){this[k]=v}};this.classList={add:c=>this.className+=' '+c};this.textContent='';this.className='';this.clientWidth=366;this.clientHeight=340;}
  append(...els){this.children.push(...els);els.forEach(e=>e.parent=this)} replaceChildren(...els){this.children=[];this.append(...els)} setAttribute(k,v){this.attrs[k]=v} addEventListener(k,f){this.events[k]=f} removeEventListener(k,f){if(this.events[k]===f)delete this.events[k]} contains(e){return this===e||this.children.some(c=>c.contains(e))} scrollIntoView(){} focus(){} click(){this.events.click?.({currentTarget:this})}
  setPointerCapture(id){this.capture=id} hasPointerCapture(id){return this.capture===id} releasePointerCapture(id){if(this.capture===id)this.capture=null}
  fire(type,details={}){const e={target:this,currentTarget:this,preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true},...details};this.events[type]?.(e);return e}
  all(cls){return [...(this.className.split(' ').includes('tm-'+cls)?[this]:[]),...this.children.flatMap(c=>c.all(cls))]}
}
function environment(){global.document={createElement:t=>new El(t),createDocumentFragment:()=>new El('fragment')};global.window={Ledger:{yen:n=>'¥'+n},ResizeObserver:class {observe(){}disconnect(){}}};return new El('root')}
test('each category gets Top N, names stay text, controls dispatch exact callback IDs/values',()=>{
  const root=environment(),calls=[];const rows=['食費','交通'].flatMap(c=>Array.from({length:7},(_,i)=>tx(c+i,7-i,c)));rows[0].title='<img onerror=x>';
  const opts={limit:3,onCategory:n=>calls.push(n),onLimit:n=>calls.push(n),onEdit:n=>calls.push(n)};const done=render(root,rows,opts);
  assert.deepEqual(root.all('rank-card').map(c=>c.all('rank-row').length),[3,3]);assert.equal(root.all('region').length,2);assert.equal(root.all('tile').length,14);assert.ok(root.all('tile-label').some(r=>r.textContent==='<img onerror=x>'));
  root.all('legend-btn')[0].click();assert.ok(['交通','食費'].includes(calls.pop()));root.all('switch')[2].click();assert.equal(calls.pop(),10);root.all('rank-card').find(c=>c.all('rank-name')[0].textContent==='<img onerror=x>').all('rank-row')[0].click();assert.equal(calls.pop(),'食費0');done();
});
test('drill, SQL rankings and no-data views honor explicit empty inputs',()=>{
  const root=environment(),rows=[tx('food',60),tx('rank',15),tx('train',20,'交通')];let back;
  render(root,rows,{category:'食費',rankedRows:[rows[1],rows[2]],onCategory:c=>back=c});assert.equal(root.all('rank-card').length,1);assert.equal(root.all('rank-name')[0].textContent,'購入 rank');assert.equal(root.all('sum')[0].children[1].textContent,'¥75');assert.equal(root.all('tile').length,2);root.all('crumb')[0].click();assert.equal(back,'');
  render(root,rows,{rankedRows:[]});assert.equal(root.all('rank-row').length,0);assert.equal(root.all('rank-empty').length,2);render(root,rows,{category:'存在しない'});assert.equal(root.all('empty').length,1);assert.equal(root.all('tile').length,0);render(root,[],{});assert.equal(root.all('empty').length,1);
});
const layoutKey='tally.treemap.layout.v1';
function layoutFixture(store=new Map()){
  const root=environment();let observer,disconnected=0;const listeners={};Object.assign(window,{innerHeight:800,localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},ResizeObserver:class{constructor(fn){observer=fn}observe(){}disconnect(){disconnected++}},addEventListener:(k,fn)=>listeners[k]=fn,removeEventListener:(k,fn)=>{if(listeners[k]===fn)delete listeners[k]}});
  const draw=(opts={})=>render(root,[tx('a',70),tx('b',30,'交通')],opts);return {root,draw,store,listeners,disconnects:()=>disconnected,resize:(w,h=800)=>{root.all('stage')[0].clientWidth=w;window.innerHeight=h;observer()},grip:k=>root.all('grip').find(g=>g.attrs['data-tm-grip']===k),preset:k=>root.all('size-btn').find(b=>b.attrs['data-tm-size']===k),dims:()=>{const f=root.all('frame')[0];return [parseInt(f.style.width),parseInt(f.style.height)]}};
}
test('pointer capture and corner motion resize both axes; separate hit rails, no drag-click, no writes until commit',()=>{
  const f=layoutFixture(), edits=[];f.draw({onEdit:id=>edits.push(id)});f.resize(800);const corner=f.grip('corner'),r=f.grip('right'),b=f.grip('bottom'),s=f.root.all('stage')[0],tile=f.root.all('tile')[0];
  const event=(h,key,x,y,extra={})=>h.fire(key,{pointerId:13,button:0,isPrimary:true,pointerType:'touch',clientX:x,clientY:y,...extra});
  assert.deepEqual(f.dims(),[800,344]);event(corner,'pointerdown',700,300);assert.equal(corner.capture,13);event(corner,'pointermove',540,354,{pointerId:22});assert.deepEqual(f.dims(),[800,344]);event(corner,'pointermove',540,354);assert.deepEqual(f.dims(),[640,398]);assert.equal(f.store.size,0);assert.equal(s.fire('click',{detail:1,target:tile}).stopped,true);event(corner,'pointerup',540,354);assert.equal(corner.capture,null);assert.deepEqual(JSON.parse(f.store.get(layoutKey)),{width:.8,height:398});assert.equal(s.fire('click',{detail:1,target:tile}).stopped,true);s.fire('pointerdown',{target:tile});assert.ok(!s.fire('click',{target:tile,detail:1}).stopped);tile.click();assert.deepEqual(edits,['a']);
  event(r,'pointerdown',650,100);event(r,'pointermove',-10000,400);assert.deepEqual(f.dims(),[180,398]);event(r,'pointercancel',0,0);assert.deepEqual(f.dims(),[640,398]);event(b,'pointerdown',700,100);event(b,'pointerup',5,5500);assert.deepEqual(f.dims(),[640,720]);assert.equal(r.attrs['aria-valuenow'],'640');assert.equal(b.attrs['aria-valuenow'],'720');
});
test('keyboard resize, presets, narrower orientation, reload, reset and teardown retain correct bounds and preferences',()=>{
  const f=layoutFixture();const stop=f.draw();f.resize(1000);f.preset('compact').click();assert.deepEqual(f.dims(),[720,240]);f.grip('right').fire('keydown',{key:'ArrowRight'});f.grip('bottom').fire('keydown',{key:'ArrowDown',shiftKey:true});assert.deepEqual(f.dims(),[728,272]);assert.ok(!f.grip('right').fire('keydown',{key:'ArrowUp'}).prevented);assert.ok(f.grip('corner').fire('keydown',{key:'ArrowLeft'}).prevented);assert.deepEqual(f.dims(),[720,272]);f.resize(135,240);assert.deepEqual(f.dims(),[135,216]);f.resize(1000);assert.deepEqual(f.dims(),[720,272]);assert.deepEqual(Object.keys(JSON.parse(f.store.get(layoutKey))).sort(),['height','width']);
  const g=f.grip('right');g.fire('pointerdown',{pointerId:8,button:0,clientX:100,clientY:40});stop();assert.equal(g.capture,null);assert.equal(f.disconnects(),1);assert.deepEqual(f.listeners,{});assert.deepEqual(Object.keys(g.events),[]);const second=layoutFixture(f.store);second.draw();second.resize(500);assert.deepEqual(second.dims(),[360,272]);second.preset('wide').click();assert.deepEqual(second.dims(),[500,260]);second.preset('reset').click();assert.equal(second.store.has(layoutKey),false);assert.deepEqual(second.dims(),[500,300]);
});
test('period control is focusable even with no rows and never submits or injects the supplied label',()=>{
  const f=layoutFixture();let count=0;const label='2026年11月 <b>';for(const rows of [[],[tx('a',10)]]){const stop=render(f.root,rows,{periodLabel:label,onPeriod:()=>count++});const b=f.root.all('period')[0];assert.equal(b.tag,'button');assert.equal(b.type,'button');assert.equal(f.root.all('period-label')[0].textContent,label);assert.match(b.attrs['aria-label'],/期間を変更/);b.click();stop();b.click()}assert.equal(count,2);
});

test('Edge retargeted move and release outside the handle still commit only the active pointer',()=>{
 const f=layoutFixture();f.draw();f.resize(800);const h=f.grip('right'),frame=f.root.all('frame')[0];h.fire('pointerdown',{pointerId:17,button:0,clientX:760,clientY:60});const event={target:frame,pointerId:17,clientX:660,clientY:70};f.listeners.pointermove({...event,pointerId:99});assert.deepEqual(f.dims(),[800,344]);f.listeners.pointermove(event);assert.deepEqual(f.dims(),[700,344]);f.listeners.pointerup(event);assert.equal(h.capture,null);assert.equal(JSON.parse(f.store.get(layoutKey)).width,.875);
});

test('income map groups original income records, titles and rank callbacks, excluding transfers and spending',()=>{
 const root=environment(),rows=[tx('s',60,'給与','income'),tx('a',9,'配当','income'),tx('b',12,'配当','income'),tx('x',700),tx('z',800,'振替','transfer')];let edit;const done=render(root,rows,{type:'income',limit:1,onEdit:id=>edit=id});assert.equal(root.all('heading')[0].textContent,'収入ツリーマップ');assert.equal(root.all('sum')[0].children[1].textContent,'¥81');assert.deepEqual(root.all('rank-card').map(c=>c.all('rank-row').length),[1,1]);root.all('rank-row')[1].click();assert.equal(edit,'b');done();
});
