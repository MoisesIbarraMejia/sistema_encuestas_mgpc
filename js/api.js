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
      if (
        v !== undefined &&
        v !== null &&
        v !== ''
      ) {
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
  // CATÁLOGO DE UT
  // ============================================================
  // Se utiliza únicamente para alimentar el buscador.
  // La geometría NO se descarga aquí.
  // ============================================================

  function getAllUTs() {
    return get(CONFIG.ENDPOINTS.utCatalogo);
  }


  // ============================================================
  // GEOMETRÍA DE UNA UT
  // ============================================================
  // filter_2 consulta directamente por cve_ut y devuelve
  // únicamente la geometría/feature de esa UT.
  // ============================================================

  function getUTByCve(cveUt) {
    return get(
      CONFIG.ENDPOINTS.utPorCve,
      { cve_ut: cveUt }
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
      includePercentage = true
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

    return post(
      `/intersect/${table}`,
      body
    );
  }


  // ============================================================
  // MANZANAS DE REFERENCIA
  // ============================================================

  function manzanasDeReferencia(geometry) {
    return intersect(
      CONFIG.TABLES.manzana,
      {
        geometry,
        mode: 'intersects',
        includePercentage: false
      }
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
    getAllUTs,
    getUTByCve,
    getSeccionesDeUT,
    cacheStore,
    intersect,
    manzanasDeReferencia,
    manzanasAfectadas,
    localidadesAfectadas
  };

})();
