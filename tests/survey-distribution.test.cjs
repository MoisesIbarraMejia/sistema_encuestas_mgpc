const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootPath = path.join(__dirname, '..');
const turfBundle = process.env.TURF_TEST_BUNDLE || path.join(rootPath, '.test-output/turf.min.js');
const hasTurf = fs.existsSync(turfBundle);
const turfSource = hasTurf ? fs.readFileSync(turfBundle, 'utf8') : null;
const test = (name, fn) => nodeTest(name, { skip: hasTurf ? false : 'Set TURF_TEST_BUNDLE to run real-geometry distribution tests.' }, fn);
const plain = value => JSON.parse(JSON.stringify(value));
const rectangle = (west, south, east, north) => ({ type: 'Polygon', coordinates: [
  [[west, south], [east, south], [east, north], [west, north], [west, south]]
] });
const feature = (geometry, properties) => ({ type: 'Feature', geometry, properties });
const collection = features => ({ type: 'FeatureCollection', features });
const block = (section, name, ln, geometry, percentage = 100) => feature(geometry, {
  seccion: section, manzana: name, LN: ln, porcentaje_afectado: percentage
});
const section = (name, ln, geometry, percentage = 100) => feature(geometry, {
  seccion: name, LN: ln, porcentaje_afectado: percentage
});
const locality = (name, ln, coordinates, section = '1') => feature({ type: 'Point', coordinates }, {
  localidad: name, seccion: section, LN: ln
});

function runtime() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, open: false, checked: true, hidden: true, disabled: false, textContent: '', listeners: {},
      addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); },
      showModal() { this.open = true; },
      close() { this.open = false; for (const callback of this.listeners.close || []) callback(); },
      focus() { context.document.activeElement = this; }
    });
    return elements.get(id);
  };
  const context = { console, document: { getElementById: element, activeElement: null } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(turfSource, context);
  for (const script of ['diff.js', 'survey-allocation.js', 'survey-distribution.js']) {
    vm.runInContext(fs.readFileSync(path.join(rootPath, 'js', script), 'utf8'), context, { filename: script });
  }
  return { ...context.MGPCSurveyDistribution, turf: context.turf, context, element };
}

