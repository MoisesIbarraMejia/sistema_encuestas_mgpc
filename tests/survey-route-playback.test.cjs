const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/survey-route-playback.js'), 'utf8'), context);
const { prepare, frame } = context.window.MGPCSurveyRoutePlayback;
const plain = value => JSON.parse(JSON.stringify(value));
const point = (lat, lng) => ({ lat, lng });
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('prepare copies paths and sums traveled meters without adding links between disconnected segments', () => {
  const paths = [[point(0, 0), point(0, 1)], [], [point(0, 50), point(0, 51)]];
  const before = structuredClone(paths), prepared = prepare(paths);
  assert.equal(prepared.segments.length, 2);
  assert.deepEqual(plain(prepared.segments.map(segment => segment.sourceIndex)), [0, 2]);
  near(prepared.totalMeters, 2 * 111195.0802335329, 0.001);
  near(prepared.offsets[1], prepared.segments[0].lengthMeters);
  assert.deepEqual(paths, before);
  prepared.segments[0].points[0].lat = 10;
  assert.deepEqual(paths, before);
});

test('progress follows distance rather than vertex count on irregular legs', () => {
  const prepared = prepare([[point(0, 0), point(0, 1), point(0, 10)]]);
  const result = frame(prepared, 0.5, 111195.0802335329);
  near(result.head.lng, 5);
  near(result.path[0].lng, 4);
  assert.equal(result.segmentIndex, 0);
  assert.equal(result.progress, 0.5);
  near(result.bearing, 90);
  assert.equal(result.path.length, 2);
});

test('tail retains intermediate corners and interpolates both ends at meter offsets', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.001), point(0.001, 0.001)]]);
  const result = frame(prepared, 0.75, prepared.totalMeters / 2);
  near(result.path[0].lat, 0);
  near(result.path[0].lng, 0.0005);
  assert.deepEqual(plain(result.path[1]), point(0, 0.001));
  near(result.head.lat, 0.0005);
  near(result.head.lng, 0.001);
  near(result.bearing, 0);
});

test('at the final frame the head reaches the final coordinate with no extrapolation', () => {
  const points = [point(19.3, -99.1), point(19.301, -99.099), point(19.302, -99.098)];
  const prepared = prepare([points]), result = frame(prepared, 1, 25);
  assert.deepEqual(plain(result.head), points.at(-1));
  assert.deepEqual(plain(result.path.at(-1)), points.at(-1));
  assert.ok(result.path[0].lat < result.head.lat);
  assert.ok(result.path[0].lat > points[1].lat);
  near(result.progress, 1);
});

test('starting frame and zero tail expose one head with a usable tangent bearing', () => {
  const points = [point(0, 0), point(0, 0.001)];
  const prepared = prepare([points]);
  const initial = frame(prepared, 0, 100), middle = frame(prepared, 0.5, 0);
  assert.deepEqual(plain(initial.path), [points[0]]);
  assert.deepEqual(plain(initial.head), points[0]);
  near(initial.bearing, 90);
  assert.equal(middle.path.length, 1);
  near(middle.head.lng, 0.0005);
  near(middle.bearing, 90);
});

test('consecutive duplicate points collapse, while empty and stationary paths remain safe', () => {
  const a = point(19, -99), b = point(19.001, -99);
  const prepared = prepare([[a, a, b, b]]);
  assert.equal(prepared.segments[0].points.length, 2);
  assert.ok(Number.isFinite(frame(prepared, 0.5).bearing));
  for (const progress of [0, 0.5, 1]) {
    const stationary = frame(prepare([[a, a, a]]), progress);
    assert.deepEqual(plain(stationary.path), [a]);
    assert.deepEqual(plain(stationary.head), a);
    assert.equal(stationary.bearing, 0);
    assert.deepEqual(plain(frame(prepare([[], []]), progress)), { path: [], head: null, progress, segmentIndex: -1, bearing: 0 });
  }
});

