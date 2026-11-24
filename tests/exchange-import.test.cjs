'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {read}=require('../exchange-import.js');
function file(s,name='export.ofx'){const b=new Blob([s]);Object.defineProperty(b,'name',{value:name});return b}
const q=(s,opts={confirmJPY:true})=>read(file(s,'bank.qif'),'qif',opts);
const qtr=(date='2024-03-06',n='-1,000',rest='PStore\nLFood')=>`D${date}\nT${n}\n${rest}\n^\n`;
const qb=(tx,opts,head='!Type:Bank\n')=>q(head+tx,opts);
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const tr=({type='DEBIT',date='20240306235000.000[9:JST]',n='-280.00',id='000000000000009999',name='Demo & Co',extra=''}={})=>`<STMTTRN><TRNTYPE>${type}</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>${n}</TRNAMT><FITID>${id}</FITID><NAME>${esc(name)}</NAME>${extra}</STMTTRN>`;
const of=(tx,{curr='JPY',acct='90807060001',bankid='30001',cc=false}={})=>{const tags=cc?['CREDITCARDMSGSRSV1','CCSTMTTRNRS','CCSTMTRS','CCACCTFROM']:['BANKMSGSRSV1','STMTTRNRS','STMTRS','BANKACCTFROM'];const [outer,env,st,from]=tags;return `<OFX><${outer}><${env}><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><${st}>${curr?`<CURDEF>${curr}</CURDEF>`:''}<${from}>${cc?'':`<BANKID>${bankid}</BANKID><ACCTTYPE>CHECKING</ACCTTYPE>`}<ACCTID>${acct}</ACCTID></${from}><BANKTRANLIST>${tx}</BANKTRANLIST></${st}></${env}></${outer}></OFX>`};
const readOF=(text,name)=>read(file(text,name),'ofx');
test('QIF option gates: file must be JPY, dates cannot be guessed; no FX override',async()=>{
  await assert.rejects(qb(qtr(),{}),/JPY/);assert.equal((await qb(qtr(),{},'!Currency:JPY\n!Type:Bank\n')).rows[0].date,'2024-03-06');await assert.rejects(qb(qtr(),{confirmJPY:true},'!Currency:USD\n!Type:Bank\n'),/JPY/);
  await assert.rejects(qb(qtr('03/06/2024')),/曖昧/);for(const [dateOrder,expected] of [['mdy','2024-03-06'],['dmy','2024-06-03']])assert.equal((await qb(qtr('03/06/2024'),{dateOrder,confirmJPY:true})).rows[0].date,expected);
  assert.equal((await qb(qtr('29/02/2024'))).rows[0].date,'2024-02-29');await assert.rejects(qb(qtr('29/02/2023')),/日付/);await assert.rejects(qb(qtr(),{confirmJPY:true,dateOrder:'typo'}));
});
test('QIF income/debit and bracket transfers, original category, account header; no row or filename collapse',async()=>{
  const a=qtr(),b=qtr('2024-03-07','+3500.00','P給料\nLSalary'),c=qtr('2024-03-08','-500','M振替\nL[Checking]');const header='!Account\nNSynthetic Account\nTCCard\n^\n!Type:CCard\n';const {rows,warnings,skipped}=await qb(a+b+c+a,{confirmJPY:true},header);assert.ok(warnings.length);assert.equal(skipped,0);assert.deepEqual(rows.map(r=>[r.type,r.category,r.amount,r.externalCategory]),[['expense','その他支出',1000,'Food'],['income','その他収入',3500,'Salary'],['transfer','振替',500,'[Checking]'],['expense','その他支出',1000,'Food']]);assert.equal(rows[0].source,'QIF');assert.equal(new Set(rows.map(r=>r.key)).size,4);assert.deepEqual((await qb(c+a+a+b,{confirmJPY:true},header)).rows.map(r=>r.key).sort(),rows.map(r=>r.key).sort());assert.ok(!rows[0].key.includes('Synthetic Account'));
});
test('QIF rejects partial, malformed, splits, securities, multiple accounts and bad yen',async()=>{
  for(const tx of [qtr().replace('^\n',''),qtr().replace('PStore','T-1000'),qtr('2024-03-01','0'),qtr('2024-03-01','0.98'),qtr('2024-03-01','-100,00'),qtr('2024-03-01','-200','SLunch\n$-200'),qtr()+'!Type:CCard\n',qtr().replace('PStore','U-1001')])await assert.rejects(qb(tx));await assert.rejects(q('!Type:Invst\n'+qtr()));assert.deepEqual((await qb('')).rows,[]);
});
test('OFX valid XML & SGML return equivalent account-private keys, JPY signed amounts and transfers',async()=>{
  const acct='90807060001';const xml=of(tr({extra:'<CATEGORY>食事</CATEGORY>'})+tr({type:'CREDIT',n:'+900',id:'2',name:'返金'})+tr({type:'XFER',n:'-500',id:'3',name:`to 98760000 from ${acct}`,extra:'<BANKACCTTO><ACCTID>98760000</ACCTID></BANKACCTTO>'}));const res=await readOF('<?xml version="1.0"?>\n<?OFX OFXHEADER="200"?>\n'+xml);assert.deepEqual(res.rows.map(r=>[r.date,r.type,r.amount]),[['2024-03-06','expense',280],['2024-03-06','income',900],['2024-03-06','transfer',500]]);assert.equal(res.rows[0].title,'Demo & Co');assert.equal(res.rows[0].externalCategory,'食事');assert.doesNotMatch(JSON.stringify(res),/90807060001|98760000|000000000000009999/);
  const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');assert.equal(res.rows[0].key,'ofx:v1:'+hash([hash(['BANKACCTFROM','30001','','CHECKING',acct]),'000000000000009999']));
  const sgml='OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\n\r\n'+xml.replace(/<\/(CODE|SEVERITY|CURDEF|BANKID|ACCTTYPE|ACCTID|TRNTYPE|DTPOSTED|TRNAMT|FITID|NAME|CATEGORY)>/g,'\n');const got=await readOF(sgml,'export.qfx');assert.equal(got.rows[0].source,'QFX');assert.deepEqual(got.rows.map(r=>r.key),res.rows.map(r=>r.key));
});
test('OFX scope includes institution/account/type and duplicate IDs cannot silently conflict',async()=>{
  const k=async opts=>(await readOF(of(tr(),opts))).rows[0].key;assert.equal(new Set(await Promise.all([{}, {acct:'77777'}, {bankid:'877'}, {cc:true}].map(k))).size,4);const dates=await readOF(of(tr()+tr()));assert.equal(dates.rows.length,1);assert.equal(dates.skipped,1);await assert.rejects(readOF(of(tr()+tr({n:'-999'}))),/取引ID/);assert.equal((await readOF(of('',{cc:true}))).rows.length,0);
});
test('OFX rejects non-yen/missing/mixed currencies and incomplete, non-bank or unsupported financial records',async()=>{
 const plain=of(tr());for(const text of [of(tr(),{curr:'EUR'}),of(tr(),{curr:''}),of(tr({extra:'<CURRENCY><CURSYM>USD</CURSYM></CURRENCY>'})),of(tr({extra:'<ORIGCURRENCY><CURSYM>EUR</CURSYM></ORIGCURRENCY>'})),plain.replace('<FITID>000000000000009999</FITID>',''),of(tr({date:'20240230'})),of(tr({n:'-4.59'})),of(tr({n:'77'})),of(tr({extra:'<CORRECTACTION>DELETE</CORRECTACTION>'})),of(tr(),{acct:'XXXX1234'}),plain.replace('<CODE>0','<CODE>4'),plain.slice(0,-9),plain.replace('<STMTTRN>','<INVBUY>'),plain.replace('</OFX>','<INVSTMTMSGSRSV1></INVSTMTMSGSRSV1></OFX>'),'<!DOCTYPE OFX [<!ENTITY n "a">]>'+plain,plain.replace('Demo &amp; Co','&untrusted;')])await assert.rejects(readOF(text));
});
test('empty, binary/invalid UTF-8, oversize, and unknown profile fail without ledger access',async()=>{
 for(const bad of ['', '  \n', '\0', Uint8Array.of(0xc0,0xaf)])await assert.rejects(read(file(bad),'ofx'));await assert.rejects(read(file('aaa'),'csv'));await assert.rejects(read({size:12*1024*1024+1,arrayBuffer(){throw Error('must not read')}},'qif'),/12 MB/);
});