function result({ area = rectangle(0, 0, 4, 4), blocks = [], sections = [], localities = [], N, n, usaSecciones = false } = {}) {
  return {
    geometries: { affected: area }, usaSecciones,
    manzanasResult: collection(blocks), seccionesResult: collection(sections), localidadResult: collection(localities),
    N, sample: { n }, analysisDate: '2026-10-07T10:00:00.000Z', draftPreparedAt: '2026-10-07T09:00:00.000Z',
    ut: { key: '03-038', name: 'UT de prueba' }
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('block sample uses affected LN and preserves the locality quota and exact whole-survey total', () => {
  const { buildPlan, turf } = runtime();
  const snapshot = result({
    area: rectangle(0, 0, 1, 3), N: 200, n: 40,
    blocks: [block('1', '1', 200, rectangle(0, 0, 2, 1), 50), block('1', '2', 50, rectangle(0, 1, 1, 2))],
    localities: [locality('Pueblo', 50, [0.5, 2.5])]
  });
  const plan = buildPlan(snapshot, snapshot.manzanasResult);
  const rows = Object.fromEntries(plan.rows.map(row => [row.kind + ':' + row.name, row]));
  assert.equal(plan.assigned, 40);
  assert.equal(plan.total, 40);
  assert.equal(plan.unassigned, 0);
  assert.equal(rows['block:1'].ln, 200);
  assert.equal(rows['block:1'].weight, 100);
  assert.equal(rows['block:1'].count, 20);
  assert.equal(rows['block:2'].count, 10);
  assert.equal(rows['locality:Pueblo'].count, 10);
  assert.equal(plan.bySection, false);
  assert.ok(plan.rows.every(row => Number.isInteger(row.count)));
  for (const row of plan.rows) {
    const point = turf.point([row.position.lng, row.position.lat]);
    assert.ok(turf.booleanPointInPolygon(point, snapshot.geometries.affected));
    if (row.kind === 'block') assert.ok(turf.booleanPointInPolygon(point, row.geometry, { ignoreBoundary: true }));
  }
  assert.deepEqual(plain(turf.bbox(rows['block:1'].geometry)), [0, 0, 1, 1]);
});

test('section sample keeps each section quota before distributing among its blocks', () => {
  const { buildPlan } = runtime();
  const snapshot = result({ area: rectangle(0, 0, 4, 2), N: 400, n: 40, usaSecciones: true,
    sections: [section('001', 300, rectangle(0, 0, 2, 2)), section('2', 100, rectangle(2, 0, 4, 2))]
  });
  const blocks = collection([
    block(1, '1', 150, rectangle(0, 0, 1, 2)), block('001', '2', 50, rectangle(1, 0, 2, 2)),
    block('2', '1', 100, rectangle(2, 0, 4, 2))
  ]);
  const plan = buildPlan(snapshot, blocks);
  const first = plan.rows.filter(row => row.section === '1');
  const second = plan.rows.filter(row => row.section === '2');
  assert.equal(first.reduce((sum, row) => sum + row.count, 0), 30);
  assert.equal(second.reduce((sum, row) => sum + row.count, 0), 10);
  assert.equal(first.find(row => row.name === '1').count, 23);
  assert.equal(first.find(row => row.name === '2').count, 7);
  assert.ok(first.every(row => row.sectionQuota === 30));
  assert.equal(plan.assigned, 40);
  assert.equal(plan.unassigned, 0);
  assert.equal(plan.bySection, true);
});

test('section block weights are recalculated from actual clipped area, ignoring API percentages', () => {
  const { buildPlan } = runtime();
  const snapshot = result({ area: rectangle(0, 0, 1, 2), N: 300, n: 30, usaSecciones: true,
    sections: [section('1', 300, rectangle(0, 0, 1, 2))]
  });
  const plan = buildPlan(snapshot, collection([
    block('1', '1', 200, rectangle(0, 0, 2, 1), 100),
    block('1', '2', 100, rectangle(0, 1, 1, 2), 100)
  ]));
  assert.ok(plan.rows.every(row => row.count === 15));
  const partial = plan.rows.find(row => row.name === '1');
  assert.ok(Math.abs(partial.percentage - 50) < 1e-8);
  assert.ok(Math.abs(partial.weight - 100) < 1e-8);
});

test('localities keep their own quota when the remaining surveys are distributed by section', () => {
  const { buildPlan } = runtime();
  const snapshot = result({ area: rectangle(0, 0, 4, 2), N: 400, n: 40, usaSecciones: true,
    sections: [section('1', 300, rectangle(0, 0, 2, 2))],
    localities: [locality('Pueblo', 100, [3, 1])]
  });
  const plan = buildPlan(snapshot, collection([block('1', '1', 300, rectangle(0, 0, 2, 2))]));
  assert.equal(plan.rows.find(row => row.kind === 'block').count, 30);
  assert.equal(plan.rows.find(row => row.kind === 'locality').count, 10);
  assert.equal(plan.assigned, 40);
  assert.equal(plan.unassigned, 0);
});

test('missing blocks and insufficient block capacity leave exact pending quotas without moving them to another section', () => {
  const { buildPlan } = runtime();
  const snapshot = result({ area: rectangle(0, 0, 6, 2), N: 300, n: 30, usaSecciones: true,
    sections: [section('1', 100, rectangle(0, 0, 2, 2)), section('2', 100, rectangle(2, 0, 4, 2)), section('3', 100, rectangle(4, 0, 6, 2))]
  });
  const plan = buildPlan(snapshot, collection([
    block('1', '1', 3, rectangle(0, 0, 2, 2)), block('3', '1', 100, rectangle(4, 0, 6, 2))
  ]));
  assert.equal(plan.rows.find(row => row.section === '1').count, 3);
  assert.equal(plan.rows.find(row => row.section === '3').count, 10);
  assert.equal(plan.assigned, 13);
  assert.equal(plan.unassigned, 17);
  assert.equal(plan.assigned + plan.unassigned, plan.total);
  assert.equal(plan.missing.length, 2);
  assert.match(plan.missing[0], /1: 7 encuestas/);
  assert.match(plan.missing[1], /2: 10 encuestas/);
});

test('identical records are deduplicated without multiplying population or surveys; conflicting duplicates fail', () => {
  const { buildPlan } = runtime();
  const first = block('1', '7', 100, rectangle(0, 0, 2, 2));
  const snapshot = result({ N: 100, n: 10, blocks: [first, plain(first)] });
  const plan = buildPlan(snapshot, snapshot.manzanasResult);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].count, 10);
  const conflict = plain(first);
  conflict.properties.LN = 101;
  assert.throws(() => buildPlan(snapshot, collection([first, conflict])), /registros distintos/);
  const conflictingPercentage = plain(first);
  conflictingPercentage.properties.porcentaje_afectado = 50;
  assert.throws(() => buildPlan(snapshot, collection([first, conflictingPercentage])), /registros distintos/);
});

test('numeric section and block identifiers deduplicate leading zeros and numeric values without multiplying quotas', () => {
  const { buildPlan } = runtime();
  const geometry = rectangle(0, 0, 2, 2);
  const blocks = collection([block('001', '007', 100, geometry), block(1, 7, 100, plain(geometry))]);
  const snapshot = result({ N: 100, n: 10, usaSecciones: true,
    sections: [section('001', 100, geometry), section(1, 100, plain(geometry))]
  });
  const plan = buildPlan(snapshot, blocks);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].key, 'block:1:7');
  assert.equal(plan.rows[0].section, '1');
  assert.equal(plan.rows[0].name, '007');
  assert.equal(plan.rows[0].count, 10);
  assert.equal(plan.rows[0].sectionQuota, 10);
  assert.equal(plan.assigned, 10);
  assert.equal(plan.unassigned, 0);
  const conflict = plain(blocks.features[1]);
  conflict.properties.LN = 99;
  assert.throws(() => buildPlan(snapshot, collection([blocks.features[0], conflict])), /registros distintos/);
});

