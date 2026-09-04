// ============================================================
// modeloEncuesta.js — traduce la tabla del inciso "c) Situación/
// modelo de encuesta a utilizar" del Documento Rector (pág. 14-15)
// a una función que sugiere qué modelo aplica.
//
// IMPORTANTE: esto es una AYUDA/sugerencia para el distrito, no una
// determinación legal automática. El distrito debe validar contra
// el Documento Rector completo, en particular la existencia real
// y vigencia del COPACO.
// ============================================================
const ModeloEncuesta = (() => {

  const TIPOS_CASO = [
    { id: 'division', label: 'I. División' },
    { id: 'fusion', label: 'II. Fusión' },
    { id: 'nomenclatura', label: 'III. Cambio de Nomenclatura' },
    { id: 'inc_exc_secciones', label: 'IV. Inclusión/Exclusión de Secciones electorales' },
    { id: 'inc_exc_manzanas', label: 'V. Inclusión/Exclusión de Manzanas electorales' },
    { id: 'combinacion', label: 'VI. Combinación' },
    { id: 'otros', label: 'VII. Otros' }
  ];

  /**
   * @param {string} tipoCaso - uno de los ids de TIPOS_CASO
   * @param {object} opts
   *   existeCopaco: boolean
   *   causaIdentidadCultural: boolean
   *   esDesempate: boolean            (ya hubo encuesta a ciudadanía y hubo empate)
   *   esSolicitudCiudadana: boolean   (aplica sobre todo a IV/V: la piden ciudadanos)
   *   esActualizacionCartografica: boolean
   */
  function determinarModelo(tipoCaso, opts = {}) {
    const {
      existeCopaco = false,
      causaIdentidadCultural = false,
      esDesempate = false,
      esSolicitudCiudadana = false,
      esActualizacionCartografica = false
    } = opts;

    // El desempate por resultados previos siempre se resuelve con COPACO,
    // sin importar el tipo de caso (patrón repetido en toda la tabla).
    if (esDesempate) {
      return resultado('C2', existeCopaco,
        'Desempate por resultados obtenidos al encuestar a la ciudadanía → se aplica encuesta a COPACO (Anexo 3).');
    }

    if (causaIdentidadCultural && tipoCaso !== 'inc_exc_secciones' && tipoCaso !== 'inc_exc_manzanas') {
      return resultado('C1', true,
        'La causa es identidad cultural → se aplica encuesta al % de personas ciudadanas de las manzanas/secciones involucradas (Anexo 2). La N de este sistema SÍ aplica directamente aquí.');
    }

    switch (tipoCaso) {
      case 'division':
      case 'fusion':
      case 'nomenclatura':
      case 'combinacion':
        if (!existeCopaco && esActualizacionCartografica) {
          return resultado('no_aplica', false,
            'No existe COPACO y la causa es actualización cartográfica / rasgos geográficos → no aplica encuesta.');
        }
        return resultado('C2', existeCopaco,
          'Causa distinta a identidad cultural → se aplica encuesta a integrantes del COPACO (Anexo 3).');

      case 'inc_exc_secciones':
      case 'inc_exc_manzanas':
        if (esSolicitudCiudadana) {
          return resultado('C1', true,
            'La solicitud de mover la sección/manzana la hacen las personas ciudadanas → se aplica encuesta al % de personas ciudadanas involucradas (Anexo 2). La N de este sistema aplica directamente aquí.');
        }
        if (!existeCopaco && esActualizacionCartografica) {
          return resultado('no_aplica', false,
            'No existe COPACO y es una actualización cartográfica (creación/baja de sección o manzana) → no aplica encuesta.');
        }
        return resultado('C2', existeCopaco,
          'Se requiere desempate o hay COPACO en la UT → se aplica encuesta a COPACO (Anexo 3).');

      case 'otros':
      default:
        return resultado('por_definir', false,
          'Tipo de caso "Otros": el Documento Rector indica que se determinará según cada caso particular.');
    }
  }

  function resultado(modelo, poblacionalAplica, nota) {
    const labels = {
      C1: 'MGPC2025-C1 — Encuesta a ciudadanía (Anexo 2)',
      C2: 'MGPC2025-C2 — Encuesta a integrantes del COPACO (Anexo 3)',
      no_aplica: 'No aplica encuesta',
      por_definir: 'Por definirse según el caso'
    };
    return {
      modelo,
      label: labels[modelo],
      // Indica si la "N" (población afectada) que calcula este sistema
      // se puede usar directamente para dimensionar la muestra.
      usaPoblacionAfectada: modelo === 'C1',
      nota
    };
  }

  return { TIPOS_CASO, determinarModelo };
})();
