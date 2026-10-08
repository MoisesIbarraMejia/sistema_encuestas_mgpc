/* Offline topology regression tests. Run: node --test --test-isolation=none tests/topology.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname,'..');
const bundle = process.env.TURF_TEST_BUNDLE || path.join(root,'.test-output/turf.min.js');
const available = fs.existsSync(bundle);
const options = {skip:available ? false : 'Turf 6.5.0 local requerido: .test-output/turf.min.js o TURF_TEST_BUNDLE'};
function api() {
  const sandbox = {turf:require(bundle)};
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root,'js/proposal-choices.js'),'utf8'),sandbox);
  return sandbox.ProposalChoices;
}
function ring(x1,y1,x2,y2) {return [[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]];}
function polygon(...rings) {return {type:'Polygon',coordinates:rings};}
function multiple(...polygons) {return {type:'MultiPolygon',coordinates:polygons.map(p=>p.coordinates)};}

test('snapped consecutive duplicates fail, closure and redundant collinear points remain valid',options,()=>{
  const validator = api();
  const valid = polygon([[0,0],[1,0],[2,0],[2,2],[0,2],[0,0]]);
  assert.equal(validator.validate(valid),valid);
  const duplicate = polygon([[0,0],[1,0],[1,0],[2,0],[2,2],[0,2],[0,0]]);
  const before = JSON.stringify(duplicate);
  assert.throws(()=>validator.validate(duplicate),/dos puntos seguidos/i);
  assert.equal(JSON.stringify(duplicate),before);
  assert.throws(()=>validator.validate(polygon([[0,0],[0,0],[2,0],[2,2],[0,0]])),/dos puntos seguidos/i);
});

test('holes must be inside their exterior and may not overlap or nest each other',options,()=>{
  const validator = api();
  const valid = polygon(ring(0,0,10,10),ring(1,1,2,2),ring(5,5,6,6));
  assert.equal(validator.validate(valid),valid);
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),ring(11,11,12,12))),/interior salió/i);
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),ring(9,9,11,11))),/cruzadas|interior salió/i);
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),ring(2,2,5,5),ring(4,4,6,6))),/cruzadas|superponen/i);
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),ring(2,2,8,8),ring(3,3,4,4))),/superponen/i);
});

test('concave exterior rejects a hole whose vertices fit but an edge crosses the exterior',options,()=>{
  const validator=api();
  const exterior=[[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6],[0,0]];
  const crossing=[[1,1],[5,1],[5,5],[1,5],[1,1]];
  assert.throws(()=>validator.validate(polygon(exterior,crossing)),/cruzadas|interior salió/i);
});

test('MultiPolygon rejects positive-area overlap while allowing edge and point contact',options,()=>{
  const validator=api();
  const first=polygon(ring(0,0,2,2));
  assert.throws(()=>validator.validate(multiple(first,polygon(ring(1,1,3,3)))),/partes.*superponen/i);
  assert.throws(()=>validator.validate(multiple(first,first)),/partes.*superponen/i);
  for (const other of [polygon(ring(2,0,4,2)),polygon(ring(2,2,4,4)),polygon(ring(5,5,6,6))]) {
    const candidate=multiple(first,other);
    assert.equal(validator.validate(candidate),candidate);
  }
});

test('a separate part may lie in another part’s hole without overlapping filled area',options,()=>{
  const validator=api();
  const island=multiple(polygon(ring(0,0,10,10),ring(2,2,8,8)),polygon(ring(3,3,4,4)));
  const before=JSON.stringify(island);
  assert.equal(validator.validate(island),island);
  assert.equal(JSON.stringify(island),before);
});

test('official 05-031 and its union with 05-032 validate without changing original coordinates',options,()=>{
  const validator=api();
  const input=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/adjacent-boundaries.json'),'utf8'));
  const before=JSON.stringify(input);
  assert.equal(validator.validate(input.original),input.original);
  assert.equal(validator.validate(input.neighbor),input.neighbor);
  const merged=validator.merge(input.original,[{geometry:input.neighbor}]);
  assert.equal(validator.validate(merged),merged);
  assert.equal(JSON.stringify(input),before);
});

test('fusion preserves an interior boundary touching the exterior at one point without reporting a crossing',options,()=>{
  const validator=api(),turf=require(bundle);
  const first=polygon([[0,0],[10,0],[10,5],[4,5],[2,3],[0,5],[0,0]]);
  const second=polygon([[0,5],[2,7],[4,5],[10,5],[10,10],[0,10],[0,5]]);
  const before=JSON.stringify([first,second]);
  const merged=validator.merge(first,[{key:'05-002',geometry:second}],'05-001');
  assert.equal(merged.type,'Polygon');
  assert.equal(merged.coordinates.length,2,'the interior boundary must not be removed to bypass validation');
  assert.ok(turf.kinks(turf.feature(merged)).features.length>0,'reproduces the old whole-polygon false positive');
  assert.equal(validator.validate(merged),merged);
  assert.equal(turf.booleanPointInPolygon([2,5],turf.feature(merged)),false,'the enclosed gap remains excluded');
  const expected=turf.area(turf.feature(first))+turf.area(turf.feature(second));
  assert.ok(Math.abs(turf.area(turf.feature(merged))-expected)/expected<1e-10);
  const draft=validator.prepareDraft({district:'5',ut:{key:'05-001'},caseType:'fusion'},first,merged,{relatedUTs:[{key:'05-002'}]});
  assert.deepEqual(JSON.parse(JSON.stringify(draft.geometries.proposed)),merged);
  assert.equal(JSON.stringify([first,second]),before);
});

test('ring contacts cannot admit shared edges or disconnect the interior',options,()=>{
  const validator=api();
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),ring(0,2,2,4))),/comparten un tramo/);
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),ring(2,2,4,4),ring(4,2,6,4))),/comparten un tramo/);
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),[[0,5],[5,8],[10,5],[5,2],[0,5]])),/partes desconectadas/);
  // A chain of holes can disconnect a zone even with only one contact per pair.
  const hole1=[[0,5],[2.5,7],[5,5],[2.5,3],[0,5]];
  const hole2=[[5,5],[7.5,7],[10,5],[7.5,3],[5,5]];
  assert.throws(()=>validator.validate(polygon(ring(0,0,10,10),hole1,hole2)),/partes desconectadas/);
});

test('fusion identifies the faulty source UT and never silently repairs crossed official limits',options,()=>{
  const validator=api();
  const original=polygon(ring(0,0,2,2));
  const crossed=polygon([[2,0],[4,2],[2,2],[4,0],[2,0]]);
  const before=JSON.stringify(crossed);
  assert.throws(()=>validator.merge(original,[{key:'05-002',geometry:crossed}],'05-001'),error=>{
    assert.match(error.message,/05-002.*datos de origen/);
    assert.match(error.message,/líneas cruzadas/);
    assert.doesNotMatch(error.message,/Deshaz/);
    return true;
  });
  assert.equal(JSON.stringify(crossed),before);
  assert.throws(()=>validator.merge(crossed,[{key:'05-002',geometry:original}],'05-001'),/UT principal 05-001.*datos de origen/);
});
