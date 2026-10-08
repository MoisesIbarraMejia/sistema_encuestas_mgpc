const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function workflow(storage=new Map(),path='/mgpc/') {
  const location={href:'http://localhost'+path+'territorial.html',replace(value){this.redirect=value;}};
  const notices=[];
  const document={currentScript:{src:'http://localhost'+path+'js/workflow.js'},getElementById:id=>notices.find(item=>item.id===id)||null,createElement:()=>({append(){},setAttribute(){}}),body:{prepend:value=>notices.push(value)}};
  const window={location,sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},addEventListener(){},dispatchEvent(){}};
  const sandbox={window,document,URL,CustomEvent:class{constructor(type){this.type=type;}}};
  vm.runInNewContext(fs.readFileSync('js/workflow.js','utf8'),sandbox);
  return {app:window.MGPCWorkflow,window,storage,notices};
}
const original={type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,0]]]};
const proposed={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]};
const context={district:'5',ut:{key:'02-001',name:'Unidad A',properties:{}},caseType:'division'};
function prepare(app,caseType='division') {
  app.setContext({...context,caseType});
  return app.saveDraft({...context,caseType,geometries:{original,proposed:caseType==='nomenclatura'?original:proposed,affected:original},relatedUTs:caseType==='fusion'?[{claveUT:'02-002'}]:[],sectionChanges:caseType==='inc_exc_secciones'?[{key:'100',action:'include'}]:[]});
}
function result(app) {const draft=app.getDraft();return {...context,caseType:draft.caseType,draftPreparedAt:draft.preparedAt,analysisDate:'2026-10-01T12:00:00Z',N:200,sample:{n:150},geometries:draft.geometries};}

test('acceso directo sigue orden preparar, calcular, revisar',()=>{
  const {app,window}=workflow();assert.equal(app.requireContext('review'),null);assert.equal(window.location.redirect,'index.html');
  app.setContext(context);assert.equal(app.requireContext('survey'),null);assert.equal(window.location.redirect,'editor-territorial.html');
  prepare(app);assert.equal(app.requireContext('survey').ut.key,'02-001');
  assert.equal(app.requireContext('review'),null);assert.equal(window.location.redirect,'encuestas.html');
  app.saveSurvey(result(app));assert.equal(app.requireContext('review').caseType,'division');
});
test('nomenclatura no requiere edición y casos pendientes no comienzan',()=>{
  const {app,window}=workflow();app.setContext({...context,caseType:'nomenclatura'});
  assert.equal(app.requireContext('survey').caseType,'nomenclatura');
  assert.equal(app.requireContext('proposal'),null);assert.equal(window.location.redirect,'encuestas.html');
  assert.throws(()=>app.setContext({...context,caseType:'otros'}),/disponible/);
});
test('una guarda antigua en el editor no recarga indefinidamente la misma página',()=>{
  const {app,window,notices}=workflow();
  app.setContext(context);
  window.location.href='http://localhost/mgpc/editor-territorial.html';
  assert.equal(app.requireContext('territorial'),null);
  assert.equal(window.location.redirect,undefined);
  assert.equal(notices.length,1);
  assert.equal(notices[0].id,'workflow-route-error');
  assert.equal(app.requireContext('proposal').caseType,'division');
});
test('preparación exige modificación, UT extra o selección de secciones según caso',()=>{
  const {app}=workflow();app.setContext(context);
  const draft={...context,geometries:{original,proposed:original}};
  assert.throws(()=>app.saveDraft(draft),/modifica/);
  app.setContext({...context,caseType:'fusion'});assert.throws(()=>app.saveDraft({...draft,caseType:'fusion'}),/otra UT/);
  app.setContext({...context,caseType:'inc_exc_secciones'});assert.throws(()=>app.saveDraft({...draft,caseType:'inc_exc_secciones'}),/sección/);
});
test('navegar y confirmar el mismo borrador conserva muestra y guardado',()=>{
  const {app,storage}=workflow();const draft=prepare(app);app.saveSurvey(result(app));app.saveTerritorial({proposal:{status:'saved'}});
  const next=workflow(storage).app;next.saveDraft(draft);
  assert.equal(next.hasSurvey(),true);assert.equal(next.getTerritorial().proposal.status,'saved');
  const detached=next.getDraft();detached.ut.key='99-999';assert.equal(next.getDraft().ut.key,'02-001');
});
test('cambiar tipo, UT o límites invalida resultados y confirmación',()=>{
  const {app}=workflow();prepare(app);app.saveSurvey(result(app));app.saveTerritorial({proposal:{status:'saved'}});
  app.saveDraft({...app.getDraft(),geometries:{original,proposed:{...proposed,coordinates:[[[0,0],[1.5,0],[1.5,1],[0,0]]]},affected:original}});
  assert.equal(app.hasSurvey(),false);assert.equal(app.getTerritorial(),null);
  app.setContext({...context,caseType:'fusion'});assert.equal(app.hasDraft(),false);
  app.setContext({...context,ut:{key:'02-002',name:'B'}});assert.equal(app.hasDraft(),false);
});
test('rechaza resultado tardío de otra revisión del borrador',()=>{
  const {app}=workflow();prepare(app);const snapshot=result(app);
  assert.throws(()=>app.saveSurvey({...snapshot,draftPreparedAt:'anterior'}),/cambió/);
  assert.throws(()=>app.saveSurvey({...snapshot,N:NaN}),/incompleto/);
});
test('recalcular conserva borrador y elimina confirmación previa',()=>{
  const {app}=workflow();prepare(app);app.saveSurvey(result(app));app.saveTerritorial({proposal:{status:'saved'}});
  app.invalidateSurvey();assert.equal(app.hasDraft(),true);assert.equal(app.hasSurvey(),false);assert.equal(app.getTerritorial(),null);
});
test('almacenamiento aislado por ruta, datos dañados y cuota',()=>{
  const {app,storage,window}=workflow();prepare(app);
  assert.equal(workflow(storage,'/otra/').app.getContext(),null);
  assert.equal(workflow(new Map([['mgpc.workflow.v1:/mgpc/','{invalid']])).app.getContext(),null);
  window.sessionStorage.setItem=()=>{throw new Error('QuotaExceededError');};
  assert.throws(()=>app.saveSurvey(result(app)),/conservar la propuesta/);
});
