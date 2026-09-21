// ============================================================
// postmessage.js — puente para operar como microservicio embebido
// (iframe) dentro de otro sistema (SCCMGPC / "Fase 2. Sistema SAM").
//
// El sistema externo nos manda datos iniciales (clave de UT, tipo de
// caso, folio) vía window.postMessage en vez de que la persona los
// teclee aquí. Este archivo:
//   1) Escucha esos mensajes.
//   2) Valida que vengan de un origen permitido.
//   3) Traduce los nombres/valores de campo del sistema externo a los
//      que usa este sistema.
//   4) Muestra en pantalla (y en consola) lo que va llegando, para
//      poder confirmar visualmente que la integración funciona.
//
// TODO(equipo SAM): en cuanto tengan el payload real, ajustar:
//   - ALLOWED_ORIGINS  -> dominio(s) real(es) desde donde se manda el mensaje
//   - FIELD_MAP        -> nombres reales de las llaves dentro de event.data
//   - TIPO_CASO_MAP    -> valores reales que manda "tipo_caso"
// Los tres son los ÚNICOS lugares que hace falta tocar; el resto del
// archivo no debería necesitar cambios.
// ============================================================

const PostMessageBridge = (() => {

  // 1) Orígenes desde los que se acepta el mensaje.
  // Por seguridad NUNCA se usa '*' aquí: aceptar mensajes de cualquier
  // origen permitiría que cualquier página que nos embeba en un
  // <iframe> nos mande cve_ut/tipo_caso falsos y dispare cálculos con
  // datos que no vienen realmente del sistema SAM.
  // Ajusta/agrega aquí el o los orígenes reales (protocolo + host +
  // puerto, SIN ruta) del sistema SAM en cada ambiente.
  const ALLOWED_ORIGINS = [
    'http://145.0.51.70',
    'https://145.0.51.70'
    // 'https://sam.iecm.mx', // <- agregar cuando exista un dominio de producción
  ];

  // 2) Nombres de los campos DENTRO del objeto que manda el sistema
  // externo (event.data). Confirmado con un payload real recibido:
  //   {"tipo":"INIT_FASE_2","idCaso":53,"claveUT":"05-021",
  //    "clasificacion":"FUSIÓN",
  //    "utInvolucradas":[{"idSeccxut":38,"claveUT":"02-017"}]}
  const FIELD_MAP = {
    tipo: 'tipo', // <- tipo de mensaje, ej. "INIT_FASE_2"
    cveUt: 'claveUT', // <- clave de la Unidad Territorial (ej. "05-021")
    tipoCaso: 'clasificacion', // <- tipo de caso en texto (ej. "FUSIÓN")
    caseId: 'idCaso', // <- folio/expediente, solo informativo por ahora
    utInvolucradas: 'utInvolucradas' // <- [{claveUT, idSeccxut}], usado en Fusión
  };

  // 3) Traduce el valor de "clasificacion" que manda el sistema externo
  // (texto libre, ej. "FUSIÓN") al id interno que usa
  // <select id="sel-tipo-caso"> (ver js/modeloEncuesta.js, TIPOS_CASO:
  // 'division','fusion','nomenclatura','inc_exc_secciones',
  // 'inc_exc_manzanas','combinacion','otros').
  //
  // Se hace por PALABRA CLAVE (no por coincidencia exacta) para no
  // depender de acentos/mayúsculas exactas del sistema externo. Si el
  // equipo de SAM confirma que mandan otro texto para algún caso,
  // agrega la palabra clave correspondiente en KEYWORDS_POR_TIPO.
  const KEYWORDS_POR_TIPO = [
    ['division', ['DIVISION']],
    ['fusion', ['FUSION']],
    ['nomenclatura', ['NOMENCLATURA']],
    ['inc_exc_secciones', ['SECCION', 'SECCIONES']],
    ['inc_exc_manzanas', ['MANZANA', 'MANZANAS']],
    ['combinacion', ['COMBINA']],
    ['otros', ['OTRO']]
  ];

  function normalizarTexto(texto) {
    return String(texto ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // quita acentos
      .toUpperCase()
      .trim();
  }

  function traducirTipoCaso(valorExterno) {
    if (valorExterno === undefined || valorExterno === null) return null;

    const normalizado = normalizarTexto(valorExterno);

    for (const [id, keywords] of KEYWORDS_POR_TIPO) {
      if (keywords.some((kw) => normalizado.includes(kw))) {
        return id;
      }
    }

    return null;
  }

  let onDataReceived = null;
  let lastReceived = null;

  function init(callback) {
    onDataReceived = callback;
    window.addEventListener('message', handleMessage);
    logDebug('Escuchando postMessage. Orígenes permitidos: ' + ALLOWED_ORIGINS.join(', '));
    notifyReady();
  }

  // Avisa a la página que nos embebe que ya podemos recibir datos.
  // Útil si el iframe tarda en cargar y el padre ya había mandado el
  // mensaje antes de que estuviéramos escuchando.
  function notifyReady() {
    try {
      window.parent.postMessage({ type: 'mgpc-encuestas:ready' }, '*');
    } catch (e) {
      // No estamos dentro de un iframe (ej. pruebas locales abriendo
      // el archivo directo) — se ignora sin problema.
    }
  }

  function handleMessage(event) {
    const origenPermitido = ALLOWED_ORIGINS.includes(event.origin);

    if (!origenPermitido) {
      // No se procesa, pero se deja constancia visible: si esperabas
      // que esto funcionara y ves este mensaje, probablemente falta
      // agregar tu origen a ALLOWED_ORIGINS arriba.
      logDebug(
        ` Mensaje ignorado: origen "${event.origin}" no está en ALLOWED_ORIGINS.`,
        event.data,
        true
      );
      return;
    }

    const raw = event.data;
    if (!raw || typeof raw !== 'object') {
      logDebug('Mensaje recibido de origen permitido pero sin datos utilizables:', raw);
      return;
    }

    const cveUt = raw[FIELD_MAP.cveUt];
    const tipoCasoRaw = raw[FIELD_MAP.tipoCaso];
    const caseId = raw[FIELD_MAP.caseId];
    const utInvolucradas = raw[FIELD_MAP.utInvolucradas];

    if (cveUt === undefined && tipoCasoRaw === undefined) {
      // Trae otra cosa (otro tipo de mensaje del mismo sistema padre);
      // no es un error, simplemente no es para nosotros.
      logDebug('Mensaje de origen permitido, sin cve_ut ni tipo_caso (se ignora):', raw);
      return;
    }

    const tipoCasoId = traducirTipoCaso(tipoCasoRaw);

    if (tipoCasoRaw !== undefined && tipoCasoId === null) {
      logDebug(
        `⚠️ clasificacion="${tipoCasoRaw}" no coincide con ninguna palabra clave conocida — revisa/agrega en KEYWORDS_POR_TIPO en js/postmessage.js.`,
        null,
        true
      );
    }

    lastReceived = {
      cveUt,
      tipoCasoRaw,
      tipoCasoId,
      caseId,
      utInvolucradas: Array.isArray(utInvolucradas) ? utInvolucradas : [],
      raw
    };

    logDebug(' Datos recibidos y traducidos correctamente:', lastReceived);

    if (typeof onDataReceived === 'function') {
      onDataReceived(lastReceived);
    }
  }

  function logDebug(msg, data, isWarning = false) {
    console.log(
      isWarning ? '%c[postMessage] ' : '%c[postMessage]',
      isWarning ? 'color:#b02a37;font-weight:bold;' : 'color:#5b3aa6;font-weight:bold;',
      msg,
      data !== undefined ? data : ''
    );

    const el = document.getElementById('postmessage-debug');
    if (!el) return;

    const line = document.createElement('div');
    line.style.color = isWarning ? '#b02a37' : '#333';
    line.style.borderBottom = '1px solid #eee';
    line.style.padding = '2px 0';
    line.textContent =
      `[${new Date().toLocaleTimeString('es-MX')}] ${msg}` +
      (data !== undefined && data !== null ? ' ' + JSON.stringify(data) : '');
    el.prepend(line);
  }

  function getLastReceived() {
    return lastReceived;
  }

  return { init, getLastReceived };
})();
