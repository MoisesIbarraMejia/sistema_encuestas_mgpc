/* Run with: node --test tests/territorial.test.cjs. No external services are used. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function runtime(filename) {
  const elements = new Map();
  function element() {
    return {style:{setProperty(){}},dataset:{},classList:{add(){},remove(){},contains(){return false},toggle(){}},
      addEventListener(){},removeEventListener(){},appendChild(){},append(){},replaceChildren(){},remove(){},click(){},setAttribute(){},setCustomValidity(){},
      textContent:'',innerHTML:'',hidden:false,disabled:false,checked:false};
  }
  const saved = [];
  const context = vm.createContext({
    CONFIG:{API_BASE:'api-proxy_local.php'},console:{error(){},warn(){},log(){}},
    setTimeout(){return 1},clearTimeout(){},URL,URLSearchParams,Blob,
    document:{addEventListener(){},getElementById(id){if(!elements.has(id)) elements.set(id,element());return elements.get(id)},
      querySelectorAll(){return []},querySelector(){return null},createElement:element,body:element()},
    window:{addEventListener(){},location:{href:''}},
    MGPCWorkflow:{requireContext(){return null},renderHeader(){},getContext(){return null},getDraft(){return null},getSurvey(){return null},getTerritorial(){return saved.at(-1) || null},saveTerritorial(value){saved.push(value)},paths:{}},
    turf:{area(){return 1000000}},
    fetch(){throw new Error('Unexpected network request')},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',filename),'utf8'),context);
  return {context,saved,elements,run(code){return vm.runInContext(code,context)}};
}
const square = {type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,2],[0,0]]]};

test('Polygon and MultiPolygon preserve their rings and separate parts', () => {
  const r=runtime('editor-territorial.js');
  const geometry={type:'MultiPolygon',coordinates:[square.coordinates,[[[3,3],[4,3],[4,4],[3,3]],[[3.1,3.1],[3.2,3.1],[3.2,3.2],[3.1,3.1]]]]};
  r.context.input=geometry;
  r.run('editorPoly.original=input; geometryToEditor(input);');
  assert.deepEqual(JSON.parse(r.run('JSON.stringify(editorToGeometry())')),geometry);
  assert.equal(r.run('editorPoly.polygons.length'),2);
  assert.equal(r.run('editorPoly.polygons[1].rings.length'),2);
  // Unclosed input no longer loses its last real vertex during conversion.
  r.context.input={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]};
  r.run('editorPoly.original=input; geometryToEditor(input);');
  assert.equal(r.run('obtenerTotalVertices()'),4);
  assert.equal(r.run('editorToGeometry().coordinates[0].length'),5);
});

test('Rejects incomplete rings and non-finite or out-of-range coordinates', () => {
  const r=runtime('editor-territorial.js');
  r.context.input=square;
  assert.equal(r.run('geometryIsValid(input)'),true);
  for (const coordinates of [[],[[[0,0],[1,1],[0,0]]],[[[0,0],[181,0],[1,1],[0,0]]],[[[0,0],[1,0],[1,1],[9,9]]]]) {
    r.context.input={type:'Polygon',coordinates};
    assert.equal(r.run('geometryIsValid(input)'),false);
  }
});

function reviewRuntime(caseType='division') {
  const r=runtime('territorial.js');
  const context={district:'5',ut:{key:'05-001',name:'UT de prueba'},caseType,caseId:null};
  const draft={...context,preparedAt:'2026-10-01T10:00:00.000Z',newName:'Nombre propuesto',relatedUTs:[],sectionChanges:[],geometries:{original:square,proposed:square,affected:square}};
  const survey={...context,draftPreparedAt:draft.preparedAt,analysisDate:'2026-10-01T10:01:00.000Z',geometries:draft.geometries,N:200,sample:{n:132,method:'muestreo'},params:{d:.05}};
  r.context.MGPCWorkflow.getContext=()=>context;
  r.context.MGPCWorkflow.getDraft=()=>draft;
  r.context.MGPCWorkflow.getSurvey=()=>survey;
  r.run('renderFinalReview()');
  return {...r,bundle:{context,draft,survey}};
}

test('Final review requires user confirmation and never saves a failed request locally', async () => {
  const r=reviewRuntime();
  let calls=0;
  r.context.fetch=async()=>{calls++;return {ok:false,status:503,text:async()=>'{"error":"Unavailable"}'}};
  await r.run('saveFinalReview()');
  assert.equal(calls,0);
  r.elements.get('review-confirm').checked=true;
  await r.run('saveFinalReview()');
  assert.equal(calls,1);
  assert.equal(r.saved.length,0);
  assert.equal(r.run('review.completed'),false);
  assert.match(r.elements.get('review-error').textContent,/Unavailable/);
});

test('Final review saves the prepared geometry with the real history contract only after success', async () => {
  const r=reviewRuntime();
  let request;
  r.context.fetch=async(url,options)=>{request={url,options};return {ok:true,status:201,text:async()=>'{"id":42,"table":"historial_ajustes_ut"}'}};
  r.elements.get('review-confirm').checked=true;
  await r.run('saveFinalReview()');
  const payload=JSON.parse(request.options.body);
  assert.match(request.url,/create%2Fhistorial_ajustes_ut/);
  assert.equal(request.options.method,'POST');
  assert.deepEqual(payload.geometry,square);
  assert.equal(payload.properties.cve_ut,'05-001');
  assert.equal(payload.properties.origen_propuesta,'');
  assert.equal(payload.properties.num_vertices,4);
  assert.equal(r.saved[0].proposal.status,'saved');
  assert.equal(r.saved[0].proposal.serverResponse.id,42);
  assert.equal(r.run('review.completed'),true);
  assert.equal(r.elements.get('btn-save-review').disabled,true);
});

test('Nomenclature finalizes locally without writing geometry or requiring tables', async () => {
  const r=reviewRuntime('nomenclatura');
  let calls=0;r.context.fetch=async()=>{calls++;throw new Error('No API writes expected')};
  r.elements.get('review-confirm').checked=true;
  await r.run('saveFinalReview()');
  assert.equal(calls,0);
  assert.equal(r.saved[0].proposal.status,'confirmed-local');
  assert.equal(r.saved[0].proposal.newName,'Nombre propuesto');
  assert.match(r.elements.get('review-status').textContent,/esta pestaña/);
  assert.equal(r.run('review.completed'),true);
});

test('A stale sample cannot confirm a changed draft', async () => {
  const r=reviewRuntime();
  r.bundle.survey.draftPreparedAt='old-version';
  r.elements.get('review-confirm').checked=true;
  await r.run('saveFinalReview()');
  assert.equal(r.saved.length,0);
  assert.match(r.elements.get('review-error').textContent,/mismo caso/);
});

test('Retry after session storage failure does not repeat the successful remote insert', async () => {
  const r=reviewRuntime();
  let calls=0;
  r.context.fetch=async()=>{calls++;return {ok:true,status:201,text:async()=>'{"id":42}'}};
  r.elements.get('review-confirm').checked=true;
  r.context.MGPCWorkflow.saveTerritorial=()=>{throw new Error('Storage full')};
  await r.run('saveFinalReview()');
  assert.equal(calls,1);assert.equal(r.saved.length,0);
  r.context.MGPCWorkflow.saveTerritorial=value=>r.saved.push(value);
  await r.run('saveFinalReview()');
  assert.equal(calls,1);assert.equal(r.saved.length,1);
});

test('Both stage 2 clients reject HTTP errors, malformed JSON and API-reported failures', async () => {
  for (const file of ['territorial.js','editor-territorial.js']) {
    const r=runtime(file);
    for (const response of [{ok:false,status:403,text:async()=>'{"message":"Sin permiso"}'},
      {ok:true,status:200,text:async()=>'<html>Error</html>'},
      {ok:true,status:200,text:async()=>'{"success":false,"message":"No guardado"}'}]) {
      r.context.response=response;
      await assert.rejects(r.run('readApiResponse(response)'));
    }
  }
});
