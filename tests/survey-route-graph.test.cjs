/* Red de proximidad, MST y caminos mínimos del orden de visitas. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const load=files=>{const window={};for(const f of files)vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js',f),'utf8'),{window});return window;};
const G=load(['survey-route-graph.js']).MGPCSurveyRouteGraph;
const plain=value=>JSON.parse(JSON.stringify(value));
const M=1/111195;
const at=(east,north)=>({lat:19.43+north*M,lng:-99.13+east*M/Math.cos(19.43*Math.PI/180)});

test('MST of collinear points chains neighbours and bounds any open route from below',()=>{
  const points=[0,100,250,300,800].map(x=>at(x,0));
  const graph=G.create(points);
  assert.ok(Math.abs(graph.mstWeight-800)<1);
  assert.deepEqual(plain([...graph.peripheral].sort()),[0,4]);
  assert.deepEqual(plain(graph.walk(0)),[0,1,2,3,4]);
});

test('tree walk visits every node once and keeps each branch together',()=>{
  const points=[[0,0],[100,0],[200,0],[100,100],[100,200],[300,0]].map(([x,y])=>at(x,y));
  const walk=G.create(points).walk(0);
  assert.equal(new Set(walk).size,points.length);
  assert.equal(walk[0],0);
  const branch=[3,4].map(node=>walk.indexOf(node));
  assert.equal(Math.abs(branch[0]-branch[1]),1);
});

test('measured edges give shortest paths and ignore invalid measurements',()=>{
  const points=[0,100,200].map(x=>at(x,0));
  const graph=G.create(points,{measured:[{a:0,b:1,meters:400},{a:1,b:2,meters:500},{a:0,b:2,meters:Infinity},{a:0,b:9,meters:1},{a:1,b:1,meters:1}]});
  assert.equal(graph.usesMeasured,true);
  assert.equal(graph.distance(0,2),900);
  assert.equal(graph.distance(2,0),900);
  assert.ok(graph.straight(0,2)<210);
});

test('measurements that leave the graph disconnected fall back to straight lines',()=>{
  const points=[0,100,200].map(x=>at(x,0));
  const graph=G.create(points,{measured:[{a:0,b:1,meters:400}]});
  assert.equal(graph.usesMeasured,false);
  assert.ok(graph.distance(0,2)<210);
});

test('neighborPairs is a connected, deduplicated, sorted subset of all pairs',()=>{
  const points=Array.from({length:30},(_,i)=>at((i%6)*100,Math.floor(i/6)*100));
  const pairs=G.neighborPairs(points,{k:3});
  assert.ok(pairs.length<30*29/2/3);
  assert.equal(new Set(pairs.map(([a,b])=>a+':'+b)).size,pairs.length);
  assert.ok(pairs.every(([a,b])=>a<b));
  const graph=G.create(points,{measured:pairs.map(([a,b])=>({a,b,meters:1}))});
  assert.equal(graph.usesMeasured,true);
});

test('invalid or oversized input returns null or no pairs instead of throwing',()=>{
  assert.equal(G.create([]),null);
  assert.equal(G.create([{lat:99,lng:0}]),null);
  assert.equal(G.create(Array.from({length:1501},()=>at(0,0))),null);
  assert.deepEqual(plain(G.neighborPairs([at(0,0)])),[]);
  assert.equal(G.create([at(0,0)]).size,1);
});

test('inputs are not mutated',()=>{
  const points=[at(0,0),at(100,0),at(0,100)],before=JSON.stringify(points);
  G.create(points,{measured:[{a:0,b:1,meters:10},{a:1,b:2,meters:10}]});G.neighborPairs(points);
  assert.equal(JSON.stringify(points),before);
});
