/* Ciudad sintética: retícula de calles de 100 m, un río con dos puentes y calles cortadas. */
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'../../js/');
const win={};
for(const f of ['survey-route-graph.js']) vm.runInNewContext(fs.readFileSync(repo+f,'utf8'),{window:win});
const G=win.MGPCSurveyRouteGraph;

// PRNG
function rng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

// Ciudad: W×H intersecciones, 100 m. Río vertical con 2 puentes + calles cortadas al azar.
function city(seed,W=14,H=10,{river=true,cut=0.12}={}){
  const r=rng(seed), id=(x,y)=>y*W+x, adj=Array.from({length:W*H},()=>[]);
  const riverX=Math.floor(W/2)-1, bridges=new Set([1+Math.floor(r()*2), H-2-Math.floor(r()*2)]);
  const add=(a,b)=>{adj[a].push([b,100]);adj[b].push([a,100]);};
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(x+1<W){const blocked=river&&x===riverX&&!bridges.has(y); if(!blocked&&r()>cut)add(id(x,y),id(x+1,y));}
    if(y+1<H){ if(r()>cut)add(id(x,y),id(x,y+1)); }
  }
  // 1 m de lat ≈ 1/111195°; ancla en CDMX
  const lat0=19.43,lng0=-99.13,mLat=1/111195,mLng=1/(111195*Math.cos(lat0*Math.PI/180));
  const pos=(x,y)=>({lat:lat0+y*100*mLat,lng:lng0+x*100*mLng});
  return {W,H,adj,id,pos};
}
function allPairs(c){const n=c.W*c.H,D=[];for(let s=0;s<n;s++)D.push(G.dijkstra(c.adj,s));return D;}


const trueLen=(order,D,nodes)=>{let s=0;for(let i=1;i<order.length;i++)s+=D[nodes[order[i-1]]][nodes[order[i]]];return s;};
module.exports={G,rng,city,allPairs,trueLen};
