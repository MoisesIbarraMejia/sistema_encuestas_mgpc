/* Real planner/service integration; only Google's street responses are offline fixtures. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const plain=value=>JSON.parse(JSON.stringify(value));
function harness({baselineChunks=1,slowerCandidate=false}={}) {
  const calls=[];
  const window={google:{maps:{routes:{Route:{computeRoutes:async request=>{
    calls.push(request);
    // Centers are north of the street; the router returns the street actually used.
    const points=[request.origin,...request.intermediates.map(stop=>stop.location),request.destination].map(point=>({lat:0,lng:point.lng}));
    const legs=points.slice(1).map((point,index)=>{
      const distanceMeters=Math.abs(point.lng-points[index].lng)*111195.08023;
      return {path:[points[index],point],startLocation:points[index],endLocation:point,distanceMeters,
        durationMillis:distanceMeters/1.4*1000*(slowerCandidate&&calls.length>baselineChunks?10:1)};
    });
    return {routes:[{path:points,legs,distanceMeters:legs.reduce((sum,leg)=>sum+leg.distanceMeters,0),
      durationMillis:legs.reduce((sum,leg)=>sum+leg.durationMillis,0),warnings:[]}]};
  }}}}}};
  for(const file of ['survey-route-optimize.js','survey-route-service.js'])
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),{window});
  return {service:window.MGPCSurveyRouteService,calls};
}
const stop=(key,lng,count=10)=>({key,count,position:{lat:.0003,lng},kind:'block',name:key});

test('real service and optimizer replace the far-block return with a first-pass visit for both priorities',async()=>{
  for(const strategy of ['short','workload']) {
    const {service,calls}=harness();
    const stops=[stop('start',0),stop('far',.003),stop('middle',.001,20)],before=structuredClone(stops);
    const result=plain(await service.compute(stops,{improve:true,strategy}));
    assert.equal(calls.length,2);
    assert.equal(result.optimization.status,'improved');
    assert.deepEqual(result.stops.map(stop=>stop.key),['start','middle','far']);
    assert.ok(result.optimization.baselineDistanceMeters>550&&result.optimization.baselineDistanceMeters<560);
    assert.ok(result.distanceMeters>330&&result.distanceMeters<340);
    assert.ok(result.optimization.savedMeters>220);
    assert.equal(result.stops.reduce((sum,stop)=>sum+stop.count,0),40);
    assert.ok(result.stops.every(stop=>stop.routePosition.lat===0&&stop.position.lat===.0003));
    assert.deepEqual(stops,before);
  }
});

test('a global 41-stop street order remains complete across both baseline and candidate chunks',async()=>{
  const {service,calls}=harness({baselineChunks:2});
  const ordered=Array.from({length:41},(_,index)=>stop(String(index),index*.0002));
  const adverse=[ordered[0],...ordered.slice(1).reverse()];
  const result=plain(await service.compute(adverse,{improve:true}));
  assert.equal(calls.length,4);
  assert.equal(result.optimization.status,'improved');
  assert.deepEqual(result.stops.map(stop=>stop.key),ordered.map(stop=>stop.key));
  assert.equal(result.legs.length,40);
  assert.equal(result.segments.length,2);
  assert.equal(result.stops.reduce((sum,stop)=>sum+stop.count,0),410);
  assert.ok(result.distanceMeters<result.optimization.baselineDistanceMeters*.6);
});

test('a real shorter candidate with a slower street journey keeps the complete baseline',async()=>{
  const {service,calls}=harness({slowerCandidate:true});
  const stops=[stop('start',0),stop('far',.003),stop('middle',.001)];
  const result=plain(await service.compute(stops,{improve:true}));
  assert.equal(calls.length,2);
  assert.equal(result.optimization.status,'unchanged');
  assert.deepEqual(result.stops.map(stop=>stop.key),stops.map(stop=>stop.key));
  assert.equal(result.optimization.savedMeters,0);
  assert.equal(result.distanceMeters,result.optimization.baselineDistanceMeters);
});
