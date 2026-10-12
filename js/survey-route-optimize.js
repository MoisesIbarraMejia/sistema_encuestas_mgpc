/* Conservative refinement using streets already returned by Google Routes. */
(function (global) {
  'use strict';
  const R = 6371008.8, RAD = Math.PI / 180;
  const ACCESS_RADIUS = 10, REPEAT_CELL = 6, MAX_CELLS = 120000;
  const validPoint = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const copyPoint = p => ({ lat: p.lat, lng: p.lng });

  function inspect(stops, result, roundTrip) {
    if (!Array.isArray(stops) || !stops.length || !result || !Array.isArray(result.legs) ||
        !Number.isFinite(result.distanceMeters) || result.distanceMeters < 0) return null;
    const keys = new Set();
    for (const stop of stops) {
      if (!stop || typeof stop.key !== 'string' || !stop.key || keys.has(stop.key) ||
          !Number.isSafeInteger(stop.count) || stop.count <= 0 || !validPoint(stop.position)) return null;
      keys.add(stop.key);
    }
    const count = stops.length - 1 + (roundTrip && stops.length > 1 ? 1 : 0);
    if (result.legs.length !== count) return null;
    const accesses = new Map();
    for (let i = 0; i < count; i += 1) {
      const leg = result.legs[i], from = stops[i % stops.length], to = stops[(i + 1) % stops.length];
      if (!leg || leg.fromKey !== from.key || leg.toKey !== to.key || !validPoint(leg.startLocation) ||
          !validPoint(leg.endLocation) || !Array.isArray(leg.path) || !leg.path.length ||
          !leg.path.every(validPoint) || !Number.isFinite(leg.distanceMeters) || leg.distanceMeters < 0 ||
          (leg.path.length === 1 && leg.distanceMeters > 0)) return null;
      if (i === 0) accesses.set(from.key, copyPoint(leg.startLocation));
      if (!accesses.has(to.key)) accesses.set(to.key, copyPoint(leg.endLocation));
    }
    if (stops.length > 1 && accesses.size !== stops.length) return null;
    const stableStops = [...stops].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const latitude = stableStops.reduce((sum, stop) => sum + stop.position.lat, 0) / stops.length;
    const origin = stops[0].position;
    const factor = Math.cos(latitude * RAD);
    const project = point => ({ x: (point.lng - origin.lng) * RAD * R * factor, y: (point.lat - origin.lat) * RAD * R });
    return { accesses, project };
  }

  function cellsAlong(a, b, size, budget) {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!length) return [];
    const breaks = [0, 1];
    for (const [start, delta] of [[a.x, dx], [a.y, dy]]) {
      if (!delta) continue;
      const low = Math.ceil(Math.min(start, start + delta) / size);
      const high = Math.floor(Math.max(start, start + delta) / size);
      if (high - low > budget.left) return null;
      for (let line = low; line <= high; line += 1) {
        const t = (line * size - start) / delta;
        if (t > 1e-10 && t < 1 - 1e-10) breaks.push(t);
      }
    }
    breaks.sort((a, b) => a - b);
    const pieces = [];
    for (let i = 1; i < breaks.length; i += 1) {
      const from = breaks[i - 1], to = breaks[i];
      if (to - from < 1e-10) continue;
      if (--budget.left < 0) return null;
      const middle = (from + to) / 2;
      pieces.push({ x: Math.floor((a.x + dx * middle) / size), y: Math.floor((a.y + dy * middle) / size), from, to, length: (to - from) * length });
    }
    return pieces;
  }

  /**
   * Suggest a GLOBAL first-encounter order, including stops beyond API chunks.
   * Accesses come only from actual leg endpoints; polygon centers stay intact.
   * Returns copied stops with order and routePosition, or null without complete
   * road detail or outside the work budget. No network calls or input mutations.
   */
  function propose(stops, result, { strategy = 'short', roundTrip = false } = {}) {
    const detail = inspect(stops, result, roundTrip);
    if (!detail || stops.length < 2 || !['short', 'workload'].includes(strategy)) return null;
    const { accesses, project } = detail;
    const entries = stops.map((stop, index) => ({ stop, index, point: project(accesses.get(stop.key)), encountered: index === 0 ? 0 : null }));
    const entriesByKey = new Map(entries.map(entry => [entry.stop.key, entry]));
    const grid = new Map();
    for (const entry of entries) {
      const key = Math.floor(entry.point.x / ACCESS_RADIUS) + ':' + Math.floor(entry.point.y / ACCESS_RADIUS);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(entry);
    }
    const budget = { left: MAX_CELLS };
    let traveled = 0;
    for (const leg of result.legs) {
      const path = leg.path.map(project);
      for (let i = 1; i < path.length; i += 1) {
        const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy), pieces = cellsAlong(a, b, ACCESS_RADIUS, budget);
        if (!pieces) return null;
        const tested = new Set();
        for (const cell of pieces) {
          for (let x = cell.x - 1; x <= cell.x + 1; x += 1) {
            for (let y = cell.y - 1; y <= cell.y + 1; y += 1) {
              for (const entry of grid.get(x + ':' + y) || []) {
                if (entry.encountered !== null || tested.has(entry.index)) continue;
                tested.add(entry.index);
                const t = Math.max(0, Math.min(1, ((entry.point.x - a.x) * dx + (entry.point.y - a.y) * dy) / (length * length)));
                if (Math.hypot(entry.point.x - a.x - dx * t, entry.point.y - a.y - dy * t) <= ACCESS_RADIUS) {
                  entry.encountered = traveled + length * t;
                }
              }
            }
          }
        }
        traveled += length;
      }
      // Stationary legs still represent a real visit to a shared access.
      for (const key of [leg.fromKey, leg.toKey]) {
        const entry = entriesByKey.get(key);
        if (entry.encountered === null) entry.encountered = traveled;
      }
    }
    if (entries.some(entry => entry.encountered === null)) return null;
    const tail = entries.slice(1).sort((a, b) => Math.abs(a.encountered - b.encountered) > 0.25 ?
      a.encountered - b.encountered : strategy === 'workload' ? b.stop.count - a.stop.count || a.index - b.index : a.index - b.index);
    return [entries[0], ...tail].map(({ stop }, index) => ({
      ...stop, position: copyPoint(stop.position), routePosition: copyPoint(accesses.get(stop.key)), order: index + 1
    }));
  }

  /**
   * Approximate repeated street meters in 6 m cells, distinguished by direction
   * axis (opposite directions share an axis). Continuous occupancy across path
   * vertices and legs is one visit. Crossings on different axes are distinct.
   * weightedArrival is count-weighted cumulative distance at service stops.
   * weightedArrivalSeconds uses actual leg durations when every leg has one;
   * the optional return to origin contributes no second service visit.
   */
  function assess(stops, result, { roundTrip = false } = {}) {
    const detail = inspect(stops, result, roundTrip);
    if (!detail) return null;
    const { project } = detail, seen = new Set(), budget = { left: MAX_CELLS };
    const counts = new Map(stops.map(stop => [stop.key, stop.count]));
    const totalCount = stops.reduce((sum, stop) => sum + stop.count, 0);
    const timed = result.legs.every(leg => Number.isFinite(leg.durationSeconds) && leg.durationSeconds >= 0);
    let repeatMeters = 0, traveled = 0, weightedArrival = 0, elapsed = 0, weightedArrivalSeconds = 0, lastCell = null, repeating = false;
    for (let legIndex = 0; legIndex < result.legs.length; legIndex += 1) {
      const leg = result.legs[legIndex], points = leg.path.map(project);
      const pathMeters = points.slice(1).reduce((sum, b, i) => sum + Math.hypot(b.x - points[i].x, b.y - points[i].y), 0);
      const scale = pathMeters ? leg.distanceMeters / pathMeters : 0;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1], b = points[i];
        const cells = cellsAlong(a, b, REPEAT_CELL, budget);
        if (!cells) return null;
        const axis = Math.floor((((Math.atan2(b.y - a.y, b.x - a.x) + Math.PI) % Math.PI) / Math.PI) * 6);
        for (const cell of cells) {
          const key = cell.x + ':' + cell.y + ':' + axis;
          if (key !== lastCell) {
            repeating = seen.has(key);
            seen.add(key);
            lastCell = key;
          }
          if (repeating) repeatMeters += cell.length * scale;
        }
      }
      traveled += leg.distanceMeters;
      if (timed) elapsed += leg.durationSeconds;
      if (legIndex < stops.length - 1) {
        const share = counts.get(leg.toKey) / totalCount;
        weightedArrival += traveled * share;
        if (timed) weightedArrivalSeconds += elapsed * share;
      }
    }
    return { repeatMeters, weightedArrival, weightedArrivalSeconds: timed ? weightedArrivalSeconds : null };
  }

  /** Accept only an observed improvement, never a geometric-cost prediction. */
  function accept(stops, baseline, candidateStops, candidate, { strategy = 'short', roundTrip = false } = {}) {
    if (!['short', 'workload'].includes(strategy) || !Array.isArray(stops) || !Array.isArray(candidateStops) ||
        !stops.length || stops.length !== candidateStops.length || stops[0].key !== candidateStops[0]?.key) return false;
    const identities = new Map(stops.map(stop => [stop.key, stop.count]));
    const seen = new Set();
    for (const stop of candidateStops) {
      if (!stop || seen.has(stop.key) || identities.get(stop.key) !== stop.count) return false;
      seen.add(stop.key);
    }
    const base = assess(stops, baseline, { roundTrip }), next = assess(candidateStops, candidate, { roundTrip });
    if (!base || !next) return false;
    // Absolute tolerances absorb rounded API distances and cell boundaries,
    // rather than permitting a percentage increase on long routes.
    if (candidate.distanceMeters > baseline.distanceMeters + 1 || next.repeatMeters > base.repeatMeters + 3) return false;
    if (Number.isFinite(baseline.durationSeconds) && Number.isFinite(candidate.durationSeconds) &&
        candidate.durationSeconds > baseline.durationSeconds + 2) return false;
    const shorter = candidate.distanceMeters < baseline.distanceMeters - 2;
    const fewerRepeats = next.repeatMeters < base.repeatMeters - 6;
    const faster = Number.isFinite(baseline.durationSeconds) && Number.isFinite(candidate.durationSeconds) &&
      candidate.durationSeconds < baseline.durationSeconds - 2;
    if (strategy === 'workload') {
      const timed = Number.isFinite(base.weightedArrivalSeconds) && Number.isFinite(next.weightedArrivalSeconds);
      if (next.weightedArrival > base.weightedArrival + 0.5 ||
          (timed && next.weightedArrivalSeconds > base.weightedArrivalSeconds + 0.5)) return false;
      return shorter || fewerRepeats || faster || next.weightedArrival < base.weightedArrival - 2 ||
        (timed && next.weightedArrivalSeconds < base.weightedArrivalSeconds - 2);
    }
    return shorter || fewerRepeats || faster;
  }

  global.MGPCSurveyRouteOptimize = Object.freeze({ propose, assess, accept });
})(window);
