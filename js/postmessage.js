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
  // externo (event.data). El valor de la derecha es la llave real que
  // usa el sistema SAM; cámbialo aquí cuando te lo confirmen — no hace
  // falta tocar nada más en este archivo ni en app.js.
  const FIELD_MAP = {
    cveUt: 'cve_ut', // <- clave de la Unidad Territorial (ej. "05-030")
    tipoCaso: 'tipo_caso', // <- tipo de caso (I, II, III, IV, V, VI, VII / 1-7)
    caseId: 'id' // <- folio/expediente, solo informativo por ahora
  };

  // 3) Traduce el valor de "tipo_caso" que manda el sistema externo al
  // id interno que usa <select id="sel-tipo-caso"> (ver
  // js/modeloEncuesta.js, TIPOS_CASO). Se incluyen de entrada varias
  // formas razonables (numeral romano, número, nombre) para que algo
  // funcione desde el primer día de pruebas; borra las que no apliquen
  // y ajusta las que sí en cuanto sepan el valor exacto.
  const TIPO_CASO_MAP = {
    I: 'division', '1': 'division', division: 'division',
    II: 'fusion', '2': 'fusion', fusion: 'fusion',
    III: 'nomenclatura', '3': 'nomenclatura', nomenclatura: 'nomenclatura',
    IV: 'inc_exc_secciones', '4': 'inc_exc_secciones', inc_exc_secciones: 'inc_exc_secciones',
    V: 'inc_exc_manzanas', '5': 'inc_exc_manzanas', inc_exc_manzanas: 'inc_exc_manzanas',
    VI: 'combinacion', '6': 'combinacion', combinacion: 'combinacion',
    VII: 'otros', '7': 'otros', otros: 'otros'
  };

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

    if (cveUt === undefined && tipoCasoRaw === undefined) {
      // Trae otra cosa (otro tipo de mensaje del mismo sistema padre);
      // no es un error, simplemente no es para nosotros.
      logDebug('Mensaje de origen permitido, sin cve_ut ni tipo_caso (se ignora):', raw);
      return;
    }

    const tipoCasoId =
      tipoCasoRaw !== undefined ? TIPO_CASO_MAP[tipoCasoRaw] ?? null : null;

    if (tipoCasoRaw !== undefined && tipoCasoId === null) {
      logDebug(
        ` tipo_caso="${tipoCasoRaw}" no está en TIPO_CASO_MAP — revisa/agrega ese valor en js/postmessage.js.`,
        null,
        true
      );
    }

    lastReceived = { cveUt, tipoCasoRaw, tipoCasoId, caseId, raw };

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
