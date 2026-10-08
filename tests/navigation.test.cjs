/* Page integration tests: execute each HTML's local scripts against its real IDs.
   These do not replace visual/browser tests; Maps and network are kept offline. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'editor-territorial.html', 'encuestas.html', 'territorial.html'];
const cases = ['division', 'fusion', 'nomenclatura', 'inc_exc_secciones', 'inc_exc_manzanas'];
const original = { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]]] };
const proposed = { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };

function fixture(caseType, phase = 'context') {
  const context = { district: '5', ut: {key: '02-001', name: 'UT de prueba'}, caseType };
  const result = { version: 2, context, draft: null, survey: null, territorial: null };
  if (phase !== 'context') result.draft = {
    ...context, preparedAt: '2026-10-01T12:00:00.000Z',
    geometries: { original, proposed: caseType === 'nomenclatura' ? original : proposed, affected: proposed },
    relatedUTs: caseType === 'fusion' ? [{claveUT: '02-002'}] : [],
    sectionChanges: caseType === 'inc_exc_secciones' ? [{key: '100', action: 'include'}] : []
  };
  if (phase === 'survey') result.survey = {
    ...context, geometries: result.draft.geometries,
    draftPreparedAt: result.draft.preparedAt, analysisDate: '2026-10-01T12:01:00.000Z',
    N: 200, sample: {n: 132, method: 'muestreo'}, params: {Z: 2.58, p: .5, q: .5, d: .05, censusThreshold: 100}
  };
  return result;
}

function boot(page, stored = null) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const ids = new Map(), queriedMissing = new Set(), redirects = [], listeners = new Map();
  const storage = new Map(stored ? [['mgpc.workflow.v1:/mgpc/', JSON.stringify(stored)]] : []);
  function element(tag = 'div', id = '') {
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(), id, children: [], dataset: {}, events: {},
      style: { setProperty() {} }, textContent: '', innerHTML: '', hidden: false,
      disabled: false, checked: false, className: '', parentNode: null,
      classList: { add(...items) { items.forEach(x => classes.add(x)); }, remove(...items) { items.forEach(x => classes.delete(x)); }, contains(item) { return classes.has(item); }, toggle(item, value) { if (value ?? !classes.has(item)) classes.add(item); else classes.delete(item); } },
      append(...children) { for (const child of children) { this.children.push(child); if (child && typeof child === 'object') { child.parentNode = this; if (child.id) ids.set(child.id, child); } } },
      appendChild(child) { this.append(child); return child; }, prepend(...children) { this.append(...children); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }, removeEventListener() {},
      setAttribute(name, value) { this[name] = String(value); }, removeAttribute(name) { delete this[name]; },
      setCustomValidity() {}, focus() { document.activeElement=this; }, click() { return Promise.all((this.events.click || []).map(cb => cb({target: this}))); },
      remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }
    };
    let value = '';
    Object.defineProperty(el, 'value', { get() { return value; }, set(next) { value = String(next); } });
    if (tag.toLowerCase()==='dialog') {
      el.open=false;
      el.showModal=function(){this.open=true;};
      el.close=function(){this.open=false;for(const callback of this.events.close || [])callback();};
    }
    if (id) ids.set(id, el);
    return el;
  }
  for (const tag of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = /\bid="([^"]+)"/.exec(tag[2])?.[1];
    if (!id) continue;
    assert.equal(ids.has(id), false, `${page}: duplicate ID ${id}`);
    const el = element(tag[1], id);
    el.checked = /\bchecked\b/.test(tag[2]); el.hidden = /\bhidden\b/.test(tag[2]);
    el.disabled = /\bdisabled\b/.test(tag[2]);
  }
  const document = {
    currentScript: null, body: element('body'), head: element('head'),
    getElementById(id) { if (!ids.has(id)) queriedMissing.add(id); return ids.get(id) || null; },
    createElement: element, createTextNode: text => ({textContent: text}),
    querySelector(selector) { return selector.startsWith('#') ? ids.get(selector.slice(1)) || null : null; },
    querySelectorAll() { return []; }, addEventListener() {}
  };
  const location = { href: `http://localhost/mgpc/${page}`, pathname: `/mgpc/${page}`,
    replace(target) { redirects.push(new URL(target, this.href).pathname.split('/').pop()); },
    assign(target) { redirects.push(new URL(target, this.href).pathname.split('/').pop()); }
  };
  const sandbox = {
    document, location, URL, URLSearchParams, Blob, AbortController, structuredClone,
    console: {log() {}, warn() {}, error() {}},
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout() { return 1; }, clearTimeout() {}, confirm() { return true; },
    sessionStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)},
    addEventListener(type, callback) { (listeners.get(type) || listeners.set(type, []).get(type)).push(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
    fetch: async (url) => {
      const data = /uts_mgpc/.test(String(url)) ? {type:'FeatureCollection', features:[{type:'Feature', properties:{cve_ut:'02-001', nombre:'UT de prueba', dtto_loc:'5', secciones:'100', secciones1:null}, geometry:original}]} : {type:'FeatureCollection', features:[]};
      return {ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data};
    }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map(match => match[1]);
  for (const src of scripts) {
    if (/^https?:/.test(src)) continue;
    const filename = src.split('?')[0];
    assert.equal(fs.existsSync(path.join(root, filename)), true, `${page}: missing script ${src}`);
    document.currentScript = {src: new URL(src, location.href).href};
    vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), context, {filename});
  }
  return {context, document, ids, queriedMissing, redirects, storage, run: code => vm.runInContext(code, context)};
}

test('the actual standalone HTML pages load their local scripts in a valid order', () => {
  for (const page of pages) {
    const pageState = page === 'territorial.html' ? fixture('division', 'survey')
      : page === 'encuestas.html' ? fixture('division', 'draft') : fixture('division');
    const runtime = boot(page, pageState);
    assert.equal(typeof runtime.context.MGPCWorkflow?.requireContext, 'function', `${page}: workflow available`);
    if (page !== 'index.html') assert.equal(typeof runtime.context.initMap, 'function', `${page}: Maps callback exists`);
    if (page === 'encuestas.html') assert.equal(runtime.run('typeof Sampling.validateParams'), 'function');
  }
});

test('a newly selected editable case stays on preparation and never reloads itself', () => {
  for (const caseType of cases.filter(value => value !== 'nomenclatura')) {
    const runtime = boot('editor-territorial.html', fixture(caseType));
    assert.deepEqual(runtime.redirects, [], `${caseType}: the proposal editor must be immediately usable without an old survey`);
    assert.equal(runtime.context.MGPCWorkflow.nextPath(), 'editor-territorial.html');
    // A guard that merely suppresses the redirect must not leave a blank editor.
    assert.equal(runtime.run('state.cveUt'), '02-001', `${caseType}: preparation receives the selected UT`);
  }
});

test('direct page access settles on the permitted step without redirect cycles', () => {
  for (const caseType of cases) {
    for (const phase of ['context', 'draft', 'survey']) {
      for (const startPage of pages.slice(1)) {
        let page = startPage;
        const visited = new Set();
        for (let hop = 0; hop < pages.length + 1; hop++) {
          assert.equal(visited.has(page), false, `${caseType}/${phase}: redirect cycle revisits ${page}`);
          visited.add(page);
          const runtime = boot(page, fixture(caseType, phase));
          assert.ok(runtime.redirects.length <= 1, `${page}: competing redirects`);
          if (!runtime.redirects.length) break;
          assert.notEqual(runtime.redirects[0], page, `${page}: redirects to itself`);
          page = runtime.redirects[0];
          assert.ok(pages.includes(page), `route exists: ${page}`);
        }
      }
    }
  }
});

test('entry with no session returns to selection in a single navigation', () => {
  for (const page of pages.slice(1)) {
    const runtime = boot(page);
    assert.deepEqual(runtime.redirects, ['index.html'], page);
  }
  assert.deepEqual(boot('index.html').redirects, []);
});

test('selection stores a complete case that can open its next page immediately', async () => {
  for (const caseType of cases) {
    const start = boot('index.html');
    const district = start.ids.get('district-select'); district.value = '5';
    await Promise.all(district.events.change.map(callback => callback({target:district})));
    const radio = start.ids.get('ut-list').children[0].children[0].children[0];
    radio.events.change.forEach(callback => callback({target:radio}));
    const caseSelect = start.ids.get('case-select'); caseSelect.value = caseType;
    caseSelect.events.change.forEach(callback => callback({target:caseSelect}));
    await start.ids.get('start-survey').click();
    const expected = caseType === 'nomenclatura' ? 'encuestas.html' : 'editor-territorial.html';
    assert.deepEqual(start.redirects, [expected]);
    const stored = JSON.parse(start.storage.get('mgpc.workflow.v1:/mgpc/'));
    assert.equal(stored.context.caseType, caseType);
    assert.equal(stored.context.ut.key, '02-001');
    const next = boot(expected, stored);
    assert.deepEqual(next.redirects, [], `${caseType}: no bounce after selection`);
    if (expected === 'editor-territorial.html') assert.equal(next.run('state.cveUt'), stored.context.ut.key);
  }
});

test('the survey context and review summary use elements present in their HTML', () => {
  for (const caseType of cases) {
    const survey = boot('encuestas.html', fixture(caseType, 'draft'));
    assert.match(survey.ids.get('survey-ut-name').textContent, /UT de prueba/);
    assert.ok(survey.ids.get('survey-scope').textContent.length > 15, `${caseType}: explanatory sample scope`);
    const review = boot('territorial.html', fixture(caseType, 'survey'));
    assert.equal(review.ids.get('review-population').textContent, '200');
    assert.equal(review.ids.get('review-sample').textContent, '132');
    assert.equal(review.ids.get('review-error').textContent, '', `${caseType}: review startup`);
  }
});

test('editing guide opens only for manual cases and can be closed and reopened without changing the proposal', async () => {
  for (const caseType of cases) {
    const runtime=boot('editor-territorial.html',fixture(caseType));
    const dialog=runtime.ids.get('editor-help-dialog');
    const trigger=runtime.ids.get('btn-editor-help');
    const manual=['division','inc_exc_manzanas'].includes(caseType);
    assert.equal(dialog.open,manual,caseType);
    assert.equal(trigger.hidden,!manual,caseType);
    if (!manual) continue;
    const before=JSON.stringify([...runtime.storage]);
    assert.equal(runtime.document.activeElement.id,'editor-help-title');
    await runtime.ids.get('btn-editor-help-start').click();
    assert.equal(dialog.open,false);
    assert.equal(runtime.document.activeElement,trigger);
    await trigger.click();
    assert.equal(dialog.open,true);
    await runtime.ids.get('btn-editor-help-close').click();
    assert.equal(dialog.open,false);
    assert.equal(runtime.document.activeElement,trigger);
    assert.equal(JSON.stringify([...runtime.storage]),before);
    assert.deepEqual(runtime.redirects,[]);
  }
  const empty=boot('editor-territorial.html');
  assert.equal(empty.ids.get('editor-help-dialog').open,false);
});

test('final review initializes its comparison map using only the retained HTML and geometry helpers', async () => {
  const maps = [];
  const geometry = value => {
    if (value.type === 'MultiPolygon') return {getType:()=>value.type, getArray:()=>value.coordinates.map(coordinates=>geometry({type:'Polygon',coordinates}))};
    return {getType:()=>value.type, getArray:()=>value.coordinates.map(ring=>({getArray:()=>ring.map(([lng,lat])=>({lng:()=>lng,lat:()=>lat}))}))};
  };
  class Data {
    constructor() { this.features=[]; }
    addGeoJson(collection) { this.features=collection.features.map(feature=>({getGeometry:()=>geometry(feature.geometry),getProperty:key=>feature.properties[key]})); }
    forEach(fn) { this.features.forEach(fn); }
    setStyle(style) { this.style=style; }
    getStyle() { return this.style; }
  }
  class MapView {
    constructor(element) { assert.equal(element.id,'review-map');this.data=new Data();maps.push(this); }
    fitBounds(bounds) { this.bounds=bounds; }
  }
  class Bounds {
    constructor() { this.points=[]; }
    extend(point) { this.points.push(point); }
    isEmpty() { return this.points.length===0; }
  }
  for (const caseType of cases) {
    const stored=fixture(caseType,'survey');
    if (caseType==='fusion') stored.draft.geometries.proposed={type:'MultiPolygon',coordinates:[original.coordinates,proposed.coordinates]};
    const runtime=boot('territorial.html',stored);
    // The shared header checks for its element before creating it on startup.
    runtime.queriedMissing.delete('workflow-header');
    runtime.context.google={maps:{Map:MapView,LatLngBounds:Bounds}};
    runtime.context.fetch=()=>{throw new Error('The comparison must not request another module');};
    await runtime.context.mgpcMapsReady();
    assert.equal(runtime.ids.get('map-error').hidden,true);
    assert.equal(runtime.ids.get('review-error').textContent,'');
    const map=maps.at(-1);
    assert.equal(map.data.features.length,caseType==='nomenclatura'?1:2);
    assert.equal(map.bounds.points.length,caseType==='nomenclatura'?5:caseType==='fusion'?15:10);
    assert.equal(map.data.style(map.data.features[0]).visible,true);
    runtime.ids.get('review-show-original').checked=false;
    for (const listener of runtime.ids.get('review-show-original').events.change) listener();
    assert.equal(map.data.style(map.data.features[0]).visible,false);
    assert.deepEqual([...runtime.queriedMissing],[]);
    assert.deepEqual(runtime.redirects,[]);
  }
});

test('survey initialization enables calculation using only the controls in its current HTML', async () => {
  for (const caseType of cases) {
    const runtime = boot('encuestas.html', fixture(caseType, 'draft'));
    runtime.context.turf = {
      truncate: value => value,
      feature: geometry => ({type:'Feature', properties:{}, geometry}),
      featureCollection: features => ({type:'FeatureCollection', features}),
      area: () => 1000,
      difference: () => ({type:'Feature', properties:{}, geometry:proposed}),
      union: () => ({type:'Feature', properties:{}, geometry:proposed})
    };
    // Replace the map's drawing operations only. Keep its actual public method
    // names so a call to a non-existent MapManager method still fails.
    runtime.run(`
      const RealMapManager = MapManager;
      MapManager = class {
        constructor(id) { if (!document.getElementById(id)) throw new Error('Missing map ' + id); }
        loadOriginalUT(feature) { this.original = feature; this.proposed = feature; }
        restoreEditedGeometry(geometry) { this.proposed = geometry.type === 'Feature' ? geometry : {type:'Feature', properties:{}, geometry}; }
        getOriginalGeoJSON() { return this.original; }
        getEditedGeoJSON() { return this.proposed; }
      };
      for (const name of Object.getOwnPropertyNames(RealMapManager.prototype)) {
        if (name !== 'constructor' && !MapManager.prototype[name]) MapManager.prototype[name] = function () {};
      }
    `);
    await runtime.run('initAppMap()');
    assert.equal(runtime.ids.get('btn-analizar').disabled, false, `${caseType}: ${runtime.ids.get('analizar-status').textContent}`);
    assert.equal(runtime.ids.get('panel-resultados').hidden, true, 'results remain hidden until a calculation finishes');
    assert.deepEqual(runtime.redirects, [], `${caseType}: calculation page remains open`);
  }
});

test('a Maps authorization failure shows a useful error without starting reloads', () => {
  for (const page of pages.slice(1)) {
    const runtime = boot(page, fixture('division', page === 'territorial.html' ? 'survey' : 'draft'));
    runtime.context.gm_authFailure();
    assert.equal(runtime.ids.get('map-error').hidden, false, `${page}: visible Maps error`);
    assert.match(runtime.ids.get('map-error').textContent, /Google Maps/);
    assert.deepEqual(runtime.redirects, [], `${page}: no redirect on map failure`);
  }
});

test('Maps loader refuses a missing callback and surfaces initialization failures without an unhandled rejection',async()=>{
  const runtime=boot('editor-territorial.html',fixture('division'));
  const source=fs.readFileSync(path.join(root,'js/maps-loader.js'),'utf8');
  runtime.context.initMap=undefined;runtime.document.head.replaceChildren();
  vm.runInContext(source,runtime.context);
  assert.equal(runtime.document.head.children.length,0,'a broken screen never requests a nonexistent Google callback');
  assert.match(runtime.ids.get('map-error').textContent,/iniciar la pantalla/);
  runtime.context.initMap=async()=>{throw new Error('No se pudo cargar la UT')};
  vm.runInContext(source,runtime.context);
  await runtime.context.mgpcMapsReady();
  assert.match(runtime.ids.get('map-error').textContent,/No se pudo cargar la UT/);
  assert.deepEqual(runtime.redirects,[]);
});

// Exercise the actual editor startup and controls. The Maps drawing primitives
// are offline stand-ins; polygon calculations use the same real Turf version.
const turfBundle=process.env.TURF_TEST_BUNDLE || path.join(root,'.test-output/turf.min.js');
const hasTurf=fs.existsSync(turfBundle);
function drawingAPI() {
  const layers=[],polylines=[];
  const mvc=items=>({events:{},forEach:fn=>items.forEach(fn),getAt:index=>items[index],getLength:()=>items.length,
    setAt(index,value){const old=items[index];items[index]=value;(this.events.set_at||[]).forEach(fn=>fn(index,old));},
    insertAt(index,value){items.splice(index,0,value);(this.events.insert_at||[]).forEach(fn=>fn(index));},
    removeAt(index){const old=items.splice(index,1)[0];(this.events.remove_at||[]).forEach(fn=>fn(index,old));}});
  class Polygon {
    constructor(options){this.paths=mvc(options.paths.map(ring=>mvc(ring.map(point=>({lat:()=>point.lat,lng:()=>point.lng})))));}
    getPaths(){return this.paths} setMap(){} setEditable(){} addListener(){return {remove(){}}}
  }
  class Data {
    constructor(options={}){this.features=[];this.events={};this.map=options.map||null;layers.push(this)}
    addGeoJson(value){const added=(value.features || [value]).map(f=>({source:f,getProperty:key=>f.properties?.[key],getGeometry(){return this.geometry||null},setGeometry(value){this.geometry=value}}));this.features.push(...added);return added;}
    setStyle(style){this.style=style} setMap(map){this.map=map} getMap(){return this.map} forEach(fn){this.features.slice().forEach(fn)}
    remove(feature){this.features=this.features.filter(f=>f!==feature)}
    addListener(name,fn){this.events[name]=fn;return {remove(){}}}
  }
  Data.Point=class {constructor(position){this.position=position;}};
  class MapView {constructor(){this.controls={TOP_RIGHT:[]}}fitBounds(){}getZoom(){return this.zoom ?? 16}setZoom(value){this.zoom=value}panTo(point){this.center=point}addListener(){return {remove(){}}} }
  class OverlayView {
    setMap(map){this.map=map;if(map)this.onAdd?.();else this.onRemove?.();}
    getPanes(){return {overlayMouseTarget:{appendChild(){}}};}
    getProjection(){return null;}
    static preventMapHitsAndGesturesFrom(){}
  }
  class Polyline {
    constructor(options){this.options=options;this.map=options.map;polylines.push(this)}
    setMap(map){this.map=map}
    set(key,value){this.options[key]=value}
  }
  return {layers,polylines,maps:{Map:MapView,OverlayView,Polygon,Polyline,Data,SymbolPath:{CIRCLE:'circle',FORWARD_CLOSED_ARROW:'arrow'},LatLng:class{constructor(lat,lng){this.lat=()=>lat;this.lng=()=>lng;}},LatLngBounds:class {constructor(){this.count=0;}extend(){this.count++;}isEmpty(){return !this.count;}},
    ControlPosition:{TOP_RIGHT:'TOP_RIGHT'},geometry:{spherical:{computeArea:()=>1000}},
    event:{clearInstanceListeners(target){target.events={}},addListener(target,name,fn){(target.events[name]||=([])).push(fn);return {remove(){}}},removeListener(){}}}};
}

test('survey initializes the real MapManager with the label module loaded from its HTML', {skip:!hasTurf}, async()=>{
  const r=boot('encuestas.html',fixture('inc_exc_manzanas','draft'));
  r.context.google=drawingAPI();r.context.turf=require(turfBundle);
  await r.context.mgpcMapsReady();
  assert.equal(r.ids.get('btn-analizar').disabled,false,r.ids.get('analizar-status').textContent);
  assert.equal(r.run('mapManager instanceof MapManager'),true);
  assert.equal(r.run('!!mapManager.labels'),true);
  assert.equal(r.ids.get('map-error').hidden,true);
});

test('editor loads the UT and saves a prepared manual change before any sample exists', {skip:!hasTurf}, async()=>{
  for(const caseType of ['division','inc_exc_manzanas']) {
    const r=boot('editor-territorial.html',fixture(caseType));
    r.context.google=drawingAPI();r.context.turf=require(turfBundle);
    await r.context.mgpcMapsReady();
    assert.equal(r.run('proposalReady'),true,r.ids.get('proposal-error').textContent);
    assert.equal(r.ids.get('ut-info-cve').textContent,'02-001');
    assert.equal(r.run('editorPoly.editMode'),true);
    assert.equal(r.ids.get('btn-editor-save').disabled,true,'unchanged limits cannot continue');
    r.context.changed=proposed;
    r.run('geometryToEditor(changed); editorPoly.cambios=true; actualizar();');
    await r.ids.get('btn-editor-save').click();
    assert.deepEqual(JSON.parse(JSON.stringify(r.context.MGPCWorkflow.getDraft().geometries.proposed)),proposed);
    assert.equal(r.context.location.href,'encuestas.html');
    assert.equal(r.context.MGPCWorkflow.hasSurvey(),false);
  }
});

test('fusion and sections load 20 m choices, react to map/list selection and retain the chosen proposal', {skip:!hasTurf},async()=>{
  const neighbor={type:'Feature',properties:{cve_ut:'02-002',nombre:'UT vecina',seccion:101},geometry:{type:'Polygon',coordinates:[[[2,0],[3,0],[3,2],[2,2],[2,0]]]}};
  for(const caseType of ['fusion','inc_exc_secciones']) {
    const r=boot('editor-territorial.html',fixture(caseType));
    r.context.google=drawingAPI();r.context.turf=require(turfBundle);
    const calls=[];
    r.context.fetch=async(url,options={})=>{
      const endpoint=new URL(url,'http://localhost/mgpc/').searchParams.get('endpoint');
      const body=options.body?JSON.parse(options.body):null;calls.push({endpoint,body});
      const data={type:'FeatureCollection',features:endpoint==='filter_2/uts_mgpc'
        ? [{type:'Feature',properties:{cve_ut:'02-001',nombre:'UT principal'},geometry:original}]
        : body?.buffer_meters===20 ? [neighbor] : []};
      return {ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)};
    };
    await r.context.mgpcMapsReady();
    assert.equal(r.run('proposalReady'),true,r.ids.get('proposal-error').textContent);
    assert.ok(calls.some(call=>call.endpoint==='intersect/'+(caseType==='fusion'?'uts_mgpc':'secciones')&&call.body.buffer_meters===20));
    const primaryId=caseType==='fusion'?'chk-colindancias-ut':'chk-colindancias-secciones';
    assert.equal(r.ids.get(primaryId).checked,true);
    assert.equal(r.ids.get(primaryId).disabled,true);
    const referencesBefore=JSON.stringify(r.run('proposalChoices.getReferenceFeatures()'));
    const callCount=calls.length;
    r.ids.get(primaryId).checked=false;
    await r.run('refrescarColindancias()');
    assert.equal(r.ids.get(primaryId).checked,true,'the primary reference cannot be switched off');
    assert.equal(calls.length,callCount,'primary references reuse the original candidate dataset');
    const input=r.ids.get('proposal-choice-list').children[0].children[0];
    if(caseType==='fusion')input.checked=true;else input.value='include';
    await Promise.all(input.events.change.map(fn=>fn({target:input})));
    assert.equal(r.ids.get('btn-editor-save').disabled,false);
    const layer=r.context.google.layers.find(item=>item.features.some(f=>f.getProperty('choiceKey')));
    layer.events.click({feature:layer.features[0]});
    assert.equal(JSON.stringify(r.run('proposalChoices.getReferenceFeatures()')),referencesBefore);
    assert.equal(r.ids.get('btn-editor-save').disabled,true,'map click removes the selected zone');
    layer.events.click({feature:layer.features[0]});
    await r.ids.get('btn-editor-save').click();
    const draft=r.context.MGPCWorkflow.getDraft();
    assert.equal((caseType==='fusion'?draft.relatedUTs:draft.sectionChanges).length,1);
    assert.ok(r.context.turf.area({type:'Feature',properties:{},geometry:draft.geometries.proposed})>r.context.turf.area({type:'Feature',properties:{},geometry:original}));
    assert.ok(calls.every(call=>!call.endpoint.startsWith('create/')),'preparation performs no writes to history');
  }
});

async function editableRuntime() {
  const r=boot('editor-territorial.html',fixture('division'));
  r.context.google=drawingAPI();r.context.turf=require(turfBundle);
  await r.context.mgpcMapsReady();
  r.ids.get('editor-snap-distance').value='5';
  r.context.reference={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-.00002,-.00002],[-1,-1],[-1,-2],[-.00002,-.00002]]]}};
  r.run('editorSnap.uts=[reference]; editorPoly.colindanciasUTLayer=new google.maps.Data({map:editorPoly.map});');
  return r;
}
test('an editable gesture snaps once to a visible layer, preserves references and undoes in one step',{skip:!hasTurf},async()=>{
  const r=await editableRuntime();r.ids.get('chk-colindancias-ut').checked=true;
  const refs=JSON.stringify(r.context.reference);
  r.run('editorSnap.pointerDown=true; editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(0,new google.maps.LatLng(-.000015,-.000015));');
  assert.equal(r.run('editorPoly.historial.length'),0,'dragging does not prematurely record history');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),-.000015);
  r.run('editorSnap.pointerDown=false; finalizarEdicion();');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),-.00002);
  assert.equal(r.run('editorPoly.historial.length'),1);
  assert.equal(r.run('editorSnap.pending'),null,'programmatic setAt must not schedule another snap');
  assert.match(r.ids.get('editor-snap-status').textContent,/UT vecina/);
  r.run('revertir()');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),0);
  assert.equal(r.run('editorPoly.historial.length'),0);
  assert.equal(JSON.stringify(r.context.reference),refs);
});
test('hidden references are ignored and disabling snapping retains the dragged coordinate',{skip:!hasTurf},async()=>{
  const r=await editableRuntime();
  r.run('editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(0,new google.maps.LatLng(-.000015,-.000015)); finalizarEdicion();');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),0,'only the original visible boundary is eligible');
  r.ids.get('chk-editor-snap').checked=false;
  r.run('editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(0,new google.maps.LatLng(-.000015,-.000015)); finalizarEdicion();');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),-.000015);
  assert.equal(r.run('editorPoly.historial.length'),1);
});
test('enabling a hidden layer does not snap to its old data while the new request is pending',{skip:!hasTurf},async()=>{
  const r=await editableRuntime();
  r.run('ocultarUTColindantesEnMapa()');
  r.ids.get('chk-colindancias-ut').checked=true;
  const sources=r.run('referenciasDeAjuste().vertices.map(point=>point.source)');
  assert.ok(!sources.includes('UT vecina'));
  r.run('editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(0,new google.maps.LatLng(-.000015,-.000015)); finalizarEdicion();');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),0);
  r.run('mostrarUTColindantesEnMapa()');
  assert.ok(r.run('referenciasDeAjuste().vertices.some(point=>point.source==="UT vecina")'));
});
test('crossing edits are rolled back and a snap that collapses adjacent points is not applied',{skip:!hasTurf},async()=>{
  const r=await editableRuntime();
  r.run('editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(1,new google.maps.LatLng(1,-1)); finalizarEdicion();');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][1].lng'),2);
  assert.equal(r.run('editorPoly.historial.length'),0);
  assert.match(r.ids.get('proposal-error').textContent,/deshizo/);
  r.run('editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(0,new google.maps.LatLng(.00001,1.99999)); finalizarEdicion();');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),1.99999);
  assert.match(r.ids.get('editor-snap-status').textContent,/no se aplicó/);
  assert.equal(r.run('editorPoly.historial.length'),1);
});
test('a new gesture recovers a missed pointer release and keeps separate undo steps',{skip:!hasTurf},async()=>{
  const r=await editableRuntime();r.ids.get('chk-editor-snap').checked=false;
  r.run('iniciarArrastre({isPrimary:true}); editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(0,new google.maps.LatLng(-.001,-.001));');
  assert.equal(r.run('editorPoly.historial.length'),0);
  r.run('iniciarArrastre({isPrimary:true});');
  assert.equal(r.run('editorPoly.historial.length'),1,'a new press finalizes the earlier movement');
  r.run('editorPoly.mapPolygons[0].getPaths().getAt(0).setAt(1,new google.maps.LatLng(-.001,2)); finalizarEdicion();');
  assert.equal(r.run('editorPoly.historial.length'),2);
  r.run('revertir()');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),-.001);
  assert.equal(r.run('editorPoly.polygons[0].rings[0][1].lat'),0);
  r.run('revertir()');
  assert.equal(r.run('editorPoly.polygons[0].rings[0][0].lng'),0);
});

function distributionRuntime() {
  const r=boot('encuestas.html',fixture('inc_exc_manzanas','draft'));
  r.context.google=drawingAPI();r.context.turf=require(turfBundle);
  const heat=[];
  r.context.MGPCSurveyHeat={create(map,points){
    const handle={map,points,setMap(next){this.map=next},remove(){this.map=null}};
    heat.push(handle);return handle;
  }};
  const snapshot={...fixture('inc_exc_manzanas','survey').survey,usaSecciones:false,
    geometries:{original,proposed,affected:original},N:200,nAfectacion:200,nLocalidades:0,
    sample:{N:200,n:50,method:'muestreo'},
    manzanasResult:{type:'FeatureCollection',features:[{type:'Feature',geometry:original,properties:{manzana:'7',seccion:'100',LN:200,porcentaje_afectado:100}}]},
    localidadResult:{type:'FeatureCollection',features:[]}};
  return {r,heat,snapshot};
}

test('distribution dialog from real HTML shows exact counts, supports controls and downloads safe CSV without API writes',{skip:!hasTurf},async()=>{
  const {r,heat,snapshot}=distributionRuntime();
  snapshot.manzanasResult.features[0].properties.manzana='  =1+1';
  const before=JSON.stringify(snapshot);
  r.context.fetch=async()=>{throw new Error('Unexpected API request for an existing block result')};
  let downloaded;
  r.context.URL=class extends URL {static createObjectURL(blob){downloaded=blob;return 'blob:distribution'}static revokeObjectURL(){}};
  r.context.MGPCSurveyDistribution.setResult(snapshot);
  const trigger=r.ids.get('btn-survey-distribution');trigger.focus();
  await trigger.click();
  assert.equal(r.ids.get('distribution-dialog').open,true);
  assert.equal(r.ids.get('distribution-content').hidden,false,r.ids.get('distribution-status').textContent);
  assert.match(r.ids.get('distribution-status').textContent,/50 de 50/);
  assert.equal(r.ids.get('distribution-total').textContent,'50');
  assert.equal(r.ids.get('distribution-rows').children[0].children.at(-1).textContent,'50');
  assert.equal(heat[0].points[0].weight,50);
  assert.equal(r.ids.get('distribution-download').disabled,false);
  const layers=r.context.MGPCMapLabels.forMap(heat[0].map);
  assert.equal(layers.entries.size,1);
  const card=[...layers.entries][0];
  assert.deepEqual(JSON.parse(JSON.stringify(card.position)),JSON.parse(JSON.stringify(heat[0].points[0].position)));
  assert.ok(card.details.some(detail=>detail.label==='Núm. encuestas'&&detail.value==='50'));
  assert.equal(card.details.length,1,'distribution labels contain only the survey count below the block name');
  const labelsToggle=r.ids.get('distribution-labels');labelsToggle.checked=false;
  labelsToggle.events.change.forEach(callback=>callback({target:labelsToggle}));
  assert.equal(layers.entries.size,0);
  labelsToggle.checked=true;labelsToggle.events.change.forEach(callback=>callback({target:labelsToggle}));
  assert.equal(layers.entries.size,1);
  const heatToggle=r.ids.get('distribution-heat');heatToggle.checked=false;
  heatToggle.events.change.forEach(callback=>callback({target:heatToggle}));
  assert.equal(heat[0].map,null);
  await r.ids.get('distribution-download').click();
  const csv=await downloaded.text();
  assert.match(csv,/"'  =1\+1"/,'spreadsheet formulas preceded by whitespace are escaped');
  assert.match(csv,/"Muestra total","","","","","50"/);
  await r.ids.get('distribution-close').click();
  assert.equal(layers.entries.size,0);
  assert.equal(r.document.activeElement,trigger);
  await trigger.click();
  assert.equal(r.ids.get('distribution-content').hidden,false);
  r.run('clearResults(false)');
  assert.equal(r.ids.get('distribution-dialog').open,false);
  assert.equal(trigger.disabled,true);
  assert.equal(heat.at(-1).map,null);
  assert.equal(JSON.stringify(snapshot),before);
  assert.deepEqual([...r.queriedMissing],[]);
});

test('a map failure leaves distribution retry usable and closing after retry restores the external trigger',{skip:!hasTurf},async()=>{
  const {r,heat,snapshot}=distributionRuntime();
  const create=r.context.MGPCSurveyHeat.create;
  r.context.MGPCSurveyHeat.create=()=>{throw new Error('Map not available')};
  r.context.MGPCSurveyDistribution.setResult(snapshot);
  const trigger=r.ids.get('btn-survey-distribution');trigger.focus();await trigger.click();
  assert.match(r.ids.get('distribution-status').textContent,/Map not available/);
  assert.equal(r.ids.get('distribution-download').disabled,true);
  assert.equal(r.ids.get('distribution-fit').disabled,true);
  assert.equal(r.ids.get('distribution-retry').hidden,false);
  r.context.MGPCSurveyHeat.create=create;
  r.ids.get('distribution-retry').focus();await r.ids.get('distribution-retry').click();
  assert.equal(r.ids.get('distribution-download').disabled,false);
  assert.equal(r.ids.get('distribution-content').hidden,false);
  await r.ids.get('distribution-close').click();
  assert.equal(r.document.activeElement,trigger);
  assert.equal(heat.at(-1).map,null);
});

async function routeRuntime(setup) {
  const data=distributionRuntime();
  setup?.(data.r);
  data.snapshot.manzanasResult.features=[100,50,50,0].map((LN,i)=>{
    const x=i%2,y=Math.floor(i/2);
    return {type:'Feature',properties:{manzana:String(i+1),seccion:'100',LN,porcentaje_afectado:100},
      geometry:{type:'Polygon',coordinates:[[[x,y],[x+1,y],[x+1,y+1],[x,y+1],[x,y]]]}};
  });
  data.r.context.MGPCSurveyDistribution.setResult(data.snapshot);
  await data.r.ids.get('btn-survey-distribution').click();
  await data.r.ids.get('distribution-tab-route').click();
  return data;
}

test('routes visit only assigned blocks, keep street metrics separate and release lines when options change',{skip:!hasTurf},async()=>{
  const {r,snapshot}=await routeRuntime();
  let received;
  r.context.MGPCSurveyRouteService={compute:async(stops,options)=>{
    received={stops,options};
    return {segments:[{path:stops.map(stop=>stop.position)}],distanceMeters:900,durationSeconds:720,warnings:['Aviso peatonal del proveedor']};
  }};
  assert.equal(r.ids.get('distribution-data-panel').hidden,true);
  assert.equal(r.ids.get('distribution-route-panel').hidden,false);
  assert.equal(r.ids.get('distribution-tab-route')['aria-selected'],'true');
  assert.equal(r.ids.get('route-generate').disabled,false);
  r.ids.get('route-start').value='block:100:2';
  r.ids.get('route-roundtrip').checked=true;
  const originalSnapshot=JSON.stringify(snapshot);
  await r.ids.get('route-generate').click();
  assert.equal(received.options.travelMode,'WALKING');
  assert.equal(received.options.roundTrip,true);
  assert.equal(received.stops[0].key,'block:100:2');
  assert.equal(received.stops.length,3);
  assert.ok(received.stops.every(stop=>stop.count>0));
  assert.equal(received.stops.reduce((sum,stop)=>sum+stop.count,0),50);
  assert.equal(r.ids.get('route-stops').children.length,3);
  assert.ok(r.ids.get('route-summary').children.some(item=>/900 m.*12 min/.test(item.textContent)));
  assert.equal(r.ids.get('route-warnings').children[0].textContent,'Aviso peatonal del proveedor');
  assert.equal(r.ids.get('route-warnings').hidden,false);
  assert.equal(r.ids.get('route-download').disabled,false);
  const activeLines=r.context.google.polylines.filter(line=>line.map);
  assert.equal(activeLines.length,3);
  const halo=activeLines.find(line=>line.options.zIndex===45),trail=activeLines.find(line=>line.options.zIndex===46);
  assert.equal(halo.options.strokeColor,'#ffffff');
  assert.equal(trail.options.strokeColor,'#087f8c');
  assert.ok(halo.options.strokeWeight>trail.options.strokeWeight);
  assert.equal(activeLines.find(line=>line.options.zIndex===40).options.icons.length,1,'return trips share their start and finish');
  assert.equal(r.context.google.polylines.filter(line=>line.map&&line.options.zIndex===31).length,0,'complete paths are hidden by default');
  assert.equal(r.ids.get('route-playback').hidden,false);
  assert.equal(r.ids.get('route-map-key').hidden,false);
  assert.equal(r.ids.get('route-map-kind').textContent,'Recorrido por calles · vista previa');
  assert.equal(r.ids.get('route-map-end').textContent,'Regreso al inicio');
  const link=r.ids.get('route-links').children.find(child=>child.tagName==='A');
  assert.equal(new URL(link.href).searchParams.get('travelmode'),'walking');
  const input=r.ids.get('route-mode');input.value='driving';input.events.change.forEach(fn=>fn({target:input}));
  assert.equal(r.ids.get('route-summary').hidden,true);
  assert.equal(r.ids.get('route-download').disabled,true);
  assert.equal(r.context.google.polylines.filter(line=>line.map).length,0);
  assert.equal(r.ids.get('route-map-key').hidden,true);
  assert.equal(JSON.stringify(snapshot),originalSnapshot);
  assert.deepEqual([...r.queriedMissing],[]);
});

test('route service failure keeps an explicit direct-line fallback and downloadable visit order',{skip:!hasTurf},async()=>{
  const {r}=await routeRuntime();
  r.context.MGPCSurveyRouteService={compute:async()=>{throw new Error('Servicio de calles no disponible')}};
  let downloaded;
  r.context.URL=class extends URL {static createObjectURL(blob){downloaded=blob;return 'blob:route'}static revokeObjectURL(){}};
  await r.ids.get('route-generate').click();
  assert.match(r.ids.get('route-status').textContent,/líneas punteadas/);
  assert.ok(r.ids.get('route-summary').children.some(item=>/en línea directa/.test(item.textContent)));
  assert.ok(!r.ids.get('route-summary').children.some(item=>/min de traslado/.test(item.textContent)));
  assert.equal(r.ids.get('route-stops').children.length,3);
  assert.equal(r.ids.get('route-download').disabled,false);
  assert.equal(r.context.google.polylines.filter(line=>line.map)[0].options.strokeOpacity,0);
  assert.equal(r.ids.get('route-map-key').classList.contains('is-direct'),true);
  assert.match(r.ids.get('route-map-kind').textContent,/sin calles/);
  assert.equal(r.ids.get('route-motion').disabled,true,'orientation never pretends to be an animated street route');
  await r.ids.get('route-download').click();
  const csv=await downloaded.text();
  assert.match(csv,/Distancia en línea directa/);
  assert.match(csv,/Tiempo de traslado por calles \(min\)","Sin datos/);
  await r.ids.get('distribution-close').click();
  assert.equal(r.context.google.polylines.filter(line=>line.map).length,0);
});

test('closing the modal discards late street routes and never restores cleared overlays',{skip:!hasTurf},async()=>{
  const {r}=await routeRuntime();
  let finish,options;
  r.context.MGPCSurveyRouteService={compute:(_stops,settings)=>{options=settings;return new Promise(resolve=>{finish=resolve})}};
  const pending=r.ids.get('route-generate').click();
  assert.equal(r.ids.get('route-generate').disabled,true);
  await r.ids.get('distribution-close').click();
  assert.equal(options.isCurrent(),false);
  finish({segments:[{path:[{lat:0,lng:0},{lat:1,lng:1}]}],distanceMeters:123,durationSeconds:45,warnings:[]});
  await pending;
  assert.equal(r.ids.get('route-summary').hidden,true);
  assert.equal(r.context.google.polylines.filter(line=>line.map).length,0);
  assert.equal(r.ids.get('route-generate').disabled,true);
  await r.ids.get('btn-survey-distribution').click();
  assert.equal(r.ids.get('distribution-data-panel').hidden,false);
  assert.equal(r.ids.get('distribution-route-panel').hidden,true);
  assert.equal(r.ids.get('route-generate').disabled,false);
});

test('route motion can pause and resume, respects reduced motion and releases scheduled frames on close',{skip:!hasTurf},async()=>{
  const frames=new Map(),reduced={matches:false};
  let nextFrame=0,preferenceChanged,visibilityChanged;
  const {r}=await routeRuntime(runtime=>{
    runtime.context.requestAnimationFrame=callback=>{frames.set(++nextFrame,callback);return nextFrame;};
    runtime.context.cancelAnimationFrame=id=>frames.delete(id);
    reduced.addEventListener=(type,callback)=>{preferenceChanged=callback;};
    runtime.context.matchMedia=()=>reduced;
    runtime.document.addEventListener=(type,callback)=>{if(type==='visibilitychange')visibilityChanged=callback;};
  });
  const advance=time=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(time));};
  advance(-100); // Finish the initial map-label layout before measuring route animation.
  r.context.MGPCSurveyRouteService={compute:async stops=>({segments:[{path:stops.map(stop=>stop.position)}],distanceMeters:900,durationSeconds:720,warnings:[]})};
  await r.ids.get('route-generate').click();
  const motion=r.ids.get('route-motion');
  assert.equal(motion['aria-pressed'],'true');
  assert.equal(frames.size,1);
  const line=r.context.google.polylines.find(item=>item.map&&item.options.zIndex===46);
  const arrowLayer=r.context.google.layers.find(item=>item.map&&item.features.some(feature=>feature.getProperty('role')==='route-preview'));
  assert.equal(arrowLayer.features.length,1,'exactly one arrow represents the current position');
  const before=JSON.stringify(arrowLayer.features[0].geometry.position);
  advance(0);advance(100);
  assert.notEqual(JSON.stringify(arrowLayer.features[0].geometry.position),before);
  assert.equal(line.options.icons,undefined,'the short trail carries no repeated arrows');
  const endpointLine=r.context.google.polylines.find(item=>item.map&&item.options.zIndex===40);
  assert.deepEqual(Array.from(endpointLine.options.icons,icon=>icon.offset),['0','100%'],'start and finish never move');
  await motion.click();
  assert.equal(frames.size,0);
  assert.equal(motion['aria-pressed'],'false');
  await motion.click();
  assert.equal(frames.size,1);
  r.document.hidden=true;visibilityChanged();assert.equal(frames.size,0);
  r.document.hidden=false;visibilityChanged();assert.equal(frames.size,1);
  reduced.matches=true;preferenceChanged();
  assert.equal(frames.size,0);
  assert.equal(motion.disabled,true);
  reduced.matches=false;preferenceChanged();assert.equal(frames.size,1);
  const pendingFrame=[...frames.keys()][0];
  await r.ids.get('distribution-close').click();
  assert.equal(frames.has(pendingFrame),false,'the route frame is cancelled, not merely ignored');
  advance(1000); // Closing also schedules a final label cleanup.
  assert.equal(frames.size,0);
  assert.equal(motion.disabled,true);
  assert.equal(r.ids.get('route-map-key').hidden,true);
  assert.equal(r.ids.get('route-playback').hidden,true);
  assert.equal(arrowLayer.map,null);
});

test('preview seeks manually and toggles overview without recalculating or connecting separate street segments',{skip:!hasTurf},async()=>{
  const {r,snapshot}=await routeRuntime();
  const originalSnapshot=JSON.stringify(snapshot);
  let calls=0;
  r.context.MGPCSurveyRouteService={compute:async()=>{
    calls++;
    return {segments:[{path:[{lat:19,lng:-99},{lat:19,lng:-98.999}]},{path:[{lat:20,lng:-98},{lat:20,lng:-97.999}]}],distanceMeters:210,durationSeconds:140,warnings:[]};
  }};
  await r.ids.get('route-generate').click();
  const slider=r.ids.get('route-progress');slider.value='750';slider.events.input.forEach(callback=>callback());
  assert.equal(r.ids.get('route-progress-label').textContent,'75 %');
  assert.match(slider['aria-valuetext'],/75 %/);
  const trail=r.context.google.polylines.find(line=>line.map&&line.options.zIndex===46);
  assert.ok(trail.options.path.every(point=>point.lat===20),'only the current segment is visible; no jump is drawn');
  assert.equal(r.ids.get('route-motion')['aria-pressed'],'false');
  const arrowLayer=r.context.google.layers.find(layer=>layer.map&&layer.features.some(feature=>feature.getProperty('role')==='route-preview'));
  await r.ids.get('route-focus').click();
  assert.deepEqual(arrowLayer.map.center,arrowLayer.features[0].geometry.position);
  const view=r.ids.get('route-view');view.value='overview';view.events.change.forEach(callback=>callback());
  assert.equal(trail.map,null);assert.equal(arrowLayer.map,null);
  const complete=r.context.google.polylines.filter(line=>line.map&&line.options.zIndex===31);
  assert.equal(complete.length,2,'street segments are not concatenated');
  assert.ok(complete.every(line=>line.options.icons.length===0));
  assert.equal(slider.disabled,true);
  view.value='trail';view.events.change.forEach(callback=>callback());
  assert.ok(trail.map);assert.ok(arrowLayer.map);
  assert.equal(complete.filter(line=>line.map).length,0);
  assert.equal(slider.value,'750','switching views preserves progress');
  slider.value='1000';slider.events.input.forEach(callback=>callback());
  assert.equal(r.ids.get('route-motion').textContent,'Reproducir de nuevo');
  await r.ids.get('route-restart').click();
  assert.equal(slider.value,'0');
  assert.equal(calls,1,'preview controls do not incur new route requests');
  assert.equal(JSON.stringify(snapshot),originalSnapshot);
});
