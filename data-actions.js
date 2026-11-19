/* Action cards for the four data operations; no nested controls or dynamic HTML. */
(() => {
  'use strict';
  const svgNS='http://www.w3.org/2000/svg';
  const glyphs=Object.freeze({
    IMPORT:['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z','M14 3v5h5','M12 11v7m-3-3 3 3 3-3'],
    EXPORT:['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z','M14 3v5h5','M12 18v-7m-3 3 3-3 3 3'],
    BACKUP:['M4 8h16v12H4z','M3 4h18v4H3z','M9 12h6','M10 15h4'],
    RESTORE:['M3.5 10a8.5 8.5 0 1 1 .7 7','M3 5v5h5','M12 7v5l3 2'],
    arrow:['M4 12h15m-5-5 5 5-5 5']
  });
  function icon(which,cls){
    const node=document.createElementNS(svgNS,'svg');node.setAttribute('viewBox','0 0 24 24');node.setAttribute('fill','none');node.setAttribute('stroke','currentColor');node.setAttribute('stroke-width','1.65');node.setAttribute('stroke-linecap','round');node.setAttribute('stroke-linejoin','round');node.setAttribute('aria-hidden','true');node.setAttribute('focusable','false');node.setAttribute('class',cls);
    for(const d of glyphs[which]){const p=document.createElementNS(svgNS,'path');p.setAttribute('d',d);node.append(p)}return node;
  }
  function card(tag,title,action,opts={}){
    const key=String(tag).toUpperCase();if(!['IMPORT','EXPORT','BACKUP','RESTORE'].includes(key))throw new TypeError('Unknown data action');
    const button=document.createElement('button');button.type='button';button.className='tally-action-card';button.dataset.dataAction=key.toLowerCase();button.dataset.actionTag=key;
    const badge=document.createElement('span');badge.className='tally-action-icon';badge.append(icon(key,'tally-action-glyph'));
    const name=document.createElement('span');name.className='tally-action-name';name.textContent=title;
    button.append(badge,name,icon('arrow','tally-action-arrow'));button.disabled=!!opts.disabled || typeof action!=='function';
    if(button.disabled&&opts.disabledReason){button.title=String(opts.disabledReason);button.setAttribute('aria-description',String(opts.disabledReason))}
    if(typeof action==='function')button.addEventListener('click',event=>{if(!button.disabled)action(event)});
    return button;
  }
  window.TallyDataActions=Object.freeze({card});
})();
