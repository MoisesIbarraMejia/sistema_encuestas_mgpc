/* Suggested visit orders use straight-line distances, not street routing. */
(function (global) {
  'use strict';

  const RADIUS_METERS = 6371008.8;
  const RAD = Math.PI / 180;
  const EPSILON = 0.000001;
  const compareKeys = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  function validateRows(rows) {
    if (!Array.isArray(rows)) throw new TypeError('Las paradas deben ser un arreglo.');
    const seen = new Set();
    const valid = [];
    for (const row of rows) {
      if (!row || typeof row.key !== 'string' || !row.key.trim() || seen.has(row.key)) {
        throw new TypeError('Cada parada debe tener una clave distinta y no vacía.');
      }
      seen.add(row.key);
      if (!Number.isSafeInteger(row.count)) throw new RangeError('Las encuestas deben ser números enteros finitos.');
      if (row.count <= 0) continue;
      const position = row.position;
      if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng) ||
          Math.abs(position.lat) > 90 || Math.abs(position.lng) > 180) {
        throw new RangeError('Cada parada con encuestas debe tener coordenadas válidas.');
      }
      valid.push({ ...row, position: { lat: position.lat, lng: position.lng } });
    }
    return valid;
  }

  function haversine(a, b) {
    const dLat = (b.position.lat - a.position.lat) * RAD;
    const dLng = (b.position.lng - a.position.lng) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.position.lat * RAD) *
      Math.cos(b.position.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * RADIUS_METERS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
  }

  function totalDistance(route, distance, roundTrip) {
    let total = 0;
    for (let i = 1; i < route.length; i += 1) total += distance(route[i - 1], route[i]);
    if (roundTrip && route.length > 1) total += distance(route[route.length - 1], route[0]);
    return total;
  }

  function startsAtBoundary(rows) {
    // Geographic extremes avoid beginning in the middle of the working area.
    const projections = [p => p.lat, p => p.lng, p => p.lat + p.lng, p => p.lat - p.lng];
    const starts = [];
    for (const projection of projections) {
      const ordered = [...rows].sort((a, b) => projection(a.position) - projection(b.position) || compareKeys(a, b));
      starts.push(ordered[0], ordered[ordered.length - 1]);
    }
    return [...new Set(starts)];
  }

  function nearestOrder(rows, start, distance, strategy) {
    const remaining = new Set(rows);
    const route = [start];
    remaining.delete(start);
    while (remaining.size) {
      const current = route[route.length - 1];
      let next, best = Infinity;
      for (const row of remaining) {
        // The workload alternative favors nearby stops with more surveys.
        const score = distance(current, row) / (strategy === 'workload' ? Math.sqrt(row.count) : 1);
        if (score < best - EPSILON || (Math.abs(score - best) <= EPSILON && (!next || compareKeys(row, next) < 0))) {
          next = row;
          best = score;
        }
      }
      route.push(next);
      remaining.delete(next);
    }
    return route;
  }

  function improveShortRoute(input, distance, roundTrip) {
    const route = [...input];
    let comparisons = 0;
    // Preserve the chosen origin. Bound both passes and work for large layers.
    for (let pass = 0; pass < 8 && comparisons < 60000; pass += 1) {
      let changed = false;
      for (let i = 1; i < route.length - 1 && comparisons < 60000; i += 1) {
        for (let j = i + 1; j < route.length && comparisons < 60000; j += 1) {
          comparisons += 1;
          const before = route[i - 1], first = route[i], last = route[j];
          const after = route[j + 1] || (roundTrip ? route[0] : null);
          const current = distance(before, first) + (after ? distance(last, after) : 0);
          const swapped = distance(before, last) + (after ? distance(first, after) : 0);
          if (swapped < current - EPSILON) {
            const reversed = route.slice(i, j + 1).reverse();
            route.splice(i, reversed.length, ...reversed);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return route;
  }

  function plan(input, options = {}) {
    const rows = validateRows(input).sort(compareKeys);
    const strategy = options.strategy ?? 'short';
    const roundTrip = options.roundTrip === true;
    if (!['short', 'workload'].includes(strategy)) throw new RangeError('La estrategia de recorrido no es válida.');
    let explicitStart;
    if (options.startKey !== undefined && options.startKey !== null && options.startKey !== '') {
      explicitStart = rows.find(row => row.key === options.startKey);
      if (!explicitStart) throw new RangeError('La parada de inicio debe tener encuestas asignadas.');
    }
    if (!rows.length) return { stops: [], distanceMeters: 0, initialDistanceMeters: 0, strategy, roundTrip };

    const indices = new Map(rows.map((row, index) => [row, index]));
    const matrix = rows.length <= 600 ? new Float64Array(rows.length * rows.length).fill(-1) : null;
    const distance = (a, b) => {
      if (a === b) return 0;
      if (!matrix) return haversine(a, b);
      const ia = indices.get(a), ib = indices.get(b), index = ia * rows.length + ib;
      if (matrix[index] < 0) {
        const meters = haversine(a, b);
        matrix[index] = meters;
        matrix[ib * rows.length + ia] = meters;
      }
      return matrix[index];
    };
    const starts = explicitStart ? [explicitStart] : startsAtBoundary(rows).slice(0, rows.length > 300 ? 4 : 8);
    const baseline = [starts[0], ...rows.filter(row => row !== starts[0])];
    const initialDistanceMeters = totalDistance(baseline, distance, roundTrip);
    const score = route => {
      if (strategy === 'short') return totalDistance(route, distance, roundTrip);
      let elapsed = 0, weightedArrival = 0;
      const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
      for (let i = 1; i < route.length; i += 1) {
        elapsed += distance(route[i - 1], route[i]);
        weightedArrival += elapsed * (route[i].count / totalCount);
      }
      return weightedArrival;
    };
    let best = baseline, bestScore = score(baseline);
    for (const start of starts) {
      let candidate = nearestOrder(rows, start, distance, strategy);
      if (strategy === 'short') candidate = improveShortRoute(candidate, distance, roundTrip);
      const candidateScore = score(candidate);
      if (candidateScore < bestScore - EPSILON) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    return {
      stops: best.map((row, index) => ({ ...row, order: index + 1 })),
      distanceMeters: totalDistance(best, distance, roundTrip), initialDistanceMeters, strategy, roundTrip
    };
  }

  function segmentLinks(input, options = {}) {
    const stops = validateRows(input);
    const travelMode = options.travelMode ?? 'walking';
    if (!['walking', 'driving'].includes(travelMode)) throw new RangeError('El modo de traslado no es válido.');
    if (stops.length < 2) return [];
    const visits = stops.map((row, index) => ({ ...row, order: index + 1 }));
    if (options.roundTrip === true) visits.push(visits[0]);
    const links = [];
    const coordinate = row => {
      const point=row.routePosition||row.position;
      if(!Number.isFinite(point.lat)||!Number.isFinite(point.lng)||Math.abs(point.lat)>90||Math.abs(point.lng)>180)throw new RangeError('Una referencia vial no tiene coordenadas válidas.');
      return point.lat+','+point.lng;
    };
    // Maps URLs supports only three intermediate waypoints on mobile browsers.
    // Carry the preceding destination into the next origin; no stop is omitted.
    for (let offset = 0; offset < visits.length - 1; offset += 4) {
      const segment = visits.slice(offset, offset + 5);
      const first = segment[0], last = segment[segment.length - 1];
      let url = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(coordinate(first)) +
        '&destination=' + encodeURIComponent(coordinate(last)) + '&travelmode=' + travelMode;
      if (segment.length > 2) url += '&waypoints=' + encodeURIComponent(segment.slice(1, -1).map(coordinate).join('|'));
      links.push({
        url, fromOrder: first.order, toOrder: last.order, stopKeys: segment.map(row => row.key),
        roundTrip: options.roundTrip === true && offset + 5 >= visits.length
      });
    }
    return links;
  }

  global.MGPCSurveyRoutePlan = Object.freeze({ plan, segmentLinks });
})(window);
