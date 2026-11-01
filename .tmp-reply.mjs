import fs from 'node:fs'; import p from 'node:path'; import os from 'node:os';
const root=p.join(os.homedir(),'.claude','projects');
// 「回复」的定义：问句之后，出现了新的真人消息
// 但要看：多久算回复？怎样算同一个问题被回复？
let files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(e.name.endsWith('.jsonl')&&!f.includes('subagents'))files.push(f)}})(root);
const SYS=/^(task-notification|local-command|ide_opened_file|caveat|<)|This session is being continued/;

// 统计：问句之后多久出现真人回复
const deltas=[];
for(const f of files){
  const recs=fs.readFileSync(f,'utf8').split('\n').filter(Boolean)
    .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  for(let i=0;i<recs.length;i++){
    const r=recs[i];
    if(r.type!=='assistant'||!r.message)continue;
    const txt=Array.isArray(r.message.content)?r.message.content.filter(x=>x.type==='text').map(x=>x.text||'').join(''):'';
    if(!/[？?]/.test(txt.slice(-40)))continue;
    const qts=Date.parse(r.timestamp||''); if(!Number.isFinite(qts))continue;
    // 往后找第一条真人消息
    for(let k=i+1;k<recs.length;k++){
      const u=recs[k];
      if(u.type!=='user'||!u.message)continue;
      const c=u.message.content;
      const t=(typeof c==='string'?c:(Array.isArray(c)?c.map(x=>x.text||'').join(''):'')).trim();
      if(!t||SYS.test(t)||/<(system-reminder|command-name)/.test(t))continue;
      const uts=Date.parse(u.timestamp||'');
      if(Number.isFinite(uts)) deltas.push((uts-qts)/3600e3);
      break;
    }
  }
}
deltas.sort((a,b)=>a-b);
const q=x=>deltas[Math.floor(deltas.length*x)];
console.log('有真人回复的问句:', deltas.length);
console.log('回复延迟(小时): p10='+q(.1)?.toFixed(2), 'p25='+q(.25)?.toFixed(2), 'p50='+q(.5)?.toFixed(2), 'p75='+q(.75)?.toFixed(1), 'p90='+q(.9)?.toFixed(1));
console.log('<1h:', deltas.filter(x=>x<1).length, '| <24h:', deltas.filter(x=>x<24).length, '| >7d:', deltas.filter(x=>x>168).length);
