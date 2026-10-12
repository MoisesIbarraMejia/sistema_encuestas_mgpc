const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/survey-route-optimize.js'), 'utf8'), context);
const api = context.window.MGPCSurveyRouteOptimize;
const plain = value => JSON.parse(JSON.stringify(value));
const point = (lat, lng) => ({ lat, lng });
const stop = (key, lat, lng, count = 1) => ({ key, count, position: point(lat, lng), kind: 'block', name: key });
const ids = stops => stops.map(row => row.key);
const length = points => points.slice(1).reduce((sum, b, i) => {
  const a = points[i];
  return sum + Math.hypot((b.lat - a.lat) * 111195.08023, (b.lng - a.lng) * 111195.08023 * Math.cos(a.lat * Math.PI / 180));
}, 0);
function road(stops, { roundTrip = false, paths, accesses, distances } = {}) {
  const visits = roundTrip ? [...stops, stops[0]] : stops;
  const legs = [];
  for (let i = 1; i < visits.length; i += 1) {
    const from = visits[i - 1], to = visits[i];
    const startLocation = accesses?.[from.key] || from.routePosition || from.position;
    const endLocation = accesses?.[to.key] || to.routePosition || to.position;
    const legPath = paths?.[i - 1] || [startLocation, endLocation];
    const distanceMeters = distances?.[i - 1] ?? length(legPath);
    legs.push({ fromKey: from.key, toKey: to.key, path: legPath, startLocation, endLocation, distanceMeters, durationSeconds: distanceMeters / 1.4 });
  }
  return { legs, distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0) };
}
const propose = (stops, result, options) => plain(api.propose(stops, result, options));

test('first road pass visits an intermediate block before driving to the far block and back', () => {
  const stops = [stop('start', 0.0003, 0), stop('far', 0.0003, 0.003), stop('middle', 0.0003, 0.001, 12)];
  const accesses = { start: point(0, 0), far: point(0, 0.003), middle: point(0, 0.001) };
  const baseline = road(stops, { accesses }), before = structuredClone({ stops, baseline });
  const proposed = propose(stops, baseline);
  assert.deepEqual(ids(proposed), ['start', 'middle', 'far']);
  assert.deepEqual(proposed.map(row => row.order), [1, 2, 3]);
  assert.deepEqual(proposed[1].position, stops[2].position);
  assert.deepEqual(proposed[1].routePosition, accesses.middle);
  const candidate = road(proposed);
  assert.ok(api.assess(stops, baseline).repeatMeters > 200);
  assert.ok(api.assess(proposed, candidate).repeatMeters < 1);
  assert.ok(candidate.distanceMeters < baseline.distanceMeters - 200);
  assert.equal(api.accept(stops, baseline, proposed, candidate), true);
  assert.equal(api.accept(stops, baseline, proposed, candidate, { strategy: 'workload' }), true);
  assert.deepEqual({ stops, baseline }, before);
  proposed[0].position.lat = 5;
  proposed[0].routePosition.lat = 5;
  assert.deepEqual({ stops, baseline }, before);
});

test('refinement considers all 41 stops globally, including later API chunks and a movable open destination', () => {
  const ordered = Array.from({ length: 41 }, (_, index) => stop(String(index).padStart(2, '0'), 0, index * 0.0002));
  const adverse = [ordered[0], ...ordered.slice(1).reverse()];
  const baseline = road(adverse), proposed = propose(adverse, baseline);
  assert.deepEqual(ids(proposed), ids(ordered));
  assert.equal(new Set(ids(proposed)).size, 41);
  assert.equal(proposed[0].key, adverse[0].key);
  assert.notEqual(proposed.at(-1).key, adverse.at(-1).key);
  assert.equal(proposed.reduce((sum, row) => sum + row.count, 0), 41);
  assert.equal(api.accept(adverse, baseline, proposed, road(proposed)), true);
});

test('parallel streets farther than 10 meters are not mistaken for a future stop access', () => {
  const stops = [stop('a', 0, 0), stop('b', 0, 0.003), stop('parallel', 0.0002, 0.001)];
  const baseline = road(stops, { paths: [[point(0, 0), point(0, 0.003)], [point(0, 0.003), point(0.0002, 0.003), point(0.0002, 0.001)]] });
  const proposed = propose(stops, baseline);
  assert.deepEqual(ids(proposed), ids(stops));
});

