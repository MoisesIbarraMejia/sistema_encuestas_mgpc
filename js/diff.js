// ============================================================
// diff.js — calcula la "zona afectada" entre el polígono original
// de la UT y el polígono propuesto/editado, usando Turf.js.
// La zona afectada = diferencia simétrica (lo que se agrega + lo
// que se quita), que es justo lo que hay que intersectar contra
// manzanas/localidades para saber qué población cambia de UT.
// ============================================================
const Diff = (() => {

  function toFeature(geojson) {
    if (!geojson) return null;
    if (geojson.type === 'FeatureCollection') {
      if (!Array.isArray(geojson.features) || geojson.features.length === 0) return null;
      // Todas las partes cuentan: omitir las posteriores a la primera
      // subestimaba el área de las UT compuestas por varias geometrías.
      return geojson.features.map(toFeature).reduce((merged, feature) => {
        if (!feature) throw new Error('La colección contiene una geometría vacía.');
        if (!merged) return feature;
        const combined = turf.union(merged, feature);
        if (!combined) throw new Error('No se pudieron unir todas las partes del polígono.');
        return combined;
      }, null);
    }
    const feature = geojson.type === 'Feature' ? geojson : turf.feature(geojson);
    if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
      throw new Error('Se requiere una geometría Polygon o MultiPolygon.');
    }
    const polygons = feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (!Array.isArray(polygons) || polygons.length === 0) {
      throw new Error('El polígono no contiene coordenadas.');
    }
    polygons.forEach((rings) => {
      if (!Array.isArray(rings) || rings.length === 0) throw new Error('El polígono no contiene anillos.');
      rings.forEach((ring) => {
        if (!Array.isArray(ring) || ring.length < 4 || ring.some((point) =>
          !Array.isArray(point) || point.length < 2 ||
          !Number.isFinite(point[0]) || !Number.isFinite(point[1])
        )) throw new Error('El polígono contiene coordenadas inválidas.');
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          throw new Error('Todos los anillos del polígono deben estar cerrados.');
        }
      });
    });
    // Misma precisión de cálculo que el editor: estabiliza límites contiguos
    // sin mutar las geometrías originales ni descartar partes del resultado.
    return turf.truncate(feature, {precision:10, mutate:false});
  }

  // Devuelve { affected, added, removed } — cada uno Feature|null
  function computeAffectedGeometry(originalGeoJSON, modifiedGeoJSON) {
    const original = toFeature(originalGeoJSON);
    const modified = toFeature(modifiedGeoJSON);

    if (!original || !modified) {
      throw new Error('Se requieren ambos polígonos (original y modificado) para calcular la diferencia');
    }

    try {
      const removed = turf.difference(original, modified);
      const added = turf.difference(modified, original);
      const affected = added && removed ? turf.union(added, removed) : added || removed || null;
      if (added && removed && !affected) throw new Error('La unión de las diferencias está vacía.');
      return { affected, added, removed };
    } catch (error) {
      // Un fallo no equivale a una diferencia vacía; abortar evita calcular
      // encuestas usando únicamente una parte de la población afectada.
      throw new Error('No se pudo calcular la zona afectada completa. Revisa los polígonos: ' + error.message);
    }
  }

  // true si el polígono editado es idéntico (o casi) al original
  function isUnchanged(originalGeoJSON, modifiedGeoJSON) {
    const original = toFeature(originalGeoJSON);
    const modified = toFeature(modifiedGeoJSON);
    if (!original || !modified) throw new Error('Se requieren ambos polígonos para comparar los cambios.');
    const areaOriginal = turf.area(original);
    if (!Number.isFinite(areaOriginal) || areaOriginal <= 0) throw new Error('El polígono original no tiene un área válida.');
    const { affected } = computeAffectedGeometry(original, modified);
    if (!affected) return true;
    const areaAfectada = turf.area(affected);
    if (!Number.isFinite(areaAfectada)) throw new Error('El área afectada no es válida.');
    // Cambios menores a 1 m² se consideran ruido de edición, no un cambio real.
    return areaAfectada < 1 || areaAfectada / areaOriginal < 0.00001;
  }

  // % del área de "feature" que cae dentro de "referencia" (0-100).
  // Se usa para recalcular en el cliente el porcentaje de afectación de
  // cada manzana, en vez de confiar ciegamente en el valor que devuelve
  // la Spatial API (que en la práctica ha estado devolviendo 100% fijo).
  // Devuelve null si no se pudo calcular (geometría inválida, etc.),
  // para que quien lo use pueda decidir un valor de respaldo.
  function computeOverlapPercentage(featureGeoJSON, referenciaGeoJSON) {
    try {
      const feature = toFeature(featureGeoJSON);
      const referencia = toFeature(referenciaGeoJSON);
      if (!feature || !referencia) return null;

      const areaFeature = turf.area(feature);
      if (!(areaFeature > 0)) return 0;

      const interseccion = turf.intersect(feature, referencia);
      if (!interseccion) return 0;

      const areaInterseccion = turf.area(interseccion);
      return Math.max(0, Math.min(100, (areaInterseccion / areaFeature) * 100));
    } catch (e) {
      return null;
    }
  }

  return { computeAffectedGeometry, isUnchanged, toFeature, computeOverlapPercentage };
})();
