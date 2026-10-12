const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/survey-route-plan.js'), 'utf8'), context);
const api = context.window.MGPCSurveyRoutePlan;
const plain = value => JSON.parse(JSON.stringify(value));
const plan = (rows, options) => plain(api.plan(rows, options));
const links = (stops, options) => plain(api.segmentLinks(stops, options));
const row = (key, lat, lng, count = 1) => ({ key, position: { lat, lng }, count, kind: 'block', name: key });
const ids = result => result.stops.map(stop => stop.key);
const line = count => Array.from({ length: count }, (_, i) => row(String(i + 1).padStart(2, '0'), 19.3, -99.2 + i * 0.001));

test('visits every positive allocation exactly once and preserves survey totals and source metadata', () => {
  const rows = [...line(35), row('zero', 20, -99, 0), row('negative', 20, -99, -1)];
  rows[3].count = 23;
  rows[3].section = '1512';
  const before = structuredClone(rows);
  const result = plan(rows);
  assert.equal(result.stops.length, 35);
  assert.equal(new Set(ids(result)).size, 35);
  assert.deepEqual([...ids(result)].sort(), rows.filter(item => item.count > 0).map(item => item.key).sort());
  assert.equal(result.stops.reduce((sum, stop) => sum + stop.count, 0), 57);
  assert.equal(result.stops.find(stop => stop.key === '04').section, '1512');
  assert.deepEqual(result.stops.map(stop => stop.order), Array.from({ length: 35 }, (_, i) => i + 1));
  assert.deepEqual(rows, before);
  result.stops[0].position.lat = 0;
  assert.deepEqual(rows, before);
});

test('keeps the selected starting point for open and return routes under either strategy', () => {
  const rows = line(14);
  for (const strategy of ['short', 'workload']) {
    for (const roundTrip of [false, true]) {
      const result = plan(rows, { startKey: '07', strategy, roundTrip });
      assert.equal(result.stops[0].key, '07');
      assert.equal(result.stops.length, rows.length);
      assert.equal(result.roundTrip, roundTrip);
      assert.equal(result.strategy, strategy);
    }
  }
});

test('automatic routes are deterministic across source order and start at a geographic extreme', () => {
  const rows = [row('middle', 19.5, -99.2), row('west', 19.5, -99.21), row('east', 19.5, -99.19), row('north', 19.51, -99.2), row('south', 19.49, -99.2)];
  const forward = plan(rows), reverse = plan([...rows].reverse());
  assert.deepEqual(forward, reverse);
  assert.notEqual(forward.stops[0].key, 'middle');
});

test('handles no surveys, a single stop and coincident coordinates without invalid distances', () => {
  assert.deepEqual(plan([]), { stops: [], distanceMeters: 0, initialDistanceMeters: 0, strategy: 'short', roundTrip: false });
  assert.equal(plan([{ key: 'unused', count: 0 }]).stops.length, 0);
  assert.equal(plan([row('one', 19, -99)], { roundTrip: true }).distanceMeters, 0);
  const result = plan([row('b', 19, -99), row('a', 19, -99), row('c', 19, -99)], { roundTrip: true });
  assert.deepEqual(ids(result), ['a', 'b', 'c']);
  assert.equal(result.distanceMeters, 0);
  assert.equal(result.initialDistanceMeters, 0);
});

test('uses haversine meters and counts the return leg only when requested', () => {
  const rows = [row('a', 0, 0), row('b', 0, 1)];
  const open = plan(rows), circuit = plan(rows, { roundTrip: true });
  assert.ok(Math.abs(open.distanceMeters - 111195.0802335329) < 0.001);
  assert.equal(circuit.distanceMeters, open.distanceMeters * 2);
  assert.equal(circuit.stops.length, 2);
  const antipodal = plan([row('a', 90, 180), row('b', -90, -180)]);
  assert.ok(Number.isFinite(antipodal.distanceMeters));
});

test('short routes improve or retain the stable baseline, including disconnected groups', () => {
  const rows = [row('a', 19.3, -99.1), row('b', 19.8, -99.1), row('c', 19.31, -99.11), row('d', 19.81, -99.11), row('e', 19.305, -99.105), row('f', 19.805, -99.105)];
  for (const roundTrip of [false, true]) {
    const result = plan(rows, { roundTrip, startKey: 'a' });
    assert.ok(result.distanceMeters < result.initialDistanceMeters);
    assert.equal(result.stops.length, rows.length);
    assert.ok(result.distanceMeters > 0);
  }
});

