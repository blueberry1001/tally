// Node.js: rebuild the standalone, network-independent app from its editable sources.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,f),'utf8');
// Keep the offline Help tab and the distributed Japanese guide in sync.
const guide=[];for(const line of read('使い方.txt').split(/\r?\n/)){const h=/^【(.+)】$/.exec(line);if(h)guide.push({title:h[1],lines:[]});else if(line.trim()&&guide.length)guide[guide.length-1].lines.push(line.trim())}
if(!guide.length)throw Error('No guide sections found.');fs.writeFileSync(path.join(__dirname,'guide-data.js'),'window.TallyGuide='+JSON.stringify(guide)+';\n','utf8');
let doc=read('shell.html');
doc=doc.replace(/<link rel="stylesheet" href="([\w.-]+\.css)">/g,(_,f)=>`<style>\n${read(f)}\n</style>`);
doc=doc.replace(/<script src="([\w.-]+\.js)"><\/script>/g,(_,f)=>`<script>\n${read(f).replace(/<\/script/gi,'<\\/script')}\n</script>`);
fs.writeFileSync(path.join(__dirname,'index.html'),doc,'utf8');
// GitHub Pages publishes main:/docs only. No user data or server files are copied.
const site=path.join(__dirname,'docs');fs.mkdirSync(site,{recursive:true});fs.writeFileSync(path.join(site,'index.html'),doc,'utf8');
console.log('Built standalone and Pages HTML ('+Buffer.byteLength(doc)+' bytes each)');