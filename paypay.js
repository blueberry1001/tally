/* PayPay consumer transaction history (not PayPay for Business / card statements).
 * Official fields: https://paypay.ne.jp/help/c0447/ ; transaction types: /help/c0141/.
 * await PayPayCSV.read(file) -> {rows, skipped, warnings}; no uploads or persistence.
 * A bad file/header/CSV syntax rejects the promise rather than yielding a partial file.
 */
(() => {
  'use strict';
  const norm = s => s.normalize('NFKC').trim();
  const absent = s => /^(?:|[-–—−])$/.test(norm(s));

  async function decode(file) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('CSVファイルを選択してください。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch {
      if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
        try { return new TextDecoder('shift_jis', {fatal: true}).decode(bytes); } catch { /* invalid CP932 */ }
      }
      throw new Error('文字コードを判定できません。UTF-8またはShift_JIS（CP932）のCSVを選択してください。');
    }
  }

  // Normalize line endings once, including those inside quoted fields. Report physical
  // start lines rather than record indices so warnings still locate multiline records.
  function* records(text) {
    text = text.replace(/\r\n?/g, '\n');
    let cells = [], field = '', quoted = false, closed = false, line = 1, start = 1;
    for (let i = 0; i <= text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === undefined) throw new Error(`${start}行目：CSVの引用符が閉じていません。`);
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
        } else { field += c; if (c === '\n') line++; }
      } else if (c === undefined || c === ',' || c === '\n') {
        cells.push(field); field = ''; closed = false;
        if (c !== ',') {
          if (cells.length > 1 || cells[0].trim()) yield {cells, start};
          cells = []; start = ++line;
        }
      } else if (closed || c === '"') {
        if (closed || field) throw new Error(`${line}行目：CSVの引用符が不正です。`);
        quoted = true;
      } else { field += c; }
    }
  }

  const headerNames = {
    date: ['取引日', '取引日時'], out: ['出金金額(円)', '出金金額'], in: ['入金金額(円)', '入金金額'],
    kind: ['取引内容'], party: ['取引先'], method: ['取引方法'], id: ['取引番号', '取引ID'],
    status: ['ステータス', '取引ステータス', '取引状態', '取引状況', '状態']
  };
  function columns(headers) {
    const cols = {};
    headers.forEach((header, i) => {
      const name = norm(header).replace(/\s+/g, '');
      for (const [k, names] of Object.entries(headerNames)) if (names.includes(name)) {
        if (k in cols) throw new Error(`見出し「${name}」が重複しています。`);
        cols[k] = i;
      }
    });
    const missing = ['date', 'out', 'in', 'kind'].filter(k => !(k in cols));
    if (missing.length) throw new Error(`PayPay取引履歴CSVの見出しが見つかりません：${missing.map(k => headerNames[k][0]).join('、')}。`);
    return cols;
  }

  function timestamp(raw) {
    const m = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(norm(raw));
    if (!m) return null;
    const [y, mo, d, h, min, sec] = [m[1], m[3], m[4], m[5] || 0, m[6] || 0, m[7] || 0].map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!y || mo < 1 || mo > 12 || d < 1 || d > last[mo - 1] || h > 23 || min > 59 || sec > 59) return null;
    const pad = v => String(v).padStart(2, '0');
    return `${m[1]}-${pad(mo)}-${pad(d)}` + (m[5] ? `T${pad(h)}:${pad(min)}:${pad(sec)}` : '');
  }
  function yen(raw) {
    if (absent(raw)) return 0;
    const m = /^(?:¥\s*)?(\d+|\d{1,3}(?:,\d{3})+)(?:\s*円)?$/.exec(norm(raw));
    if (!m) return NaN;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isSafeInteger(n) ? n : NaN;
  }

  const expenseRules = [
    ['固定費', /家賃|電気料金|電力|ガス料金|水道|通信料|携帯料金|保険料|サブスク/],
    ['交通', /鉄道|電鉄|タクシー|交通|駐車|高速道路|乗車券|ガソリン|suica|pasmo/i],
    ['日用品', /ドラッグ|薬局|マツモトキヨシ|ウエルシア|ダイソー|セリア|ホームセンター/],
    ['趣味', /映画|書店|書籍|ゲーム|カラオケ|チケット|美術館/],
    ['食費', /スーパー|コンビニ|セブン[・ー-]?イレブン|ローソン|ファミリーマート|レストラン|食堂|カフェ|コーヒー|スターバックス|カレー|寿司|ラーメン|マクドナルド|すき家|吉野家|松屋|弁当/]
  ];
  const balanceMovement = /振替|チャージ|送金|送付|譲渡|送った|送る|払い出し|出金|引き出し|受け取[りるっ]|受取|ポイント運用/;
  const incomplete = /処理中|保留|失敗|期限切れ|期間切れ|超過利用|キャンセル|取消|取り消し|取消し|待ち|予定|受付|未完了/;
  const settled = /^(?:(?:取引|決済|支払い?|チャージ|送金|受取|返金|付与)?(?:完了|済み?)|成立|成功|確定|completed|success)$/i;
  function classify(kind, party, outgoing) {
    if (!outgoing && /給与|給料|賞与/.test(kind)) return ['income', '給与'];
    if (!outgoing && /副収入|副業|報酬/.test(kind)) return ['income', '副収入'];
    if (!outgoing && /返金|還元|付与|ポイント獲得|キャッシュバック/.test(kind)) return ['income', 'その他収入'];
    if (balanceMovement.test(kind) && !/手数料/.test(kind)) return ['transfer', '振替'];
    if (outgoing) return ['expense', expenseRules.find(([, re]) => re.test(party))?.[0] || 'その他支出', !/支払|払い|決済|寄付|手数料/.test(kind)];
    return ['income', 'その他収入', true];
  }

  async function read(file) {
    const text = await decode(file);
    if (text.includes('\0')) throw new Error('CSVに読み取れない文字があります。UTF-8またはShift_JISのCSVを選択してください。');
    const iter = records(text), first = iter.next();
    if (first.done) throw new Error('CSVが空です。');
    const headers = first.value.cells, cols = columns(headers);
    const rows = [], warnings = [], seen = new Map(), occurrences = new Map();
    let skipped = 0, noId = 0;
    for (const {cells, start} of iter) {
      const skip = why => { skipped++; warnings.push(`${start}行目：${why}（除外）`); };
      if (cells.length !== headers.length) { skip('列数が見出しと一致しません'); continue; }
      const get = k => (cells[cols[k]] || '').trim();
      const kind = norm(get('kind')), party = get('party'), status = norm(get('status'));
      if (absent(kind)) { skip('取引内容が空です'); continue; }
      if (('status' in cols && !settled.test(status)) || (incomplete.test(kind) && !/^チャージ取[り]?消[し]?$/.test(kind))) {
        skip(`完了を確認できない取引です：${status || kind}`); continue;
      }
      const stamp = timestamp(get('date'));
      if (!stamp) { skip('取引日が不正です'); continue; }
      const debit = yen(get('out')), credit = yen(get('in'));
      if (Number.isNaN(debit) || Number.isNaN(credit) || (debit > 0) === (credit > 0)) {
        skip('円の出金・入金の片方だけに正の整数が必要です'); continue;
      }
      const outgoing = debit > 0, amount = debit || credit;
      const [type, category, inferred] = classify(kind, norm(party), outgoing);
      const date = stamp.slice(0, 10), title = absent(party) ? kind : party;
      const id = get('id'), direction = outgoing ? 'out' : 'in';
      // An order can have separate payment, point and refund events. Do not coerce
      // long IDs to JS numbers or collapse separate events merely sharing an order.
      const fingerprint = JSON.stringify([stamp, kind, direction, amount, party, get('method')]);
      let key;
      if (!absent(id)) {
        key = 'paypay:id:' + JSON.stringify([id, kind, direction]);
        if (seen.has(key)) {
          skip(seen.get(key) === fingerprint ? '同一の取引番号・取引内容が重複しています' : '同一の取引番号・取引内容で明細が異なります。先の行を採用しました'); continue;
        }
        seen.set(key, fingerprint);
      } else {
        // Keep genuinely identical-looking purchases; numbering is local to a
        // fingerprint, not the file, filename or row index. No secure context needed.
        const count = (occurrences.get(fingerprint) || 0) + 1;
        occurrences.set(fingerprint, count); noId++;
        key = `paypay:row:${fingerprint}:${count}`;
      }
      if (inferred) warnings.push(`${start}行目：「${kind}」は金額の向きから${outgoing ? '支出' : '収入'}としました。分類を確認してください。`);
      rows.push({date, type, amount, title, category, source: 'PayPay', key});
    }
    if (noId) warnings.push(`取引番号のない${noId}件は日時・取引内容などで照合します。重複する期間を取り込む場合は明細を確認してください。`);
    if (!rows.length && !skipped) warnings.push('見出しだけで、取り込める取引がありません。');
    return {rows, skipped, warnings};
  }
  window.PayPayCSV = Object.freeze({read});
})();
