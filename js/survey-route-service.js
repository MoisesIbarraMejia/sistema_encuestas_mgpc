/* Google Routes adapter. Stop order is supplied by the local survey planner. */
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
    const point = value?.position ?? value;
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

  /**
   * compute([{lat,lng} | {position:{lat,lng}, ...}], options)
   * options: {roundTrip?:boolean, travelMode?:'WALKING'|'DRIVING', isCurrent?:()=>boolean}
   * Returns {segments:[{path:[{lat,lng}],distanceMeters,durationSeconds,warnings}],
   *          distanceMeters,durationSeconds,warnings} only after ALL chunks succeed.
   * Segments are independent API paths; do not connect them with invented lines.
   * Cancellation prevents subsequent requests/results, but cannot cancel a Maps request in flight.
   * The caller must display returned warnings and discard AbortError silently.
   * API shape: https://developers.google.com/maps/documentation/javascript/reference/route
   * Setup: https://developers.google.com/maps/documentation/javascript/routes/start
   * Walking notice: https://developers.google.com/maps/documentation/javascript/routes/vehicle-types
   */
  async function compute(stops, { roundTrip = false, travelMode = 'WALKING', isCurrent } = {}) {
    checkCurrent(isCurrent);
    if (!Array.isArray(stops)) throw failure('INVALID_ROUTE_POINTS', 'Las paradas del recorrido deben ser una lista.');
    if (!['WALKING', 'DRIVING'].includes(travelMode)) throw failure('INVALID_ROUTE_MODE', 'Elige un recorrido a pie o en automóvil.');
    const points = stops.map(coordinate);
    if (roundTrip && points.length > 1 && !samePoint(points[0], points[points.length - 1])) points.push({ ...points[0] });
    const result = { segments: [], distanceMeters: 0, durationSeconds: 0, warnings: [] };
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
        travelMode, optimizeWaypointOrder: false, language: 'es', region: 'mx', polylineQuality: 'HIGH_QUALITY',
        fields: ['path', 'distanceMeters', 'durationMillis', 'warnings']
      };
      // routingPreference is invalid for WALKING.
      if (travelMode === 'DRIVING') request.routingPreference = 'TRAFFIC_UNAWARE';
      let response;
      try { response = await Route.computeRoutes(request); }
      catch (error) { checkCurrent(isCurrent); throw requestError(error); }
      checkCurrent(isCurrent);
      const route = response?.routes?.[0];
      if (!route) throw failure('ROUTE_NOT_FOUND', 'No se encontró un recorrido por calles para todas las paradas. Utiliza el orden orientativo y revisa los accesos.');
      let path;
      try { path = Array.isArray(route.path) ? route.path.map(coordinate) : []; }
      catch (_) { path = []; }
      if (path.length < 2 || !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0 ||
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
    }
    if (travelMode === 'WALKING') result.warnings.unshift(WALKING_WARNING);
    result.warnings = uniqueWarnings(result.warnings);
    checkCurrent(isCurrent);
    return result;
  }

  global.MGPCSurveyRouteService = Object.freeze({ compute });
})(window);
