const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/survey-route-playback.js'), 'utf8'), context);
const { prepare, frame, comet } = context.window.MGPCSurveyRoutePlayback;
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

test('comet fades and narrows behind the head with eight contiguous bands of equal traveled distance', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.0001), point(0, 0.002)]]);
  const result = comet(prepared, 0.75, 90), current = frame(prepared, 0.75, 90);
  assert.equal(result.bands.length, 8);
  assert.deepEqual(plain(result.head), plain(current.head));
  assert.deepEqual(plain(result.path), plain(current.path));
  assert.equal(result.bearing, current.bearing);
  assert.equal(result.bands[0].opacity, 0.06);
  assert.equal(result.bands[0].widthScale, 0.2);
  assert.equal(result.bands.at(-1).opacity, 0.95);
  assert.equal(result.bands.at(-1).widthScale, 1);
  assert.deepEqual(plain(result.bands[0].path[0]), plain(result.path[0]));
  assert.deepEqual(plain(result.bands.at(-1).path.at(-1)), plain(result.head));
  result.bands.forEach((band, index) => {
    near(prepare([band.path]).totalMeters, 90 / 8, 0.00001);
    for (let i = 1; i < band.path.length; i += 1) assert.ok(band.path[i].lng > band.path[i - 1].lng);
    if (!index) return;
    const previous = result.bands[index - 1];
    assert.deepEqual(plain(previous.path.at(-1)), plain(band.path[0]));
    assert.ok(band.opacity > previous.opacity);
    assert.ok(band.widthScale > previous.widthScale);
  });
});

test('comet bands preserve intermediate corners without drawing diagonal shortcuts or repeating full tails', () => {
  const points = [point(0, 0), point(0, 0.001), point(0.001, 0.001), point(0.001, 0.003)];
  const prepared = prepare([points]), result = comet(prepared, 1, 10000, 3);
  const visible = result.bands.flatMap(band => band.path);
  for (const corner of points) assert.ok(visible.some(p => p.lat === corner.lat && p.lng === corner.lng));
  let total = 0;
  result.bands.forEach((band, index) => {
    const length = prepare([band.path]).totalMeters;
    near(length, prepared.totalMeters / 3, 0.00001);
    total += length;
    if (index) assert.deepEqual(plain(result.bands[index - 1].path.at(-1)), plain(band.path[0]));
  });
  near(total, prepared.totalMeters, 0.00001);
});

test('comet resets all bands at U-turns and only paints the currently traveled direction', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.002), point(0, 0.001), point(0, 0)]]);
  const boundary = prepared.segments[0].turnDistances[0] / prepared.totalMeters;
  const turning = comet(prepared, boundary, 10000);
  assert.equal(turning.bands.length, 0);
  near(turning.head.lng, 0.002);
  const returning = comet(prepared, 0.8, 10000);
  near(returning.bands[0].path[0].lng, 0.002);
  near(returning.head.lng, 0.0008);
  near(returning.bearing, 270);
  for (const band of returning.bands) {
    for (let i = 1; i < band.path.length; i += 1) assert.ok(band.path[i].lng < band.path[i - 1].lng);
    assert.ok(band.path.every(p => p.lng >= returning.head.lng && p.lng <= 0.002));
  }
});

test('comet never carries a band across a disconnected path boundary', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.001)], [], [point(0, 1), point(0, 1.001)]]);
  const boundary = prepared.offsets[1] / prepared.totalMeters;
  const atBoundary = comet(prepared, boundary, 10000);
  assert.equal(atBoundary.segmentIndex, 2);
  assert.deepEqual(plain(atBoundary.head), point(0, 1));
  assert.equal(atBoundary.bands.length, 0);
  const result = comet(prepared, boundary + 0.1, 10000);
  assert.equal(result.segmentIndex, 2);
  assert.equal(result.bands.length, 8);
  assert.ok(result.bands.every(band => band.path.every(p => p.lng >= 1 && p.lng <= result.head.lng)));
});

test('comet retains the head without bands for empty, initial, stationary and zero-tail frames', () => {
  const empty = comet(prepare([]), 0.5);
  assert.deepEqual(plain(empty), { path: [], head: null, progress: 0.5, segmentIndex: -1, bearing: 0, bands: [] });
  const stationary = comet(prepare([[point(19, -99), point(19, -99)]]), 1);
  assert.equal(stationary.bands.length, 0);
  assert.deepEqual(plain(stationary.head), point(19, -99));
  const prepared = prepare([[point(0, 0), point(0, 0.001)]]);
  assert.equal(comet(prepared, 0).bands.length, 0);
  const zeroTail = comet(prepared, 0.5, 0);
  assert.equal(zeroTail.bands.length, 0);
  near(zeroTail.head.lng, 0.0005);
});

test('comet copies prepared coordinates and does not alias band boundaries or the frame head', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.001), point(0.001, 0.001)]]);
  const before = plain(prepared), result = comet(prepared, 0.9, 500);
  const frameBefore = plain({ path: result.path, head: result.head }), followingStart = plain(result.bands[1].path[0]);
  result.bands[0].path.at(-1).lat = 88;
  assert.deepEqual(plain(result.bands[1].path[0]), followingStart);
  result.bands.at(-1).path.at(-1).lng = 77;
  assert.deepEqual(plain({ path: result.path, head: result.head }), frameBefore);
  assert.deepEqual(plain(prepared), before);
});

test('comet accepts a single bright band and validates count, progress and tail input', () => {
  const prepared = prepare([[point(0, 0), point(0, 0.001)]]);
  const single = comet(prepared, 1, 50, 1);
  assert.equal(single.bands.length, 1);
  assert.equal(single.bands[0].opacity, 0.95);
  assert.equal(single.bands[0].widthScale, 1);
  assert.deepEqual(plain(single.bands[0].path), plain(single.path));
  for (const count of [0, -1, 1.5, NaN, Infinity, '8']) assert.throws(() => comet(prepared, 1, 50, count), /bandas/);
  assert.throws(() => comet(prepared, 2, 50), /avance/);
  assert.throws(() => comet(prepared, 0.5, -1), /cola/);
});
