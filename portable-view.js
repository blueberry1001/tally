/* Portable UI preferences are data, never a dump of browser storage. No I/O. */
(() => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const C = node ? require('./insight-core.js') : window.TallyReportCore;
  const P = node ? require('./preferences.js') : window.TallyPrefs;
  const flows = ['expense','income'];
  const homeKinds = ['month','week','30','90','year','all','custom'];
  const presets = ['month','picked-month','week','90','year','all','custom'];
  const views = ['map','calendar','report','heat'];
  function bad(field) { throw new TypeError('表示設定の形式または値が正しくありません：' + field); }

  // Accept JSON objects (also from another realm) and null-prototype records.
  // Never evaluate accessor properties, copy inherited keys, or merge the input.
  function record(raw, required, optional, field) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad(field);
    const proto = Object.getPrototypeOf(raw);
    if (proto !== null && proto !== Object.prototype) {
      const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
      if (Object.getPrototypeOf(proto) !== null || typeof ctor !== 'function' ||
          Function.prototype.toString.call(ctor) !== Function.prototype.toString.call(Object) || ctor.prototype !== proto) bad(field);
    }
    const keys = Reflect.ownKeys(raw);
    if (keys.length < required.length || keys.length > required.length + optional.length) bad(field);
    for (const k of keys) {
      if (!required.includes(k) && !optional.includes(k)) bad(field);
      const desc = Object.getOwnPropertyDescriptor(raw,k);
      if (!desc.enumerable || !Object.hasOwn(desc,'value')) bad(field);
    }
    if (!required.every(k => Object.hasOwn(raw,k))) bad(field);
  }
  function one(value, options, field) { if (!options.includes(value)) bad(field); return value; }
  function month(value, field) { if (!C.validMonth(value)) bad(field); return value; }
  function dates(raw, output, active, field) {
    if (!active) {
      if (Object.hasOwn(raw,'a') || Object.hasOwn(raw,'b')) bad(field);
      return;
    }
    if (!Object.hasOwn(raw,'a') || !Object.hasOwn(raw,'b') || !C.valid(raw.a) || !C.valid(raw.b) || raw.a > raw.b) bad(field);
    output.a = raw.a; output.b = raw.b;
  }
  function validate(raw, customCategories) {
    record(raw,['version','month','trendMonths','home','analysis','mapLayout'],[],'view');
    if (raw.version !== 1) bad('version');
    const sharedMonth = month(raw.month,'month');
    const trendMonths = one(raw.trendMonths,[6,12],'trendMonths');

    const h = raw.home;
    record(h,['kind','type'],['a','b'],'home');
    const home = {kind:one(h.kind,homeKinds,'home.kind'), type:one(h.type,flows,'home.type')};
    dates(h,home,home.kind === 'custom','home.a/b');

    const v = raw.analysis;
    record(v,['type','view','preset','limit','category'],['a','b','month','week','weekDay','cal','heatYear'],'analysis');
    const analysis = {type:one(v.type,flows,'analysis.type'), view:one(v.view,views,'analysis.view'),
      preset:one(v.preset,presets,'analysis.preset'), limit:one(v.limit,[3,5,10],'analysis.limit'), category:v.category};
    const allowed = P.categoryList(analysis.type,customCategories);
    if (analysis.category !== '' && !allowed.includes(analysis.category)) bad('analysis.category');
    dates(v,analysis,analysis.preset === 'custom','analysis.a/b');
    if ((analysis.preset === 'picked-month') !== Object.hasOwn(v,'month')) bad('analysis.month');
    if (analysis.preset === 'picked-month') analysis.month = month(v.month,'analysis.month');
    const week = analysis.preset === 'week';
    if (week !== Object.hasOwn(v,'week') || week !== Object.hasOwn(v,'weekDay')) bad('analysis.week');
    if (week) {
      const [a,b] = C.weekRange(v.week);
      if (!C.valid(v.weekDay) || v.weekDay < a || v.weekDay > b) bad('analysis.weekDay');
      analysis.week = v.week; analysis.weekDay = v.weekDay;
    }
    if (Object.hasOwn(v,'cal')) {
      if (analysis.view !== 'calendar') bad('analysis.cal');
      analysis.cal = month(v.cal,'analysis.cal');
    }
    if (Object.hasOwn(v,'heatYear')) {
      if (analysis.view !== 'heat' || !Number.isInteger(v.heatYear) || v.heatYear < 1900 || v.heatYear > 9999) bad('analysis.heatYear');
      analysis.heatYear = v.heatYear;
    }
    let mapLayout = null;
    if (raw.mapLayout !== null) {
      record(raw.mapLayout,['width','height'],[],'mapLayout');
      const {width,height} = raw.mapLayout;
      if (!Number.isFinite(width) || width <= 0 || width > 1 || !Number.isFinite(height) || height < 160 || height > 960) bad('mapLayout');
      mapLayout = {width,height};
    }
    return {version:1,month:sharedMonth,trendMonths,home,analysis,mapLayout};
  }
  function defaults(sharedMonth) {
    return {version:1,month:month(sharedMonth,'month'),trendMonths:6,home:{kind:'month',type:'expense'},
      analysis:{type:'expense',view:'map',preset:'month',limit:3,category:''},mapLayout:null};
  }
  const api = Object.freeze({validate,defaults});
  if (node) module.exports = api; else window.TallyPortableView = api;
})();
