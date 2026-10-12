/* Google Routes adapter: compare local and optional Google waypoint orders. */
(function (global) {
  'use strict';

  // Maps JS Routes permits 25 intermediates plus origin and destination.
  // https://developers.google.com/maps/documentation/javascript/routes/intermediate-waypoints
  const MAX_POINTS = 27;
  const WALKING_WARNING = 'Las rutas a pie están en versión beta y pueden omitir banquetas o senderos peatonales. Revisa los accesos antes del recorrido.';
  const SETUP_MESSAGE = 'No está disponible el trazado por calles. Habilita Routes API y revisa los permisos de la clave de Google Maps, o utiliza el orden orientativo.';
  let libraryPromise = null;

  function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function checkCurrent(isCurrent) {
    if (isCurrent && !isCurrent()) {
      const error = failure('ROUTE_CANCELLED', 'El cálculo del recorrido fue reemplazado o la ventana se cerró.');
      error.name = 'AbortError';
      throw error;
    }
  }

  function coordinate(value) {
    const point = value?.routePosition ?? value?.position ?? value;
    const lat = typeof point?.lat === 'function' ? point.lat() : point?.lat;
    const lng = typeof point?.lng === 'function' ? point.lng() : point?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw failure('INVALID_ROUTE_POINT', 'Una parada del recorrido no tiene coordenadas válidas.');
    }
    return { lat, lng };
  }

  function samePoint(a, b) { return a.lat === b.lat && a.lng === b.lng; }
  function uniqueWarnings(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  }

  async function routeClass() {
    if (typeof global.google?.maps?.routes?.Route?.computeRoutes === 'function') return global.google.maps.routes.Route;
    if (typeof global.google?.maps?.importLibrary !== 'function') throw failure('ROUTES_UNAVAILABLE', SETUP_MESSAGE);
    if (!libraryPromise) {
      libraryPromise = Promise.resolve().then(() => global.google.maps.importLibrary('routes')).then(library => {
        if (typeof library?.Route?.computeRoutes !== 'function') throw failure('ROUTES_UNAVAILABLE', SETUP_MESSAGE);
        return library.Route;
      }).catch(() => {
        libraryPromise = null;
        throw failure('ROUTES_UNAVAILABLE', SETUP_MESSAGE);
      });
    }
    return libraryPromise;
  }

  function requestError(error) {
    const details = `${error?.code ?? ''} ${error?.message ?? ''}`;
    if (/PERMISSION_DENIED|REQUEST_DENIED|UNAUTHENTICATED|API_KEY|ApiNotActivated|not enabled|not authorized|billing/i.test(details)) {
      return failure('ROUTES_UNAVAILABLE', SETUP_MESSAGE);
    }
    return failure('ROUTES_FAILED', 'No se pudo completar el trazado por calles. Intenta de nuevo o utiliza el orden orientativo; no se ha calculado una distancia total por calles.');
  }

  function readLegPath(leg) {
    if (Array.isArray(leg.path) && leg.path.length) return leg.path.map(coordinate);
    // Some Maps releases provide the geometry on navigation steps. Only join
    // contiguous API paths; never connect missing steps or block centroids.
    if (!Array.isArray(leg.steps) || !leg.steps.length) return [];
    const path = [];
    for (const step of leg.steps) {
      if (!Array.isArray(step.path) || !step.path.length) return [];
      const next = step.path.map(coordinate);
      if (path.length && !samePoint(path[path.length - 1], next[0])) return [];
      path.push(...(path.length ? next.slice(1) : next));
    }
    return path;
  }

  function readLegs(route, keys) {
    if (!Array.isArray(route.legs) || route.legs.length !== keys.length - 1) return null;
    try {
      return route.legs.map((leg, index) => {
        const path = readLegPath(leg);
        if (!path.length || !Number.isFinite(leg.distanceMeters) || leg.distanceMeters < 0 ||
            (path.length < 2 && leg.distanceMeters > 0)) throw new Error('Incomplete leg');
        const milliseconds = leg.durationMillis ?? leg.staticDurationMillis;
        return {
          fromKey: keys[index], toKey: keys[index + 1], path,
          startLocation: coordinate(leg.startLocation ?? path[0]),
          endLocation: coordinate(leg.endLocation ?? path[path.length - 1]),
          distanceMeters: leg.distanceMeters,
          durationSeconds: Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null
        };
      });
    } catch (_) { return null; }
  }

  function numberedStops(stops) {
    return stops.map((stop, index) => ({
      ...stop,
      ...(stop.position ? { position: { ...stop.position } } : {}),
      ...(stop.routePosition ? { routePosition: { ...stop.routePosition } } : {}),
      order: index + 1
    }));
  }

  function sameStops(first, second) {
    return first.length === second.length && first.every((stop, index) =>
      stop.key === second[index].key && samePoint(coordinate(stop), coordinate(second[index])));
  }

  function sameIdentities(first, second) {
    if (!Array.isArray(second) || first.length !== second.length) return false;
    const keys = new Set(first.map(stop => stop.key));
    if (keys.size !== first.length || keys.has(undefined) || keys.has(null)) return false;
    return second.every(stop => stop && keys.delete(stop.key)) && keys.size === 0;
  }

  function sameOrderAtUsedAccesses(stops, candidate, baseline) {
    if (!stops.every((stop, index) => stop.key === candidate[index].key)) return false;
    const arrivals = new Map(baseline.legs.map(leg => [leg.toKey, leg.endLocation]));
    return stops.every((stop, index) => {
      const access = index === 0 ? baseline.legs[0]?.startLocation : arrivals.get(stop.key);
      return access && candidate[index].routePosition && samePoint(coordinate(candidate[index]), coordinate(access));
    });
  }

  function optimizedIndices(route, count) {
    const indices = route.optimizedIntermediateWaypointIndices ?? (count === 0 ? [] : null);
    if (!Array.isArray(indices) || indices.length !== count || new Set(indices).size !== count ||
        indices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) {
      throw failure('INVALID_OPTIMIZED_ORDER', 'Google devolvió un orden incompleto de las paradas. Se conserva el recorrido anterior.');
    }
    return [0, ...indices.map(index => index + 1), count + 1];
  }

  /**
   * compute([{lat,lng} | {position:{lat,lng}, ...}], options)
   * options: {roundTrip?:boolean, travelMode?:'WALKING'|'DRIVING', isCurrent?:()=>boolean,
   *           improve?:boolean, optimizeWithGoogle?:boolean,
   *           strategy?:'short'|'workload', onProgress?:(text)=>void}
   * Returns {segments:[{path:[{lat,lng}],distanceMeters,durationSeconds,warnings}],
   *          distanceMeters,durationSeconds,warnings} only after ALL chunks succeed.
   * Segments are independent API paths; do not connect them with invented lines.
   * Cancellation prevents subsequent requests/results, but cannot cancel a Maps request in flight.
   * The caller must display returned warnings and discard AbortError silently.
   * API shape: https://developers.google.com/maps/documentation/javascript/reference/route
   * Setup: https://developers.google.com/maps/documentation/javascript/routes/start
   * Walking notice: https://developers.google.com/maps/documentation/javascript/routes/vehicle-types
   */
  async function computeOrdered(stops, { roundTrip = false, travelMode = 'WALKING', isCurrent, includeLegs = false, _optimizeWaypointOrder = false } = {}) {
    checkCurrent(isCurrent);
    if (!Array.isArray(stops)) throw failure('INVALID_ROUTE_POINTS', 'Las paradas del recorrido deben ser una lista.');
    if (!['WALKING', 'DRIVING'].includes(travelMode)) throw failure('INVALID_ROUTE_MODE', 'Elige un recorrido a pie o en automóvil.');
    const points = stops.map(coordinate);
    const keys = stops.map((stop, index) => stop.key ?? String(index));
    const stopIndices = stops.map((_, index) => index);
    const orderedIndices = [];
    const closesByIdentity = includeLegs && stops[0]?.key != null && stops[stops.length - 1]?.key != null;
    if (roundTrip && points.length > 1 && (closesByIdentity ? keys[0] !== keys[keys.length - 1] : !samePoint(points[0], points[points.length - 1]))) {
      points.push({ ...points[0] });
      keys.push(keys[0]);
      stopIndices.push(0);
    }
    const result = { segments: [], distanceMeters: 0, durationSeconds: 0, warnings: [] };
    if (includeLegs) { result.legs = []; result.legsComplete = true; }
    if (points.length < 2) return result;

    let Route;
    try { Route = await routeClass(); }
    catch (error) { checkCurrent(isCurrent); throw error; }
    checkCurrent(isCurrent);
    for (let start = 0; start < points.length - 1; start += MAX_POINTS - 1) {
      checkCurrent(isCurrent);
      // Consecutive chunks share their boundary stop, so every leg is requested once.
      const chunk = points.slice(start, start + MAX_POINTS);
      const request = {
        origin: chunk[0], destination: chunk[chunk.length - 1],
        intermediates: chunk.slice(1, -1).map(location => ({ location })),
        travelMode, optimizeWaypointOrder: _optimizeWaypointOrder, language: 'es', region: 'mx', polylineQuality: 'HIGH_QUALITY',
        fields: ['path', 'distanceMeters', 'durationMillis', 'warnings']
      };
      if (includeLegs) request.fields.push('legs');
      if (_optimizeWaypointOrder) request.fields.push('optimizedIntermediateWaypointIndices');
      // routingPreference is invalid for WALKING.
      if (travelMode === 'DRIVING') request.routingPreference = 'TRAFFIC_UNAWARE';
      let response;
      try { response = await Route.computeRoutes(request); }
      catch (error) { checkCurrent(isCurrent); throw requestError(error); }
      checkCurrent(isCurrent);
      const route = response?.routes?.[0];
      if (!route) throw failure('ROUTE_NOT_FOUND', 'No se encontró un recorrido por calles para todas las paradas. Utiliza el orden orientativo y revisa los accesos.');
      const chunkOrder = _optimizeWaypointOrder ? optimizedIndices(route, chunk.length - 2) : chunk.map((_, index) => index);
      const chunkKeys = chunkOrder.map(index => keys[start + index]);
      orderedIndices.push(...chunkOrder.slice(start ? 1 : 0).map(index => stopIndices[start + index]));
      let path;
      try { path = Array.isArray(route.path) ? route.path.map(coordinate) : []; }
      catch (_) { path = []; }
      if (!path.length || (path.length < 2 && route.distanceMeters > 0) || !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0 ||
          !Number.isFinite(route.durationMillis) || route.durationMillis < 0) {
        throw failure('INCOMPLETE_ROUTE', 'Google Maps devolvió un recorrido incompleto. Intenta de nuevo o utiliza el orden orientativo.');
      }
      const warnings = Array.isArray(route.warnings) ? [...route.warnings] : [];
      if (response.fallbackInfo) warnings.push('Google Maps utilizó una alternativa para calcular un tramo del recorrido.');
      const segment = { path, distanceMeters: route.distanceMeters, durationSeconds: route.durationMillis / 1000, warnings: uniqueWarnings(warnings) };
      result.segments.push(segment);
      result.distanceMeters += segment.distanceMeters;
      result.durationSeconds += segment.durationSeconds;
      result.warnings.push(...segment.warnings);
      if (includeLegs) {
        const legs = readLegs(route, chunkKeys);
        if (legs) result.legs.push(...legs);
        else result.legsComplete = false;
      }
    }
    if (includeLegs && !result.legsComplete) result.legs = [];
    if (_optimizeWaypointOrder) {
      // The repeated origin closes the geometry, but is not another survey stop.
      if (orderedIndices.length > stops.length) orderedIndices.pop();
      result.stops = numberedStops(orderedIndices.map(index => stops[index]));
    }
    if (travelMode === 'WALKING') result.warnings.unshift(WALKING_WARNING);
    result.warnings = uniqueWarnings(result.warnings);
    checkCurrent(isCurrent);
    return result;
  }

  // At most two complete itineraries are requested: a baseline and one global
  // candidate. A failed optional comparison never discards a usable baseline.
  async function computeImproved(stops, options = {}) {
    const { improve = false, strategy = 'short', roundTrip = false, isCurrent, onProgress } = options;
    if (!improve) return computeOrdered(stops, options);
    checkCurrent(isCurrent);
    if (typeof onProgress === 'function') onProgress('Calculando el recorrido por calles y sus puntos de llegada…');
    const baseline = await computeOrdered(stops, { ...options, includeLegs: true });
    checkCurrent(isCurrent);
    const helper = global.MGPCSurveyRouteOptimize;
    const finish = (route, finalStops, status) => {
      checkCurrent(isCurrent);
      route.stops = numberedStops(finalStops);
      route.optimization = {
        status, baselineDistanceMeters: baseline.distanceMeters,
        savedMeters: Math.max(0, baseline.distanceMeters - route.distanceMeters)
      };
      // Optional diagnostics never block a usable itinerary.
      if (typeof helper?.assess === 'function') {
        try {
          const before = helper.assess(stops, baseline, { roundTrip });
          const after = helper.assess(finalStops, route, { roundTrip });
          if (before && after) {
            for (const [name, value] of Object.entries({
              baselineRepeatMeters: before.repeatMeters, repeatMeters: after.repeatMeters,
              baselineWeightedArrival: before.weightedArrival, weightedArrival: after.weightedArrival
            })) if (Number.isFinite(value)) route.optimization[name] = value;
          }
        } catch (_) { /* Diagnostics are optional. */ }
      }
      return route;
    };
    const unavailable = message => {
      baseline.warnings = uniqueWarnings([...baseline.warnings, message]);
      return finish(baseline, stops, 'unavailable');
    };
    if (stops.length < 2) return finish(baseline, stops, 'unchanged');
    if (!baseline.legsComplete) return unavailable('No se recibieron todos los tramos para comparar alternativas. Se conserva el recorrido por calles calculado.');
    if (typeof helper?.propose !== 'function' || typeof helper?.accept !== 'function') {
      return unavailable('No está disponible la comparación de recorridos. Se conserva el recorrido por calles calculado.');
    }
    try {
      const candidateStops = helper.propose(stops, baseline, { strategy, roundTrip });
      checkCurrent(isCurrent);
      if (candidateStops == null) return unavailable('No hubo suficiente detalle vial para revisar otro orden de visitas. Se conserva el recorrido por calles calculado.');
      if (!sameIdentities(stops, candidateStops)) return unavailable('No se pudo comparar otra alternativa con todas las paradas. Se conserva el recorrido por calles calculado.');
      // Validate every coordinate before requesting any candidate chunk.
      candidateStops.forEach(coordinate);
      if (sameStops(stops, candidateStops) || sameOrderAtUsedAccesses(stops, candidateStops, baseline)) {
        // Only the recorded access points changed: the baseline already used them.
        // Keep all original survey metadata and marker positions.
        const anchoredStops = stops.map((stop, index) => ({
          ...stop, ...(candidateStops[index].routePosition ? { routePosition: coordinate(candidateStops[index]) } : {})
        }));
        return finish(baseline, anchoredStops, 'unchanged');
      }
      if (typeof onProgress === 'function') onProgress('Comparando una alternativa para reducir regresos por las mismas calles…');
      checkCurrent(isCurrent);
      const candidate = await computeOrdered(candidateStops, { ...options, includeLegs: true });
      checkCurrent(isCurrent);
      if (!candidate.legsComplete) return unavailable('La alternativa no incluyó todos sus tramos. Se conserva el recorrido por calles calculado.');
      if (helper.accept(stops, baseline, candidateStops, candidate, { strategy, roundTrip }) === true) {
        return finish(candidate, candidateStops, 'improved');
      }
      return finish(baseline, stops, 'unchanged');
    } catch (error) {
      checkCurrent(isCurrent);
      if (error?.name === 'AbortError') throw error;
      return unavailable('No se pudo completar la comparación con otra alternativa. Se conserva el recorrido por calles calculado.');
    }
  }

  global.MGPCSurveyRouteService = Object.freeze({ compute });
})(window);
