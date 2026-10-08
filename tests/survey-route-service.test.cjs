const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/survey-route-service.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const points = count => Array.from({ length: count }, (_, index) => ({ lat: 19.3 + index / 10000, lng: -99.1 }));
const route = request => ({ routes: [{
  path: [request.origin, ...request.intermediates.map(stop => stop.location), request.destination],
  distanceMeters: request.intermediates.length * 100 + 100,
  durationMillis: (request.intermediates.length + 1) * 60000,
  warnings: ['Revisar el cruce.', 'Revisar el cruce.']
}] });

function harness(computeRoutes = async request => route(request), importOverride) {
  const calls = [];
  const imports = [];
  const window = { google: { maps: { importLibrary: async name => {
    imports.push(name);
    if (importOverride) return importOverride(name);
    return { Route: { computeRoutes: async request => { calls.push(request); return computeRoutes(request); } } };
  } } } };
  vm.runInNewContext(source, { window });
  return { service: window.MGPCSurveyRouteService, calls, imports, window };
}

test('Routes Library uses current request shape, ordered intermediate stops and duration in seconds', async () => {
  const { service, calls, imports } = harness();
  const stops = points(4).map(position => ({ position, count: 3 }));
  const snapshot = structuredClone(stops);
  const result = plain(await service.compute(stops));
  assert.deepEqual(stops, snapshot);
  assert.deepEqual(imports, ['routes']);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].origin), stops[0].position);
  assert.deepEqual(plain(calls[0].destination), stops[3].position);
  assert.deepEqual(plain(calls[0].intermediates), stops.slice(1, -1).map(stop => ({ location: stop.position })));
  assert.equal(calls[0].travelMode, 'WALKING');
  assert.equal(calls[0].optimizeWaypointOrder, false);
  assert.equal(calls[0].polylineQuality, 'HIGH_QUALITY');
  assert.equal('routingPreference' in calls[0], false);
  assert.deepEqual(plain(calls[0].fields), ['path', 'distanceMeters', 'durationMillis', 'warnings']);
  assert.equal(result.distanceMeters, 300);
  assert.equal(result.durationSeconds, 180);
  assert.equal(result.segments.length, 1);
  assert.match(result.warnings[0], /rutas a pie.*beta/);
  assert.equal(result.warnings.filter(value => value === 'Revisar el cruce.').length, 1);
});

test('more than 25 intermediates use sequential overlapping chunks with no missing or repeated leg', async () => {
  let active = 0;
  let peak = 0;
  const { service, calls } = harness(async request => {
    active += 1; peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return route(request);
  });
  const stops = points(60);
  const result = plain(await service.compute(stops, { travelMode: 'DRIVING' }));
  assert.equal(peak, 1);
  assert.equal(calls.length, 3);
  const routedPoints = calls.flatMap((request, index) => {
    const chunk = [request.origin, ...request.intermediates.map(value => value.location), request.destination];
    assert.ok(request.intermediates.length <= 25);
    return index ? chunk.slice(1) : chunk;
  });
  assert.deepEqual(plain(routedPoints), stops);
  assert.deepEqual(plain(calls[0].destination), plain(calls[1].origin));
  assert.equal(result.distanceMeters, 5900);
  assert.equal(result.durationSeconds, 3540);
  assert.equal(result.segments.length, 3);
  assert.ok(calls.every(request => request.routingPreference === 'TRAFFIC_UNAWARE'));
  assert.equal(result.warnings.some(value => /beta/.test(value)), false);
});

test('round trips append the origin once and preserve the closing leg across a chunk boundary', async () => {
  const { service, calls } = harness();
  const stops = points(27);
  const result = await service.compute(stops, { roundTrip: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls[1].origin), stops[26]);
  assert.deepEqual(plain(calls[1].destination), stops[0]);
  assert.equal(result.distanceMeters, 2700);
  const closed = [...points(3), points(3)[0]];
  await service.compute(closed, { roundTrip: true });
  assert.equal(calls[2].intermediates.length, 2);
});

