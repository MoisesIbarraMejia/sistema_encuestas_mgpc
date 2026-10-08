const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/survey-allocation.js'), 'utf8'), context);
const allocate = (rows, total) => JSON.parse(JSON.stringify(context.window.MGPCSurveyAllocation.allocate(rows, total)));
const counts = result => Object.fromEntries(result.rows.map(row => [row.key, row.count]));

test('largest remainders preserve the sample total and proportion of the considered population', () => {
  const result = allocate([
    { key: '5515:1', weight: 101 },
    { key: '5515:2', weight: 202 },
    { key: '5515:3', weight: 303 }
  ], 20);
  assert.deepEqual(counts(result), { '5515:1': 3, '5515:2': 7, '5515:3': 10 });
  assert.equal(result.rows.reduce((sum, row) => sum + row.count, 0), 20);
  assert.equal(result.assigned, 20);
  assert.equal(result.unassigned, 0);
  assert.equal(result.weightTotal, 606);
  assert.equal(result.rows[0].factor, 101 / 606);
  assert.equal(result.rows[0].quota, 20 * (101 / 606));
  assert.ok(result.rows.every(row => Number.isInteger(row.count) && row.count >= 0));
});

test('equal remainders are resolved by key regardless of input order, while output keeps input order', () => {
  const rows = [{ key: 'c', weight: 1 }, { key: 'a', weight: 1 }, { key: 'b', weight: 1 }];
  const first = allocate(rows, 2);
  const reversed = allocate([...rows].reverse(), 2);
  assert.deepEqual(counts(first), { c: 0, a: 1, b: 1 });
  assert.deepEqual(counts(first), counts(reversed));
  assert.deepEqual(first.rows.map(row => row.key), ['c', 'a', 'b']);
});

test('zero weights never receive surveys, including when positive rows hit capacity', () => {
  const result = allocate([{ key: 'empty', weight: 0, capacity: 100 }, { key: 'full', weight: 5, capacity: 1 }], 5);
  assert.deepEqual(counts(result), { empty: 0, full: 1 });
  assert.equal(result.assigned, 1);
  assert.equal(result.unassigned, 4);
  assert.equal(result.rows[0].factor, 0);
  assert.equal(result.rows[0].quota, 0);
});

test('capacity saturation redistributes over several rounds without changing original quotas', () => {
  const result = allocate([
    { key: 'a', weight: 80, capacity: 2 },
    { key: 'b', weight: 15, capacity: 3 },
    { key: 'c', weight: 5, capacity: 20 }
  ], 10);
  assert.deepEqual(counts(result), { a: 2, b: 3, c: 5 });
  assert.deepEqual(result.rows.map(row => row.quota), [8, 1.5, 0.5]);
  assert.equal(result.unassigned, 0);
});

test('insufficient combined capacity returns explicit unassigned surveys', () => {
  const result = allocate([{ key: 'a', weight: 2, capacity: 2 }, { key: 'b', weight: 1, capacity: 1 }], 10);
  assert.deepEqual(counts(result), { a: 2, b: 1 });
  assert.equal(result.total, 10);
  assert.equal(result.assigned, 3);
  assert.equal(result.unassigned, 7);
});

test('zero capacity is excluded while an omitted capacity permits proportional redistribution', () => {
  const result = allocate([{ key: 'a', weight: 100, capacity: 0 }, { key: 'b', weight: 10 }, { key: 'c', weight: 10 }], 5);
  assert.deepEqual(counts(result), { a: 0, b: 3, c: 2 });
  assert.equal(result.unassigned, 0);
  assert.equal(result.weightTotal, 120);
  assert.equal(result.rows[0].factor, 100 / 120);
});

test('empty input, zero sample, and all-zero weights have explicit totals', () => {
  assert.deepEqual(allocate([], 3), { rows: [], total: 3, assigned: 0, unassigned: 3, weightTotal: 0 });
  assert.deepEqual(allocate([], 0), { rows: [], total: 0, assigned: 0, unassigned: 0, weightTotal: 0 });
  const zero = allocate([{ key: 'a', weight: 6 }], 0);
  assert.equal(zero.rows[0].count, 0);
  assert.equal(zero.rows[0].quota, 0);
  assert.equal(zero.rows[0].factor, 1);
  assert.equal(allocate([{ key: 'a', weight: 0 }, { key: 'b', weight: 0 }], 7).unassigned, 7);
});

test('input rows and metadata are not mutated', () => {
  const detail = Object.freeze({ section: '5515' });
  const rows = Object.freeze([Object.freeze({ key: 'a', weight: 12.75, capacity: 13, detail, name: 'Manzana 1' })]);
  const result = context.window.MGPCSurveyAllocation.allocate(rows, 3);
  assert.equal(result.rows[0].name, 'Manzana 1');
  assert.equal(result.rows[0].detail, detail);
  assert.notEqual(result.rows[0], rows[0]);
  assert.equal(Object.hasOwn(rows[0], 'count'), false);
  result.rows[0].name = 'Otro nombre';
  assert.equal(rows[0].name, 'Manzana 1');
});

test('invalid totals, weights, capacities, and duplicate keys are rejected', () => {
  const valid = [{ key: 'a', weight: 1 }];
  for (const total of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(() => allocate(valid, total), /entero no negativo/);
  }
  for (const weight of [-1, NaN, Infinity, '2', null, undefined]) {
    assert.throws(() => allocate([{ key: 'a', weight }], 1), /peso/);
  }
  for (const capacity of [-1, 1.5, Infinity, null, '3']) {
    assert.throws(() => allocate([{ key: 'a', weight: 1, capacity }], 1), /capacidad/);
  }
  assert.throws(() => allocate(null, 1), /arreglo/);
  for (const row of [null, [], 5]) assert.throws(() => allocate([row], 1), /objeto/);
  for (const key of ['', '  ', 1, null]) assert.throws(() => allocate([{ key, weight: 1 }], 1), /clave/);
  assert.throws(() => allocate([{ key: 'a', weight: 1 }, { key: 'a', weight: 2 }], 1), /clave/);
  assert.throws(() => allocate([{ key: 'a', weight: 1e308 }, { key: 'b', weight: 1e308 }], 1), /suma/);
});

test('many fractional populations keep integer counts within capacity and exactly preserve feasible totals', () => {
  for (let total = 1; total <= 100; total++) {
    const rows = Array.from({ length: 23 }, (_, index) => ({
      key: String(index).padStart(2, '0'), weight: ((index * 17) % 29) / 7, capacity: (index % 8) + 1
    }));
    const result = allocate(rows, total);
    const capacity = rows.reduce((sum, row) => sum + (row.weight ? row.capacity : 0), 0);
    assert.equal(result.assigned, Math.min(total, capacity));
    assert.equal(result.assigned + result.unassigned, total);
    assert.equal(result.rows.reduce((sum, row) => sum + row.count, 0), result.assigned);
    assert.ok(result.rows.every(row => Number.isInteger(row.count) && row.count >= 0 && row.count <= row.capacity));
  }
});
