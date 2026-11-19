(() => {
  'use strict';
  const L=window.Ledger, { $,dialog,close,id,typeName,actualRows,icon,setMonth }=window.TallyUI;
  const picker=$('#import-file'); let seq=0;
  const esc=L.escape;
  function choose(error='') {
    seq++;
    dialog('PayPay CSVをインポート',`${error?`<p class="notice" role="alert">${esc(error)}</p>`:''}<button class="file-drop" id="choose-csv">${icon('upload')}<strong>CSVファイルを選択</strong></button>`, 'PAYPAY IMPORT');
    const b=$('#choose-csv');b.onclick=()=>{picker.value='';picker.click()};b.ondragover=e=>{e.preventDefault();b.classList.add('over')};b.ondragleave=()=>b.classList.remove('over');b.ondrop=e=>{e.preventDefault();b.classList.remove('over');if(e.dataTransfer.files.length===1)load(e.dataTransfer.files[0]);else choose('1回につき1ファイルを選んでください。')};
  }
  async function load(file){if(!file)return;const ticket=++seq;try{
    if(file.size>12*1024*1024)throw Error('12 MB以下にしてください。PayPayで短い期間を指定するとファイルを分割できます。');
    const result=await window.PayPayCSV.read(file);
    if(ticket!==seq||!$('#dialog').open)return;
    preview(file.name,result);
  }catch(e){if(ticket===seq&&$('#dialog').open)choose(e.message||'CSVを読み取れませんでした。')}}
  picker.addEventListener('change',()=>{const f=picker.files[0];picker.value='';load(f)});
  function preview(name,result){const lookup=window.TallyPrefs.matcher(window.TallyUI.actualRules()),known=new Set(actualRows().map(r=>r.key).filter(Boolean)),rows=[],warnings=[...result.warnings];let duplicate=0,invalid=0;
    for(const r of result.rows){if(known.has(r.key)){duplicate++;continue}if(r.date<'1900-01-01'||r.title.length>8192||r.key.length>8192){invalid++;continue}rows.push({...r,category:lookup(r.type,r.title)?.category||r.category})}if(invalid)warnings.push(`${invalid}件は対応する日付・項目長の範囲外のため除外しました。`);
    const selected=rows.map(()=>true);let page=0;const size=25;
    dialog('インポート内容を確認',`<div class="import-preview"><p class="hint"><b>${esc(name)}</b><br>追加候補 ${rows.length}件 ／ 登録済み ${duplicate}件 ／ 読み取り除外 ${result.skipped+invalid}件</p>${L.isDemo()?'<p class="notice">保存先：自分の家計簿</p>':''}${warnings.length?`<details class="warnings"><summary>読み取り時の注意（${warnings.length}件）</summary><ul class="warn-list">${warnings.slice(0,120).map(s=>`<li>${esc(s)}</li>`).join('')}${warnings.length>120?`<li>残り${warnings.length-120}件。詳細は期間を分けて確認してください。</li>`:''}</ul></details>`:''}<label class="check-all"><input id="select-all" type="checkbox"> 全件を選択</label><div class="import-list" id="import-rows"></div><div id="import-pages" class="import-pages"></div><p id="import-error" role="alert" class="hint"></p><div class="dialog-actions"><button class="btn" id="choose-again">選び直す</button><button class="btn primary" id="import-commit"></button></div></div>`,'IMPORT PREVIEW');
    const all=$('#select-all'),commit=$('#import-commit');function count(){const n=selected.reduce((s,b)=>s+Number(b),0);all.checked=n>0&&n===rows.length;all.indeterminate=n>0&&n<rows.length;all.disabled=!rows.length;commit.textContent=n?`${n}件をインポート`:'追加する取引なし';commit.disabled=!n}
    function show(){const start=page*size,chunk=rows.slice(start,start+size),list=$('#import-rows');list.innerHTML=chunk.map((r,j)=>{const i=j+start;return `<div class="import-row" data-idx="${i}"><input type="checkbox" aria-label="${esc(r.title)}を追加" ${selected[i]?'checked':''}><div><strong>${esc(r.title)}</strong><small>${esc(r.date)}</small></div><b>${L.yen(r.amount)}</b><div class="import-options"><select class="form-select" data-kind aria-label="種別">${Object.entries(typeName).map(([v,label])=>`<option value="${v}" ${r.type===v?'selected':''}>${label}</option>`).join('')}</select><select class="form-select" data-cat aria-label="カテゴリ">${window.TallyUI.actualCategoryList(r.type).map(c=>`<option ${r.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div></div>`}).join('')||`<p class="empty">${duplicate?'登録済みの取引は再追加しません。':'取り込める明細がありません。'}</p>`;list.scrollTop=0;
      for(const div of list.children){if(!div.hasAttribute('data-idx'))continue;const i=Number(div.dataset.idx),r=rows[i],sel=div.querySelector('[data-cat]');div.querySelector('input').onchange=e=>{selected[i]=e.target.checked;count()};div.querySelector('[data-kind]').onchange=e=>{r.type=e.target.value;r.category=lookup(r.type,r.title)?.category||window.TallyUI.actualCategoryList(r.type)[0];sel.innerHTML=window.TallyUI.actualCategoryList(r.type).map(c=>`<option>${esc(c)}</option>`).join('');sel.value=r.category};sel.onchange=e=>r.category=e.target.value}
      const pages=Math.ceil(rows.length/size);$('#import-pages').innerHTML=pages>1?`<button class="btn" id="import-prev" ${page===0?'disabled':''}>前へ</button><small>${page+1} / ${pages}</small><button class="btn" id="import-next" ${page+1===pages?'disabled':''}>次へ</button>`:'';if(pages>1){$('#import-prev').onclick=()=>{page--;show()};$('#import-next').onclick=()=>{page++;show()}}count()}
    all.onchange=()=>{selected.fill(all.checked);show()};$('#choose-again').onclick=()=>choose();commit.onclick=()=>{const current=new Set(actualRows().map(r=>r.key));const add=rows.filter((r,i)=>selected[i]&&!current.has(r.key)).map(r=>({...r,id:id()}));if(!add.length)return;try{if(L.isDemo())L.useActual();L.saveRows([...actualRows(),...add])}catch(e){$('#import-error').textContent=e.message;return}close();const latest=add.reduce((a,r)=>a>r.date?a:r.date,'').slice(0,7);setMonth(latest);L.go('transactions');L.toast(`${add.length}件を追加しました。${latest.replace('-','年')}月の明細を表示しています。`)};show()
  }
  window.TallyImport=()=>choose();
})();