test('segment transitions clear the previous tail instead of inventing a connector', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.001)], [point(0, 1), point(0, 1.001)]]);
  const boundary = prepared.offsets[1] / prepared.totalMeters;
  const atBoundary = frame(prepared, boundary, 10000);
  assert.equal(atBoundary.segmentIndex, 1);
  assert.deepEqual(plain(atBoundary.path), [point(0, 1)]);
  const afterward = frame(prepared, boundary + 0.1, 10000);
  assert.equal(afterward.segmentIndex, 1);
  assert.ok(afterward.path.every(coordinate => coordinate.lng >= 1));
  assert.ok(afterward.head.lng < 1.001);
  const final = frame(prepared, 1, 10000);
  assert.deepEqual(plain(final.path), [point(0, 1), point(0, 1.001)]);
});

test('a U-turn trims the outward path so a returning tail does not cover both directions', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.002), point(0, 0.001), point(0, 0)]]);
  assert.equal(prepared.segments[0].turnDistances.length, 1);
  const outward = frame(prepared, 0.25, 10000);
  near(outward.path[0].lng, 0);
  near(outward.head.lng, 0.001);
  const returning = frame(prepared, 0.8, 10000);
  near(returning.path[0].lng, 0.002);
  near(returning.head.lng, 0.0008);
  near(returning.bearing, 270);
  for (let i = 1; i < returning.path.length; i += 1) assert.ok(returning.path[i].lng < returning.path[i - 1].lng);
});

test('only the last reached sharp turn limits the tail and ordinary crossings are not deduplicated', () => {
  const paths = [point(0, 0), point(0, 0.002), point(0, 0.001), point(0, 0.003)];
  const prepared = prepare([paths]);
  assert.equal(prepared.segments[0].turnDistances.length, 2);
  const final = frame(prepared, 1, 10000);
  assert.deepEqual(plain(final.path), [paths[2], paths[3]]);
  const crossing = [point(-0.001, -0.001), point(0.001, 0.001), point(0.002, 0.001), point(0.002, -0.001), point(0.001, -0.001), point(-0.001, 0.001)];
  const crossed = prepare([crossing]);
  assert.equal(crossed.segments[0].turnDistances.length, 0);
  assert.deepEqual(plain(frame(crossed, 1, 10000).path), crossing);
});

test('interpolation follows the short longitude interval across the antimeridian', () => {
  const prepared = prepare([[point(0, 179), point(0, -179)]]);
  near(prepared.totalMeters, 2 * 111195.0802335329, 0.001);
  near(Math.abs(frame(prepared, 0.5, 0).head.lng), 180);
  near(frame(prepared, 0.75, 0).head.lng, -179.5);
});

test('frames leave prepared data unchanged and returned coordinates do not alias it', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.001), point(0.001, 0.001)]]);
  const before = plain(prepared);
  for (const progress of [0, 0.2, 0.7, 1]) {
    const result = frame(prepared, progress, 500);
    result.head.lat = 50;
    result.path.forEach(coordinate => { coordinate.lng = 50; });
  }
  assert.deepEqual(plain(prepared), before);
});

test('rejects malformed paths, nonfinite coordinates, invalid progress and invalid tail distances', () => {
  for (const paths of [null, {}, [null], [[null]], [[point(NaN, 0)]], [[point(0, Infinity)]], [[point(91, 0)]], [[point(0, 181)]], [[point('19', 0)]]]) {
    assert.throws(() => prepare(paths), /tramos|tramo|coordenadas/);
  }
  assert.throws(() => frame({}, 0), /prepara/);
  const prepared = prepare([[point(0, 0), point(0, 0.001)]]);
  for (const progress of [-0.1, 1.1, NaN, Infinity, '0.5', undefined]) assert.throws(() => frame(prepared, progress), /avance/);
  for (const tail of [-1, NaN, Infinity, '10']) assert.throws(() => frame(prepared, 0.5, tail), /cola/);
});
