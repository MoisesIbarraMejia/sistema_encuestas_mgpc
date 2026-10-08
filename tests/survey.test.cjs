const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const original={type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,2],[0,0]]]};
const proposed={type:'Polygon',coordinates:[[[0,0],[1,0],[1,2],[0,2],[0,0]]]};
const affected={type:'Polygon',coordinates:[[[1,0],[2,0],[2,2],[1,2],[1,0]]]};
const feature=(geometry=original,properties={})=>({type:'Feature',geometry,properties});
const collection=features=>({type:'FeatureCollection',features});
const initial={district:'5',ut:{key:'02-001',name:'UT de prueba'},caseType:'division'};
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function harness(caseType='division',prepare=true) {
  const elements=new Map(),storage=new Map();
  const element=()=>({value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,checked:false,style:{},children:[],events:{},
    classList:{add(){},remove(){},toggle(){}},appendChild(child){this.children.push(child)},replaceChildren(...children){this.children=children},
    addEventListener(type,fn){this.events[type]=fn},setAttribute(){},remove(){},click(){}});
  const document={currentScript:{src:'http://localhost/mgpc/js/workflow.js'},
    getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},
    createElement:element,querySelector:id=>document.getElementById(id),body:element()};
  const mockMap={clearDownstream(){},clearAll(){},disableEditing(){},loadOriginalUT(){},restoreEditedGeometry(){},showAffected(){},showManzanasResult(){},showSeccionesResult(){},showLocalidadResult(){}};
  const sandbox={document,mockMap,URL,Blob,setTimeout,clearTimeout,console,
    location:{href:'http://localhost/mgpc/encuestas.html',replace(){}},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    addEventListener(){},dispatchEvent(){},CustomEvent:class {},
    turf:{feature},
    Api:{getUTByCve:async key=>collection([feature(original,{cve_ut:key})]),cacheStore:async()=>({cache_id:'cache'}),
      manzanasAfectadas:async()=>collection([feature(original,{ln:200})]),
      seccionesAfectadas:async()=>collection([feature(original,{ln:200})]),
      localidadesAfectadas:async()=>collection([feature({type:'Point',coordinates:[1,1]},{ln:50})])},
    Diff:{isUnchanged:(a,b)=>JSON.stringify(a)===JSON.stringify(b),computeAffectedGeometry:()=>({affected:feature(affected)}),computeOverlapPercentage:()=>50}
  };
  sandbox.window=sandbox;
  const context=vm.createContext(sandbox);
  for(const file of ['config.js','workflow.js','sampling.js','modeloEncuesta.js','app.js'])vm.runInContext(fs.readFileSync('js/'+file,'utf8'),context,{filename:file});
  const run=code=>vm.runInContext(code,context);
  run('mapManager=mockMap; populateParamInputs();');
  const app=context.MGPCWorkflow;
  const selected={...initial,caseType};app.setContext(selected);
  if(prepare)app.saveDraft({...selected,geometries:{original,proposed:caseType==='nomenclatura'?original:proposed,affected},
    relatedUTs:caseType==='fusion'?[{key:'02-002'}]:[],sectionChanges:caseType==='inc_exc_secciones'?[{key:'100',action:'include'}]:[]});
  return {context,run,app,elements,document,storage};
}

test('Sampling exports its validation and prevents NaN, invalid proportions and n greater than N',()=>{
  const h=harness();
  assert.equal(h.run('typeof Sampling.validateParams'),'function');
  for(const patch of ['{d:0}','{p:-.5}','{p:.8}','{Z:0}','{censusThreshold:1.5}'])assert.throws(()=>h.run('Sampling.computeSampleSize(200,{...CONFIG.SAMPLING,...'+patch+'})'));
  assert.throws(()=>h.run('Sampling.computeSampleSize(NaN)'));
  assert.throws(()=>h.run('Sampling.computeSampleSize(-1)'));
  assert.equal(h.run('Sampling.computeSampleSize(100).n'),100);
  assert.equal(h.run('Sampling.computeSampleSize(0).method'),'sin_poblacion');
  assert.ok(h.run('Sampling.computeSampleSize(200).n')<=200);
});

