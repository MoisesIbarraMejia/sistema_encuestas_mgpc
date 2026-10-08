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

    if (res.status === 204) return null;

    try {
      body = await res.json();
    } catch (e) {
      throw new Error(
        `Respuesta no válida del servidor (HTTP ${res.status})`
      );
    }

    if (!res.ok || body?.success === false || body?.status === 'error' || body?.error) {
      const detail = typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message || body?.message);
      const error = new Error(detail || `La API rechazó la operación (HTTP ${res.status})`);
      error.status = res.status;
      throw error;
    }

    if (body === null || typeof body !== 'object') {
      throw new Error('La API devolvió un resultado vacío o con un formato inesperado.');
    }
    return body;
  }

  async function request(path, options, queryParams = {}) {
    let response;
    try {
      response = await fetch(buildUrl(path, queryParams), {
        credentials: 'same-origin',
        ...options
      });
    } catch (error) {
      throw new Error('No se pudo contactar con el servidor MGPC. Revisa la conexión e intenta nuevamente.');
    }
    return handle(response);
  }

  function get(path, queryParams = {}) {
    return request(path, { method: 'GET' }, queryParams);
  }

  function post(path, bodyObj, queryParams = {}) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    }, queryParams);
  }

  function normalizeFeatureCollection(body) {
    if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
      throw new Error('La API no devolvió una colección GeoJSON válida.');
    }
    body.features.forEach((feature) => {
      if (feature?.type !== 'Feature') throw new Error('La API devolvió un elemento GeoJSON inválido.');
      feature.properties = feature.properties || {};
      // Spatial API publica estas métricas al nivel del Feature. La interfaz
      // las consulta en properties: conservar ambas representaciones.
      ['porcentaje_afectado', 'area_total_m2', 'area_interseccion_m2'].forEach((key) => {
        if (feature[key] !== undefined && feature[key] !== null) {
          const value = Number(feature[key]);
          if (!Number.isFinite(value)) throw new Error('La API devolvió una métrica espacial inválida: ' + key);
          feature.properties[key] = value;
        }
      });
    });
    return body;
  }

  async function getAllFeatures(path, queryParams) {
    // filter_2 no devuelve total y su límite predeterminado es 10 millones.
    // Consultar páginas acotadas y no presentar catálogos truncados.
    const limit = 1000;
    const features = [];
    for (let offset = 0; offset < 100000; offset += limit) {
      const page = normalizeFeatureCollection(await get(path, { ...queryParams, limit, offset }));
      features.push(...page.features);
      if (page.features.length < limit) return { ...page, features };
    }
    throw new Error('La consulta excedió el tamaño permitido. Ajusta el filtro antes de continuar.');
  }

  // El catálogo distrital es el mismo para ambas etapas.
  function getDistrictUTs(district) {
    const number = Number(district);
    if (!Number.isInteger(number) || number < 1 || number > 33) {
      return Promise.reject(new Error('Selecciona un distrito válido (1 a 33).'));
    }
    return getAllFeatures(CONFIG.ENDPOINTS.utPorCve, { dtto_loc: number });
  }

  // ============================================================
  // GEOMETRÍA DE UNA UT
  // ============================================================
  // filter_2 consulta directamente la BD mediante cve_ut y
  // devuelve exclusivamente la geometría/properties de esa UT.
  // ============================================================

  function getUTByCve(cveUt) {
    return getAllFeatures(
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
    ).then(normalizeFeatureCollection);
  }

  // ============================================================
  // SECCIONES DE REFERENCIA CON BUFFER
  // ============================================================

  function seccionesDeReferencia(
    geometry,
    bufferMeters = CONFIG.MAP.referenceBufferMeters
  ) {
    return intersect(
      CONFIG.TABLES.secciones,
      {
        geometry,
        mode: 'intersects',
        includePercentage: false,
        bufferMeters
      }
    );
  }

  // ============================================================
  // SECCIONES
  // ============================================================

  function getSeccionesDeUT(cveUt) {
    return getAllFeatures(
      `/filter_2/${CONFIG.TABLES.secciones}`,
      { clave: cveUt }
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
    }).then((body) => {
      if (typeof body?.cache_id !== 'string' || !body.cache_id) {
        throw new Error('La API no devolvió el identificador de la geometría temporal.');
      }
      return body;
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
    ).then(normalizeFeatureCollection);
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

  // ============================================================
  // SECCIONES AFECTADAS (caso IV: inclusión/exclusión de secciones)
  // ============================================================

  function seccionesAfectadas({ geometry, cacheId }) {
    return intersect(
      CONFIG.TABLES.secciones,
      {
        geometry,
        cacheId,
        mode: 'intersects',
        includePercentage: true
      }
    );
  }

  return {
    getDistrictUTs,
    getUTByCve,
    getSeccionesDeUT,
    cacheStore,
    intersect,
    manzanasDeReferencia,
    seccionesDeReferencia,
    manzanasAfectadas,
    localidadesAfectadas,
    seccionesAfectadas
  };

})();
