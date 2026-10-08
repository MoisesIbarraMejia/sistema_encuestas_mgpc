'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const polygon = properties => ({ type: 'Feature', properties, geometry: {
  type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
} });
const collection = (...features) => ({ type: 'FeatureCollection', features });

function harness() {
  const polygons = [], labels = [], popups = [], active = new Set();
  const controller = { add(options) {
    const handle = { options, setMap(map) { this.map = map; if (map) active.add(this); else active.delete(this); }, remove() { this.setMap(null); }, getPosition() { return options.position; } };
    labels.push(handle); handle.setMap(controller.map); return handle;
  } };
  const context = vm.createContext({ console,
    document: { getElementById: () => ({}) },
    CONFIG: { MAP: { center: [19, -99], zoom: 15 } },
    MGPCMapLabels: { forMap(map) { controller.map = map; return controller; } },
    turf: { centroid: () => ({ geometry: { coordinates: [0.5, 0.5] } }) },
    google: { maps: {
      Map: class {},
      LatLng: class { constructor(lat, lng) { this.lat = () => lat; this.lng = () => lng; } }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/mapManager.js'), 'utf8') + ';globalThis.Manager=MapManager;', context);
  const manager = new context.Manager('map');
  manager.createPolygon = (paths, options) => {
    const result = { options, events: {}, addListener(name, callback) { this.events[name] = callback; }, setMap(map) { this.map = map; } };
    polygons.push(result); return result;
  };
  manager.showInfoWindow = (object, content, position) => popups.push({ object, content, position });
  return { manager, context, polygons, labels, popups, active };
}

test('manzana labels stay numeric while reference and result popups retain section and LN', () => {
  const h = harness();
  const data = collection(polygon({ manzana: '007', seccion: 1234, LN: 285, porcentaje_afectado: 60 }));
  h.manager.showReferenceManzanas(data);
  h.manager.showManzanasResult(data);
  assert.deepEqual(h.labels.map(label => label.options.text), ['007', '007']);
  assert.deepEqual(h.labels.map(label => label.options.layer), ['block', 'block']);
  assert.deepEqual(h.labels.map(label => label.options.key), ['1234:007', '1234:007']);
  assert.deepEqual(h.labels.map(label => label.options.variant), ['reference', 'results']);
  h.polygons.forEach(item => item.events.click({ latLng: 'clicked-position' }));
  h.popups.forEach(popup => {
    assert.match(popup.content, /Manzana[^<]*007/);
    assert.match(popup.content, /Sección: 1234/);
    assert.match(popup.content, /Lista Nominal: 285/);
    assert.equal(popup.position, 'clicked-position');
  });
  assert.match(h.popups[1].content, /60%/);
  assert.equal(h.polygons[0].options.clickable, true);
  h.labels[1].options.onClick();
  assert.match(h.popups.at(-1).content, /60%/);
  assert.equal(h.popups.at(-1).object, null);
  assert.equal(h.popups.at(-1).position.lat(), 0.5);
});

test('section labels retain one to four digits in reference and result layers; popup values are escaped', () => {
  const h = harness();
  const data = collection(...[7, 42, 412, 1234].map(seccion => polygon({ seccion, LN: '<script>bad</script>' })));
  h.manager.showReferenceSecciones(data);
  h.manager.showSeccionesResult(data);
  assert.deepEqual(h.labels.map(label => label.options.text), ['7', '42', '412', '1234', '7', '42', '412', '1234']);
  assert.deepEqual(h.labels.map(label => label.options.key), ['7', '42', '412', '1234', '7', '42', '412', '1234']);
  assert.ok(h.labels.every(label => label.options.layer === 'section'));
  h.polygons.forEach(item => item.events.click({ latLng: 'clicked-position' }));
  h.popups.forEach(popup => {
    assert.match(popup.content, /Sección:/);
    assert.match(popup.content, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.ok(!popup.content.includes('<script>'));
  });
});

test('localidad icons join the shared grouping and preserve their positional popup', () => {
  const h = harness();
  const feature = { type: 'Feature', properties: { localidad: 'Centro', seccion: 412, LN: 90 }, geometry: { type: 'Point', coordinates: [-99, 19] } };
  h.manager.showLocalidadResult(collection(feature));
  const marker = h.labels[0];
  assert.equal(marker.options.image, 'img/localidad.png');
  assert.equal(marker.options.layer, 'locality');
  assert.equal(marker.options.text, 'Centro');
  assert.equal(h.active.has(marker), true);
  marker.options.onClick();
  assert.match(h.popups[0].content, /Localidad: Centro/);
  assert.match(h.popups[0].content, /Sección: 412/);
  assert.match(h.popups[0].content, /Lista Nominal: 90/);
  assert.equal(h.popups[0].object, null);
  assert.equal(h.popups[0].position.lat(), 19);
  assert.equal(h.popups[0].position.lng(), -99);
  h.manager.showLocalidadResult(collection());
  assert.equal(h.active.has(marker), false);
});

test('reference visibility and replacement release labels without affecting result labels', () => {
  const h = harness();
  const data = collection(polygon({ manzana: 1, seccion: 412 }), polygon({ manzana: 1, seccion: 413 }));
  h.manager.showReferenceManzanas(data);
  h.manager.showManzanasResult(data);
  assert.deepEqual(h.labels.slice(0, 2).map(label => label.options.key), ['412:1', '413:1']);
  assert.equal(h.active.size, 4);
  h.manager.toggleReferenceVisible(false);
  assert.equal(h.active.size, 2);
  h.manager.toggleReferenceVisible(true);
  assert.equal(h.active.size, 4);
  h.manager.showReferenceSecciones(collection(polygon({ seccion: 412 })));
  assert.equal(h.active.size, 3);
  assert.equal(h.active.has(h.labels[0]), false);
  assert.equal(h.active.has(h.labels[1]), false);
  h.manager.clearDownstream();
  assert.equal(h.active.size, 1);
  h.manager.clearAll();
  assert.equal(h.active.size, 0);
});

test('map initialization reports a missing shared label controller', () => {
  const h = harness();
  h.context.MGPCMapLabels = undefined;
  assert.throws(() => new h.context.Manager('map'), /sistema de etiquetas/);
});
