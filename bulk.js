/* Tally: preview-first prefix recategorization. Only the final confirmation writes. */
(() => {
  'use strict';
  const TYPES = Object.freeze({expense:'支出',income:'収入'});
  const PAGE_SIZE = 20;
  const normalize = s => String(s ?? '').normalize('NFKC').trim().toLowerCase();
  const stale = () => new Error('記録またはルールが更新されました。プレビューをやり直してください。');
  const allowedType = t => t === 'expense' || t === 'income';
  function criterion(input, categories, norm) {
    if (!input || !allowedType(input.type) || !categories(input.type).includes(input.category)) throw Error('変更先のカテゴリを選んでください。');
    if (typeof input.prefix !== 'string') throw Error('先頭の文字を入力してください。');
    const key = norm(input.prefix);
    if (!key || !key.trim()) throw Error('先頭の文字を入力してください。');
    if (!['month','all'].includes(input.scope) || (input.scope === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month))) throw Error('対象期間を選んでください。');
    return {prefix:input.prefix.trim(), key, type:input.type, category:input.category, scope:input.scope, month:input.month};
  }
  function preview(rows,input,categories,norm=normalize) {
    const spec=criterion(input,categories,norm), ids=new Set(), matches=[];
    let unchanged=0;
    for (const r of rows) {
      if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id)) throw Error('取引IDを確認できないため変更できません。');
      ids.add(r.id);
      if (r.type!==spec.type || (spec.scope==='month' && !r.date.startsWith(spec.month+'-')) || !norm(r.title).startsWith(spec.key)) continue;
      if (r.category === spec.category) {unchanged++;continue;}
      // Displayed properties are copied, not live references. The original rows remain immutable.
      matches.push({id:r.id,date:r.date,title:r.title,category:r.category,amount:r.amount});
    }
    matches.sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:a.id<b.id?-1:a.id>b.id?1:0);
    return {source:rows,spec,matches,unchanged};
  }
  function projectedRows(rows, plan, chosen, categories, norm=normalize) {
    if (rows !== plan.source) throw stale();
    // Check in-place changes as well as the immutable snapshots used by the ledger.
    const now=preview(rows,plan.spec,categories,norm);
    if (now.unchanged!==plan.unchanged || now.matches.length!==plan.matches.length || now.matches.some((r,i)=>{
      const old=plan.matches[i];return r.id!==old.id || r.date!==old.date || r.title!==old.title || r.category!==old.category || r.amount!==old.amount;
    })) throw stale();
    const permitted=new Set(now.matches.map(r=>r.id));
    for(const id of chosen) if(!permitted.has(id)) throw stale();
    return chosen.size ? rows.map(r=>chosen.has(r.id)?{...r,category:plan.spec.category}:r) : rows;
  }
  const ruleStamp = rules=>JSON.stringify(rules.map(r=>[r.type,r.prefix,r.category]));
  const prevRule=(rules,s,norm)=>rules.find(r=>r.type===s.type&&norm(r.prefix)===s.key);
  function commit({L,prefs,plan,chosen,future,demo,expectedRules}) {
    if (L.isDemo()!==demo || (plan.spec.scope==='month' && L.month()!==plan.spec.month)) throw stale();
    const rows=projectedRows(L.rows(),plan,chosen,t=>L.categories(t),prefs.norm),spec=plan.spec;
    let result;
    if (future) {
      const rules=L.rules();if(ruleStamp(rules)!==expectedRules)throw stale();
      const change=prevRule(rules,spec,prefs.norm)?.category!==spec.category;
      if(!chosen.size&&!change)throw Error('変更はありません。');
      const next=change?prefs.upsertRule(rules.map(r=>({...r})),{prefix:spec.prefix,type:spec.type,category:spec.category},L.customCategories?.()):rules;
      if(!Array.isArray(next))throw Error('ルールを保存できません。');
      result=L.saveBatch(rows,next);
    } else {
      if(!chosen.size)throw Error('変更する取引を選んでください。');
      result=L.saveRows(rows);
    }
    if(result===false)throw Error('保存できませんでした。');
    return chosen.size;
  }
  function initialForm(initial,month,categories) {
    const type=allowedType(initial?.type)?initial.type:'expense';
    const category=(!initial?.type||initial.type===type)&&typeof initial?.category==='string'&&categories(type).includes(initial.category)?initial.category:'';
    // Preserve the exact transaction title; never silently broaden its match by truncating it.
    const prefix=typeof initial?.prefix==='string'?initial.prefix:'';
    return {prefix,type,category,scope:initial?.scope==='all'?'all':'month',month};
  }
  function open(initial) {
    const L=window.Ledger,U=window.TallyUI,prefs=window.TallyPrefs;
    if(!prefs?.norm || !prefs.upsertRule || !L?.rules || !L?.saveBatch) {L?.toast('一括分類を読み込めませんでした。');return;}
    const demo=L.isDemo(), month=L.month(), esc=L.escape, $=id=>document.getElementById(id);
    const scopeText=s=>s.scope==='month'?s.month.replace('-','年')+'月':'全期間';
    const settings=initialForm(initial,month,t=>L.categories(t));
    let plan=null, selected=new Set(), page=0, future=true, expectedRules='', prior, busy=false;
    const closeButton=()=>{if($('bulk-cancel'))$('bulk-cancel').onclick=U.close};
    const getRuleText=()=>!future?'保存しない':prior?.category===plan.spec.category?'登録済み（変更なし）':prior?'更新':'新規登録';
    function configure(){
      U.dialog('カテゴリを一括変更',`<form id="bulk-form" class="bulk-dialog"><div class="form-grid"><label class="field full">取引名の先頭<input id="bulk-prefix" required maxlength="150" value="${esc(settings.prefix)}" placeholder="例：ファミリーマート" autocomplete="off"></label><label class="field">種別<select id="bulk-type"><option value="expense">支出</option><option value="income">収入</option></select></label><label class="field">変更先カテゴリ<select id="bulk-category" required></select></label><label class="field full">既存の取引の対象期間<select id="bulk-scope"><option value="month">選択月（${esc(month)}）</option><option value="all">全期間</option></select></label></div><label class="bulk-check"><input id="bulk-future" type="checkbox"${future?' checked':''}>今後の取引にも適用</label><p class="bulk-error" id="bulk-error" role="alert"></p><div class="dialog-actions"><button id="bulk-cancel" class="btn" type="button">キャンセル</button><button id="bulk-preview" class="btn primary" type="submit">プレビュー</button></div></form>`,'BATCH CATEGORY');
      const type=$('bulk-type'),cat=$('bulk-category');type.value=settings.type;$('bulk-scope').value=settings.scope;
      const opts=()=>{cat.innerHTML='<option value="">選択してください</option>'+L.categories(type.value).map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')};opts();cat.value=settings.category;type.onchange=opts;closeButton();
      $('bulk-form').onsubmit=event=>{event.preventDefault();Object.assign(settings,{prefix:$('bulk-prefix').value,type:type.value,category:cat.value,scope:$('bulk-scope').value});future=$('bulk-future').checked;
        try{if(L.isDemo()!==demo||L.month()!==month)throw stale();if(future && (settings.prefix.trim().length>150 || prefs.norm(settings.prefix).length>150))throw Error('今後のルールとして保存する場合は、先頭の文字列を150文字以内に短くしてください。');plan=preview(L.rows(),settings,t=>L.categories(t),prefs.norm);const rules=L.rules();expectedRules=ruleStamp(rules);prior=prevRule(rules,plan.spec,prefs.norm);selected=new Set(plan.matches.map(r=>r.id));page=0;showPreview()}catch(err){$('bulk-error').textContent=err.message}
      };
    }
    function showPreview(){
      const s=plan.spec,n=plan.matches.length;
      U.dialog('変更内容のプレビュー',`<div class="bulk-dialog"><div class="bulk-tags"><span>${esc(TYPES[s.type])}</span><span>${esc(scopeText(s))}</span><span>${demo?'デモデータ':'自分の家計簿'}</span></div><p class="bulk-condition"><b>${esc(s.prefix)}</b> で始まる取引 → <strong>${esc(s.category)}</strong></p><div class="bulk-controls"><label class="bulk-check"><input id="bulk-select-all" type="checkbox">全候補を選択</label><span id="bulk-count" role="status"></span></div><div class="bulk-list" id="bulk-list"></div><div class="bulk-pager" id="bulk-pager"></div><p class="bulk-hint">変更済みのため除外：${plan.unchanged}件 ／ 今後のルール：${getRuleText()}</p><div class="dialog-actions"><button id="bulk-back" type="button" class="btn">条件に戻る</button><button id="bulk-next" type="button" class="btn primary">確認へ</button></div></div>`,'BATCH PREVIEW');
      const all=$('bulk-select-all'),next=$('bulk-next'),ruleChange=future&&prior?.category!==s.category;
      function counts(){all.checked=n>0&&selected.size===n;all.indeterminate=selected.size>0&&selected.size<n;all.disabled=!n;$('bulk-count').textContent=`変更予定 ${selected.size} / ${n}件`;next.disabled=!selected.size&&!ruleChange}
      function list(){const start=page*PAGE_SIZE,pages=Math.ceil(n/PAGE_SIZE),list=$('bulk-list');list.innerHTML=plan.matches.slice(start,start+PAGE_SIZE).map((r,j)=>`<label class="bulk-row"><input type="checkbox" data-i="${start+j}" ${selected.has(r.id)?'checked':''}><span><b>${esc(r.title)}</b><small>${esc(r.date)} · ${esc(L.yen(r.amount))}</small></span><span class="bulk-change">${esc(r.category)} → <strong>${esc(s.category)}</strong></span></label>`).join('')||'<p class="empty">変更候補はありません。</p>';list.scrollTop=0;
        for(const box of list.querySelectorAll('[data-i]'))box.onchange=()=>{const id=plan.matches[Number(box.dataset.i)].id;if(box.checked)selected.add(id);else selected.delete(id);counts()};
        $('bulk-pager').innerHTML=pages>1?`<button id="bulk-prev-page" class="btn" ${page===0?'disabled':''}>前へ</button><small>${page+1} / ${pages}</small><button id="bulk-next-page" class="btn" ${page+1===pages?'disabled':''}>次へ</button>`:'';if(pages>1){$('bulk-prev-page').onclick=()=>{page--;listPage()};$('bulk-next-page').onclick=()=>{page++;listPage()}}counts()
      }
      const listPage=list;all.onchange=()=>{selected=new Set(all.checked?plan.matches.map(r=>r.id):[]);listPage()};$('bulk-back').onclick=configure;next.onclick=confirm;listPage();
    }
    function confirm(){const s=plan.spec;
      U.dialog('カテゴリの変更を確定',`<div class="bulk-dialog"><dl class="bulk-summary"><dt>保存先</dt><dd>${demo?'デモデータ':'自分の家計簿'}</dd><dt>取引名の先頭</dt><dd>${esc(s.prefix)}</dd><dt>対象期間</dt><dd>${esc(scopeText(s))}</dd><dt>変更先</dt><dd>${esc(TYPES[s.type])} ／ ${esc(s.category)}</dd><dt>既存の取引</dt><dd><strong>${selected.size}件を変更</strong></dd><dt>今後のルール</dt><dd>${getRuleText()}${future&&prior&&prior.category!==s.category?'：'+esc(prior.category)+' → '+esc(s.category):''}</dd></dl><p class="bulk-error" id="bulk-error" role="alert"></p><div class="dialog-actions"><button type="button" class="btn" id="bulk-back">戻る</button><button type="button" class="btn primary" id="bulk-apply">${selected.size?'確定して変更':'ルールを保存'}</button></div></div>`,'CONFIRM CHANGE');
      $('bulk-back').onclick=showPreview;const apply=$('bulk-apply');apply.onclick=()=>{if(busy)return;busy=true;apply.disabled=true;
        try{commit({L,prefs,plan,chosen:selected,future,demo,expectedRules})}catch(err){$('bulk-error').textContent=err.message||'保存できませんでした。';$('bulk-back').textContent='条件に戻る';$('bulk-back').onclick=configure;busy=false;return}
        U.close();L.refresh();L.toast((selected.size?`${selected.size}件のカテゴリを変更しました。`:'')+(future&&prior?.category!==s.category?'ルールを保存しました。':''));
      };
    }
    configure();
  }
  if(typeof window!=='undefined')window.TallyBulk=Object.freeze({open});
  if(typeof module==='object'&&module.exports)module.exports={normalize,initialForm,preview,projectedRows,ruleStamp,commit};
})();
