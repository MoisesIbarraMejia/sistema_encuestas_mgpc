/* Offline checks for reference labels. No Maps requests or API writes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname,'..');
const bundle = process.env.TURF_TEST_BUNDLE || path.join(root,'.test-output/turf.min.js');
const turfAvailable = fs.existsSync(bundle);
const square = {type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,2],[0,0]]]};
const feature = (manzana,id=manzana) => ({type:'Feature',id,properties:{manzana,seccion:1412,completa:true,pct:100},geometry:square});

function runtime() {
  const elements = new Map(), markers = [];
  const element = () => ({style:{setProperty(){}},dataset:{},textContent:'',innerHTML:'',checked:false,hidden:false,
    classList:{add(){},remove(){}},addEventListener(){},setAttribute(){},appendChild(){},remove(){}});
  class Data {
    constructor({map=null}={}) {this.map=map;this.features=[];}
    setMap(map) {this.map=map;}
    getMap() {return this.map;}
    setStyle() {}
    addListener() {}
    addGeoJson(data) {this.features.push(...(data.features || [data]));}
    forEach(callback) {this.features.slice().forEach(callback);}
    remove(feature) {this.features=this.features.filter(item=>item!==feature);}
  }
  class Marker {
    constructor(options) {Object.assign(this,options);markers.push(this);}
    setMap(map) {this.map=map;}
  }
  const context = vm.createContext({
    CONFIG:{API_BASE:'api-proxy_local.php'},
    MGPCMapLabels:{forMap(map){return {add(options){const item={options,map,setMap(next){this.map=next;}};markers.push(item);return item;}};}},
    MGPCWorkflow:{requireContext(){return null;},getDraft(){return null;},renderHeader(){}},
    document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,addEventListener(){}},
    window:{addEventListener(){},location:{}},console:{warn(){},error(){},log(){}},
    setTimeout(){return 1;},clearTimeout(){},
    google:{maps:{Data,Marker,Size:class{constructor(width,height){this.width=width;this.height=height;}},Point:class{constructor(x,y){this.x=x;this.y=y;}}}}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'js/editor-territorial.js'),'utf8'),context);
  return {context,elements,markers,run(code){return vm.runInContext(code,context);}};
}

test('numeric references delegate their full text and layer to shared grouping',()=>{
  const r=runtime();r.run('editorPoly.map={};posicionEtiquetaReferencia = () => ({lat:19.4,lng:-99.1})');
  r.context.input=square;
  for (const value of ['7','41','412','1412']) {
    r.context.value=value;
    const marker=r.run('crearEtiquetaNumericaReferencia(value,input,{map:editorPoly.map})');
    assert.equal(marker.options.text,value);
    assert.equal(marker.options.key,value);
    assert.equal(marker.options.layer,'section');
    assert.ok(marker.map);
  }
  for(const invalid of [null,undefined,'','Mz 12','<img>']){
    r.context.value=invalid;assert.equal(r.run('crearEtiquetaNumericaReferencia(value,input,{})'),null);
  }
  r.context.unit={cveUt:'05-029',nombre:'CONSTITUCION DE LA REPUBLICA',feature:{geometry:square}};
  const ut=r.run('crearEtiquetaUTReferencia(unit)');
  assert.equal(ut.options.text,'05-029');
  assert.equal(ut.options.name,'CONSTITUCION DE LA REPUBLICA');
  assert.equal(ut.options.layer,'ut');
});

test('section reference renderers use number-only labels and remove previous markers',()=>{
  const r=runtime();r.run('posicionEtiquetaReferencia = () => ({lat:19.4,lng:-99.1})');
  r.context.input={type:'Feature',geometry:square,properties:{seccion:1412}};
  r.run('editorPoly.map={};editorPoly.seccionesLayer=new google.maps.Data({map:editorPoly.map});state.features=[{seccion:1412,feature:input}]');
  r.elements.get('chk-colindancias-secciones').checked=true;
  r.run('renderSeccionLabelsEditor()');
  const first=r.run('editorPoly.seccionLabels[0]');
  assert.equal(first.options.text,'1412');assert.ok(first.map);
  r.run('renderSeccionLabelsEditor()');
  assert.equal(first.map,null);assert.equal(r.run('editorPoly.seccionLabels.length'),1);
  r.run('ocultarSeccionesUTEnMapa()');assert.equal(r.run('editorPoly.seccionLabels[0].map'),null);
  r.run('renderSeccionesColindantesEnMapa([input])');
  const neighboring=r.run('editorPoly.colindanciasSeccionesLabels[0]');
  assert.equal(neighboring.options.text,'1412');assert.equal(neighboring.options.layer,'section');
  r.run('renderSeccionesColindantesEnMapa([])');
  assert.equal(neighboring.map,null);assert.equal(r.run('editorPoly.colindanciasSeccionesLabels.length'),0);
});

test('block labels contain only the block number and disappear on reload, hide and late responses',async()=>{
  const r=runtime();r.run('posicionEtiquetaReferencia = () => ({lat:19.4,lng:-99.1})');
  r.context.input=feature(23);r.run('editorPoly.map={};editorPoly.original=input.geometry;geometryToEditor(input.geometry)');
  r.elements.get('chk-manzanas').checked=true;
  r.run('renderManzanas([input])');
  const first=r.run('editorPoly.manzanasLabels[0]');
  assert.equal(first.options.text,'23');assert.ok(first.map);
  const waiting=[];
  r.context.intersectar=()=>new Promise(resolve=>waiting.push(resolve));
  const loading=r.run('refrescarManzanas()');
  assert.equal(first.map,null);assert.equal(r.run('editorPoly.manzanasLabels.length'),0);
  r.elements.get('chk-manzanas').checked=false;
  await r.run('refrescarManzanas()');
  for (const resolve of waiting) resolve({type:'FeatureCollection',features:[{...feature(23),porcentaje_afectado:100}]});
  await loading;
  assert.equal(r.run('editorPoly.manzanasLabels.length'),0,'obsolete response must not restore labels');
  assert.equal(r.run('editorPoly.manzanasLayer.getMap()'),null);
  r.elements.get('chk-manzanas').checked=true;
  r.run('renderManzanas([input])');
  const second=r.run('editorPoly.manzanasLabels[0]');
  r.context.input=feature(124);
  r.run('renderManzanas([], [input])');
  assert.equal(second.map,null);assert.equal(r.run('editorPoly.manzanasLabels[0].options.text'),'124');
  r.context.intersectar=async()=>{throw new Error('Offline');};
  await r.run('refrescarManzanas()');
  assert.equal(r.run('editorPoly.manzanasLabels.length'),0);
  assert.equal(r.run('editorPoly.manzanasLayer.getMap()'),null);
});

test('real label placement remains inside concave areas and holes, choosing the largest MultiPolygon part',{
  skip:turfAvailable?false:'Turf local required in .test-output/turf.min.js or TURF_TEST_BUNDLE'
},()=>{
  const r=runtime();const turf=require(bundle);r.context.turf=turf;
  const geometries=[
    {type:'Polygon',coordinates:[[[0,0],[6,0],[6,2],[2,2],[2,6],[0,6],[0,0]]]},
    {type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[6,4],[6,6],[4,6],[4,4]]]},
    {type:'MultiPolygon',coordinates:[[[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[10,0],[14,0],[14,4],[10,4],[10,0]]]]}
  ];
  for (const geometry of geometries) {
    const before=JSON.stringify(geometry);r.context.input=geometry;
    const position=r.run('posicionEtiquetaReferencia(input)');
    assert.ok(position);
    assert.ok(turf.booleanPointInPolygon([position.lng,position.lat],turf.feature(geometry),{ignoreBoundary:true}));
    if (geometry.type==='MultiPolygon') assert.ok(position.lng>10,'choose the larger part, not the gap between parts');
    assert.equal(JSON.stringify(geometry),before);
  }
  r.context.input={type:'Polygon',coordinates:[]};
  assert.equal(r.run('posicionEtiquetaReferencia(input)'),null);
});