test('each case analyzes its required territory after preparing limits',async()=>{
  for(const caseType of ['division','fusion','nomenclatura','inc_exc_secciones','inc_exc_manzanas']){
    const h=harness(caseType);await h.run('loadContext()');
    const target=h.run('state.affectedFeature.geometry');
    assert.deepEqual(JSON.parse(JSON.stringify(target)),caseType==='division'||caseType==='nomenclatura'?original:caseType==='fusion'?proposed:affected,caseType);
    assert.equal(h.document.getElementById('btn-analizar').disabled,false);
  }
});

test('nomenclature creates an unchanged draft without opening the editor',async()=>{
  const h=harness('nomenclatura',false);await h.run('loadContext()');
  const draft=h.app.getDraft();assert.deepEqual(draft.geometries.original,draft.geometries.proposed);
  assert.ok(draft.preparedAt);assert.equal(h.document.getElementById('btn-analizar').disabled,false);
});

test('a failed data load clears the previous result and enables retry',async()=>{
  const h=harness();await h.run('loadContext()');await h.run('analizar()');assert.equal(h.app.hasSurvey(),true);
  h.context.Api.getUTByCve=async()=>{throw new Error('Servidor no disponible')};
  await h.run('loadContext()');
  assert.equal(h.run('state.selectedUT'),null);assert.equal(h.app.hasSurvey(),false);
  assert.equal(h.document.getElementById('btn-survey-retry').hidden,false);
  assert.match(h.document.getElementById('analizar-status').textContent,/Servidor no disponible/);
});

test('an earlier UT response cannot overwrite a later selection',async()=>{
  const h=harness('nomenclatura',false),slow=deferred();
  h.context.Api.getUTByCve=key=>key==='02-001'?slow.promise:Promise.resolve(collection([feature(original,{cve_ut:key})]));
  const previous=h.run('loadContext()');
  h.app.setContext({...initial,caseType:'nomenclatura',ut:{key:'02-002',name:'Segunda UT'}});
  await h.run('loadContext()');slow.resolve(collection([feature(original,{cve_ut:'02-001'})]));await previous;
  assert.equal(h.run('state.selectedUT.properties.cve_ut'),'02-002');
});

test('analysis weights population, saves the exact draft and restores a completed review',async()=>{
  const h=harness();await h.run('loadContext()');await h.run('analizar()');
  const result=h.app.getSurvey();assert.equal(result.N,150);assert.equal(result.draftPreparedAt,h.app.getDraft().preparedAt);
  assert.deepEqual(result.geometries.proposed,h.app.getDraft().geometries.proposed);
  h.app.saveTerritorial({proposal:{status:'saved',id:8}});
  await h.run('loadContext()');
  assert.equal(h.app.getTerritorial().proposal.id,8);assert.equal(h.app.getSurvey().analysisDate,result.analysisDate);
  assert.equal(h.document.getElementById('panel-resultados').hidden,false);
});

test('invalidating in-flight analysis prevents stale intersections and persistence',async()=>{
  const h=harness(),pending=deferred();await h.run('loadContext()');
  h.context.Api.cacheStore=()=>pending.promise;
  let requests=0;h.context.Api.manzanasAfectadas=async()=>{requests++;return collection([])};
  const running=h.run('analizar()');h.run('clearResults()');pending.resolve({cache_id:'old'});await running;
  assert.equal(requests,0);assert.equal(h.app.hasSurvey(),false);assert.equal(h.run('state.ultimoResultado'),null);
});

test('missing nominal population and invalid geometry prevent a false complete sample',async()=>{
  const h=harness();await h.run('loadContext()');
  h.context.Api.manzanasAfectadas=async()=>collection([feature(original,{})]);await h.run('analizar()');
  assert.equal(h.app.hasSurvey(),false);assert.match(h.document.getElementById('analizar-status').textContent,/lista nominal/);
  h.context.Api.manzanasAfectadas=async()=>collection([feature(original,{ln:200})]);
  h.context.Diff.computeOverlapPercentage=()=>null;await h.run('analizar()');
  assert.equal(h.app.hasSurvey(),false);assert.match(h.document.getElementById('analizar-status').textContent,/porcentaje/);
});

test('older Sampling module yields a useful visible error instead of an uncaught TypeError',async()=>{
  const h=harness();h.run('Sampling.validateParams=undefined');await h.run('initAppMap()');
  assert.equal(h.document.getElementById('btn-analizar').disabled,true);
  assert.match(h.document.getElementById('analizar-status').textContent,/versión actual/);
});
