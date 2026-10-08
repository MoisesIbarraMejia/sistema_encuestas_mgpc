'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const square = (x = 0) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] }
});
function apiContext() {
  const ctx = vm.createContext({
    URL,
    CONFIG: { API_BASE: 'api-proxy_local.php', ENDPOINTS: { utPorCve: '/filter_2/uts_mgpc' }, TABLES: { secciones: 'secciones' }, CACHE_TTL_MINUTES: 120 },
    window: { location: { href: 'https://example.test/mgpc/index.html' } },
    fetch: async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }))
  });
  vm.runInContext(source('js/api.js') + ';globalThis.api=Api;', ctx);
  return ctx;
}

test('API uses the shared district catalog, relative proxy, and bounded pagination', async () => {
  const ctx = apiContext();
  const calls = [];
  ctx.fetch = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options });
    const length = parsed.searchParams.get('offset') === '0' ? 1000 : 1;
    return new Response(JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length }, () => square()) }));
  };
  const result = await ctx.api.getDistrictUTs('05');
  assert.equal(result.features.length, 1001);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/mgpc/api-proxy_local.php');
  assert.equal(calls[0].url.searchParams.get('endpoint'), 'filter_2/uts_mgpc');
  assert.equal(calls[0].url.searchParams.get('dtto_loc'), '5');
  assert.equal(calls[0].url.searchParams.has('cve_ut'), false);
  assert.equal(calls[0].url.searchParams.get('limit'), '1000');
  assert.equal(calls[1].url.searchParams.get('offset'), '1000');
  await assert.rejects(ctx.api.getDistrictUTs(34), /distrito/);
  calls.length = 0;
  await ctx.api.getUTByCve('05-030');
  assert.equal(calls[0].url.searchParams.get('endpoint'), 'filter_2/uts_mgpc');
  assert.equal(calls[0].url.searchParams.get('cve_ut'), '05-030');
  assert.equal(calls[0].url.searchParams.has('dtto_loc'), false);
});

test('API surfaces HTTP, JSON, application, network and cache contract failures', async () => {
  const ctx = apiContext();
  for (const payload of [{ error: 'rejected' }, { success: false, message: 'rejected' }, { status: 'error', message: 'rejected' }]) {
    ctx.fetch = async () => new Response(JSON.stringify(payload));
    await assert.rejects(ctx.api.getDistrictUTs(5), /rejected/);
  }
  ctx.fetch = async () => new Response('<html>Error</html>', { status: 502 });
  await assert.rejects(ctx.api.getDistrictUTs(5), /HTTP 502/);
  ctx.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(ctx.api.getDistrictUTs(5), /servidor MGPC/);
  ctx.fetch = async () => new Response('{}');
  await assert.rejects(ctx.api.getDistrictUTs(5), /GeoJSON/);
  await assert.rejects(ctx.api.cacheStore(square().geometry, '05-030', {}), /identificador/);
});

test('API preserves root spatial metrics and copies them into properties', async () => {
  const ctx = apiContext();
  ctx.fetch = async () => new Response(JSON.stringify({
    type: 'FeatureCollection',
    features: [{ ...square(), porcentaje_afectado: 25.5, area_total_m2: 120, area_interseccion_m2: 30.6 }]
  }));
  const result = await ctx.api.intersect('manzana', { geometry: square().geometry });
  assert.equal(result.features[0].porcentaje_afectado, 25.5);
  assert.equal(result.features[0].properties.porcentaje_afectado, 25.5);
  assert.equal(result.features[0].properties.area_total_m2, 120);
  assert.equal(result.features[0].properties.area_interseccion_m2, 30.6);
});

// Turf operations are fixtures here: these tests verify failure propagation and
// retention of all components, not Turf's numerical clipping implementation.
test('differences fail as a whole rather than losing added/removed components', () => {
  const original = square(), modified = square(1), added = square(2), removed = square(3);
  const combined = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [added.geometry.coordinates, removed.geometry.coordinates] } };
  let calls = 0;
  const turf = { truncate: value => value,
    feature: geometry => ({ type: 'Feature', properties: {}, geometry }),
    difference: () => ++calls === 1 ? removed : added,
    union: () => combined, area: () => 100
  };
  const ctx = vm.createContext({ turf });
  vm.runInContext(source('js/diff.js') + ';globalThis.diff=Diff;', ctx);
  const result = ctx.diff.computeAffectedGeometry(original, modified);
  assert.equal(result.affected, combined); assert.equal(result.added, added); assert.equal(result.removed, removed);
  turf.difference = () => { throw new Error('clipping failed'); };
  assert.throws(() => ctx.diff.computeAffectedGeometry(original, modified), /zona afectada completa/);
  assert.throws(() => ctx.diff.isUnchanged(original, modified), /zona afectada completa/);
  calls = 0; turf.difference = () => ++calls === 1 ? removed : added;
  turf.union = () => { throw new Error('union failed'); };
  assert.throws(() => ctx.diff.computeAffectedGeometry(original, modified), /zona afectada completa/);
  turf.difference = () => null;
  assert.equal(ctx.diff.isUnchanged(original, modified), true);
  assert.throws(() => ctx.diff.isUnchanged(null, modified), /ambos/);
  turf.union = () => combined;
  assert.equal(ctx.diff.toFeature({ type: 'FeatureCollection', features: [original, modified] }), combined);
  assert.throws(() => ctx.diff.toFeature({ type: 'Point', coordinates: [0, 0] }), /Polygon/);
  const bad = square(); bad.geometry.coordinates[0][4] = [7, 7];
  assert.throws(() => ctx.diff.toFeature(bad), /cerrados/);
});

test('restoring a proposal preserves official polygons; map text is escaped', () => {
  const ctx = vm.createContext({ console });
  vm.runInContext(source('js/mapManager.js') + ';globalThis.Manager=MapManager;', ctx);
  const manager = Object.create(ctx.Manager.prototype);
  const official = [{ official: true }];
  let cleared = false;
  manager.originalPolygons = official;
  manager.editablePolygons = [{ setMap: value => { assert.equal(value, null); cleared = true; } }];
  manager.editingEnabled = true;
  manager.createPolygon = (paths, options) => ({
    options, setMap: () => {},
    getPaths: () => ({ forEach: fn => paths.forEach(ring => fn({
      getLength: () => ring.length, getAt: i => ({ lng: () => ring[i].lng, lat: () => ring[i].lat })
    })) })
  });
  assert.equal(manager.restoreEditedGeometry(square()).geometry.type, 'Polygon');
  assert.equal(manager.originalPolygons, official);
  assert.ok(cleared);
  assert.equal(manager.editablePolygons[0].options.editable, true);
  const before = manager.editablePolygons;
  assert.throws(() => manager.restoreEditedGeometry({ type: 'Point', coordinates: [0, 0] }), /Polygon/);
  assert.equal(manager.editablePolygons, before);
  assert.equal(manager.escapeHtml('<img src=x onerror="x">&'), '&lt;img src=x onerror=&quot;x&quot;&gt;&amp;');
  let content = '';
  manager.manzanasResultObjects = [];
  manager.createPolygon = () => ({ addListener: (name, fn) => fn({ latLng: { lat: 1, lng: 1 } }) });
  manager.showInfoWindow = (object, html) => { content = html; };
  manager.createFeatureLabel = () => null;
  manager.showManzanasResult({ features: [{ ...square(), properties: { manzana: '<img onerror=x>', seccion: '<script>x</script>', LN: 25 } }] });
  assert.ok(content.includes('&lt;img onerror=x&gt;'));
  assert.ok(!content.includes('<script>'));
});
