const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const sandbox={};sandbox.window=sandbox;
vm.runInNewContext(fs.readFileSync('js/snapping.js','utf8'),sandbox);
const snap=sandbox.MGPCSnapping;
const geometry={type:'Polygon',coordinates:[[[0,0],[.01,0],[.01,.01],[0,.01],[0,0]]]};
const reference=snap.build([{geometry,source:'manzana'}]);
const plain=value=>JSON.parse(JSON.stringify(value));

test('snapping uses exact nearby reference vertices and projects onto intervening edges',()=>{
  const vertex=snap.nearest([.00001,.00001],reference);
  assert.equal(vertex.kind,'vertex');assert.deepEqual(plain(vertex.coordinate),[0,0]);
  const edge=snap.nearest([.005,.00002],reference);
  assert.equal(edge.kind,'edge');assert.ok(Math.abs(edge.coordinate[0]-.005)<1e-12);assert.equal(edge.coordinate[1],0);
  assert.equal(edge.source,'manzana');assert.ok(edge.distance>2&&edge.distance<2.3);
});
test('snapping respects both the chosen meter tolerance and the visual distance at each zoom',()=>{
  assert.equal(snap.nearest([.005,.00006],reference,{meters:5}),null);
  assert.equal(snap.nearest([.005,.00002],reference,{meters:1}),null);
  assert.ok(snap.nearest([.005,.00002],reference,{meters:3}));
  assert.equal(snap.nearest([.005,.00001],reference,{meters:5,pixels:12,zoom:23}),null);
  assert.equal(snap.nearest([NaN,0],reference),null);
  assert.equal(snap.nearest([0,0],snap.build([])),null);
});
test('reference indexing keeps separate parts and holes without bridging rings',()=>{
  const hole=[[.003,.003],[.003,.004],[.004,.004],[.004,.003],[.003,.003]];
  const multi={type:'MultiPolygon',coordinates:[[geometry.coordinates[0],hole],[[[1,1],[2,1],[2,2],[1,1]]]]};
  const before=JSON.stringify(multi),index=snap.build([{geometry:multi,source:'sección'}]);
  assert.equal(index.vertices.length,11);assert.equal(index.segments.length,11);
  assert.ok(snap.nearest([.0035,.00301],index));
  assert.equal(snap.nearest([.5,.5],index),null);
  assert.equal(JSON.stringify(multi),before);
});
test('moving the first vertex preserves ring closure, calls validation and never mutates its input',()=>{
  const before=JSON.stringify(geometry);let validated=false;
  const result=snap.applyVertex(geometry,{polygonIndex:0,ringIndex:0,index:0},[-.00001,-.00001],()=>{validated=true});
  assert.equal(validated,true);assert.deepEqual(plain(result.coordinates[0][0]),[-.00001,-.00001]);
  assert.deepEqual(plain(result.coordinates[0].at(-1)),[-.00001,-.00001]);
  assert.equal(JSON.stringify(geometry),before);
});
test('snapping refuses collapsed neighboring vertices and propagates topology validation failures',()=>{
  const target={polygonIndex:0,ringIndex:0,index:0};
  assert.throws(()=>snap.applyVertex(geometry,target,[.01,0],()=>{}),/consecutivos/);
  assert.throws(()=>snap.applyVertex(geometry,target,[0,.01],()=>{}),/consecutivos/);
  assert.throws(()=>snap.applyVertex(geometry,target,[.006,.009],()=>{throw new Error('Cruce detectado')}),/Cruce/);
  assert.deepEqual(geometry.coordinates[0][0],[0,0]);
});
