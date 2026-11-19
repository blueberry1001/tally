/* Tally reporting vocabulary: local civil dates, integer yen, no account-balance assumptions. */
(() => {
  'use strict';
  const dayMs=86400000, day=s=>Math.floor(Date.parse(s+'T00:00:00Z')/dayMs), stamp=n=>new Date(n*dayMs).toISOString().slice(0,10);
  const valid=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&s>='1900-01-01'&&Number.isFinite(day(s))&&stamp(day(s))===s;
  const endMonth=m=>{const y=+m.slice(0,4),a=+m.slice(5);return stamp(Math.floor(Date.UTC(y,a,0)/dayMs))};
  const MIN_DATE='1900-01-01',MAX_DATE='9999-12-31';
  const minDay=day(MIN_DATE),maxDay=day(MAX_DATE);
  const validMonth=m=>typeof m==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(m)&&valid(m+'-01');
  function monthRange(m){if(!validMonth(m))throw new RangeError('1900年1月から9999年12月までの年月を選んでください。');return [m+'-01',endMonth(m)]}
  // Civil day ordinals, not local timestamps: DST and UTC offsets never shorten a week.
  const monday=n=>n-(((n+3)%7+7)%7); // 1970-01-01 was Thursday.
  const firstMonday=year=>monday(day(year+'-01-04'));
  const firstFullWeek=monday(minDay)<minDay?monday(minDay)+7:monday(minDay);
  const lastFullWeek=monday(maxDay-6);
  function weekCode(start){const isoYear=new Date((start+3)*dayMs).getUTCFullYear();return `${isoYear}-W${String(1+(start-firstMonday(isoYear))/7).padStart(2,'0')}`}
  function weekOf(date){if(!valid(date))throw new RangeError('有効な日付を選んでください。');const start=monday(day(date));if(start<firstFullWeek||start>lastFullWeek)throw new RangeError('月曜日から日曜日までが対象範囲に収まる週を選んでください。');return weekCode(start)}
  function weekRange(week){const m=typeof week==='string'&&/^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(week);if(!m||+m[1]<1900)throw new RangeError('有効なISO週を選んでください。');const start=firstMonday(m[1])+(+m[2]-1)*7;if(start<firstFullWeek||start>lastFullWeek||weekCode(start)!==week)throw new RangeError('存在しない週、または対象範囲外の週です。');return [stamp(start),stamp(start+6)]}
  function shiftWeek(week,delta){if(!Number.isSafeInteger(delta))throw new RangeError('週数が不正です。');const start=day(weekRange(week)[0])+delta*7;return start<firstFullWeek||start>lastFullWeek?null:weekCode(start)}
  const weekLimits=Object.freeze({min:weekCode(firstFullWeek),max:weekCode(lastFullWeek),minDate:stamp(firstFullWeek),maxDate:stamp(lastFullWeek+6)});
  function bounds(kind, month, today, rows, pick={}){
    if(kind==='picked-month')return monthRange(pick.month);
    if(kind==='week')return weekRange(pick.week);
    if(kind==='90')return [stamp(Math.max(minDay,day(today)-89)),today];
    if(kind==='year')return [today.slice(0,4)+'-01-01',today];
    if(kind==='all'&&rows.length){let first=rows[0].date,last=first;for(const r of rows){if(r.date<first)first=r.date;if(r.date>last)last=r.date}return [first,last]}
    return monthRange(month);
  }
  function aggregate(rows,a,b,category='',type='expense'){
    if(!valid(a)||!valid(b)||a>b)throw Error('正しい開始日・終了日を指定してください。');
    if(type!=='income'&&type!=='expense')throw Error('収入または支出を指定してください。');
    const days=day(b)-day(a)+1,cut=day(a)-days,prevA=stamp(Math.max(day('0001-01-01'),cut)),prevB=stamp(day(a)-1);
    const period=[],expenses=[],focusRows=[],daily=new Map(),merchants=new Map();let total=0,prev=0,prevCount=0,income=0,max=0;
    for(const r of rows){const within=r.date>=a&&r.date<=b;if(within)period.push(r);
      if((r.type!=='expense'&&r.type!=='income')||(category&&r.category!==category))continue;
      if(!within){if(r.type===type&&r.date>=prevA&&r.date<=prevB){prev+=r.amount;prevCount++}continue}
      const d=daily.get(r.date)||{spend:0,income:0,n:0};if(r.type==='income'){d.income+=r.amount;income+=r.amount}else{d.spend+=r.amount;expenses.push(r)}if(r.type===type)d.n++;daily.set(r.date,d);
      if(r.type!==type)continue;focusRows.push(r);total+=r.amount;max=Math.max(max,r.amount);
      const k=r.title.normalize('NFKC').trim().toLocaleLowerCase('ja');const m=merchants.get(k)||{title:r.title,total:0,count:0,months:new Set(),rows:[]};m.total+=r.amount;m.count++;m.months.add(r.date.slice(0,7));m.rows.push(r);merchants.set(k,m)
    }
    return {period,expenses,focusRows,days,total,income,max,prev,prevCount,prevA,prevB,daily,merchants:[...merchants.values()].sort((x,y)=>y.total-x.total||x.title.localeCompare(y.title,'ja'))}
  }
  function series(daily,a,b){const start=day(a),end=day(b),n=end-start+1,bins=[];let label='日別';if(n<=35||n<=180){const step=n<=35?1:7;label=step===1?'日別':'7日ごと';for(let i=start;i<=end;i+=step)bins.push({a:stamp(i),b:stamp(Math.min(end,i+step-1)),spend:0,income:0})}else{const years=(+b.slice(0,4))-(+a.slice(0,4))+1;const byYears=years>3,ys=Math.max(1,Math.ceil(years/36));label=byYears?(ys===1?'年別':ys+'年ごと'):'月別';for(let i=start;i<=end;){const date=stamp(i),y=+date.slice(0,4),m=+date.slice(5,7);const next=Math.floor(Date.UTC(y+(byYears?ys:0),byYears?0:m,1)/dayMs);bins.push({a:date,b:stamp(Math.min(end,next-1)),spend:0,income:0});i=next}}
    let i=0;for(const [date,d] of [...daily].sort((a,b)=>a[0].localeCompare(b[0]))){while(i<bins.length&&date>bins[i].b)i++;if(i<bins.length&&date>=bins[i].a){bins[i].spend+=d.spend;bins[i].income+=d.income}}
    return {label,bins}
  }
  function goals(list){if(!Array.isArray(list)||list.length>100)throw Error('目標のリストが不正です。');const ids=new Set();return list.map(g=>{if(!g||typeof g.id!=='string'||!g.id||g.id.length>512||ids.has(g.id)||typeof g.title!=='string'||!g.title.trim()||g.title.length>100||!Number.isSafeInteger(g.target)||g.target<=0||!Number.isSafeInteger(g.saved)||g.saved<0)throw Error('貯蓄目標の内容に不正な値があります。');ids.add(g.id);return {id:g.id,title:g.title.trim(),target:g.target,saved:g.saved}})}
  const api={day,stamp,valid,validMonth,endMonth,monthRange,weekOf,weekRange,shiftWeek,weekLimits,bounds,aggregate,series,goals};if(typeof module==='object'&&module.exports)module.exports=api;else window.TallyReportCore=api;
})();