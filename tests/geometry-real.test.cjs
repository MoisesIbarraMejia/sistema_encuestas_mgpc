const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bundle = process.env.TURF_TEST_BUNDLE || path.resolve('.test-output/turf.min.js');
const available = fs.existsSync(bundle);
test('Turf 6 real: unión, recorte y área afectada conservan todas las partes', {skip:available ? false : 'Descargar Turf 6.5.0 en .test-output/turf.min.js o definir TURF_TEST_BUNDLE'}, () => {
  const turf = require(bundle);
  const sandbox = {turf};
  vm.runInNewContext(fs.readFileSync('js/diff.js','utf8')+'\nglobalThis.diff=Diff;',sandbox);
  const original=turf.bboxPolygon([-99.15,19.40,-99.14,19.41]);
  const shifted=turf.bboxPolygon([-99.145,19.40,-99.135,19.41]);
  const {affected,added,removed}=sandbox.diff.computeAffectedGeometry(original,shifted);
  assert.ok(turf.area(added)>0 && turf.area(removed)>0);
  assert.ok(Math.abs(turf.area(affected)-turf.area(added)-turf.area(removed))<0.1);
  assert.ok(Math.abs(sandbox.diff.computeOverlapPercentage(original,shifted)-50)<0.01);
  assert.equal(sandbox.diff.isUnchanged(original,original),true);
  assert.equal(sandbox.diff.isUnchanged(original,shifted),false);
  const union=turf.union(original,shifted);
  assert.ok(turf.area(union)>turf.area(original));
  const disjoint=turf.bboxPolygon([-99.12,19.4,-99.11,19.41]);
  const multiple=sandbox.diff.toFeature(turf.featureCollection([original,disjoint]));
  assert.equal(multiple.geometry.type,'MultiPolygon');
  assert.ok(Math.abs(turf.area(multiple)-turf.area(original)-turf.area(disjoint))<0.1);
});

test('real neighboring boundaries merge without degenerate rings or mutating original coordinates',{skip:!available},()=>{
  const turf=require(bundle),sandbox={turf};sandbox.window=sandbox;
  vm.runInNewContext(fs.readFileSync('js/proposal-choices.js','utf8'),sandbox);
  vm.runInNewContext(fs.readFileSync('js/diff.js','utf8')+'\nglobalThis.diff=Diff;',sandbox);
  // Read-only fixture: official limits 05-031 and 05-032, fetched 2026-10-02.
  // Turf 6 union on the raw floating-point boundaries produced a short ring.
  const input=JSON.parse(fs.readFileSync('tests/fixtures/adjacent-boundaries.json','utf8'));
  const before=JSON.stringify(input);
  const proposed=sandbox.ProposalChoices.merge(input.original,[{geometry:input.neighbor}]);
  sandbox.ProposalChoices.validate(proposed);
  const draft=sandbox.ProposalChoices.prepareDraft({district:'4',ut:{key:'05-031'},caseType:'fusion'},input.original,proposed,{relatedUTs:[{key:'05-032'}]});
  assert.ok(turf.area(turf.feature(proposed))>turf.area(turf.feature(input.original)));
  assert.ok(sandbox.diff.computeAffectedGeometry(input.original,proposed).affected);
  assert.equal(draft.relatedUTs.length,1);
  assert.equal(JSON.stringify(input),before);
});

test('section composition removes only the chosen zone and rejects an empty UT or crossed limits',{skip:!available},()=>{
  const turf=require(bundle),sandbox={turf};sandbox.window=sandbox;
  vm.runInNewContext(fs.readFileSync('js/proposal-choices.js','utf8'),sandbox);
  const original=turf.bboxPolygon([0,0,2,2]);
  const half=turf.bboxPolygon([0,0,1,2]);
  const outside=turf.bboxPolygon([2,0,3,2]);
  const proposed=sandbox.ProposalChoices.sections(original.geometry,[{action:'exclude',feature:half},{action:'include',feature:outside}]);
  assert.ok(turf.booleanPointInPolygon([.5,1],turf.feature(proposed))===false);
  assert.ok(turf.booleanPointInPolygon([2.5,1],turf.feature(proposed)));
  assert.throws(()=>sandbox.ProposalChoices.sections(original.geometry,[{action:'exclude',feature:original}]),/toda la UT/);
  assert.throws(()=>sandbox.ProposalChoices.validate({type:'Polygon',coordinates:[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}),/cruzadas/);
  assert.throws(()=>sandbox.ProposalChoices.prepareDraft({caseType:'division',ut:{key:'05-031'}},original.geometry,original.geometry),/mismos límites/);
});

test('reported fusions 13-058/13-030 and 07-046/07-301 retain their holes and can proceed to sampling',{skip:!available},()=>{
  const turf=require(bundle),sandbox={turf};sandbox.window=sandbox;
  vm.runInNewContext(fs.readFileSync('js/proposal-choices.js','utf8'),sandbox);
  vm.runInNewContext(fs.readFileSync('js/diff.js','utf8')+'\nglobalThis.diff=Diff;',sandbox);
  // Official limits fetched read-only on 2026-10-05. The old whole-Polygon
  // kinks check rejected point contacts between the exterior and interior rings.
  const cases=JSON.parse(fs.readFileSync('tests/fixtures/fusion-boundary-contacts.json','utf8'));
  for (const input of cases) {
    const before=JSON.stringify(input);
    const rawUnion=turf.union(turf.truncate(turf.feature(input.original),{precision:10}),turf.truncate(turf.feature(input.neighbor),{precision:10}));
    assert.ok(turf.kinks(rawUnion).features.length>0,'reproduces the reported validation failure');
    const relatedUTs=[{key:input.neighborKey,geometry:input.neighbor}];
    const proposed=sandbox.ProposalChoices.merge(input.original,relatedUTs,input.originalKey);
    assert.deepEqual(JSON.parse(JSON.stringify(proposed)),rawUnion.geometry,'validation must not move boundaries or remove interior rings');
    const draft=sandbox.ProposalChoices.prepareDraft({district:input.district,ut:{key:input.originalKey},caseType:'fusion'},input.original,proposed,{relatedUTs});
    assert.equal(draft.relatedUTs[0].key,input.neighborKey);
    const analysis=sandbox.diff.computeAffectedGeometry(input.original,draft.geometries.proposed);
    assert.ok(analysis.affected && turf.area(analysis.affected)>0);
    assert.ok(turf.area(turf.feature(draft.geometries.proposed))>turf.area(turf.feature(input.original)));
    assert.equal(JSON.stringify(input),before);
  }
});
