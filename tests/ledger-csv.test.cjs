// Synthetic records only. No household data, external dependencies, network or disk writes.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../ledger-csv.js');
const text=lines=>lines.map(r=>r.map(x=>'"'+String(x).replaceAll('"','""')+'"').join(',')).join('\r\n');
const file=(...lines)=>new Blob(['\ufeff'+text(lines)]);
const tally=['日付','種別','タイトル','カテゴリ','金額','取込元'];
const mf=['計算対象','日付','内容','金額（円）','保有金融機関','大項目','中項目','メモ','振替','ID'];
const zaim=['日付','方法','カテゴリ','カテゴリの内訳','支払元','入金先','品目','メモ','お店','通貨','収入','支出','振替','残高調整','通貨変換前の金額','集計設定'];
const noKey=rows=>rows.map(({key,...x})=>x);
test('classic API without Node globals; inspect and suggest indices, including ambiguous duplicate headers',async()=>{
 const ctx={window:{},TextDecoder};vm.runInNewContext(fs.readFileSync(require.resolve('../ledger-csv.js'),'utf8'),ctx);const browser=ctx.window.TallyLedgerCSV;
 const h=['カテゴリー','出金額（円）','入金','振替','日付','タイトル','通貨','id'],data=['外食','500','','','2026/6/1','カフェ,\n"テスト"','JPY','0002'];
 assert.deepEqual(JSON.parse(JSON.stringify(await browser.inspect(file(h,data)))),{headers:h,sample:data});assert.deepEqual(JSON.parse(JSON.stringify(browser.suggest(h))),{date:4,title:5,category:0,out:1,in:2,transfer:3,currency:6,id:7});assert.deepEqual(api.suggest(['日付','日付','金額','無関係']),{amount:2});assert.deepEqual(await api.inspect(file(h)),{headers:h,sample:[]});
});
test('Tally reimports all three kinds, original labels and source, quotes and guarded formula text as inert data',async()=>{
 const rows=[['2024-02-29','支出',"'　＝外食,\n\"北\"",'旅行','1,234','PayPay'],['20241130','収入','\'通常名','追加名','２０００円','手入力'],['2024年3月1日','振替','財布間','振替','¥500','CSV']];
 const result=await api.read(file(tally,...rows),'tally');assert.equal(result.skipped,0);assert.deepEqual(noKey(result.rows),[
 {date:'2024-02-29',type:'expense',amount:1234,title:'　＝外食,\n"北"',category:'旅行',source:'PayPay'},
 {date:'2024-11-30',type:'income',amount:2000,title:"'通常名",category:'追加名',source:'手入力'},
 {date:'2024-03-01',type:'transfer',amount:500,title:'財布間',category:'振替',source:'CSV'}]);
});
test('MF official monthly Web column layout: signs, transfer priority over 計算対象, flags and string IDs',async()=>{
 const row=(flag,n,tr,id,other='仮想店')=>[flag,'2025/6/1',other,n,'架空銀行','分類原文','交通費','',tr,id];
 const records=[row(1,'-4,000',0,'000123456789012345678'),row(1,1234,0,'i'),row(0,-222,1,'t'),row(0,-50,0,'skip'),row('',33,0,'f'),row(1,22,'false','f'),row(1,'=1+2',0,'bad'),row(1,'-4,000',0,'000123456789012345678'),row(1,-4001,0,'000123456789012345678')];
 const res=await api.read(file(mf,...records),'mf');assert.equal(res.skipped,6);assert.deepEqual(res.rows.map(r=>[r.type,r.amount,r.category]),[['expense',4000,'分類原文'],['income',1234,'分類原文'],['transfer',222,'分類原文']]);assert.match(res.rows[0].key,/000123456789012345678/);assert.match(res.warnings.join(' '),/対象外/);assert.match(res.warnings.join(' '),/明細が異な/);
});
test('Zaim amount lanes: empty/zero lanes, transfer column, income, title fallback, FX and conflicting direction excluded',async()=>{
 const row=(k,inc,out,tr,ccy='JPY',adjust='',item='')=>['2024.2.29',k,'自作分類','分類内訳','口座A','口座B',item,'メモ','テスト店',ccy,inc,out,tr,adjust,1234,''];
 const res=await api.read(file(zaim,row('支出','',500,0,'円','','購入品'),row('収入',1000,0,0),row('振替','-','',300),row('支出',100,200,0),row('未確認',30,0,0),row('振替',0,200,0),row('支出',0,90,0,'USD'),row('支出',0,90,0,''),row('支出',0,90,0,'JPY',22)),'zaim');assert.equal(res.skipped,6);assert.deepEqual(res.rows.map(r=>[r.type,r.amount,r.title,r.category]),[['expense',500,'購入品','自作分類'],['income',1000,'テスト店','自作分類'],['transfer',300,'テスト店','自作分類']]);
});
test('custom mapping binds by index, validates monetary units independently, never guesses unknown transaction kinds',async()=>{
 const h=['同名','同名','通貨コード','名称','処理種別','出金列','入金列'],m={date:1,title:3,kind:4,category:0,out:5,in:6,currency:-1};const row=(k,out,inc,ccy='JPY')=>['分類','2024-02-29T02:03:04',ccy,'振替という店名',k,out,inc];
 const res=await api.read(file(h,row('出金',7,''),row('入金',0,20),row('振替',25,0),row('??',7,0),row('支出',0,99),row('収入',0,100,'EUR'),row('支出',24,2)),'custom',m);assert.equal(res.skipped,4);assert.deepEqual(res.rows.map(r=>[r.type,r.amount]),[['expense',7],['income',20],['transfer',25]]);
 for(const bad of [{...m,kind:99},{...m,kind:'4'},{...m,title:0},{...m,bogus:3},{...m,amount:4,kind:-1}])await assert.rejects(api.read(file(h),'custom',bad));
 for(const amount of ['金額(USD)','金額[XYZ]','Amount INR','外貨金額'])await assert.rejects(api.read(file(['日付','名称',amount]),'custom',{date:0,title:1,amount:2,amountMode:'signed'}),/外貨/);
});
test('custom single-amount mode supports only explicit kind, signed yen or one selected direction',async()=>{
 const h=['D','T','N'],m={date:0,title:1,amount:2};const f=file(h,...['-1,500','120','0','9007199254740992','3.9','12,3','3 USD','2.00','+3',"'=2"].map(n=>['2024/1/1','給与という店名',n]));
 await assert.rejects(api.read(f,'custom',m));await assert.rejects(api.read(f,'custom',{...m,amountMode:'auto'}));
 const s=await api.read(f,'custom',{...m,amountMode:'signed'});assert.equal(s.skipped,7);assert.deepEqual(s.rows.map(r=>[r.type,r.amount]),[['expense',1500],['income',120],['income',3]]);
 for(const mode of ['income','expense']){const abs=await api.read(f,'custom',{...m,amountMode:mode});assert.equal(abs.skipped,8);assert.ok(abs.rows.every(r=>r.type===mode&&r.amount>0))}
 await assert.rejects(api.read(file([...h,'K']),'custom',{...m,kind:3,amountMode:'signed'}));await assert.rejects(api.read(f,'custom',{date:0,title:1,out:2,amountMode:'signed'}));
});
test('repeated identical rows are not collapsed; stable keys across reordering and header reordering',async()=>{
 const a=['2025/1/1','支出','珈琲','外食',500,'手入力'],b=['2025/01/02','支出','映画','趣味',1000,'手入力'];
 const run=async(h,r)=>(await api.read(file(h,...r),'tally')).rows.map(v=>v.key).sort();const ks=await run(tally,[a,a,b]);assert.equal(new Set(ks).size,3);assert.deepEqual(await run(tally.slice().reverse(),[b,a,a].map(v=>v.slice().reverse())),ks);
});
test('bad files reject atomically; invalid dates, row widths, negative unsigned/zero amounts skip with physical row numbers',async()=>{
 const row=(date,amount=10)=>[date,'支出','架空\n店舗','趣味',amount,'手入力'];const f=file(tally,row('2024/02/29'),row('2023/02/29'),row('2024-02-29 24:01'),row('20260601',-100),row('1899/1/1'),row('2025/1/1',0),row('2025/1/1').slice(1));const res=await api.read(f,'tally');assert.equal(res.rows.length,1);assert.equal(res.skipped,6);assert.match(res.warnings[0],/^4行目/);
 for(const f of [new Blob(['  ']),new Blob(['\0']),new Blob([new Uint8Array([0xef,0xbb,0xbf,0x82])]),new Blob([text([tally,row('2024-01-01')])+'\n"oops']),file([...tally,'金額']),file(['日付','合計（円）'])])await assert.rejects(api.read(f,'tally'));
 assert.equal((await api.read(file(tally),'tally')).warnings.length,1);
});
test('CP932 stays intact (including NEC/Roman numeral vendor extension bytes)',async()=>{
 const bytes=Buffer.concat([Buffer.from('D,T,N\r\n2024/3/2,"','ascii'),Buffer.from([0x83,0x65,0x83,0x58,0x83,0x67,0x87,0x54]),Buffer.from('",123','ascii')]);const f=new Blob([bytes]);assert.equal((await api.inspect(f)).sample[1],'テストⅠ');const s=await api.read(f,'custom',{date:0,title:1,amount:2,amountMode:'expense'});assert.equal(s.rows[0].title,'テストⅠ');
});

test('custom delimited text: tab and semicolon headers ignore quoted punctuation; unrelated exports may reuse IDs',async()=>{
  const m={date:0,title:1,amount:2,id:3,amountMode:'signed'};
  for(const sep of [';', '\t']){const f=new Blob([['date','"title, note"','amount','id'].join(sep)+'\n'+['2025/1/2','"cafe'+sep+'taxi"','-200','1'].join(sep)+'\n'+['2025/1/3','bus','-300','1'].join(sep)]);assert.equal((await api.inspect(f)).headers.length,4);const {rows,skipped}=await api.read(f,'custom',m);assert.equal(skipped,0);assert.equal(rows[0].title,'cafe'+sep+'taxi');assert.notEqual(rows[0].key,rows[1].key)}
  await assert.rejects(api.inspect(new Blob(['date,kind;amount\n'])),/区切り/);
});
