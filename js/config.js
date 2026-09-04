const CONFIG = {

  // Proxy PHP local
  API_BASE: 'api-proxy_local.php',

  // Endpoints espaciales de UT
  ENDPOINTS: {
    utCatalogo: '/geometries/uts_mgpc',
    utPorCve: '/filter_2/uts_mgpc'
  },

  // Nombres de tablas
  TABLES: {
    uts: 'uts_mgpc',
    secciones: 'secciones_uts',
    manzana: 'manzana',
    localidad: 'localidad'
  },

  SAMPLING: {
    Z: 2.58,
    p: 0.5,
    q: 0.5,
    d: 0.002,
    censusThreshold: 100
  },

  MAP: {
    center: [19.4326, -99.1332],
    zoom: 11,
    maxZoom: 20
  },

  CACHE_TTL_MINUTES: 120
};
