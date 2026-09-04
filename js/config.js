const CONFIG = {

  // Proxy PHP local
  API_BASE: 'api-proxy_local.php',

  // Endpoint para obtener únicamente la UT solicitada.
  // Ejemplo: /filter_2/uts_mgpc?cve_ut=05-030
  ENDPOINTS: {
    utPorCve: '/filter_2/uts_mgpc'
  },

  // Nombres de tablas usadas por la Spatial API
  TABLES: {
    uts: 'uts_mgpc',
    secciones: 'secciones_uts',
    manzana: 'manzana',
    localidad: 'localidad'
  },

  // Parámetros del muestreo
  SAMPLING: {
    Z: 2.58,
    p: 0.5,
    q: 0.5,
    d: 0.002,
    censusThreshold: 100
  },

  // Configuración del mapa
  MAP: {
    center: [19.4326, -99.1332],
    zoom: 11,
    maxZoom: 20,

    // Distancia utilizada únicamente para mostrar contexto visual
    // alrededor de la UT seleccionada.
    referenceBufferMeters: 50
  },

  // TTL de la geometría de zona afectada guardada en la API
  CACHE_TTL_MINUTES: 120
};
