// ============================================================
// api.js — capa delgada sobre fetch() para hablar con la Spatial API
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
      throw new Error(`Respuesta no válida del servidor (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(body?.error || `Error HTTP ${res.status}`);
    }
    return body;
  }

  async function get(path, queryParams = {}) {
    const res = await fetch(buildUrl(path, queryParams), { method: 'GET' });
    return handle(res);
  }

  async function post(path, bodyObj, queryParams = {}) {
    const res = await fetch(buildUrl(path, queryParams), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    return handle(res);
  }

  // ---- Endpoints de alto nivel usados por la app ----

  // Carga todas las UT (para el buscador). Ajusta el límite si tienes más de ~5000.
  function getAllUTs() {
    return get(`/geometries/${CONFIG.TABLES.uts}`);
  }

  // Trae las secciones que pertenecen a una UT (tabla secciones_uts, campo "clave")
  function getSeccionesDeUT(cveUt) {
    return get(`/filter/${CONFIG.TABLES.secciones}`, { clave: cveUt, limit: 500 });
  }

  // Guarda una geometría temporal en el servidor
  function cacheStore(geometry, cveUt, meta) {
    return post('/cache/store', {
      geometry,
      cve_ut: cveUt,
      meta,
      ttl_minutes: CONFIG.CACHE_TTL_MINUTES
    });
  }

  // Intersección espacial contra una tabla, usando geometría directa o cache_id
  function intersect(table, { geometry, cacheId, mode = 'intersects', includePercentage = true }) {
    const body = { mode, include_percentage: includePercentage };
    if (cacheId) body.cache_id = cacheId;
    else body.geometry = geometry;
    return post(`/intersect/${table}`, body);
  }

  // Manzanas de referencia visual dentro/cerca de una UT (para dibujar contexto)
  function manzanasDeReferencia(geometry) {
    return intersect(CONFIG.TABLES.manzana, { geometry, mode: 'intersects', includePercentage: false });
  }

  // Manzanas afectadas por la zona de cambio (con % de área para ponderar LN)
  function manzanasAfectadas({ geometry, cacheId }) {
    return intersect(CONFIG.TABLES.manzana, { geometry, cacheId, mode: 'intersects', includePercentage: true });
  }

  // Localidades (puntos) afectadas — inclusión total, sin % de área
  function localidadesAfectadas({ geometry, cacheId }) {
    return intersect(CONFIG.TABLES.localidad, { geometry, cacheId, mode: 'within', includePercentage: false });
  }

  return {
    getAllUTs,
    getSeccionesDeUT,
    cacheStore,
    intersect,
    manzanasDeReferencia,
    manzanasAfectadas,
    localidadesAfectadas
  };
})();
