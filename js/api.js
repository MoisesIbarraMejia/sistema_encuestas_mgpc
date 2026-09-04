// ============================================================
// api.js — capa de comunicación entre el frontend y el proxy PHP
// ============================================================
const Api = (() => {

  function buildUrl(path, queryParams = {}) {
    const url = new URL(
      CONFIG.API_BASE,
      window.location.href
    );

    url.searchParams.set(
      'endpoint',
      path.replace(/^\/+/, '')
    );

    Object.entries(queryParams).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, v);
      }
    });

    return url.toString();
  }

  async function handle(res) {
    let body;

    try {
      body = await res.json();
    } catch (e) {
      throw new Error(
        `Respuesta no válida del servidor (HTTP ${res.status})`
      );
    }

    if (!res.ok) {
      throw new Error(
        body?.error || `Error HTTP ${res.status}`
      );
    }

    return body;
  }

  async function get(path, queryParams = {}) {
    const res = await fetch(
      buildUrl(path, queryParams),
      { method: 'GET' }
    );

    return handle(res);
  }

  async function post(path, bodyObj, queryParams = {}) {
    const res = await fetch(
      buildUrl(path, queryParams),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyObj)
      }
    );

    return handle(res);
  }

  // ============================================================
  // GEOMETRÍA DE UNA UT
  // ============================================================
  // filter_2 consulta directamente la BD mediante cve_ut y
  // devuelve exclusivamente la geometría/properties de esa UT.
  // ============================================================

  function getUTByCve(cveUt) {
    return get(
      CONFIG.ENDPOINTS.utPorCve,
      { cve_ut: cveUt }
    );
  }

  // ============================================================
  // MANZANAS DE REFERENCIA CON BUFFER
  // ============================================================
  // Devuelve las manzanas que intersectan la geometría de la UT
  // ampliada con el buffer indicado en metros.
  // ============================================================

  function manzanasDeReferencia(geometry, bufferMeters = CONFIG.MAP.referenceBufferMeters) {
    return post(
      '/intersect/manzana',
      {
        geometry,
        mode: 'intersects',
        include_percentage: false,
        buffer_meters: bufferMeters
      }
    );
  }

  // ============================================================
  // SECCIONES
  // ============================================================

  function getSeccionesDeUT(cveUt) {
    return get(
      `/filter/${CONFIG.TABLES.secciones}`,
      {
        clave: cveUt,
        limit: 500
      }
    );
  }

  // ============================================================
  // CACHE DE GEOMETRÍA AFECTADA
  // ============================================================

  function cacheStore(geometry, cveUt, meta) {
    return post('/cache/store', {
      geometry,
      cve_ut: cveUt,
      meta,
      ttl_minutes: CONFIG.CACHE_TTL_MINUTES
    });
  }

  // ============================================================
  // INTERSECCIÓN ESPACIAL
  // ============================================================

  function intersect(
    table,
    {
      geometry,
      cacheId,
      mode = 'intersects',
      includePercentage = true,
      bufferMeters
    }
  ) {

    const body = {
      mode,
      include_percentage: includePercentage
    };

    if (cacheId) {
      body.cache_id = cacheId;
    } else {
      body.geometry = geometry;
    }

    if (
      bufferMeters !== undefined &&
      bufferMeters !== null
    ) {
      body.buffer_meters = bufferMeters;
    }

    return post(
      `/intersect/${table}`,
      body
    );
  }

  // ============================================================
  // MANZANAS AFECTADAS
  // ============================================================

  function manzanasAfectadas({ geometry, cacheId }) {
    return intersect(
      CONFIG.TABLES.manzana,
      {
        geometry,
        cacheId,
        mode: 'intersects',
        includePercentage: true
      }
    );
  }

  // ============================================================
  // LOCALIDADES AFECTADAS
  // ============================================================

  function localidadesAfectadas({ geometry, cacheId }) {
    return intersect(
      CONFIG.TABLES.localidad,
      {
        geometry,
        cacheId,
        mode: 'within',
        includePercentage: false
      }
    );
  }

  return {
    getUTByCve,
    getSeccionesDeUT,
    cacheStore,
    intersect,
    manzanasDeReferencia,
    manzanasAfectadas,
    localidadesAfectadas
  };

})();