test('invalid inputs do not make API calls and zero or one stop has no travel', async () => {
  const { service, imports } = harness();
  for (const invalid of [null, [{ lat: NaN, lng: 0 }], [{ lat: 91, lng: 0 }], [{ lat: '19', lng: -99 }]]) {
    await assert.rejects(service.compute(invalid));
  }
  await assert.rejects(service.compute(points(2), { travelMode: 'TRANSIT' }), /a pie o en automóvil/);
  for (const stops of [[], points(1)]) {
    assert.deepEqual(plain(await service.compute(stops, { roundTrip: true })), { segments: [], distanceMeters: 0, durationSeconds: 0, warnings: [] });
  }
  assert.equal(imports.length, 0);
});

test('missing library and denied API explain setup; failed library imports can be retried', async () => {
  let attempts = 0;
  const { service, window } = harness(null, () => {
    attempts += 1;
    if (attempts === 1) return {};
    return { Route: { computeRoutes: request => route(request) } };
  });
  await assert.rejects(service.compute(points(2)), error => error.code === 'ROUTES_UNAVAILABLE' && /Habilita Routes API/.test(error.message));
  assert.equal((await service.compute(points(2))).segments.length, 1);
  window.google.maps.routes = { Route: { computeRoutes: async () => { throw new Error('PERMISSION_DENIED'); } } };
  await assert.rejects(service.compute(points(2)), /Habilita Routes API/);
  delete window.google;
  await assert.rejects(service.compute(points(2)), /orden orientativo/);
});

test('failure in a later chunk rejects the complete result instead of returning a partial total', async () => {
  let count = 0;
  const { service, calls } = harness(async request => {
    if (++count === 2) throw new Error('network failed');
    return route(request);
  });
  await assert.rejects(service.compute(points(60)), error => error.code === 'ROUTES_FAILED' && /distancia total/.test(error.message));
  assert.equal(calls.length, 2);
});

test('empty or incomplete routes are rejected, not rendered as a straight-line substitute', async () => {
  for (const response of [{ routes: [] }, { routes: [{ path: points(2), durationMillis: 0 }] },
    { routes: [{ path: [], durationMillis: 0, distanceMeters: 0 }] },
    { routes: [{ path: points(2), durationMillis: Infinity, distanceMeters: 20 }] },
    { routes: [{ path: [{ lat: NaN, lng: 0 }, points(1)[0]], durationMillis: 30, distanceMeters: 20 }] }]) {
    const { service } = harness(async () => response);
    await assert.rejects(service.compute(points(2)), error => ['INCOMPLETE_ROUTE', 'ROUTE_NOT_FOUND'].includes(error.code));
  }
});

test('cancellation before or after an in-flight call avoids subsequent requests and stale results', async () => {
  let current = false;
  const { service, calls, imports } = harness(async request => {
    current = false;
    return route(request);
  });
  await assert.rejects(service.compute(points(60), { isCurrent: () => current }), error => error.name === 'AbortError');
  assert.equal(imports.length, 0);
  current = true;
  await assert.rejects(service.compute(points(60), { isCurrent: () => current }), error => error.name === 'AbortError');
  assert.equal(calls.length, 1);
});

test('cancellation while importing or while a failed request is pending remains an AbortError', async () => {
  let current = true;
  const imported = harness(null, () => { current = false; return {}; });
  await assert.rejects(imported.service.compute(points(2), { isCurrent: () => current }), error => error.name === 'AbortError');
  current = true;
  const requested = harness(() => { current = false; throw new Error('REQUEST_DENIED'); });
  await assert.rejects(requested.service.compute(points(2), { isCurrent: () => current }), error => error.name === 'AbortError');
});

test('modern numeric LatLngAltitude paths and classic LatLng accessors are normalized; fallback warnings survive', async () => {
  const { service } = harness(request => ({
    ...route(request), fallbackInfo: { reason: 'SERVER_ERROR' },
    routes: [{ ...route(request).routes[0], path: [{ lat: () => 19.3, lng: () => -99.1 }, { lat: 19.301, lng: -99.1, altitude: 2 }] }]
  }));
  const result = plain(await service.compute(points(2)));
  assert.deepEqual(result.segments[0].path, [{ lat: 19.3, lng: -99.1 }, { lat: 19.301, lng: -99.1 }]);
  assert.ok(result.warnings.some(value => /alternativa/.test(value)));
});
