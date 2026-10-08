const CONFIG = {

  ASSET_VERSION: '20261007-labels-1',
  CASES: {
    division: { label: 'División de una UT', instruction: 'Primero prepara los nuevos límites. La muestra se calculará sobre toda la UT original.' },
    fusion: { label: 'Fusión de UT', instruction: 'Elige una o más UT vecinas para unirlas a la seleccionada. Después calcula la muestra del conjunto.' },
    nomenclatura: { label: 'Cambio de nomenclatura', instruction: 'Los límites se conservan. Continúa directamente al cálculo de la muestra.' },
    inc_exc_secciones: { label: 'Incluir o quitar secciones', instruction: 'Elige en el mapa las secciones que deseas agregar o quitar. Después calcula la muestra de la zona que cambia.' },
    inc_exc_manzanas: { label: 'Ajustar límites y manzanas', instruction: 'Ajusta los límites en el mapa. Después calcula la muestra de la zona que cambia.' },
    combinacion: { label: 'Combinación de casos', pending: true },
    otros: { label: 'Otros casos', pending: true }
  },

  // Clave pública de navegador: restringir por dominio en Google Cloud.
  GOOGLE_MAPS_API_KEY: 'AIzaSyCw42oKA6idOiNV51RXLHzRwYwn7MerDBI',

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
    secciones: 'secciones',
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

  // ============================================================
  // Perfil de comportamiento por tipo de caso (ids de
  // ModeloEncuesta.TIPOS_CASO). Define, para cada uno:
  //   targetGeometry: sobre qué geometría se aplica la fórmula
  //     - 'original'      -> el polígono completo de la UT cargada
  //     - 'merge'         -> unión (turf.union) de la UT + las UTs
  //                          involucradas elegidas en el mapa
  //     - 'zona_afectada' -> la diferencia simétrica que resulta de
  //                          editar manualmente el polígono (flujo
  //                          "3. Editar propuesta de límite")
  //   capa: contra qué tabla se intersecta para sacar la N
  //     - 'manzana' | 'seccion'
  //   editable: permite mover los límites en la preparación.
  //     En división se prepara primero aunque se consulte toda la UT.
  //     Fusión y secciones se preparan mediante selección en el mapa.
  //   pendiente: true -> metodología aún no definida (Combinación,
  //     Otros); el sistema bloquea el análisis y lo deja explícito.
  // ============================================================
  CASOS_PERFIL: {
    division: {
      targetGeometry: 'original',
      capa: 'manzana',
      editable: true,
      requiresProposal: true
    },
    fusion: {
      targetGeometry: 'merge',
      capa: 'manzana',
      editable: false,
      requiresProposal: true
    },
    nomenclatura: {
      targetGeometry: 'original',
      capa: 'manzana',
      editable: false,
      requiresProposal: false
    },
    inc_exc_manzanas: {
      targetGeometry: 'zona_afectada',
      capa: 'manzana',
      editable: true,
      requiresProposal: true
    },
    inc_exc_secciones: {
      targetGeometry: 'zona_afectada',
      capa: 'seccion',
      editable: false,
      requiresProposal: true
    },
    combinacion: { pendiente: true },
    otros: { pendiente: true }
  },

  // TTL de la geometría de zona afectada guardada en la API
  CACHE_TTL_MINUTES: 120
};