test('workload resolves coincident access ties by surveys while short preserves the basal order', () => {
  const stops = [stop('a', 0, 0), stop('far', 0, 0.003), stop('small', 0, 0.001, 1), stop('large', 0, 0.001, 20)];
  const baseline = road(stops);
  assert.deepEqual(ids(propose(stops, baseline)), ['a', 'small', 'large', 'far']);
  assert.deepEqual(ids(propose(stops, baseline, { strategy: 'workload' })), ['a', 'large', 'small', 'far']);
});

test('round trips preserve origin and every service stop exactly once', () => {
  const stops = [stop('start', 0, 0), stop('far', 0, 0.004), stop('near', 0, 0.001, 4), stop('middle', 0, 0.003)];
  const baseline = road(stops, { roundTrip: true });
  const proposed = propose(stops, baseline, { roundTrip: true });
  assert.deepEqual(ids(proposed), ['start', 'near', 'middle', 'far']);
  assert.equal(proposed.length, stops.length);
  assert.equal(new Set(ids(proposed)).size, stops.length);
  const candidate = road(proposed, { roundTrip: true });
  const assessed = api.assess(proposed, candidate, { roundTrip: true });
  const expected = candidate.legs.slice(0, -1).reduce((state, leg) => {
    state.distance += leg.distanceMeters;
    state.weighted += state.distance * proposed.find(stop => stop.key === leg.toKey).count / 7;
    return state;
  }, { distance: 0, weighted: 0 });
  assert.ok(Math.abs(assessed.weightedArrival - expected.weighted) < 0.0001);
  assert.equal(api.accept(stops, baseline, proposed, candidate, { roundTrip: true, strategy: 'workload' }), true);
});

test('polyline vertices, shared chunk endpoints and stationary legs do not create repeated street meters', () => {
  const stops = [stop('a', 0, 0), stop('b', 0, 0.001), stop('same', 0, 0.001), stop('c', 0, 0.002)];
  const result = road(stops, { paths: [[point(0, 0), point(0, 0.0001), point(0, 0.0005), point(0, 0.001)], [point(0, 0.001), point(0, 0.001)], [point(0, 0.001), point(0, 0.0014), point(0, 0.002)]] });
  assert.equal(api.assess(stops, result).repeatMeters, 0);
  assert.deepEqual(ids(propose(stops, result)), ids(stops));
});

test('repetition is detected independently of added collinear path vertices', () => {
  const stops = [stop('a', 0, 0), stop('b', 0, 0.003), stop('c', 0, 0.001)];
  const simple = road(stops);
  const subdivided = road(stops, { paths: [[point(0, 0), point(0, 0.0003), point(0, 0.0017), point(0, 0.003)], [point(0, 0.003), point(0, 0.0028), point(0, 0.0014), point(0, 0.001)]] });
  assert.ok(Math.abs(api.assess(stops, simple).repeatMeters - api.assess(stops, subdivided).repeatMeters) < 0.001);
});

test('a crossing on a different street axis does not count as traveling the same road twice', () => {
  const stops = [stop('a', 0, -0.001), stop('b', 0, 0.001), stop('c', 0.001, 0), stop('d', -0.001, 0)];
  const result = road(stops, { paths: [[point(0, -0.001), point(0, 0.001)], [point(0, 0.001), point(0.001, 0.001), point(0.001, 0)], [point(0.001, 0), point(-0.001, 0)]] });
  assert.equal(api.assess(stops, result).repeatMeters, 0);
});

test('a worse actual Google distance is rejected even when the proposed geometry looks better', () => {
  const stops = [stop('a', 0, 0), stop('far', 0, 0.003), stop('middle', 0, 0.001)];
  const baseline = road(stops), proposed = propose(stops, baseline), candidate = road(proposed);
  candidate.distanceMeters = baseline.distanceMeters + 2;
  assert.equal(api.accept(stops, baseline, proposed, candidate), false);
  assert.equal(api.accept(stops, baseline, proposed, candidate, { strategy: 'workload' }), false);
});

