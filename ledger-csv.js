/* Local-only household ledger CSV readers. Input cells are text, never formulas or HTML.
 * Named profiles target Japanese transaction-history exports, not arbitrary reports.
 * Custom mapping: zero-based indices; absent / -1 = unmapped. No sign-only guessing.
 */
(() => {
  'use strict';
  const norm=v=>v.normalize('NFKC').trim(), hdr=v=>norm(v).toLowerCase().replace(/\s+/g,''), own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const MAX=12*1024*1024, fail=message=>{throw Error(message)};
  async function decode(file){
    if(!file || typeof file.arrayBuffer!=='function')fail('CSVファイルを選択してください。');
    if(file.size>MAX)fail('12 MB以下のCSVを選択してください。');
    const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length>MAX)fail('12 MB以下のCSVを選択してください。');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{
      if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)fail('UTF-8のCSVが破損しています。');
      try{text=new TextDecoder('shift_jis',{fatal:true}).decode(bytes)}catch{fail('UTF-8またはShift_JIS（CP932）のCSVを選択してください。')}
    }
    if(text.includes('\0'))fail('CSVに読み取れない文字があります。');return text.replace(/\r\n?/g,'\n');
  }
  // Inspect only the header record, not amounts or punctuation inside quoted names.
  function delimiter(text){let quoted=false;const counts={',':0,';':0,'\t':0};
    const start=text.search(/[^ \r\n]/);for(let i=Math.max(start,0);i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){i++;continue}quoted=!quoted}else if(!quoted){if(c==='\n')break;if(own(counts,c))counts[c]++}}
    const hits=Object.keys(counts).filter(k=>counts[k]);if(hits.length>1)fail('見出しの区切りが混在しています。区切りを統一するか、見出し内の区切り文字を引用符で囲んでください。');return hits[0]||',';
  }
  function* records(text,sep=','){
    let cells=[],v='',quoted=false,closed=false,line=1,start=1;
    for(let i=0;i<=text.length;i++){
      const c=text[i];
      if(quoted){if(c===undefined)fail(`${start}行目：引用符が閉じていません。`);if(c==='"'){if(text[i+1]==='"'){v+='"';i++}else{quoted=false;closed=true}}else{v+=c;if(c==='\n')line++}}
      else if(c===undefined||c===sep||c==='\n'){cells.push(v);v='';closed=false;if(c!==sep){if(cells.length!==1||cells[0].trim())yield {cells,start};cells=[];start=++line}}
      else if(c==='"'||closed){if(v||closed)fail(`${line}行目：CSVの引用符が不正です。`);quoted=true}else v+=c;
    }
  }
  async function open(file,detect=false){const text=await decode(file),it=records(text,detect?delimiter(text):','),first=it.next();if(first.done)fail('CSVが空です。');const headers=first.value.cells;if(headers.length>256)fail('列数が多すぎます（最大256列）。');return {it,headers}}
  async function inspect(file){const {headers,it}=await open(file,true);return {headers,sample:it.next().value?.cells||[]}}
  const common={date:['日付','年月日','取引日','取引日時','利用日','date'],title:['タイトル','取引名','内容','摘要','品目','お店','店名','店舗名','お店名','description','title'],category:['カテゴリ','カテゴリー','カテゴリ名','大項目','category'],kind:['種別','種類','区分','取引種別','収支区分','方法','type','kind'],amount:['金額','金額(円)','amount','amount(jpy)'],in:['入金','収入','入金額','収入額','入金金額','入金額(円)','入金金額(円)','収入(円)','income','credit','inflow'],out:['出金','支出','出金額','支出額','出金金額','出金額(円)','出金金額(円)','支出(円)','expense','debit','outflow'],transfer:['振替額','振替金額','振替(円)','transferamount'],currency:['通貨','通貨コード','通貨単位','currency','currencycode'],id:['id','取引id','取引番号','明細id']};
  const names={tally:'Tally',mf:'Money Forward ME',zaim:'Zaim',custom:'CSV'};
  function find(headers,aliases,strict){const cols={};for(const [k,labels] of Object.entries(aliases)){const hits=[];headers.forEach((h,i)=>{if(labels.includes(hdr(h)))hits.push(i)});if(hits.length===1)cols[k]=hits[0];else if(hits.length>1&&strict)fail(`${labels[0]}に対応する見出しが重複しています。カスタム形式で列を指定してください。`)}return cols}
  function suggest(headers){if(!Array.isArray(headers)||headers.some(v=>typeof v!=='string'))fail('見出しが不正です。');const cols=find(headers,common,false);if((own(cols,'in')||own(cols,'out'))&&!own(cols,'transfer'))Object.assign(cols,find(headers,{transfer:['振替']},false));return cols}
  function required(cols,...keys){for(const k of keys)if(!own(cols,k))fail(`必要な列がありません：${common[k]?.[0]||k}。形式または列指定を確認してください。`)}
  function amountPlan(c){
    if(own(c,'amount')){if(['in','out','transfer'].some(k=>own(c,k)))fail('金額と入出金別の列は同時に指定できません。');if(c.amountMode==='kind')required(c,'kind');else if(own(c,'kind'))fail('種別列と金額の解釈が重複しています。')}
    else if(c.amountMode!=='kind'||!['in','out','transfer'].some(k=>own(c,k)))fail('指定した金額の解釈に対応する列がありません。');
  }
  function columns(h,p,mapping){
    if(p==='custom'){
      const raw=mapping===undefined?suggest(h):mapping,c={},used=new Set();if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('列指定が不正です。');
      c.amountMode=own(raw,'amountMode')?raw.amountMode:'kind';if(!['kind','signed','income','expense'].includes(c.amountMode))fail('金額の解釈が不正です。');
      for(const [k,i] of Object.entries(raw)){if(k==='amountMode')continue;if(!own(common,k)||!Number.isInteger(i)||i< -1||i>=h.length)fail('列指定が不正です。');if(i===-1)continue;if(used.has(i))fail('同じ列は複数の役割に使用できません。');used.add(i);c[k]=i}
      required(c,'date','title');amountPlan(c);return c;
    }
    if(p==='tally'){const c=find(h,{date:['日付'],kind:['種別'],title:['タイトル'],category:['カテゴリ'],amount:['金額','金額(円)'],source:['取込元']},true);required(c,'date','kind','title','category','amount');return c}
    if(p==='mf'){const c=find(h,{date:['日付'],title:['内容'],category:['大項目'],amount:['金額(円)'],計算対象:['計算対象'],振替:['振替'],id:common.id},true);required(c,'date','title','amount','計算対象','振替');return c}
    const c=find(h,{date:['日付'],kind:['方法','種別'],category:common.category,item:['品目','商品名'],shop:['お店','お店名','店名','店舗','店舗名'],memo:['メモ','備考'],in:['収入','収入(円)'],out:['支出','支出(円)'],transfer:['振替','振替(円)','振替額'],id:common.id,adjust:['残高調整']},true);
    required(c,'date','category','in','out','transfer');return c;
  }
  function timestamp(raw){
    const s=norm(raw).replace(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/,'$1-$2-$3').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
    const m=/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);if(!m)return null;
    const [y,mo,d,h,min,sec]=[m[1],m[3],m[4],m[5]||0,m[6]||0,m[7]||0].map(Number),last=new Date(Date.UTC(y,mo,0)).getUTCDate();if(y<1900||mo<1||mo>12||d<1||d>last||h>23||min>59||sec>59)return null;
    const pad=n=>String(n).padStart(2,'0');return `${y}-${pad(mo)}-${pad(d)}`+(m[5]?`T${pad(h)}:${pad(min)}:${pad(sec)}`:'');
  }
  function money(raw,signed=false){let s=norm(raw).replace(/^−/,'-');if(!s||s==='-'||s==='—')return 0;const m=/^([+-]?)(?:¥\s*|JPY\s*)?(\d+|\d{1,3}(?:,\d{3})+)(?:\s*円)?$/i.exec(s);if(!m||(!signed&&m[1]==='-'))return NaN;const n=Number(m[1]+m[2].replace(/,/g,''));return Number.isSafeInteger(n)?n:NaN}
  const kinds=new Map([['支出','expense'],['出金','expense'],['支払い','expense'],['支払','expense'],['expense','expense'],['payment','expense'],['収入','income'],['入金','income'],['income','income'],['振替','transfer'],['振り替え','transfer'],['transfer','transfer']]);
  const isJPY=s=>/^(?:jpy|円|日本円|¥)$/i.test(norm(s));
  const currencyCodes=new Set(typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('currency'):['USD','EUR','GBP','CNY','KRW','AUD','CAD','HKD','CHF','TWD','NZD','INR']);
  function foreignHeader(value){const s=norm(value);return /[$€£₩]|ドル|ユーロ|人民元|外貨|元通貨|米国通貨/i.test(s)||[...s.matchAll(/\b([a-z]{3})\b/gi)].some(m=>m[1].toUpperCase()!=='JPY'&&currencyCodes.has(m[1].toUpperCase()))||[...s.matchAll(/[[(]([^\])]+)[\])]/g)].some(m=>!isJPY(m[1]))}
  // Reverse only the spreadsheet text prefix that Tally's own CSV exporter adds.
  // An original apostrophe is indistinguishable in this one corner; arbitrary input is never evaluated.
  function tallyText(s){if(s[0]!=="'")return s;const t=s.slice(1);return /^[\t\r\n]/.test(t)||/^[\p{White_Space}\p{Cc}\p{Cf}]*[=@+\-]/u.test(t.normalize('NFKC'))?t:s}
  async function read(file,profile,mapping){
    if(!own(names,profile))fail('対応していないCSV形式です。');const {it,headers}=await open(file,profile==='custom'),c=columns(headers,profile,mapping);
    const currencies=headers.map((h,i)=>common.currency.includes(hdr(h))?i:-1).filter(i=>i>=0);if(own(c,'currency')&&!currencies.includes(c.currency))currencies.push(c.currency);
    if(['amount','in','out','transfer'].some(k=>own(c,k)&&foreignHeader(headers[c[k]])))fail('外貨建ての金額列は使用できません。円の列を指定してください。');
    const rows=[],warnings=[],seen=new Map(),counts=new Map();let skipped=0;
    for(const {cells,start} of it){
      const skip=s=>{warnings.push(`${start}行目：${s}（除外）`);skipped++};const get=k=>cells[c[k]]??'';
      if(cells.length!==headers.length){skip('列数が見出しと一致しません');continue}
      if(currencies.some(i=>!isJPY(cells[i]))){skip('通貨が円ではないか、通貨を確認できません');continue}
      const stamp=timestamp(get('date'));if(!stamp){skip('日付または時刻が不正です');continue}
      let type,amount;
      if(profile==='mf'){
        const tr=norm(get('振替')),use=norm(get('計算対象'));if(!['0','1'].includes(tr)||!['0','1'].includes(use)){skip('計算対象・振替は0または1が必要です');continue}if(tr==='0'&&use==='0'){skip('計算対象外です');continue}
        const n=money(get('amount'),true);amount=Math.abs(n);type=tr==='1'?'transfer':n<0?'expense':'income';
      }else{
        const kind=own(c,'kind')?kinds.get(norm(get('kind')).toLowerCase()):null;if(own(c,'kind')&&!kind){skip('種別が不明です');continue}
        if(own(c,'adjust')&&money(get('adjust'),true)!==0){skip('残高調整には対応していません');continue}
        if(own(c,'amount')){const signed=c.amountMode==='signed',n=money(get('amount'),signed);type=signed?(n<0?'expense':'income'):(kind||c.amountMode);amount=signed?Math.abs(n):n}
        else{const lanes=[['income',money(get('in'))],['expense',money(get('out'))],['transfer',money(get('transfer'))]],used=lanes.filter(([,v])=>v>0);if(lanes.some(([,v])=>!Number.isFinite(v))||used.length!==1){skip('入金・出金・振替のいずれか一方だけに正の円金額が必要です');continue}
          [type,amount]=used[0];if(kind&&kind!==type){if(profile==='custom'&&kind==='transfer'&&!own(c,'transfer'))type='transfer';else{skip('種別と金額の方向が一致しません');continue}}
        }
      }
      if(!Number.isSafeInteger(amount)||amount<=0){skip('円金額が正の整数ではありません');continue}
      const text=k=>profile==='tally'?tallyText(get(k)):get(k).trim();const category=text('category');let title=profile==='zaim'?(text('item')||text('shop')||text('memo')||category):text('title');
      if(!title.trim()&&type==='transfer')title='振替';if(!title.trim()){skip('取引名が空です');continue}
      const source=profile==='tally'&&text('source').trim()?text('source'):names[profile];
      if(title.length>8192||category.length>512||source.length>2048){skip('取引名・カテゴリ・取込元が長すぎます');continue}
      const fingerprint=JSON.stringify([stamp,type,amount,title,category,source]),id=get('id').trim();let key;
      if(id){key=`ledger:${profile}:id:${JSON.stringify(profile==='custom'?[id,fingerprint]:id)}`;if(seen.has(key)){skip(seen.get(key)===fingerprint?'同じIDの取引が重複しています':'同じIDの明細が異なります。先の行を採用しました');continue}}
      else{const n=(counts.get(fingerprint)||0)+1;key=`ledger:${profile}:row:${fingerprint}:${n}`;counts.set(fingerprint,n)}
      if(key.length>8192){skip('重複確認キーが長すぎます');continue}if(id)seen.set(key,fingerprint);
      rows.push({date:stamp.slice(0,10),type,amount,title,category,source,key});
    }
    if(!rows.length&&!skipped)warnings.push('見出しだけで、取り込める取引がありません。');return {rows,skipped,warnings};
  }
  const api=Object.freeze({read,inspect,suggest});if(typeof window!=='undefined')window.TallyLedgerCSV=api;if(typeof module==='object'&&module.exports)module.exports=api;
})();
