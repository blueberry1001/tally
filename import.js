(() => {
  'use strict';
  const L=window.Ledger, { $,dialog,close,id,typeName,actualRows,icon,setMonth }=window.TallyUI;
  const picker=$('#import-file'); let seq=0;
  const esc=L.escape;
  const profiles=[
    {id:'paypay',name:'PayPay',detail:'CSV · 個人向け取引履歴',heading:'PayPay CSVをインポート'},
    {id:'mf',name:'マネーフォワード ME',detail:'CSV · 入出金履歴（内容・金額・振替）'},
    {id:'zaim',name:'Zaim',detail:'CSV · 家計簿の入金・出金・振替'},
    {id:'tally',name:'Tally',detail:'CSV · Tallyの「CSVをエクスポート」で保存した明細'},
    {id:'custom',name:'列を指定して取り込む',detail:'汎用CSV・TSV · 日付や金額の列を指定',accept:'.csv,.tsv,.txt,text/csv,text/tab-separated-values'},
    {id:'ofx',name:'OFX / QFX',detail:'OFX・QFX · 円建ての銀行・カード明細',accept:'.ofx,.qfx'},
    {id:'qif',name:'QIF',detail:'QIF · 円建ての口座明細（日付の順序を指定可能）',accept:'.qif'}
  ];
  let profile=profiles[0],qifOptions={};
  function choose(error='') {
    seq++;picker.accept=profile.accept||'.csv,text/csv';
    const qif=profile.id==='qif',format=profile.id==='ofx'?'OFX / QFX':qif?'QIF':profile.id==='custom'?'CSV / TSV':'CSV';
    dialog(profile.heading||`${profile.name}をインポート`,`${error?`<p class="notice" role="alert">${esc(error)}</p>`:''}<p class="hint">${esc(profile.detail)}。1回につき1ファイル（12 MBまで）。</p>${qif?`<label class="field">日付の順序<select id="qif-order"><option value="">自動（曖昧な日付は取り込まない）</option><option value="ymd">年／月／日</option><option value="mdy">月／日／年</option><option value="dmy">日／月／年</option></select></label><label class="check-all"><input id="qif-yen" type="checkbox"> 金額はすべて日本円です</label>`:''}<button class="file-drop" id="choose-csv">${icon('upload')}<strong>${format}ファイルを選択</strong></button>${error&&['mf','zaim','tally'].includes(profile.id)?'<button class="btn" id="import-use-custom">汎用CSVで列を指定する</button>':''}`, 'IMPORT');
    if($('#import-use-custom'))$('#import-use-custom').onclick=()=>window.TallyImport('custom');
    if(qif){$('#qif-order').value=qifOptions.dateOrder||'';$('#qif-yen').checked=!!qifOptions.confirmJPY;$('#qif-order').onchange=e=>qifOptions.dateOrder=e.target.value;$('#qif-yen').onchange=e=>qifOptions.confirmJPY=e.target.checked}
    const b=$('#choose-csv');b.onclick=()=>{picker.value='';picker.click()};b.ondragover=e=>{e.preventDefault();b.classList.add('over')};b.ondragleave=()=>b.classList.remove('over');b.ondrop=e=>{e.preventDefault();b.classList.remove('over');if(e.dataTransfer.files.length===1)load(e.dataTransfer.files[0]);else choose('1回につき1ファイルを選んでください。')};
  }
  const fields={date:'日付',title:'取引名・摘要',kind:'種別（収入／支出／振替）',amount:'金額（1列式）',out:'出金額（別列式）',in:'入金額（別列式）',transfer:'振替額（別列式）',category:'カテゴリ',currency:'通貨',id:'取引ID'};
  function mappingForm(file,{headers,sample=[]}){
    if(headers.length>256||headers.some(h=>h.length>1024))throw Error('列指定は256列まで、各見出しは1,024文字までにしてください。');
    const suggested=window.TallyLedgerCSV.suggest(headers);
    dialog('CSVの列を指定',`<form id="import-map-form"><p class="hint">${esc(file.name)}：日付・取引名を選び、金額は「1列式」または「入金・出金の別列式」の片方を指定してください。金額は日本円の明細に対応します。</p><div id="import-map" class="form-grid">${Object.entries(fields).map(([k,title])=>`<label class="field">${title}<select data-field="${k}"><option value="-1">指定しない</option>${headers.map((h,i)=>`<option value="${i}" ${suggested[k]===i?'selected':''}>${i+1}. ${esc(h)}</option>`).join('')}</select><small class="hint" data-example="${k}"></small></label>`).join('')}</div><label class="field">金額が1列の場合の読み方<select id="import-amount-mode"><option value="kind">種別列で判定</option><option value="signed">正の金額＝収入、負の金額＝支出</option><option value="expense">すべて支出（正の金額）</option><option value="income">すべて収入（正の金額）</option></select></label><p class="notice" id="import-map-error" role="alert" hidden></p><div class="dialog-actions"><button class="btn" type="button" id="choose-again">選び直す</button><button class="btn primary" type="submit">プレビューを見る</button></div></form>`,'COLUMN MAPPING');
    const form=$('#import-map-form'),selects=Array.from(form.querySelectorAll('[data-field]'));
    const samples=()=>{for(const s of selects){const v=sample[Number(s.value)];form.querySelector(`[data-example="${s.dataset.field}"]`).textContent=v?'例：'+String(v).slice(0,80):''}};form.onchange=samples;samples();$('#choose-again').onclick=()=>choose();form.onsubmit=e=>{e.preventDefault();const map={};for(const s of selects)if(+s.value>=0)map[s.dataset.field]=+s.value;if(map.amount!==undefined)map.amountMode=$('#import-amount-mode').value;load(file,map)};
  }
  async function load(file,mapping){if(!file)return;const ticket=++seq,original=$('#dialog-body').firstElementChild,live=()=>ticket===seq&&$('#dialog').open&&original===$('#dialog-body').firstElementChild;try{
    if(!file.size||file.size>12*1024*1024)throw Error('空ではない12 MB以下のファイルを選んでください。');
    if(profile.id==='custom'&&!mapping){const info=await window.TallyLedgerCSV.inspect(file);if(live())mappingForm(file,info);return}
    const result=profile.id==='paypay'?await window.PayPayCSV.read(file):['qif','ofx'].includes(profile.id)?await window.TallyExchange.read(file,profile.id,{...qifOptions}):await window.TallyLedgerCSV.read(file,profile.id,mapping);
    if(live())preview(file.name,result);
  }catch(e){if(live()){const box=mapping&&$('#import-map-error');if(box){box.hidden=false;box.textContent=e.message||'列指定を確認してください。'}else choose(e.message||'ファイルを読み取れませんでした。')}}}
  picker.addEventListener('change',()=>{const f=picker.files[0];picker.value='';load(f)});
  function preview(name,result){const lookup=window.TallyPrefs.matcher(window.TallyUI.actualRules()),known=new Set(actualRows().map(r=>r.key).filter(Boolean)),rows=[],warnings=[...result.warnings];let duplicate=0,invalid=0;
    const catalogs=Object.fromEntries(Object.keys(typeName).map(t=>[t,window.TallyUI.actualCategoryList(t)]));
    // Tally's human-readable CSV omits import keys. Match existing rows by the exported
    // fields as a multiset; two identical real transactions must not collapse to one.
    const fingerprint=r=>JSON.stringify([r.date,r.type,r.amount,r.title,r.category,r.source]);
    const counts=new Map();if(profile.id==='tally'){const reserved=new Set(result.rows.map(r=>r.key));for(const r of actualRows())if(!reserved.has(r.key)){const f=fingerprint(r);counts.set(f,(counts.get(f)||0)+1)}}
    for(const r of result.rows){if(known.has(r.key)){duplicate++;continue}if(profile.id==='tally'){const f=fingerprint(r),n=counts.get(f)||0;if(n){counts.set(f,n-1);duplicate++;continue}}
      if(r.date<'1900-01-01'||r.title.length>8192||r.key.length>8192||r.source.length>2048){invalid++;continue}
      const cats=catalogs[r.type],original=r.externalCategory||r.category||'',fallback=r.type==='income'?'その他収入':r.type==='expense'?'その他支出':'振替';
      const category=lookup(r.type,r.title)?.category||(cats.includes(original)?original:cats.includes(r.category)?r.category:fallback);
      rows.push({...r,externalCategory:original,category});known.add(r.key);
    }if(invalid)warnings.push(`${invalid}件は対応する日付・項目長の範囲外のため除外しました。`);
    const selected=rows.map(()=>true);let page=0;const size=25;
    dialog('インポート内容を確認',`<div class="import-preview"><p class="hint"><b>${esc(name)}</b><br>追加候補 ${rows.length}件 ／ 登録済み ${duplicate}件 ／ 読み取り除外 ${result.skipped+invalid}件</p>${L.isDemo()?'<p class="notice">保存先：自分の家計簿</p>':''}${warnings.length?`<details class="warnings"><summary>読み取り時の注意（${warnings.length}件）</summary><ul class="warn-list">${warnings.slice(0,120).map(s=>`<li>${esc(s)}</li>`).join('')}${warnings.length>120?`<li>残り${warnings.length-120}件。詳細は期間を分けて確認してください。</li>`:''}</ul></details>`:''}<label class="check-all"><input id="select-all" type="checkbox"> 全件を選択</label><div class="import-list" id="import-rows"></div><div id="import-pages" class="import-pages"></div><p id="import-error" role="alert" class="hint"></p><div class="dialog-actions"><button class="btn" id="choose-again">選び直す</button><button class="btn primary" id="import-commit"></button></div></div>`,'IMPORT PREVIEW');
    const all=$('#select-all'),commit=$('#import-commit');function count(){const n=selected.reduce((s,b)=>s+Number(b),0);all.checked=n>0&&n===rows.length;all.indeterminate=n>0&&n<rows.length;all.disabled=!rows.length;commit.textContent=n?`${n}件をインポート`:'追加する取引なし';commit.disabled=!n}
    function show(){const start=page*size,chunk=rows.slice(start,start+size),list=$('#import-rows');list.innerHTML=chunk.map((r,j)=>{const i=j+start;return `<div class="import-row" data-idx="${i}"><input type="checkbox" aria-label="${esc(r.title)}を追加" ${selected[i]?'checked':''}><div><strong>${esc(r.title)}</strong><small>${esc(r.date)}${profile.id!=='paypay'&&r.externalCategory?' · 元のカテゴリ：'+esc(r.externalCategory):''}</small></div><b>${L.yen(r.amount)}</b><div class="import-options"><select class="form-select" data-kind aria-label="種別">${Object.entries(typeName).map(([v,label])=>`<option value="${v}" ${r.type===v?'selected':''}>${label}</option>`).join('')}</select><select class="form-select" data-cat aria-label="カテゴリ">${catalogs[r.type].map(c=>`<option ${r.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div></div>`}).join('')||`<p class="empty">${duplicate?'登録済みの取引は再追加しません。':'取り込める明細がありません。'}</p>`;list.scrollTop=0;
      for(const div of list.children){if(!div.hasAttribute('data-idx'))continue;const i=Number(div.dataset.idx),r=rows[i],sel=div.querySelector('[data-cat]');div.querySelector('input').onchange=e=>{selected[i]=e.target.checked;count()};div.querySelector('[data-kind]').onchange=e=>{r.type=e.target.value;r.category=lookup(r.type,r.title)?.category||catalogs[r.type][0];sel.innerHTML=catalogs[r.type].map(c=>`<option>${esc(c)}</option>`).join('');sel.value=r.category};sel.onchange=e=>r.category=e.target.value}
      const pages=Math.ceil(rows.length/size);$('#import-pages').innerHTML=pages>1?`<button class="btn" id="import-prev" ${page===0?'disabled':''}>前へ</button><small>${page+1} / ${pages}</small><button class="btn" id="import-next" ${page+1===pages?'disabled':''}>次へ</button>`:'';if(pages>1){$('#import-prev').onclick=()=>{page--;show()};$('#import-next').onclick=()=>{page++;show()}}count()}
    all.onchange=()=>{selected.fill(all.checked);show()};$('#choose-again').onclick=()=>choose();commit.onclick=()=>{const current=new Set(actualRows().map(r=>r.key));const add=rows.filter((r,i)=>selected[i]&&!current.has(r.key)).map(({date,type,amount,title,category,source,key})=>({id:id(),date,type,amount,title,category,source,key}));if(!add.length)return;if(actualRows().length+add.length>100000){$('#import-error').textContent='保存できる取引は合計10万件までです。追加する行を減らしてください。';return}try{if(L.isDemo())L.useActual();L.saveRows([...actualRows(),...add])}catch(e){$('#import-error').textContent=e.message;return}close();const latest=add.reduce((a,r)=>a>r.date?a:r.date,'').slice(0,7);setMonth(latest);L.go('transactions');L.toast(`${add.length}件を追加しました。${latest.replace('-','年')}月の明細を表示しています。`)};show()
  }
  window.TallyImport=(key='paypay')=>{profile=profiles.find(p=>p.id===key)||profiles[0];qifOptions={};choose()};
  window.TallyImport.profiles=profiles;
})();