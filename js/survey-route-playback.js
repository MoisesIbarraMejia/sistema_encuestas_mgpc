/* Distance-based route animation. No map objects, timers or input mutations. */
(function (global) {
  'use strict';
  const RAD = Math.PI / 180;
  const EARTH_METERS = 6371008.8;
  const copy = point => ({ lat: point.lat, lng: point.lng });
  const same = (a, b) => a.lat === b.lat && a.lng === b.lng;

  function distance(a, b) {
    const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) *
      Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_METERS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, value))));
  }

  function direction(a, b) {
    const delta = (b.lng - a.lng) * RAD;
    const y = Math.sin(delta) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
      Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(delta);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // First index whose value exceeds target, including duplicate offsets.
  function upperBound(values, target) {
    let low = 0, high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function interpolate(a, b, ratio) {
    if (ratio <= 0) return copy(a);
    if (ratio >= 1) return copy(b);
    // Follow the short longitude interval, including at the antimeridian.
    const delta = ((b.lng - a.lng + 540) % 360) - 180;
    let lng = a.lng + delta * ratio;
    if (lng > 180) lng -= 360;
    if (lng < -180) lng += 360;
    return { lat: a.lat + (b.lat - a.lat) * ratio, lng };
  }

  /**
   * Copy paths into {segments, offsets, totalMeters}. Each nonempty segment has
   * {points, distances, turnDistances, lengthMeters, offsetMeters, sourceIndex}.
   * Offsets sum traveled distance only: separate paths never acquire a connector.
   * Consecutive duplicate coordinates are removed; empty paths are skipped.
   */
  function prepare(paths) {
    if (!Array.isArray(paths)) throw new TypeError('Los tramos deben ser un arreglo.');
    const segments = [], offsets = [];
    let totalMeters = 0;
    paths.forEach((path, sourceIndex) => {
      if (!Array.isArray(path)) throw new TypeError('Cada tramo debe ser un arreglo de coordenadas.');
      const points = [];
      for (const point of path) {
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) ||
            Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
          throw new RangeError('Las coordenadas del recorrido no son válidas.');
        }
        if (!points.length || !same(points[points.length - 1], point)) points.push(copy(point));
      }
      if (!points.length) return;
      const distances = [0], turnDistances = [];
      for (let i = 1; i < points.length; i += 1) {
        distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
      }
      for (let i = 1; i < points.length - 1; i += 1) {
        const turn = Math.abs(((direction(points[i], points[i + 1]) -
          direction(points[i - 1], points[i]) + 540) % 360) - 180);
        if (turn > 120 + 1e-8) turnDistances.push(distances[i]);
      }
      const lengthMeters = distances[distances.length - 1];
      offsets.push(totalMeters);
      segments.push({ points, distances, turnDistances, lengthMeters, offsetMeters: totalMeters, sourceIndex });
      totalMeters += lengthMeters;
    });
    return { segments, offsets, totalMeters };
  }

  function locate(segment, meters) {
    const { points, distances } = segment;
    if (points.length === 1 || segment.lengthMeters === 0) return { point: copy(points[0]), bearing: 0 };
    const index = Math.min(Math.max(upperBound(distances, meters) - 1, 0), points.length - 2);
    const length = distances[index + 1] - distances[index];
    const ratio = length > 0 ? (meters - distances[index]) / length : 0;
    return { point: interpolate(points[index], points[index + 1], ratio), bearing: direction(points[index], points[index + 1]) };
  }

  function slicePath(segment, start, end) {
    const path = [locate(segment, start).point];
    for (let i = upperBound(segment.distances, start); i < segment.points.length && segment.distances[i] < end; i += 1) {
      path.push(copy(segment.points[i]));
    }
    const last = locate(segment, end).point;
    if (!same(path[path.length - 1], last)) path.push(last);
    return path;
  }

  /**
   * progress is 0..1 of traveled meters; tailMeters defaults to 100.
   * Returns {path, head, progress, segmentIndex, bearing}; bearing is degrees
   * clockwise from north. path is a single short tail in the current segment.
   * At a boundary the next segment wins and the tail resets. A >120-degree turn
   * also resets the tail, so outgoing and returning legs do not overlap.
   * No coordinates returns head:null, path:[], segmentIndex:-1, bearing:0.
   */
  function frame(prepared, progress, tailMeters = 100) {
    if (!prepared || !Array.isArray(prepared.segments) || !Array.isArray(prepared.offsets) ||
        prepared.offsets.length !== prepared.segments.length || !Number.isFinite(prepared.totalMeters) || prepared.totalMeters < 0) {
      throw new TypeError('Primero prepara los tramos del recorrido.');
    }
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new RangeError('El avance debe estar entre 0 y 1.');
    if (!Number.isFinite(tailMeters) || tailMeters < 0) throw new RangeError('La longitud de la cola debe ser no negativa.');
    if (!prepared.segments.length) return { path: [], head: null, progress, segmentIndex: -1, bearing: 0 };
    const traveled = progress * prepared.totalMeters;
    const index = Math.max(0, upperBound(prepared.offsets, traveled) - 1);
    const segment = prepared.segments[index];
    const meters = progress === 1 ? segment.lengthMeters : Math.max(0, Math.min(segment.lengthMeters, traveled - segment.offsetMeters));
    let start = Math.max(0, meters - tailMeters);
    const lastTurn = upperBound(segment.turnDistances, meters) - 1;
    if (lastTurn >= 0) start = Math.max(start, segment.turnDistances[lastTurn]);
    const current = locate(segment, meters);
    const path = slicePath(segment, start, meters);
    return { path, head: current.point, progress, segmentIndex: segment.sourceIndex, bearing: current.bearing };
  }

  /**
   * Split the already clipped frame tail into equal traveled-distance bands.
   * Bands run tail -> head, share only their adjacent endpoints along the path,
   * and retain every corner. Opacity rises from .06 to .95; widthScale from .2
   * to 1. A single band uses the head style. Empty or stationary tails have no
   * bands, while the frame head and bearing remain available for the arrow.
   */
  function comet(prepared, progress, tailMeters = 100, bands = 8) {
    if (!Number.isSafeInteger(bands) || bands < 1) throw new RangeError('La cantidad de bandas debe ser un entero positivo.');
    const current = frame(prepared, progress, tailMeters);
    if (current.path.length < 2) return { ...current, bands: [] };
    // Measuring the clipped path preserves frame's turn and segment boundaries.
    const segment = prepare([current.path]).segments[0];
    if (!segment.lengthMeters) return { ...current, bands: [] };
    const parts = [];
    for (let i = 0; i < bands; i += 1) {
      const ratio = bands === 1 ? 1 : i / (bands - 1);
      parts.push({
        path: slicePath(segment, segment.lengthMeters * i / bands, segment.lengthMeters * (i + 1) / bands),
        opacity: i === bands - 1 ? .95 : .06 + .89 * ratio,
        widthScale: i === bands - 1 ? 1 : .2 + .8 * ratio
      });
    }
    return { ...current, bands: parts };
  }

  global.MGPCSurveyRoutePlayback = Object.freeze({ prepare, frame, comet });
})(window);
