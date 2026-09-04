// ============================================================
// Configuración del sistema — ajusta estos valores a tu entorno
// ============================================================
const CONFIG = {
  // Base de tu Spatial API. Sin slash final.
  API_BASE: 'https://145.0.50.112/api/index.php',

  // Clave API (se manda como ?api_key=... en cada petición)
  API_KEY: 'a1b2c3d4e5f6g7h8i9j0',

  // Nombres de tablas en la BD (ajusta si difieren)
  TABLES: {
    uts: 'uts_mgpc',
    secciones: 'secciones_uts',
    manzana: 'manzana',
    localidad: 'localidad'
  },

  // Parámetros de la fórmula de Cochran (mismos que el Documento Rector)
  SAMPLING: {
    Z: 2.58,
    p: 0.5,
    q: 0.5,
    d: 0.002,
    censusThreshold: 100 // si N <= esto, se aplica censo (100%)
  },

  // Mapa
  MAP: {
    center: [19.4326, -99.1332], // CDMX
    zoom: 11,
    maxZoom: 20
  },

  // TTL de la geometría cacheada en el servidor (minutos)
  CACHE_TTL_MINUTES: 120
};
