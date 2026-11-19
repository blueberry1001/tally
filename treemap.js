/* Spending explorer. No network access; storage holds only the preferred map dimensions. */
(() => {
  'use strict';
  const cmp = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const sum = xs => xs.reduce((a,b) => a + b.value, 0);

  // Keep source rows intact. Rank largest first, then newest, then ID for stable ties.
  function groupFlow(rows,type='expense') {
    const map = new Map();
    for (const row of rows || []) {
      if (!row || row.type !== type || !Number.isSafeInteger(row.amount) || row.amount <= 0) continue;
      const name = String(row.category || '未分類');
      if (!map.has(name)) map.set(name, { name, value:0, items:[] });
      const cat = map.get(name);
      cat.value += row.amount;
      cat.items.push({ value:row.amount, row });
    }
    const cats = [...map.values()];
    cats.forEach(c => c.items.sort((a,b) => b.value-a.value || cmp(String(b.row.date),String(a.row.date)) || cmp(String(a.row.id),String(b.row.id))));
    return cats.sort((a,b) => b.value-a.value || cmp(a.name,b.name));
  }

  // Bruls et al. squarification. Choose the strip that minimizes the worst
  // aspect ratio along the remaining short side. Return unpadded rectangles;
  // their areas are proportional to values and their union covers the canvas.
  function squarify(items, width, height) {
    if (![width,height].every(n => Number.isFinite(n) && n > 0)) return [];
    const ordered = items.filter(d => Number.isFinite(d.value) && d.value > 0).sort((a,b) => b.value-a.value);
    const total = sum(ordered);
    if (!total || !Number.isFinite(total)) return [];
    const areas = ordered.map(d => (d.value/total)*width*height);
    const out = [];
    let x=0, y=0, w=width, h=height, i=0;
    while (i<areas.length && w>0 && h>0) {
      const short2=Math.min(w,h)**2, max=areas[i];
      const worst=(a,min) => Math.max(short2*max/(a*a), a*a/(short2*min));
      let end=i+1, area=max, score=worst(area,max);
      while (end<areas.length) {
        const next=area+areas[end], candidate=worst(next,areas[end]);
        if (candidate>score) break;
        area=next; score=candidate; end++;
      }
      const vertical=w>=h, side=vertical?h:w;
      const thick=end===areas.length ? (vertical?w:h) : Math.min(vertical?w:h,area/side);
      let offset=0;
      for (let j=i;j<end;j++) {
        const length=j+1===end ? Math.max(0,side-offset) : Math.min(side-offset,(areas[j]/area)*side);
        out.push({item:ordered[j],x:vertical?x:x+offset,y:vertical?y+offset:y,width:vertical?thick:length,height:vertical?length:thick});
        offset+=length;
      }
      if (vertical) { x+=thick; w=Math.max(0,w-thick); } else { y+=thick; h=Math.max(0,h-thick); }
      i=end;
    }
    return out;
  }

  // Limit painted DOM, not the dataset/rankings. All omitted yen are represented
  // by one aggregate; its rows remain available in the accessible paged list.
  function bucket(items, pixelArea, scoped) {
    if (!items.length) return [];
    if (items.length===1) return items.slice();
    const total=sum(items), cap=scoped?80:32, minArea=scoped?520:440;
    let n=0;
    while (n<items.length && n<cap && (items[n].value/total)*pixelArea>=minArea) n++;
    if (n===items.length) return items.slice();
    const shown=items.slice(0,n);
    const rest=items.slice(n);
    if (rest.length===1) shown.push(rest[0]);
    else shown.push({value:sum(rest), rest});
    return shown;
  }

  const dom=(tag,cls,text) => {
    const e=document.createElement(tag);
    if (cls) e.className='tm-'+cls;
    if (text!=null) e.textContent=String(text);
    return e;
  };
  const btn=(cls,text,handler,label) => {
    const e=dom('button',cls,text); e.type='button';
    if (handler) e.addEventListener('click',handler); else e.disabled=true;
    if (label) e.setAttribute('aria-label',label);
    return e;
  };
  const pct=(a,b) => (b?(a/b*100).toLocaleString('ja-JP',{maximumFractionDigits:1}):'0')+'%';
  const count=n=>n.toLocaleString('ja-JP');
  const fallback=['#6b8f9d','#c57a54','#937eab','#918453','#488e84','#6b769a'];
  function palette(name) {
    const c=window.TallyUI?.color?.[name];
    if (typeof c==='string' && /^#[\da-f]{6}$/i.test(c)) return c;
    let n=0; for(const char of name) n=(n*31+char.codePointAt(0))>>>0;
    return fallback[n%fallback.length];
  }
  const rgb=hex=>[1,3,5].map(n=>parseInt(hex.slice(n,n+2),16));
  const blend=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));
  const rgbCSS=rgb=>`rgb(${rgb.join(',')})`;
  function textColor(bg){const c=bg.map(v=>(v/255)<=.04045 ? v/255/12.92 : ((v/255+.055)/1.055)**2.4);return (.2126*c[0]+.7152*c[1]+.0722*c[2])>.20?'#142032':'#ffffff'}
  const position=(e,x,y,w,h)=>{Object.assign(e.style,{left:x+'px',top:y+'px',width:Math.max(0,w)+'px',height:Math.max(0,h)+'px'});};
  // Store only the user-chosen width fraction and frame height. Temporary viewport clamps
  // (rotation, a narrow host or an on-screen keyboard) never overwrite this preference.
  const layoutKey='tally.treemap.layout.v1', clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  let volatileLayout=null;
  function readLayout(){try{const store=window.localStorage;if(!store)return volatileLayout;const p=JSON.parse(store.getItem(layoutKey));return p&&Number.isFinite(p.width)&&p.width>0&&p.width<=1&&Number.isFinite(p.height)&&p.height>=160&&p.height<=960?{width:p.width,height:p.height}:null}catch{return volatileLayout}}
  function saveLayout(pref){volatileLayout=pref;try{if(pref)window.localStorage?.setItem(layoutKey,JSON.stringify(pref));else window.localStorage?.removeItem(layoutKey)}catch{/* Optional even on file: and in private browsing. */}}
  function bounds(available,viewHeight){const maxW=Math.max(1,Math.floor(available)),maxH=Math.max(180,Math.min(960,Math.round((viewHeight||820)*.9)));return {minW:Math.min(180,maxW),maxW,minH:180,maxH}}
  function fitted(pref,b){return {width:clamp(Math.round((pref?.width??1)*b.maxW),b.minW,b.maxW),height:clamp(Math.round(pref?.height??(b.maxW<500?345:clamp(b.maxW*.43,300,450))),b.minH,b.maxH)}}
  const cleanups=new WeakMap();
  let serial=0;
  function render(root,rows,opts={}) {
    if (!root || typeof root.replaceChildren!=='function') throw new TypeError('TallyMap.render requires a DOM element.');
    cleanups.get(root)?.();
    const type=opts.type==='income'?'income':'expense',labelText=type==='income'?'収入':'支出';
    const groups=groupFlow(rows,type), total=sum(groups), allCount=groups.reduce((s,c)=>s+c.items.length,0);
    const active=typeof opts.category==='string'?opts.category:'';
    const groupsShown=active?groups.filter(c=>c.name===active):groups;
    const visibleSum=sum(groupsShown), visibleCount=groupsShown.reduce((s,c)=>s+c.items.length,0);
    const ranked = Array.isArray(opts.rankedRows) ? new Map(groupFlow(opts.rankedRows,type).map(c=>[c.name,c.items])) : null; // File mode reuses the period groups.
    const limit=Number.isSafeInteger(opts.limit)&&opts.limit>0?opts.limit:5;
    const yen=typeof window.Ledger?.yen==='function'?window.Ledger.yen:n=>'¥'+n.toLocaleString('ja-JP');
    const goCat=name=> typeof opts.onCategory==='function'? opts.onCategory(name):render(root,rows,{...opts,category:name});
    const goLimit=n=> typeof opts.onLimit==='function'? opts.onLimit(n):render(root,rows,{...opts,limit:n});
    const edit=typeof opts.onEdit==='function'?opts.onEdit:window.Ledger?.edit;
    const onEdit=r=> typeof edit==='function' && r.id!=null ? ()=>edit(r.id) : null;
    const ui=dom('div','explorer'), mapBox=dom('section','panel'), rankBox=dom('section','panel'), uid='tmv-'+(++serial);
    root.replaceChildren(ui); ui.append(mapBox);
    const head=dom('div','header'), label=dom('div','headcopy');
    const h2=dom('h2','heading',labelText+'ツリーマップ'); h2.id=uid+'-title'; mapBox.setAttribute('aria-labelledby',h2.id);
    const titleLine=dom('div','title-line');titleLine.append(h2);label.append(dom('div','kicker',type==='income'?'INCOME ATLAS':'SPENDING ATLAS'),titleLine);
    const release=[];let disposed=false;function listen(n,k,f,option){n.addEventListener(k,f,option);release.push(()=>n.removeEventListener(k,f,option))}
    function dispose(){if(disposed)return;disposed=true;for(const stop of release.splice(0).reverse())stop();if(cleanups.get(root)===dispose)cleanups.delete(root)}
    cleanups.set(root,dispose);
    if(typeof opts.onPeriod==='function'){const label=String(opts.periodLabel||'');const b=dom('button','period');b.type='button';b.setAttribute('aria-label',(label?label+'、':'')+'期間を変更');const cal=dom('i','calendar');cal.setAttribute('aria-hidden','true');b.append(cal,dom('span','period-label',label),dom('span','period-action','期間を変更'));listen(b,'click',()=>opts.onPeriod());titleLine.append(b)}
    const stat=dom('div','sum');stat.append(dom('small','','表示中の'+labelText),dom('strong','',yen(visibleSum)));
    head.append(label,stat);mapBox.append(head);
    const nav=dom('nav','crumbs');nav.setAttribute('aria-label',labelText+'ツリーマップの表示範囲');
    if (active) {nav.append(btn('crumb',labelText+'全体',()=>goCat('')),dom('span','sep','›'),dom('strong','current',active));}
    else nav.append(dom('strong','current',labelText+'全体'));
    nav.append(dom('span','scope',`${count(visibleCount)}件${active?' ・ 全'+labelText+'の'+pct(visibleSum,total):' ・ '+count(groups.length)+'カテゴリ'}`));
    mapBox.append(nav);
    if (!groupsShown.length) {
      const e=dom('div','empty');e.append(dom('div','empty-icon','▦'),dom('h3','',(active?'このカテゴリの':'この期間の')+labelText+'はありません'));
      if(active)e.append(btn('all-btn','全カテゴリに戻る',()=>goCat('')));mapBox.append(e);return dispose;
    }
    const atlas=dom('div','canvas');atlas.setAttribute('role','group');atlas.setAttribute('aria-label','カテゴリと取引の'+labelText+'ツリーマップ');
    atlas.id=uid+'-atlas';const stage=dom('div','stage'),frame=dom('div','frame'),tools=dom('div','geometry'),sizeText=dom('span','size-readout');sizeText.id=uid+'-size';tools.setAttribute('role','group');tools.setAttribute('aria-label','ツリーマップのサイズ');frame.append(atlas);stage.append(frame);mapBox.append(tools,stage);
    const handles={},presets={};for(const [kind,name] of [['compact','コンパクト'],['wide','横長'],['reset','リセット']]){const b=dom('button','size-btn',name);b.type='button';b.setAttribute('data-tm-size',kind);b.setAttribute('aria-controls',atlas.id);b.setAttribute('aria-label','マップサイズ：'+(kind==='reset'?'標準にリセット':name));tools.append(b);presets[kind]=b}tools.append(sizeText);
    for(const [side,label] of [['right','横幅を変更'],['bottom','高さを変更'],['corner','幅と高さを変更']]){const h=dom('button','grip');h.type='button';h.setAttribute('data-tm-grip',side);h.setAttribute('aria-controls',atlas.id);h.setAttribute('aria-describedby',sizeText.id);h.setAttribute('aria-label','マップの'+label+'（矢印キーで調整）');h.title=label+'（矢印キーで調整）';if(side!=='corner'){h.setAttribute('role','separator');h.setAttribute('aria-orientation',side==='right'?'vertical':'horizontal')}h.setAttribute('aria-keyshortcuts',side==='right'?'ArrowLeft ArrowRight':side==='bottom'?'ArrowUp ArrowDown':'ArrowLeft ArrowRight ArrowUp ArrowDown');const mark=dom('i','grip-mark');mark.setAttribute('aria-hidden','true');h.append(mark);frame.append(h);handles[side]=h}
    const legend=dom('div','legend');legend.setAttribute('role','group');legend.setAttribute('aria-label','カテゴリを選択');
    groups.forEach(c=>{const b=btn('legend-btn',null,()=>goCat(active===c.name?'':c.name),`${c.name}、${yen(c.value)}、全体の${pct(c.value,total)}。${active===c.name?'絞り込みを解除':'絞り込む'}`);b.setAttribute('aria-pressed',String(active===c.name));b.style.setProperty('--tm-accent',palette(c.name));b.append(dom('i','swatch'),dom('span','legend-name',c.name),dom('small','legend-pct',pct(c.value,total)));legend.append(b)});
    mapBox.append(legend);
    const drillBox=dom('div','details');drillBox.hidden=true;mapBox.append(drillBox);
    let origin=null;
    function showList(name,items,isRest=false,trigger=null,page=0,focus=true){
      if(trigger) origin=trigger;
      const size=15, first=page*size, pages=Math.ceil(items.length/size);drillBox.replaceChildren();drillBox.hidden=false;
      const top=dom('div','list-head'), t=dom('h3','',`${name} ／ ${isRest?'まとめた明細':'全明細'}（${count(items.length)}件）`);t.tabIndex=-1;
      const dismiss=btn('quiet','閉じる',()=>{drillBox.hidden=true;if(origin?.isConnected)origin.focus();else legend.querySelector('button')?.focus()});top.append(t,dismiss);drillBox.append(top);
      const ul=dom('ul','detail-list');items.slice(first,first+size).forEach(d=>{const li=dom('li',''),r=d.row,b=btn('detail-row',null,onEdit(r));b.append(dom('time','date',r.date),dom('span','detail-title',r.title||'名称なし'),dom('strong','',yen(d.value)));li.append(b);ul.append(li)});drillBox.append(ul);
      if(pages>1){const foot=dom('div','pager');foot.append(btn('quiet','前へ',page>0?()=>showList(name,items,isRest,null,page-1):null),dom('span','',`${page+1} / ${pages}`),btn('quiet','次へ',page+1<pages?()=>showList(name,items,isRest,null,page+1):null));drillBox.append(foot)}
      if(focus){t.focus({preventScroll:true});drillBox.scrollIntoView({block:'nearest'})}
    }
    function paint(){
      const W=atlas.clientWidth,H=atlas.clientHeight;if(!W||!H)return;
      const frag=document.createDocumentFragment();
      for(const {item:c,x,y,width,height} of squarify(groupsShown,W,H)){
        const w=Math.max(0,width-3),h=Math.max(0,height-3);if(w<1||h<1)continue;
        const region=dom('div','region'),base=rgb(palette(c.name)),dark=blend(base,[18,26,42],.50);
        position(region,x+1.5,y+1.5,w,h);region.style.setProperty('--tm-region',rgbCSS(dark));region.setAttribute('role','group');region.setAttribute('aria-label',`${c.name}、${yen(c.value)}`);
        const groupAction=()=>goCat(active===c.name?'':c.name), caption=btn('band',null,groupAction,`${c.name}、${yen(c.value)}。${active===c.name?'全体に戻る':'カテゴリで絞り込む'}`);
        const cramped=w<78 || h<60;const bandH=cramped?h:Math.min(34,Math.max(23,Math.floor(h*.15)));
        position(caption,0,0,w,bandH);caption.title=`${c.name}　${yen(c.value)}（全体の${pct(c.value,total)}）`;
        caption.append(dom('b','',c.name));if(w>120)caption.append(dom('span','band-val',yen(c.value)));region.append(caption);
        if(!cramped){const ih=h-bandH-2,iw=w-4;const parts=bucket(c.items,Math.max(0,ih*iw),!!active);let rank=0;
          for(const {item:d,x:tx,y:ty,width:tw,height:th} of squarify(parts,iw,ih)){
            const r=d.row,summary=!!d.rest,txt=summary?`その他 ${count(d.rest.length)}件`:String(r.title||'名称なし');
            const desc=`${c.name} ｜ ${summary?'少額明細の一覧':r.date} ｜ ${txt} ｜ ${yen(d.value)}`;
            const tile=btn('tile',null,summary?ev=>showList(c.name,d.rest,true,ev.currentTarget):onEdit(r),desc);tile.title=desc;
            // Use a bounded, consistent tone ramp within each category. A special
            // hatch distinguishes real transactions from the aggregate without color alone.
            const tone=blend(base,[250,248,244],.10+(rank%6)*.095);tile.style.setProperty('--tm-tile',rgbCSS(tone));tile.style.setProperty('--tm-text',textColor(tone));if(summary)tile.classList.add('tm-bundle');
            position(tile,tx+2,bandH+ty+1,Math.max(0,tw-1.5),Math.max(0,th-1.5));
            if(tw>=35 && th>=18){tile.append(dom('span','tile-label',txt));if(tw>=56&&th>=44)tile.append(dom('strong','tile-value',yen(d.value)));if(!summary&&tw>=105&&th>=82)tile.append(dom('small','tile-date',r.date))}
            else tile.tabIndex=-1;region.append(tile);rank++;
          }
        }
        frag.append(region);
      }atlas.replaceChildren(frag);
    }
    ui.append(rankBox);const rh=dom('div','header'),rhCopy=dom('div','headcopy'),rt=dom('h2','heading','カテゴリ別 高額取引');rt.id=uid+'-rank';rankBox.setAttribute('aria-labelledby',rt.id);rhCopy.append(dom('div','kicker','TOP TRANSACTIONS'),rt);
    const switches=dom('div','switches');switches.setAttribute('role','group');switches.setAttribute('aria-label','各カテゴリの表示件数');
    const rankLimits=[...new Set([3,5,10,limit])].sort((a,b)=>a-b);rankLimits.forEach(n=>{const b=btn('switch','Top '+n,()=>goLimit(n));b.setAttribute('aria-pressed',String(n===limit));switches.append(b)});rh.append(rhCopy,switches);rankBox.append(rh);
    const grid=dom('div','rank-grid');rankBox.append(grid);
    groupsShown.forEach(c=>{const card=dom('article','rank-card'),bar=dom('div','card-head');card.style.setProperty('--tm-accent',palette(c.name));
      const title=dom('h3','card-title');title.append(dom('i','swatch'),dom('span','',c.name));const totals=dom('small','card-meta',`${count(c.items.length)}件 ・ ${yen(c.value)}`);bar.append(title,totals);card.append(bar);
      const ol=dom('ol','ranking'), ranking=ranked ? (ranked.get(c.name)||[]) : c.items;if(!ranking.length)ol.append(dom('li','rank-empty','該当するランキング明細がありません。'));ranking.slice(0,limit).forEach((d,i)=>{const r=d.row,li=dom('li',''),b=btn('rank-row',null,onEdit(r),`${c.name} ${i+1}位、${r.date}、${r.title}、${yen(d.value)}。編集`);const info=dom('span','rank-info');info.append(dom('strong','rank-name',r.title||'名称なし'),dom('time','date',r.date));const am=dom('span','rank-amount');am.append(dom('b','',yen(d.value)));const meter=dom('i','meter'),fill=dom('i','fill');fill.style.width=(d.value/c.items[0].value*100)+'%';meter.append(fill);am.append(meter);b.append(dom('span','ordinal',String(i+1).padStart(2,'0')),info,am);li.append(b);ol.append(li)});card.append(ol);
      const all=btn('all-btn',`${c.name}の全${count(c.items.length)}件を見る →`,ev=>showList(c.name,c.items,false,ev.currentTarget));card.append(all);grid.append(card)});
    let pref=readLayout(),drag=null,lastW=-1,lastH=-1,raf=null,swallowUntil=0;
    const limits=()=>bounds(stage.clientWidth,window.innerHeight);
    function draw(){raf=null;if(disposed)return;if(!root.contains(ui)){dispose();return}const w=atlas.clientWidth,h=atlas.clientHeight;if(w===lastW&&h===lastH)return;lastW=w;lastH=h;paint()}
    function layout(){if(disposed||!stage.clientWidth)return;const b=limits(),s=fitted(pref,b);frame.style.width=s.width+'px';frame.style.height=s.height+'px';sizeText.textContent=s.width+' × '+s.height;for(const [h,lo,hi,now] of [[handles.right,b.minW,b.maxW,s.width],[handles.bottom,b.minH,b.maxH,s.height]]){h.setAttribute('aria-valuemin',String(lo));h.setAttribute('aria-valuemax',String(hi));h.setAttribute('aria-valuenow',String(now));h.setAttribute('aria-valuetext',now+'ピクセル')}if(window.requestAnimationFrame){if(raf===null)raf=window.requestAnimationFrame(draw)}else draw()}
    function change(base,old,side,dx,dy){const b=limits();return {width:side==='bottom'||dx===0?(old?.width??1):clamp(base.width+dx,b.minW,b.maxW)/b.maxW,height:side==='right'||dy===0?(old?.height??base.height):clamp(Math.round(base.height+dy),b.minH,b.maxH)}}
    function finish(cancel){if(!drag)return;const d=drag;drag=null;if(cancel)pref=d.prior;else if(d.moved)saveLayout(pref);if(d.moved)swallowUntil=Date.now()+500;frame.setAttribute('data-resizing','false');try{if(d.handle.hasPointerCapture(d.id))d.handle.releasePointerCapture(d.id)}catch{}if(!disposed)layout()}
    // A captured pointer can still be retargeted to the frame in some Edge/WebView builds.
    // Route events by the initiating pointer ID rather than by the current hit tile.
    function move(e){if(!drag||drag.id!==e.pointerId)return;const {side}=drag,dx=side==='bottom'?0:e.clientX-drag.x,dy=side==='right'?0:e.clientY-drag.y;if(!drag.moved&&Math.max(Math.abs(dx),Math.abs(dy))<2)return;drag.moved=true;pref=change(drag.base,drag.prior,side,dx,dy);layout()}
    function up(e){if(drag&&drag.id===e.pointerId){move(e);finish(false)}}
    function cancel(e){if(drag&&drag.id===e.pointerId)finish(true)}
    if(window.addEventListener){for(const [evt,fn] of [['pointermove',move],['pointerup',up],['pointercancel',cancel]])listen(window,evt,e=>{if(drag&&!drag.handle.contains(e.target))fn(e)},true)}
    for(const [side,h] of Object.entries(handles)){
      listen(h,'pointerdown',e=>{if(drag||e.isPrimary===false||e.button!==0)return;try{h.setPointerCapture(e.pointerId)}catch{/* The window also tracks the active pointer. */}e.preventDefault();h.focus({preventScroll:true});drag={id:e.pointerId,side,x:e.clientX,y:e.clientY,base:fitted(pref,limits()),prior:pref,handle:h,moved:false};frame.setAttribute('data-resizing','true')});
      listen(h,'pointermove',move);listen(h,'pointerup',up);listen(h,'pointercancel',cancel);listen(h,'lostpointercapture',cancel);
      listen(h,'keydown',e=>{if(drag)return;const step=e.shiftKey?32:8;const dx=side!=='bottom'?(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0):0,dy=side!=='right'?(e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0):0;if(!dx&&!dy)return;e.preventDefault();pref=change(fitted(pref,limits()),pref,side,dx,dy);saveLayout(pref);layout()});
    }
    for(const [kind,b] of Object.entries(presets))listen(b,'click',()=>{finish(true);pref=kind==='reset'?null:kind==='wide'?{width:1,height:260}:{width:.72,height:240};saveLayout(pref);layout()});
    listen(stage,'pointerdown',e=>{if(atlas.contains(e.target)&&!drag)swallowUntil=0},true);
    listen(stage,'click',e=>{if((drag||Date.now()<swallowUntil)&&e.detail!==0&&atlas.contains(e.target)){e.preventDefault();e.stopImmediatePropagation()}},true);
    if(window.addEventListener){listen(window,'resize',layout);listen(window,'blur',()=>finish(true))}
    if(window.ResizeObserver){const observer=new window.ResizeObserver(layout);observer.observe(stage);observer.observe(atlas);release.push(()=>observer.disconnect())}
    release.push(()=>{finish(true);if(raf!==null)window.cancelAnimationFrame?.(raf)});layout();if(raf!==null)window.cancelAnimationFrame(raf);draw();
    return dispose;
  }
  const api=Object.freeze({render,layout:squarify});
  if(typeof window!=='undefined') window.TallyMap=api;
  if(typeof module!=='undefined' && module.exports) module.exports={squarify,groupExpenses:groupFlow,groupFlow,bucket,render};
})();