test('workload alternative can reach a high-survey stop earlier while retaining all stops', () => {
  const rows = [row('a', 0, 0), row('b', 0.001, 0), row('c', 0.002, 0.001, 100)];
  const result = plan(rows, { strategy: 'workload', startKey: 'a' });
  assert.deepEqual(ids(result), ['a', 'c', 'b']);
  assert.equal(result.stops.reduce((sum, stop) => sum + stop.count, 0), 102);
});

test('rejects invalid identities, active coordinates, counts, modes and unknown starting stops', () => {
  assert.throws(() => plan(null), /arreglo/);
  assert.throws(() => plan([row('', 0, 0)]), /clave/);
  assert.throws(() => plan([row('same', 0, 0), row('same', 1, 1)]), /clave/);
  for (const invalidCount of [NaN, Infinity, 1.5, '1', undefined]) {
    assert.throws(() => plan([{ ...row('a', 0, 0), count: invalidCount }]), /enteros/);
  }
  for (const position of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: NaN, lng: 0 }, { lat: '19', lng: -99 }, null]) {
    assert.throws(() => plan([{ ...row('a', 0, 0), position }]), /coordenadas/);
  }
  assert.throws(() => plan(line(3), { startKey: 'missing' }), /inicio/);
  assert.throws(() => plan(line(3), { strategy: 'random' }), /estrategia/);
  assert.throws(() => links(line(3), { travelMode: 'flying' }), /traslado/);
});

test('seven stops become continuous segments with no more than three intermediate waypoints', () => {
  const stops = plan(line(7), { startKey: '01' }).stops;
  const result = links(stops);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(link => link.stopKeys), [['01', '02', '03', '04', '05'], ['05', '06', '07']]);
  assert.deepEqual(result.map(link => [link.fromOrder, link.toOrder]), [[1, 5], [5, 7]]);
  for (const link of result) {
    const parsed = new URL(link.url);
    assert.equal(parsed.origin, 'https://www.google.com');
    assert.equal(parsed.pathname, '/maps/dir/');
    assert.equal(parsed.searchParams.get('api'), '1');
    assert.equal(parsed.searchParams.get('travelmode'), 'walking');
    assert.ok(parsed.searchParams.get('waypoints').split('|').length <= 3);
    assert.ok(link.url.includes('%2C'));
    assert.ok(link.url.length < 2048);
  }
  assert.ok(result[0].url.includes('%7C'));
});

test('30 stops have no hidden cutoff and segmented circuits include the final return leg', () => {
  const stops = plan(line(30), { startKey: '01' }).stops;
  const before = structuredClone(stops);
  for (const roundTrip of [false, true]) {
    const result = links(stops, { roundTrip, travelMode: 'driving' });
    assert.equal(result.length, 8);
    const visited = [...result[0].stopKeys];
    result.slice(1).forEach((segment, i) => {
      assert.equal(result[i].stopKeys.at(-1), segment.stopKeys[0]);
      visited.push(...segment.stopKeys.slice(1));
    });
    assert.deepEqual(visited, roundTrip ? [...ids({ stops }), stops[0].key] : ids({ stops }));
    assert.ok(result.every(link => link.stopKeys.length <= 5));
    assert.equal(result.at(-1).roundTrip, roundTrip);
    assert.equal(result.at(-1).toOrder, roundTrip ? 1 : 30);
    assert.ok(result.every(link => new URL(link.url).searchParams.get('travelmode') === 'driving'));
  }
  assert.deepEqual(stops, before);
});

test('empty and single-stop plans need no navigation segments; two stops need no waypoints', () => {
  assert.deepEqual(links([]), []);
  assert.deepEqual(links(line(1), { roundTrip: true }), []);
  const result = links(line(2));
  assert.equal(result.length, 1);
  assert.equal(new URL(result[0].url).searchParams.has('waypoints'), false);
});

test('Maps links follow the accepted road references instead of returning to the block centroids', () => {
  const stops=line(3).map((stop,index)=>({...stop,routePosition:{lat:19+index/1000,lng:-99}}));
  const parsed=new URL(links(stops)[0].url);
  assert.equal(parsed.searchParams.get('origin'),'19,-99');
  assert.equal(parsed.searchParams.get('waypoints'),'19.001,-99');
  assert.equal(parsed.searchParams.get('destination'),'19.002,-99');
  stops[1].routePosition.lat=NaN;
  assert.throws(()=>links(stops),/referencia vial/);
});
