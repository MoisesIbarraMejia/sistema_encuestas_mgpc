/* Uso: node tests/bench/route-network.bench.cjs <plan-anterior.js>
 * <plan-anterior.js> = js/survey-route-plan.js de una versión previa (p. ej. `git show HEAD:js/survey-route-plan.js`).
 * Mide la longitud REAL por calles de la ruta que produce cada planificador en una ciudad sintética. */
const fs=require('fs'),vm=require('vm'),path=require('path');
const {G,rng,city,allPairs,trueLen}=require('./city-lib.cjs');
const load=f=>{const w={};vm.runInNewContext(fs.readFileSync(f,'utf8'),{window:w});return w;};
const OLD=load(process.argv[2]||path.join(__dirname,'../../js/survey-route-plan.js')).MGPCSurveyRoutePlan;
const w={};for(const f of ['survey-route-graph.js','survey-route-plan.js'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../js',f),'utf8'),{window:w});
const NEW=w.MGPCSurveyRoutePlan, GG=w.MGPCSurveyRouteGraph;
for(const [label,opts] of [['con río',{river:true}],['sin río',{river:false}]]){
  const acc={old:[],new:[],measured:[],full:[]};let valid=0;
  for(let seed=1;seed<=60;seed++){
    const c=city(seed,14,10,opts),D=allPairs(c),r=rng(seed*7+3);
    const n=18+Math.floor(r()*30),nodes=[],seen=new Set();
    while(nodes.length<n){const v=Math.floor(r()*c.W*c.H);if(!seen.has(v)){seen.add(v);nodes.push(v);}}
    if(nodes.some(v=>!Number.isFinite(D[nodes[0]][v])))continue;valid++;
    const pts=nodes.map(v=>c.pos(v%c.W,Math.floor(v/c.W)));
    const rows=pts.map((p,i)=>({key:'k'+i,count:1,position:p}));
    const ord=pl=>pl.stops.map(s=>Number(s.key.slice(1)));
    acc.old.push(trueLen(ord(OLD.plan(rows,{startKey:'k0'})),D,nodes));
    acc.new.push(trueLen(ord(NEW.plan(rows,{startKey:'k0'})),D,nodes));
    // rows se ordenan por clave dentro de plan(); measured usa índices de ESE orden
    const sorted=[...rows].sort((a,b)=>a.key<b.key?-1:1), idx=sorted.map(r=>Number(r.key.slice(1)));
    const measured=GG.neighborPairs(sorted.map(r=>r.position),{k:5}).map(([a,b])=>({a,b,meters:D[nodes[idx[a]]][nodes[idx[b]]]}));
    acc.measured.push(trueLen(ord(NEW.plan(rows,{startKey:'k0',measured})),D,nodes));
    const full=[];for(let a=0;a<n;a++)for(let b=a+1;b<n;b++)full.push({a,b,meters:D[nodes[idx[a]]][nodes[idx[b]]]});
    acc.full.push(trueLen(ord(NEW.plan(rows,{startKey:'k0',measured:full})),D,nodes));
  }
  const m=a=>a.reduce((x,y)=>x+y,0)/a.length,b=m(acc.old);
  console.log(`\n${label} · ${valid} instancias (inicio fijo)`);
  for(const [k,t] of [['actual (HEAD)','old'],['nuevo: MST+Or-opt, recta','new'],['nuevo + aristas medidas (k=5)','measured'],['nuevo + matriz completa','full']])
    console.log(t==='old'?'':'',t,k.padEnd(34),(m(acc[t])/1000).toFixed(2)+' km',((m(acc[t])/b-1)*100).toFixed(1)+' %');
}