test('additional repeated road is rejected even with a lower reported distance', () => {
  const stops = [stop('a', 0, 0), stop('b', 0, 0.001), stop('c', 0, 0.002)];
  const baseline = road(stops), candidateStops = [stops[0], stops[2], stops[1]];
  const candidate = road(candidateStops, { distances: [100, 50] });
  assert.ok(candidate.distanceMeters < baseline.distanceMeters);
  assert.ok(api.assess(candidateStops, candidate).repeatMeters > 40);
  assert.equal(api.accept(stops, baseline, candidateStops, candidate), false);
});

test('a shorter road result is rejected if the actual travel time increases by more than two seconds', () => {
  const stops = [stop('a', 0, 0), stop('far', 0, 0.003), stop('middle', 0, 0.001)];
  const baseline = road(stops), proposed = propose(stops, baseline), candidate = road(proposed);
  baseline.durationSeconds = 400;
  candidate.durationSeconds = 403;
  assert.ok(candidate.distanceMeters < baseline.distanceMeters);
  assert.equal(api.accept(stops, baseline, proposed, candidate), false);
  assert.equal(api.accept(stops, baseline, proposed, candidate, { strategy: 'workload' }), false);
  candidate.durationSeconds = 401;
  assert.equal(api.accept(stops, baseline, proposed, candidate), true);
});

test('workload rejects a shorter nonrepeating route that postpones the high-survey stop', () => {
  const stops = [stop('a', 0, 0), stop('many', 0.001, 0, 100), stop('few', 0, 0.001)];
  const baseline = road(stops, { distances: [100, 200] });
  const candidateStops = [stops[0], stops[2], stops[1]], candidate = road(candidateStops, { distances: [150, 100] });
  assert.ok(api.assess(candidateStops, candidate).weightedArrival > api.assess(stops, baseline).weightedArrival);
  assert.equal(api.accept(stops, baseline, candidateStops, candidate), true);
  assert.equal(api.accept(stops, baseline, candidateStops, candidate, { strategy: 'workload' }), false);
});

test('missing legs, keys, access points and invalid coordinates keep the baseline through null/false', () => {
  const stops = [stop('a', 0, 0), stop('b', 0, 0.001), stop('c', 0, 0.002)];
  const good = road(stops);
  const malformed = [null, { ...good, legs: [] }, { ...good, legs: good.legs.slice(0, 1) }];
  for (const mutate of [leg => { delete leg.endLocation; }, leg => { leg.toKey = 'other'; }, leg => { leg.path = []; }, leg => { leg.startLocation.lat = NaN; }]) {
    const bad = structuredClone(good); mutate(bad.legs[0]); malformed.push(bad);
  }
  for (const bad of malformed) {
    assert.equal(propose(stops, bad), null);
    assert.equal(api.assess(stops, bad), null);
    assert.equal(api.accept(stops, good, stops, bad), false);
  }
  assert.equal(propose([...stops, stops[0]], good), null);
  assert.equal(propose(stops, good, { roundTrip: true }), null);
});

test('accept rejects changed counts, duplicate or omitted stops, a changed origin and no real improvement', () => {
  const stops = [stop('a', 0, 0), stop('b', 0, 0.001), stop('c', 0, 0.002)];
  const baseline = road(stops);
  for (const proposed of [[stops[1], stops[0], stops[2]], [stops[0], stops[1]], [stops[0], stops[1], stops[1]], [stops[0], { ...stops[1], count: 10 }, stops[2]]]) {
    assert.equal(api.accept(stops, baseline, proposed, road(proposed)), false);
  }
  assert.equal(api.accept(stops, baseline, stops, baseline), false);
});

test('a zero-distance leg with one coordinate still represents both visits at a shared access',()=>{
  const stops=[stop('a',0,0),stop('b',0,0),stop('c',0,.002)];
  const baseline=road(stops);
  baseline.legs[0].path=[point(0,0)];
  const proposed=propose(stops,baseline);
  assert.deepEqual(ids(proposed),['a','b','c']);
  assert.equal(api.assess(stops,baseline).repeatMeters,0);
  baseline.legs[0].distanceMeters=10;
  assert.equal(propose(stops,baseline),null);
});
