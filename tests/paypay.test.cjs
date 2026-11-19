'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = {window: {}, TextDecoder};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'paypay.js'), 'utf8'), context);
const read = bytes => context.window.PayPayCSV.read(new Blob([bytes]));
const fields = ['取引日','出金金額（円）','入金金額（円）','取引内容','取引先','取引番号'];
const csv = records => records.map(row => row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\r\n');
const fixture = (...rows) => csv([fields, ...rows]);
const project = (rows, fn) => Array.from(rows, fn); // objects originate in the browser VM

test('official export: UTF-8 BOM, foreign currency fields ignored, quoted fields and multiline merchant', async () => {
  const headers = [...fields.slice(0,3), '海外出金金額','通貨','変換レート（円）','利用国','取引内容','取引先','取引方法','支払い区分','利用者','取引番号'];
  const party = 'カレー, "金曜"\r\n本店';
  const r = await read('\ufeff' + csv([headers, ['2024/06/03 11:28','1,500','-','10','USD','150.00','US','支払い',party,'PayPayカード','一回払い','本人','00012345678901234567890']]) + '\r\n\r\n');
  assert.deepEqual(JSON.parse(JSON.stringify(r.rows)), [{date:'2024-06-03',type:'expense',amount:1500,title:'カレー, "金曜"\n本店',category:'食費',source:'PayPay',key:r.rows[0].key}]);
  assert.equal(r.skipped, 0); assert.equal(r.warnings.length, 0);
});

test('CP932 file with vendor extension character decodes without replacement', async () => {
  const b64 = 'juaI+JP6LI9vi+CL4Ip6gWmJfoFqLJP8i+CL4Ip6gWmJfoFqLI7miPiT4JdlLI7miPiQ5iyO5oj4lNSNhg0KMjAyNC82LzMgMTE6MjgsNTAwLC0sjniVpYKiLPv8i7SQSJOwLDAwMDE=';
  const r = await read(Buffer.from(b64,'base64'));
  assert.equal(r.rows[0].title,'髙橋食堂'); assert.equal(r.rows[0].amount,500); assert.equal(r.skipped,0);
});

test('all categories; only transaction kind, not the merchant, indicates a movement', async () => {
  const examples = [
    ['支払い','コンビニ',1,'expense','食費'], ['支払い','薬局',1,'expense','日用品'],
    ['支払い','タクシー',1,'expense','交通'], ['支払い','映画館',1,'expense','趣味'],
    ['支払い','水道局',1,'expense','固定費'], ['支払い','チャージ屋',1,'expense','その他支出'],
    ['PayPay給与受取','企業',0,'income','給与'], ['副業報酬','企業',0,'income','副収入'],
    ['ポイント獲得','支払い',0,'income','その他収入'], ['返金','店',0,'income','その他収入'],
    ['チャージ','銀行',0,'transfer','振替'], ['銀行口座への出金','銀行',1,'transfer','振替'],
    ['送金（譲渡）','知人',1,'transfer','振替'], ['受け取り','知人',0,'transfer','振替'],
    ['チャージ取り消し','銀行',1,'transfer','振替'], ['銀行出金手数料','銀行',1,'expense','その他支出']
  ];
  const r = await read(fixture(...examples.map(([kind,party,out],i) => ['2024-02-29',out?100:0,out?0:100,kind,party,i])));
  assert.deepEqual(project(r.rows, x => [x.type,x.category]),examples.map(x => x.slice(3)));
  assert.equal(r.skipped,0); assert.equal(r.warnings.length,0);
});

test('invalid calendar dates/times, ambiguous or malformed amounts and missing kind are skipped with line warnings', async () => {
  const base = ['2024/2/29 09:07:00','１００円','-','支払い','店','1'];
  const bad = [
    [0,'2023/02/29'],[0,'2024/2/31'],[0,'2024/01/01 24:00'],[0,'2024/1/1 trailing'],
    [1,'0'],[1,'-5'],[1,'+1'],[1,'10.5'],[1,'1e2'],[1,'10,00'],[1,'9,007,199,254,740,992'],[1,'1,000x'],[2,'1'],[2,'broken'],[3,'-']
  ].map(([idx,v]) => base.map((x,i) => i===idx?v:x));
  const r = await read(fixture(...bad, ['','','','','',''],base));
  assert.equal(r.skipped,bad.length+1); assert.equal(r.warnings.length,r.skipped);
  assert.equal(r.rows.length,1); assert.equal(r.rows[0].amount,100); assert.equal(r.rows[0].date,'2024-02-29');
  assert.match(r.warnings[0],/^2行目/);
});

test('optional status is fail-closed, including blank, unknown and deceptive status; pending kind never booked', async () => {
  const statuses = ['完了','支払い完了','確定','処理中','取消','期限切れ','失敗','未完了','完了予定','unknown',''];
  const rows = statuses.map((s,i) => ['2024/1/2','10','-','支払い','店',i,s]);
  rows.push(['2024/1/2','10','-','支払い受付','店','pending','完了']);
  const r = await read(csv([[...fields,'取引ステータス'],...rows]));
  assert.equal(r.rows.length,3); assert.equal(r.skipped,rows.length-3); assert.equal(r.warnings.length,r.skipped);
});

test('refuse unreadable files and malformed quotes, even when preceding data looked valid', async () => {
  const hdr = fields.join(',');
  for (const s of ['', '日付,店舗名,金額', hdr + ',出金金額(円)',hdr + '\n2024/1/1,1,-,支払い,店,1\n"open',hdr + '\na"b',hdr+'\n"a"b','\0',Buffer.from([0xef,0xbb,0xbf,0xff]),Buffer.from([0x81])]) {
    await assert.rejects(read(s), /CSV|見出し|引用符|文字コード/);
  }
});

test('physical line warnings survive a quoted newline, wrong column count and unknown event', async () => {
  const r = await read(fixture(['2024/1/1','1','-','支払い','店\n二号店','1'],['short'],['2024/1/2','-','２，０００','未分類の特典','-','2']));
  assert.equal(r.skipped,1); assert.equal(r.rows[1].amount,2000); assert.equal(r.rows[1].title,'未分類の特典');
  assert.match(r.warnings[0],/^4行目.*列数/); assert.match(r.warnings[1],/^5行目.*分類/);
});

test('IDs remain strings; duplicate/conflicting records warned; related refund and point events retained; file order irrelevant', async () => {
  const a = ['2024/1/1','10','-','支払い','A','0012345678901234567890'];
  const b = [...a.slice(0,5),'0012345678901234567891'];
  const refund = [a[0],'-','10','返金',a[4],a[5]];
  const points = [a[0],'-','1','ポイント付与',a[4],a[5]];
  const r = await read(fixture(a,b,[...a],a.map((v,i)=>i===1?'20':v),refund,points));
  assert.equal(r.rows.length,4); assert.equal(new Set(project(r.rows,x=>x.key)).size,4); assert.equal(r.skipped,2);
  assert.match(r.warnings[0],/重複/); assert.match(r.warnings[1],/異なります/);
  assert.equal((await read(fixture(b,a))).rows[1].key,r.rows[0].key);
});

test('no-ID fallback preserves repeated purchases and matches across header/row reordering', async () => {
  const a = ['2024/6/3 9:07','¥1,234','','支払い','A','-'];
  const b = ['2024/06/03 09:08:00','1234','0','支払い','A',''];
  const r = await read(fixture(a,a,b));
  assert.equal(r.skipped,0); assert.equal(r.warnings.length,1); assert.match(r.warnings[0],/取引番号のない3件/);
  assert.equal(new Set(project(r.rows,x => x.key)).size,3);
  const rev = await read(csv([fields,b,a,a].map(row=>[...row].reverse())));
  assert.deepEqual(project(rev.rows,x=>x.key).sort(),project(r.rows,x=>x.key).sort());
});

test('header only import signals empty result', async () => {
  const r = await read(csv([fields])); assert.equal(r.rows.length,0); assert.equal(r.skipped,0); assert.match(r.warnings[0],/見出しだけ/);
});
