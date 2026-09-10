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

  // Parámetros del muestreo — fórmula de Cochran directa sobre la
  // población afectada + censo mínimo (ver js/sampling.js y
  // Analisis_Muestreo_MGPC2025.xlsx, hoja "3. Propuesta nueva").
  // Z, p, q son los mismos que ya usa el Documento Rector.
  // d=0.05 (5% de margen de error) es el default para el cálculo LOCAL
  // por modificación de UT — es el margen estándar en literatura de
  // muestreo aplicado (Israel 1992; Levy & Lemeshow), a diferencia del
  // d=0.002 que el Documento Rector usa para el total citadino (398,045
  // sobre 9,209,944), demasiado estricto para poblaciones locales
  // pequeñas (obliga a un censo casi completo). Ajustable aquí o en
  // vivo desde el panel "4. Parámetros de muestreo".
  // censusThreshold=100 es el umbral de censo mínimo de esa propuesta.
  SAMPLING: {
    Z: 2.58,
    p: 0.5,
    q: 0.5,
    d: 0.05,
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
