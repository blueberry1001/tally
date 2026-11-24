/* Secondary pages for the local ledger. Load as a classic script. */
(() => {
  'use strict';
  const L = () => window.Ledger;
  const types = Object.freeze({ income: '収入', expense: '支出', transfer: '振替' });
  const fallbackCategories = ['食費', '日用品', '交通', '趣味', '固定費', 'その他支出'];
  const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const unique = a => [...new Set(a)];
  const money = n => L().yen(n);
  const isDemo = () => typeof L().isDemo === 'function' && L().isDemo();
  const isRecord = o => !!o && typeof o === 'object' && !Array.isArray(o);
  const safeKey = s => s !== '__proto__' && s !== 'constructor' && s !== 'prototype';
  const safeAmount = n => Number.isSafeInteger(n) && n > 0;
  const shortText = (s, max, empty = false) => typeof s === 'string' && s.length <= max && (empty || s.trim().length > 0);
  function el(tag, classes, text) {
    const item = document.createElement(tag);
    if (classes) item.className = classes;
    if (text !== undefined) item.textContent = String(text);
    return item;
  }
  function wrap(tag, classes, ...children) {
    const item = el(tag, classes);
    item.append(...children.filter(c => c != null));
    return item;
  }
  function button(text, classes, click) {
    const item = el('button', `btn ${classes || ''}`.trim(), text);
    item.type = 'button';
    item.addEventListener('click', click);
    return item;
  }
  function field(label, input) {
    return wrap('label', 'field mgr-field', el('span', 'mgr-label', label), input);
  }
  function select(options, value, change) {
    const item = el('select');
    options.forEach(([v, title]) => { const opt = el('option', '', title); opt.value = v; item.append(opt); });
    item.value = value;
    item.addEventListener('change', () => change(item.value));
    return item;
  }
  const intro = (overline, title, description) => wrap('div', 'mgr-intro', el('p', 'eyebrow', overline), el('h2', '', title), description ? el('p', 'muted', description) : null);
  function mount(...children) {
    const root = wrap('div', 'mgr', ...children);
    document.querySelector('#page').replaceChildren(root);
    return root;
  }
  const normalize = s => String(s ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP');
  let filters = { month: '', type: '', category: '', query: '', page: 0 };
  const PAGE_SIZE = 25;
  function categoryCell(c){const dot=el('i','cfg-dot');dot.style.background=window.TallyUI.color[c];return wrap('td','',wrap('span','cfg-dest',dot,el('span','',c)))}
  function transactions() {
    const month = L().month();
    if (filters.month !== month) filters = { month, type: '', category: '', query: '', page: 0 };
    const all = L().rows().filter(r => r.date.slice(0, 7) === month).sort((a,b) => b.date.localeCompare(a.date));
    const head = wrap('div', 'section-head mgr-head', intro('MONTHLY RECORDS', '今月の明細'));
    const search = el('input'); search.type = 'search'; search.placeholder = '内容・カテゴリ・取込元で検索'; search.value = filters.query;
    const typeSelect = select([['', 'すべての種別'], ...Object.entries(types)], filters.type, v => { filters.type = v; filters.category = ''; updateCategories(); resetPage(); });
    const catSelect = select([], '', v => { filters.category = v; resetPage(); });
    function updateCategories() {
      const categories = unique(all.filter(r => !filters.type || r.type === filters.type).map(r => r.category)).filter(Boolean).sort((a,b) => a.localeCompare(b,'ja'));
      if (!categories.includes(filters.category)) filters.category = '';
      catSelect.replaceChildren();
      for (const v of ['', ...categories]) { const opt = el('option', '', v || 'すべてのカテゴリ'); opt.value = v; catSelect.append(opt); }
      catSelect.value = filters.category;
    }
    updateCategories();
    function resetPage() { filters.page = 0; results(); }
    search.addEventListener('input', () => { filters.query = search.value; resetPage(); });
    const reset = button('条件をクリア', 'mgr-quiet', () => { filters.type = filters.category = filters.query = ''; typeSelect.value = search.value = ''; updateCategories(); resetPage(); });
    const controls = wrap('div','toolbar mgr-toolbar', field('検索',search), field('種別',typeSelect), field('カテゴリ',catSelect), reset);
    const listing = el('div','mgr-results');
    mount(wrap('section','panel mgr-panel', head, controls, listing));
    function results() {
      const terms = normalize(filters.query).trim().split(/\s+/u).filter(Boolean);
      const found = all.filter(r => {
        if (filters.type && r.type !== filters.type || filters.category && r.category !== filters.category) return false;
        const text = normalize([r.title, r.category, r.source, r.date, r.amount, money(r.amount), types[r.type]].join(' '));
        return terms.every(t => text.includes(t));
      });
      reset.disabled = !(filters.type || filters.category || filters.query);
      const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
      filters.page = Math.max(0, Math.min(filters.page, pages - 1));
      const start = filters.page * PAGE_SIZE;
      const count = el('p','mgr-count muted', found.length === 0 ? '0件' : `${found.length.toLocaleString('ja-JP')}件中 ${start + 1}–${Math.min(start + PAGE_SIZE,found.length)}件を表示`);
      count.setAttribute('aria-live','polite');
      listing.replaceChildren(count);
      if (!found.length) {
        listing.append(wrap('div','mgr-empty', el('strong','',all.length ? '条件に一致する取引がありません' : 'この月の取引はまだありません'), null));
        return;
      }
      const table = el('table','mgr-table'); table.setAttribute('aria-label','取引一覧');
      const header = el('tr');
      for (const title of ['日付','内容 / 取込元','カテゴリ','種別','金額','操作']) { const th = el('th','',title); th.scope = 'col'; header.append(th); }
      const body = el('tbody');
      found.slice(start,start + PAGE_SIZE).forEach(r => {
        const actions = wrap('div','mgr-actions', button('編集','mgr-small',() => L().edit(r.id)), button('削除','mgr-small mgr-danger',() => {
          L().confirm('取引を削除しますか？',`この取引（${r.date}・${money(r.amount)}）を削除します。この操作は元に戻せません。`,() => {
            const rows = L().rows(); if (!rows.some(x => x.id === r.id)) { L().refresh(); return; }
            try { if (L().saveRows(rows.filter(x => x.id !== r.id)) === false) throw Error(); }
            catch { L().toast('削除できませんでした。保存領域をご確認ください。'); return; }
            L().refresh(); L().toast('取引を削除しました。');
          });
        }));
        const kind = has(types,r.type) ? r.type : 'transfer';
        body.append(wrap('tr','', el('td','mgr-date',r.date.slice(5).replace('-','/')), wrap('td','mgr-detail',el('b','',r.title),el('small','muted',r.source)),categoryCell(r.category),wrap('td','',el('span',`badge mgr-kind mgr-${kind}`,types[kind])),el('td',`mgr-money mgr-money-${kind}`,`${kind === 'income' ? '+' : kind === 'expense' ? '−' : ''}${money(r.amount)}`), wrap('td','',actions)));
      });
      table.append(wrap('thead','',header),body);
      const scroll = wrap('div','mgr-scroll',table); scroll.tabIndex = 0; scroll.setAttribute('aria-label','取引一覧（横スクロール）'); listing.append(scroll);
      if (pages > 1) {
        const prev = button('前へ','mgr-small',() => { filters.page--; results(); }); prev.disabled = filters.page === 0;
        const next = button('次へ','mgr-small',() => { filters.page++; results(); }); next.disabled = filters.page + 1 >= pages;
        listing.append(wrap('div','mgr-pager',prev,el('span','muted',`${filters.page + 1} / ${pages}`),next));
      }
    }
    results();
  }
  function budgets() {
    const month = L().month(), saved = L().budgets(), spent = new Map();
    L().rows().forEach(r => { if (r.type === 'expense' && r.date.slice(0,7) === month) spent.set(r.category,(spent.get(r.category) || 0) + r.amount); });
    const categories = unique([...(L().categories('expense') || fallbackCategories), ...Object.keys(saved), ...spent.keys()]).filter(c => c && safeKey(c));
    const totalBudget = categories.reduce((s,c) => s + (saved[c] || 0),0), totalSpent = [...spent.values()].reduce((a,b) => a+b,0);
    const stats = wrap('div','mgr-stats',...[[ '設定予算の合計', totalBudget ],[ '当月の支出', totalSpent ],[ '予算との差額',totalBudget - totalSpent ]].map(([label,value]) => wrap('div','mgr-stat',el('span','muted',label),el('strong', value < 0 ? 'mgr-over' : '',money(value)))));
    const fields = [], rows = el('div','mgr-budget-list');
    categories.forEach(category => {
      const limit = has(saved,category) ? saved[category] : 0, used = spent.get(category) || 0;
      const input = el('input'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.placeholder = '未設定'; input.value = limit ? String(limit) : ''; input.setAttribute('aria-label',`${category}の月間予算（円）`);
      input.addEventListener('input',() => input.setCustomValidity('')); fields.push([category,input]);
      const usedLine = wrap('div','mgr-budget-use',el('span','',`${money(used)} 使用`),el('span',used > limit && limit ? 'mgr-over' : 'muted',limit ? (used > limit ? `${money(used-limit)} 超過` : `残り ${money(limit-used)}`) : '予算未設定'));
      const meter = el('div',`mgr-meter${limit && used > limit ? ' is-over' : ''}`); meter.setAttribute('aria-hidden','true'); const fill = el('span'); fill.style.width = `${limit ? Math.min(100,used/limit*100) : 0}%`; meter.append(fill);
      rows.append(wrap('div','mgr-budget-row',wrap('strong','mgr-category cfg-dest',Object.assign(el('i','cfg-dot'),{style:'background:'+window.TallyUI.color[category]}),el('span','',category)),wrap('div','mgr-budget-progress',usedLine,meter),wrap('label','mgr-budget-input',input,el('span','muted','円'))));
    });
    const form = el('form','mgr-budget-form');
    const save = el('button','btn primary','予算を保存'); save.type = 'submit';
    form.append(rows,wrap('div','mgr-form-foot',save));
    form.addEventListener('submit',e => {
      e.preventDefault(); const next = Object.create(null);
      for (const [name,input] of fields) {
        const raw = input.value.normalize('NFKC').trim(); if (!raw) continue;
        if (!/^\d+$/.test(raw) || !safeAmount(Number(raw))) { input.setCustomValidity('1円以上の整数を入力してください。'); input.reportValidity(); input.focus(); return; }
        next[name] = Number(raw);
      }
      try { if (L().setBudgets(next) === false) throw Error(); } catch { L().toast('予算を保存できませんでした。'); return; }
      L().refresh(); L().toast('月間予算を保存しました。');
    });
    mount(wrap('section','panel mgr-panel',intro('MONTHLY BUDGET','カテゴリ別予算'),stats,form));
  }
  const MAX_FILE = 16 * 1024 * 1024;
  function dateOK(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.valueOf()) && d.toISOString().slice(0,10) === s;
  }
  function validateBackup(raw) {
    if (!isRecord(raw) || raw.format !== 'ledger-backup' || ![1,2,3,4].includes(raw.version)) throw Error('Tallyのバックアップ（v1〜v4）を選んでください。');
    if (!Array.isArray(raw.rows) || !isRecord(raw.budgets) || raw.rows.length > 100000 || Object.keys(raw.budgets).length > 1024) throw Error('取引または予算の形式・件数が正しくありません。');
    const P=window.TallyPrefs;if(raw.version===4&&!raw.customCategories)throw Error('追加カテゴリの形式が不正です。');
    const custom=P.customCategories(raw.version>=4?raw.customCategories:undefined);
    const allowed=new Map(Object.keys(types).map(t=>[t,new Set(P.categoryList(t,custom))]));
    const ids = new Set();
    const rows = raw.rows.map((r,i) => {
      const invalid = () => { throw Error(`${i+1}件目の取引に不正な値があります。`); };
      if (!isRecord(r) || !(Number.isSafeInteger(r.id) || shortText(r.id,512)) || !dateOK(r.date) || r.date<'1900-01-01' || !has(types,r.type) || !allowed.get(r.type)?.has(r.category) || typeof r.type !== 'string' || !safeAmount(r.amount) || !shortText(r.title,8192) || !shortText(r.category,512) || !safeKey(r.category) || !shortText(r.source,2048,true)) invalid();
      const id = String(r.id); if (ids.has(id)) throw Error(`${i+1}件目の取引IDが重複しています。`); ids.add(id);
      const row = { id, date:r.date, type:r.type, amount:r.amount, title:r.title, category:r.category, source:r.source };
      if (has(r,'key')) { if (!shortText(r.key,8192,true)) invalid(); row.key = r.key; }
      return row;
    });
    const budgets = Object.create(null);
    for (const [category,amount] of Object.entries(raw.budgets)) {
      if (!shortText(category,512) || !allowed.get('expense').has(category) || !safeAmount(amount)) throw Error('カテゴリ別予算に不正な値があります。');
      budgets[category] = amount;
    }
    const goals=raw.version>=2?window.TallyReportCore.goals(raw.goals):[];
    const colors=raw.version>=3?P.colors(raw.colors,custom):{},rules=raw.version>=3?P.rules(raw.rules,custom):[];const viewSettings=has(raw,'viewSettings')?window.TallyPortableView.validate(raw.viewSettings,custom):null;
    return {rows,budgets,goals,colors,rules,customCategories:custom,viewSettings};
  }
  function download(text,mime,filename) {
    const url = URL.createObjectURL(new Blob([text],{type:mime})); const a = el('a'); a.href = url; a.download = filename;
    document.body.append(a); try { a.click(); } finally { a.remove(); window.setTimeout(() => URL.revokeObjectURL(url),30000); }
  }
  function stamp() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function csvCell(value) {
    let text = String(value ?? '');
    // Quoting handles delimiters, not formulas. Guard formulas hidden behind spaces,
    // controls or invisible Unicode characters, including full-width operators.
    if (/^[\t\r\n]/u.test(text) || /^[\p{White_Space}\p{Cc}\p{Cf}]*[=@+\-]/u.test(text.normalize('NFKC'))) text = "'" + text;
    return `"${text.replace(/"/g,'""')}"`;
  }
  function exportCSV() {
    const lines = [['日付','種別','タイトル','カテゴリ','金額','取込元'], ...L().rows().map(r => [r.date,types[r.type],r.title,r.category,r.amount,r.source])];
    download('\uFEFF' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n','text/csv;charset=utf-8',`家計簿_全取引_${stamp()}.csv`);
  }
  function displaySnapshot(){return {version:1,month:L().month(),trendMonths:window.TallyUI.range(),home:window.TallyHomeView.snapshot(),analysis:window.TallyAnalysisView.snapshot(),mapLayout:window.TallyMap.snapshotLayout()}}
  function applyDisplay(v){
    // The validated ledger has committed by the time preferences are touched.
    const saved=[window.TallyUI.restoreHeader(v.month,v.trendMonths),window.TallyHomeView.apply(v.home),window.TallyAnalysisView.apply(v.analysis),window.TallyMap.applyLayout(v.mapLayout)];return saved.every(Boolean);
  }
  function backupJSON() {
    const payload = {format:'ledger-backup',version:4,exportedAt:new Date().toISOString(),rows:L().rows(),budgets:L().budgets(),goals:L().goals(),colors:L().colors(),rules:L().rules(),customCategories:L().customCategories(),viewSettings:displaySnapshot()};
    validateBackup(payload);
    const text = JSON.stringify(payload,null,2);
    if (new Blob([text]).size > MAX_FILE) throw Error('バックアップの上限（16 MB）を超えています。');
    download(text,'application/json;charset=utf-8',`Tally_${isDemo()?'デモ_':''}端末引き継ぎ_${stamp()}.json`);
  }
  function data() {
    let root;
    const picker = el('input','mgr-file'); picker.type = 'file'; picker.accept = '.json,application/json'; picker.hidden = true;
    picker.addEventListener('change',async () => {
      const file = picker.files[0]; picker.value = ''; if (!file) return;
      let backup;
      try {
        if (!file.size || file.size > MAX_FILE) throw Error('空ではない16 MB以下のJSONファイルを選んでください。');
        const text = (await file.text()).replace(/^\uFEFF/,'');
        let raw; try { raw = JSON.parse(text); } catch { throw Error('JSONファイルを読み取れませんでした。'); }
        backup = validateBackup(raw);
      } catch (err) { if (root.isConnected) L().toast(err instanceof Error ? err.message : '読み込みに失敗しました。'); return; }
      if (!root.isConnected || isDemo()) return;
      L().confirm('バックアップで置き換えますか？',`現在の取引・予算・目標・カテゴリ・色・分類ルールを、ファイル内の取引${backup.rows.length}件・予算${Object.keys(backup.budgets).length}件・目標${backup.goals.length}件・色設定${Object.keys(backup.colors).length}件・分類ルール${backup.rules.length}件・追加カテゴリ${backup.customCategories.expense.length+backup.customCategories.income.length}件に置き換えます。${backup.viewSettings?'表示月・ホーム・分析条件・面積図のサイズも引き継ぎます。':'このファイルに表示設定はないため、現在の表示設定は維持します。'}この操作は元に戻せません。`,() => {
        if (!root.isConnected || isDemo()) return;
        try { L().replaceData(backup.rows,backup.budgets,backup.goals,backup.colors,backup.rules,backup.customCategories); }
        catch { return; } // One storage write: never restore rows without their budgets.
        let durable=true;if(backup.viewSettings){try{durable=applyDisplay(backup.viewSettings)}catch{durable=false}}
        L().refresh(); L().toast(!durable?'家計データは復元しましたが、一部の表示設定を保存できませんでした。ブラウザの保存設定を確認してください。':backup.viewSettings?'家計データと表示設定を復元しました。':'バックアップを復元しました。');
      });
    });
    function guarded(fn) { return () => { try { fn(); } catch { L().toast('出力できませんでした。取引データやファイルサイズをご確認ください。'); } }; }
    const card=window.TallyDataActions.card;
    const importCards=window.TallyImport.profiles.map(p=>{const b=card('IMPORT',p.name,()=>window.TallyImport(p.id),{detail:p.detail});b.dataset.importProfile=p.id;return b});
    const imports=wrap('section','panel mgr-panel',intro('IMPORT','インポート','取り込み元を選んでください。明細はこの端末で読み取り、確認したものだけを追加します。'),wrap('div','grid mgr-data-grid',...importCards));imports.id='data-import';
    const cards=wrap('div','grid mgr-data-grid',
      card('BACKUP','端末引き継ぎ用にエクスポート',guarded(backupJSON),{detail:isDemo()?'デモの明細と設定をJSONに保存します。自分の記録は含まれません。':'JSON · 全明細、予算、カテゴリ、分類ルール、表示設定をまとめて保存'}),
      card('RESTORE','バックアップから復元',()=>{if(!isDemo())picker.click()},{detail:isDemo()?'自分の家計簿に切り替えると復元できます。':'JSON · 件数を確認して、この端末の家計簿を置き換え',disabled:isDemo(),disabledReason:'復元は自分の家計簿で利用できます。'}),
      card('EXPORT','CSVをエクスポート',guarded(exportCSV),{detail:'表計算用 · 明細のみ（設定は含みません）'}));
    root = mount(imports,wrap('section','panel mgr-panel',intro('LOCAL DATA','エクスポート・バックアップ',`保存先：${window.TallyDB?'このPCのSQLite':'このブラウザ'}${isDemo()?'（デモ表示中）':''}。取引 ${L().rows().length.toLocaleString('ja-JP')}件 ／ 予算 ${Object.keys(L().budgets()).length}件`),cards),picker);
  }
  window.Manager = { transactions,budgets,data };
})();
