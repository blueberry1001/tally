(() => {
  'use strict';
  const categories=Object.freeze({expense:Object.freeze(['食費','日用品','交通','趣味','固定費','その他支出']),income:Object.freeze(['給与','副収入','その他収入']),transfer:Object.freeze(['振替'])});
  const defaults=Object.freeze({'食費':'#e87849','日用品':'#e6b45c','交通':'#6496b0','趣味':'#a293bd','固定費':'#435975','その他支出':'#91ab9c','給与':'#398976','副収入':'#479888','その他収入':'#598c80','振替':'#8191a3'});
  const norm=s=>String(s??'').normalize('NFKC').trim().toLowerCase();
  const categoryTypes=['expense','income'];
  const reserved=new Set([...Object.getOwnPropertyNames(Object.prototype),'prototype',...Object.keys(defaults)].map(norm));
  const unsuitable=/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>&"'`]/u;
  const palette=Object.freeze(['#ba6846','#a66f3f','#a18b43','#56875a','#438d85','#4d819e','#5c729f','#846aa2','#a36e92','#a56776','#627e8b','#848659']);
  function customCategories(raw={expense:[],income:[]}){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==2||!categoryTypes.every(t=>Object.hasOwn(raw,t)))throw Error('追加カテゴリには支出と収入のリストを指定してください。');
    const out={expense:[],income:[]},seen=new Set(reserved);
    for(const t of categoryTypes){const names=raw[t];if(!Array.isArray(names)||names.length>100)throw Error('追加カテゴリは種別ごとに100件までです。');
      for(const value of names){if(typeof value!=='string'||unsuitable.test(value))throw Error('カテゴリ名に使用できない文字が含まれています。');const canonical=value.normalize('NFKC').trim(),key=norm(canonical);
        if(!canonical||canonical.length>32||unsuitable.test(canonical))throw Error('カテゴリ名は使用できる文字で32文字以内にしてください。');if(seen.has(key))throw Error('カテゴリ名が予約名または既存の名前と重複しています。');seen.add(key);out[t].push(canonical)}
    }return out;
  }
  function categoryList(type,custom){const names=customCategories(custom);return Object.hasOwn(categories,type)?[...categories[type],...(names[type]||[])]:[]}
  function defaultColor(name){if(Object.hasOwn(defaults,name))return defaults[name];let hash=2166136261;for(const ch of norm(name))hash=Math.imul(hash^ch.codePointAt(0),16777619);return palette[(hash>>>0)%palette.length]}
  function colors(raw,custom){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('カテゴリ色の形式が不正です。');const registry=customCategories(custom),allowed=new Set([...Object.keys(defaults),...registry.expense,...registry.income]);const out={};for(const [k,v] of Object.entries(raw)){if(!allowed.has(k)||typeof v!=='string'||!/^#[0-9a-f]{6}$/i.test(v))throw Error('カテゴリ名または色が不正です。');out[k]=v.toLowerCase()}return out}
  function rules(raw,custom){if(!Array.isArray(raw)||raw.length>500)throw Error('分類ルールは500件まで登録できます。');const registry=customCategories(custom),allowed=Object.fromEntries(categoryTypes.map(t=>[t,new Set([...categories[t],...registry[t]])]));const seen=new Set();return raw.map(r=>{if(!r||!categoryTypes.includes(r.type)||!allowed[r.type].has(r.category)||typeof r.prefix!=='string'||!norm(r.prefix)||r.prefix.trim().length>150||norm(r.prefix).length>150||/[\u0000]/.test(r.prefix))throw Error('接頭辞・種別・カテゴリを確認してください。');const key=r.type+'|'+norm(r.prefix);if(seen.has(key))throw Error('同じ種別と接頭辞のルールがすでにあります。');seen.add(key);return {prefix:r.prefix.trim(),type:r.type,category:r.category}})}
  function upsertRule(old,r,custom){const entry=rules([r],custom)[0],i=old.findIndex(x=>x.type===entry.type&&norm(x.prefix)===norm(entry.prefix));return rules(i<0?[...old,entry]:old.map((x,j)=>i===j?entry:x),custom)}
  // Compile once per import / entry form. Walk a title once, retaining the most specific match.
  function matcher(raw){const root={income:new Map(),expense:new Map()},leaf=Symbol('match');for(const r of raw){let n=root[r.type];if(!n)continue;for(const ch of norm(r.prefix)){if(!n.has(ch))n.set(ch,new Map());n=n.get(ch)}n.set(leaf,r)}return (type,title)=>{let n=root[type],found=null;if(!n)return null;for(const ch of norm(title)){n=n.get(ch);if(!n)break;found=n.get(leaf)||found}return found}}
  const api=Object.freeze({norm,categories,defaults,customCategories,categoryList,defaultColor,colors,rules,upsertRule,matcher});if(typeof module==='object'&&module.exports)module.exports=api;else window.TallyPrefs=api;
})();