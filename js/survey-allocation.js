/* Proportional whole-survey allocation. No DOM, map, API or population mutation. */
(function (global) {
  'use strict';

  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const byKey = (a, b) => a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0;

  /**
   * Allocate a whole-number sample by largest remainders, with optional caps.
   * Weights describe the population considered; zero-weight rows get no surveys.
   * quota/factor describe the original ideal share, before capacity redistribution.
   * Input order and metadata are retained. Ties are resolved by key, not input order.
   */
  function allocate(rows, total) {
    if (!Array.isArray(rows)) throw new TypeError('Las filas deben ser un arreglo.');
    if (!integer(total)) throw new RangeError('El total de encuestas debe ser un entero no negativo.');

    const keys = new Set();
    let weightTotal = 0;
    const entries = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new TypeError('Cada fila debe ser un objeto.');
      }
      if (typeof row.key !== 'string' || !row.key.trim() || keys.has(row.key)) {
        throw new TypeError('Cada fila debe tener una clave de texto distinta y no vacía.');
      }
      if (typeof row.weight !== 'number' || !Number.isFinite(row.weight) || row.weight < 0) {
        throw new RangeError('El peso de cada fila debe ser un número finito no negativo.');
      }
      if (row.capacity !== undefined && !integer(row.capacity)) {
        throw new RangeError('La capacidad debe ser un entero no negativo.');
      }
      keys.add(row.key);
      weightTotal += row.weight;
      return { row: { ...row }, limit: row.capacity ?? total, count: 0 };
    });
    if (!Number.isFinite(weightTotal)) throw new RangeError('La suma de los pesos es demasiado grande.');

    let remaining = total;
    let active = entries.filter(entry => entry.row.weight > 0 && entry.limit > 0).sort(byKey);

    // Freeze capacities below their ideal share, then redistribute the remaining
    // surveys proportionally among the rows that can still receive them.
    while (remaining > 0 && active.length) {
      const activeWeight = active.reduce((sum, entry) => sum + entry.row.weight, 0);
      const shares = active.map(entry => ({ entry, value: remaining * (entry.row.weight / activeWeight) }));
      const saturated = shares.filter(share => share.value >= share.entry.limit);
      if (saturated.length) {
        const capped = new Set(saturated.map(share => share.entry));
        for (const { entry } of saturated) {
          entry.count = Math.min(entry.limit, remaining);
          remaining -= entry.count;
        }
        active = active.filter(entry => !capped.has(entry));
        continue;
      }

      for (const share of shares) {
        // The remaining budget also guards against floating-point rounding at
        // the upper safe-integer limit; assignments can never exceed the total.
        share.entry.count = Math.min(Math.floor(share.value), share.entry.limit, remaining);
        remaining -= share.entry.count;
        share.remainder = share.value - Math.floor(share.value);
      }
      shares.sort((a, b) => b.remainder - a.remainder || byKey(a.entry, b.entry));
      for (const { entry } of shares) {
        if (!remaining) break;
        if (entry.count < entry.limit) {
          entry.count += 1;
          remaining -= 1;
        }
      }
      break;
    }

    return {
      rows: entries.map(({ row, count }) => {
        const factor = weightTotal ? row.weight / weightTotal : 0;
        return { ...row, quota: total * factor, count, factor };
      }),
      total,
      assigned: total - remaining,
      unassigned: remaining,
      weightTotal
    };
  }

  global.MGPCSurveyAllocation = Object.freeze({ allocate });
})(window);
