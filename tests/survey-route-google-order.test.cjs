/* compute(): Google traza cada traslado A→B; el orden propio de Google solo se adopta si mejora. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function harness({failNative=false}={}) {
  const calls=[];
  const window={google:{maps:{routes:{Route:{computeRoutes:async request=>{
    calls.push(request);
    if(request.optimizeWaypointOrder&&failNative)throw new Error('INTERNAL');
    const inter=request.intermediates.map(stop=>stop.location);
    const order=inter.map((_,index)=>index);
    if(request.optimizeWaypointOrder)order.sort((a,b)=>inter[a].lng-inter[b].lng);
    const points=[request.origin,...order.map(index=>inter[index]),request.destination].map(point=>({lat:0,lng:point.lng}));
    const legs=points.slice(1).map((point,index)=>{
      const distanceMeters=Math.abs(point.lng-points[index].lng)*111195.08023;
      return {path:[points[index],point],startLocation:points[index],endLocation:point,distanceMeters,durationMillis:distanceMeters/1.4*1000};
    });
    return {routes:[{path:points,legs,distanceMeters:legs.reduce((sum,leg)=>sum+leg.distanceMeters,0),
      durationMillis:legs.reduce((sum,leg)=>sum+leg.durationMillis,0),warnings:[],
      optimizedIntermediateWaypointIndices:request.optimizeWaypointOrder?order:undefined}]};
  }}}}}};
  for(const file of ['survey-route-optimize.js','survey-route-service.js'])
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),{window});
  return {service:window.MGPCSurveyRouteService,calls};
}
const stop=(key,lng,count=10)=>({key,count,position:{lat:.0003,lng},kind:'block',name:key,section:'1'});
const five=()=>[stop('s',0),stop('a',.004),stop('b',.001),stop('c',.003),stop('e',.005)];

test('without optimizeWithGoogle no request asks Google to reorder',async()=>{
  const {service,calls}=harness();
  await service.compute(five(),{improve:true});
  assert.ok(calls.length>=1&&calls.every(call=>call.optimizeWaypointOrder===false));
});

test('with optimizeWithGoogle every stop survives, the origin is fixed and the result is never longer',async()=>{
  const plain=await harness().service.compute(five(),{improve:true});
  const {service,calls}=harness();
  const result=await service.compute(five(),{improve:true,optimizeWithGoogle:true});
  assert.ok(calls.some(call=>call.optimizeWaypointOrder===true));
  assert.equal(result.stops[0].key,'s');
  assert.deepEqual([...result.stops.map(item=>item.key)].sort(),['a','b','c','e','s']);
  assert.equal(result.stops.reduce((sum,item)=>sum+item.count,0),50);
  assert.ok(result.distanceMeters<=plain.distanceMeters+1);
  assert.ok(['improved','unchanged'].includes(result.optimization.nativeStatus));
  assert.equal(result.legs.length,4);
});

test('a failing Google reorder keeps the complete street route and reports it unavailable',async()=>{
  const {service}=harness({failNative:true});
  const result=await service.compute(five(),{improve:true,optimizeWithGoogle:true});
  assert.equal(result.stops.length,5);
  assert.ok(result.distanceMeters>0);
  assert.equal(result.optimization.nativeStatus,'unavailable');
});

test('too few intermediates skip the Google reorder; cancellation is not swallowed',async()=>{
  const {service,calls}=harness();
  await service.compute([stop('s',0),stop('a',.001),stop('b',.002)],{improve:true,optimizeWithGoogle:true});
  assert.ok(calls.every(call=>call.optimizeWaypointOrder===false));
  let current=true;
  const second=harness();
  const original=second.service.compute;
  await assert.rejects(second.service.compute(five(),{improve:true,optimizeWithGoogle:true,isCurrent:()=>{const value=current;current=false;return value;}}),error=>error.name==='AbortError');
  assert.equal(typeof original,'function');
});
