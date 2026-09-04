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
    if (geojson.type === 'Feature') return geojson;
    if (geojson.type === 'FeatureCollection') return geojson.features[0] || null;
    // Es una geometría "pelona"
    return turf.feature(geojson);
  }

  // Devuelve { affected, added, removed } — cada uno Feature|null
  function computeAffectedGeometry(originalGeoJSON, modifiedGeoJSON) {
    const original = toFeature(originalGeoJSON);
    const modified = toFeature(modifiedGeoJSON);

    if (!original || !modified) {
      throw new Error('Se requieren ambos polígonos (original y modificado) para calcular la diferencia');
    }

    let removed = null; // lo que estaba en el original y ya no está (se quita de la UT)
    let added = null;   // lo que está en el modificado y no estaba antes (se agrega a la UT)

    try { removed = turf.difference(original, modified); } catch (e) { removed = null; }
    try { added = turf.difference(modified, original); } catch (e) { added = null; }

    let affected = null;
    if (added && removed) {
      try { affected = turf.union(added, removed); } catch (e) { affected = added || removed; }
    } else {
      affected = added || removed || null;
    }

    return { affected, added, removed };
  }

  // true si el polígono editado es idéntico (o casi) al original
  function isUnchanged(originalGeoJSON, modifiedGeoJSON) {
    const original = toFeature(originalGeoJSON);
    const modified = toFeature(modifiedGeoJSON);
    if (!original || !modified) return true;
    try {
      const areaOriginal = turf.area(original);
      const { affected } = computeAffectedGeometry(original, modified);
      if (!affected) return true;
      const areaAfectada = turf.area(affected);
      // Cambios menores a 1 m² se consideran ruido de edición, no un cambio real
      return areaAfectada < 1 || areaAfectada / areaOriginal < 0.00001;
    } catch (e) {
      return false;
    }
  }

  return { computeAffectedGeometry, isUnchanged, toFeature };
})();