test('a saved locality outside the affected area requires recalculation; one on its boundary remains valid', () => {
  const { buildPlan } = runtime();
  const snapshot = result({ N: 10, n: 5, localities: [locality('Pueblo', 10, [5, 5])] });
  assert.throws(() => buildPlan(snapshot, snapshot.manzanasResult), /fuera del área|fuera del .rea/);
  snapshot.localidadResult.features[0].geometry.coordinates = [0, 2];
  const plan = buildPlan(snapshot, snapshot.manzanasResult);
  assert.equal(plan.rows[0].kind, 'locality');
  assert.equal(plan.rows[0].count, 5);
  assert.equal(plan.unassigned, 0);
});

test('incomplete population data, invalid geography and a mismatched sample population are rejected', () => {
  const { buildPlan } = runtime();
  const valid = block('1', '1', 100, rectangle(0, 0, 2, 2));
  const snapshot = result({ N: 100, n: 10, blocks: [valid] });
  for (const ln of [undefined, null, '', 'abc', -1]) {
    const bad = plain(valid); bad.properties.LN = ln;
    assert.throws(() => buildPlan(snapshot, collection([bad])), /lista nominal/);
  }
  const missingNumber = plain(valid); delete missingNumber.properties.manzana;
  assert.throws(() => buildPlan(snapshot, collection([missingNumber])), /número de manzana|n.mero de manzana/);
  const invalidPercentage = plain(valid); invalidPercentage.properties.porcentaje_afectado = 101;
  assert.throws(() => buildPlan(snapshot, collection([invalidPercentage])), /parte afectada/);
  assert.throws(() => buildPlan({ ...snapshot, N: 99 }, snapshot.manzanasResult), /población|poblaci.n/);
  assert.throws(() => buildPlan(snapshot, null), /datos del reparto/);
  const invalidGeometry = plain(valid); invalidGeometry.geometry = { type: 'Point', coordinates: [1, 1] };
  assert.throws(() => buildPlan(snapshot, collection([invalidGeometry])), /Polygon/);
  const withBadLocality = { ...snapshot, localidadResult: collection([locality('Fuera', 1, [181, 2])]) };
  assert.throws(() => buildPlan(withBadLocality, snapshot.manzanasResult), /ubicación|ubicaci.n/);
});

test('buildPlan preserves frozen sample snapshots and returned geometry does not alias the saved area', () => {
  const { buildPlan } = runtime();
  const snapshot = freezeDeep(result({ N: 100, n: 10, blocks: [block('1', '1', 100, rectangle(0, 0, 2, 2))] }));
  const original = JSON.stringify(snapshot);
  const plan = buildPlan(snapshot, snapshot.manzanasResult);
  assert.equal(JSON.stringify(snapshot), original);
  plan.area.coordinates[0][0][0] = 999;
  plan.ut.key = 'changed';
  assert.equal(JSON.stringify(snapshot), original);
});

test('interior label/heat positions stay inside concave polygons, avoid holes and use the largest multipolygon part', () => {
  const { interiorPoint, turf } = runtime();
  const concave = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]] };
  const hole = { type: 'Polygon', coordinates: [rectangle(0, 0, 4, 4).coordinates[0], [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]] };
  for (const geometry of [concave, hole]) {
    const position = interiorPoint(geometry);
    assert.ok(turf.booleanPointInPolygon(turf.point([position.lng, position.lat]), geometry, { ignoreBoundary: true }));
  }
  const large = rectangle(10, 10, 14, 14);
  const multi = { type: 'MultiPolygon', coordinates: [rectangle(0, 0, 1, 1).coordinates, large.coordinates] };
  const point = interiorPoint(multi);
  assert.ok(turf.booleanPointInPolygon(turf.point([point.lng, point.lat]), large, { ignoreBoundary: true }));
  assert.deepEqual(plain(interiorPoint({ type: 'Point', coordinates: [-99.1, 19.3] })), { lat: 19.3, lng: -99.1 });
});

test('closing or clearing a pending block request cannot reopen or paint an obsolete distribution', async () => {
  const app = runtime();
  let resolveRequest, receivedGeometry;
  app.context.Api = { intersect: (_layer, args) => {
    receivedGeometry = plain(args.geometry);
    return new Promise(resolve => { resolveRequest = resolve; });
  } };
  const snapshot = result({ N: 100, n: 10, usaSecciones: true, sections: [section('1', 100, rectangle(0, 0, 2, 2))] });
  const originalGeometry = plain(snapshot.geometries.affected);
  app.setResult(snapshot);
  snapshot.geometries.affected.coordinates[0][0][0] = 999;
  const pending = app.open();
  assert.deepEqual(receivedGeometry, originalGeometry);
  assert.equal(app.element('distribution-dialog').open, true);
  app.clear();
  app.element('distribution-status').textContent = 'Cleared';
  resolveRequest(collection([block('1', '1', 100, rectangle(0, 0, 2, 2))]));
  await pending;
  assert.equal(app.element('distribution-dialog').open, false);
  assert.equal(app.element('btn-survey-distribution').disabled, true);
  assert.equal(app.element('distribution-status').textContent, 'Cleared');
});
