// ============================================================
// app.js — orquesta la interfaz: selección directa de UT,
// edición del polígono, cálculo de zona afectada, consultas API
// y cálculo final de la muestra.
// ============================================================

const state = {
  selectedUT: null,
  affectedFeature: null, // geometría objetivo del análisis (original, merge o zona editada, según el caso)
  referenceLoaded: false,
  referenceRequestId: 0,
  manzanasResult: null,
  localidadResult: null,
  seccionesResult: null,
  capaAfectacion: 'manzana', // 'manzana' | 'seccion' — según el tipo de caso
  utInvolucradas: [], // [{claveUT, idSeccxut}] recibidas por postMessage, para Fusión
  bloqueadoPorExterno: false, // true si UT/tipo de caso vinieron por postMessage
  ultimoResultado: null // snapshot del último análisis (N, método, modelo, params...), usado por la exportación a Excel y por el postMessage al sistema padre
};

let mapManager = null;

function setStatus(msg, type = '') {
  const el = document.getElementById('analizar-status');
  el.textContent = msg;
  el.className = 'status-line' + (type ? ' ' + type : '');
  const footer = document.getElementById('log-footer');
  const time = new Date().toLocaleTimeString('es-MX');
  footer.textContent = `[${time}] ${msg}`;
}

function normalizeCveUt(value) {
  return (value || '').trim().toUpperCase();
}

// La Spatial API a veces devuelve "LN" (mayúsculas) y otras "ln".
// Se lee de forma robusta para no perder población por un problema de mayúsculas.
function getLN(props) {
  if (!props) return 0;
  const raw = props.LN ?? props.ln ?? props.Ln ?? props.lN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function populateTipoCasoSelect() {
  const sel = document.getElementById('sel-tipo-caso');
  sel.innerHTML = '';
  ModeloEncuesta.TIPOS_CASO.forEach(({ id, label }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    sel.appendChild(opt);
  });
}

function populateParamInputs() {
  document.getElementById('param-z').value = CONFIG.SAMPLING.Z;
  document.getElementById('param-p').value = CONFIG.SAMPLING.p;
  document.getElementById('param-q').value = CONFIG.SAMPLING.q;
  document.getElementById('param-d').value = CONFIG.SAMPLING.d;
  document.getElementById('param-umbral').value = CONFIG.SAMPLING.censusThreshold;
}

function readParamsFromUI() {
  const num = (id, fallback) => {
    const v = parseFloat(document.getElementById(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    Z: num('param-z', CONFIG.SAMPLING.Z),
    p: num('param-p', CONFIG.SAMPLING.p),
    q: num('param-q', CONFIG.SAMPLING.q),
    d: num('param-d', CONFIG.SAMPLING.d),
    censusThreshold: num('param-umbral', CONFIG.SAMPLING.censusThreshold)
  };
}

function resetDownstreamState() {
  state.affectedFeature = null;
  state.manzanasResult = null;
  state.localidadResult = null;
  state.seccionesResult = null;
  state.referenceLoaded = false;
  state.ultimoResultado = null;

  document.getElementById('zona-afectada-info').classList.add('hidden');
  document.getElementById('panel-resultados').hidden = true;
  document.getElementById('btn-analizar').disabled = true;

  mapManager.clearDownstream();
}

// ---------------- Comportamiento por tipo de caso ----------------

// Habilita/deshabilita el paso "3. Editar propuesta de límite" y avisa
// por qué, cuando el tipo de caso no lo necesita (la fórmula usa la UT
// completa o una fusión, no una edición manual del límite).
function setEditarLimiteHabilitado(habilitado, motivo) {
  const panel = document.getElementById('panel-editar-limite');
  const hint = document.getElementById('editar-limite-hint');
  const btnEditar = document.getElementById('btn-editar');
  const btnCalcularZona = document.getElementById('btn-calcular-zona');

  panel.classList.toggle('panel-disabled', !habilitado);

  if (habilitado) {
    hint.textContent =
      'Carga la UT primero. Habilita la edición, arrastra los vértices del polígono azul para proponer el nuevo límite y luego bloquea la edición para poder calcular la zona afectada.';
  } else {
    btnEditar.disabled = true;
    btnCalcularZona.disabled = true;
    hint.textContent =
      motivo ||
      'Este tipo de caso no requiere editar el límite manualmente.';
  }
}

// Fija la geometría sobre la que se va a calcular la N (población
// afectada) y la muestra en el mapa, sin pasar por el flujo manual de
// "editar y calcular zona afectada".
function establecerGeometriaObjetivo(feature, etiqueta) {
  state.affectedFeature = feature;
  mapManager.showAffected(feature);

  const areaM2 = turf.area(feature);
  const info = document.getElementById('zona-afectada-info');
  info.classList.remove('hidden');
  info.innerHTML =
    `Geometría objetivo del análisis (${etiqueta}): <b>${areaM2.toLocaleString('es-MX', {
      maximumFractionDigits: 0
    })} m²</b>. Lista para analizar.`;

  document.getElementById('btn-analizar').disabled = false;
  setStatus(
    `Geometría objetivo calculada automáticamente (${etiqueta}). Puedes analizar.`,
    'ok'
  );
}

// Caso Fusión: descarga las UTs involucradas (recibidas por
// postMessage en utInvolucradas) y las une (turf.union) con la UT
// principal ya cargada.
async function fusionarUTsInvolucradas() {
  if (!state.selectedUT) return;

  if (!state.utInvolucradas.length) {
    setStatus(
      'Fusión requiere la lista de UTs involucradas (utInvolucradas), recibida por postMessage. No se recibió ninguna, así que no se puede calcular automáticamente.',
      'error'
    );
    return;
  }

  try {
    setStatus(
      `Descargando ${state.utInvolucradas.length} UT(s) involucrada(s) para la fusión…`
    );

    let mergedGeometry = state.selectedUT.geometry;

    for (const involucrada of state.utInvolucradas) {
      const cve = normalizeCveUt(involucrada.claveUT);
      if (!cve) continue;

      const response = await Api.getUTByCve(cve);
      const feature =
        response?.type === 'Feature'
          ? response
          : response?.features?.[0] || null;

      if (!feature?.geometry) {
        throw new Error(
          `No se pudo obtener la geometría de la UT involucrada ${cve}.`
        );
      }

      mergedGeometry = turf.union(
        turf.feature(mergedGeometry),
        turf.feature(feature.geometry)
      ).geometry;
    }

    const mergedFeature = turf.feature(mergedGeometry);
    establecerGeometriaObjetivo(mergedFeature, 'fusión de UTs');

  } catch (e) {
    setStatus('Error al fusionar las UTs involucradas: ' + e.message, 'error');
  }
}

// ---------------- Referencia visual según capa ----------------

function actualizarReferenciaUI() {
  const label = document.getElementById('lbl-referencia');

  if (!label) return;

  label.textContent =
    state.capaAfectacion === 'seccion'
      ? 'Mostrar secciones de referencia (contexto visual)'
      : 'Mostrar manzanas de referencia (contexto visual)';
}

async function loadReferenceLayer() {
  const requestId = ++state.referenceRequestId;
  const capaSolicitada = state.capaAfectacion;

  try {
    const original = mapManager.getOriginalGeoJSON();

    if (!original?.geometry) {
      throw new Error('La UT seleccionada no tiene una geometría válida.');
    }

    const esSeccion = capaSolicitada === 'seccion';
    const etiqueta = esSeccion ? 'secciones' : 'manzanas';

    setStatus(
      `Cargando ${etiqueta} de referencia (buffer ${CONFIG.MAP.referenceBufferMeters} m)…`
    );

    const fc = esSeccion
      ? await Api.seccionesDeReferencia(original.geometry)
      : await Api.manzanasDeReferencia(original.geometry);

    // La respuesta puede llegar después de que el usuario haya
    // cambiado el tipo de caso. En ese escenario ya no corresponde
    // dibujar esta capa.
    if (
      requestId !== state.referenceRequestId ||
      capaSolicitada !== state.capaAfectacion
    ) {
      return;
    }

    if (esSeccion) {
      mapManager.showReferenceSecciones(fc);
    } else {
      mapManager.showReferenceManzanas(fc);
    }

    state.referenceLoaded = true;

    setStatus(
      `${etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1)} de referencia cargadas: ${fc.count ?? fc.features?.length ?? 0}.`,
      'ok'
    );

  } catch (e) {
    // No mostrar un error de una petición que ya quedó obsoleta.
    if (
      requestId !== state.referenceRequestId ||
      capaSolicitada !== state.capaAfectacion
    ) {
      return;
    }

    state.referenceLoaded = false;

    setStatus(
      'Error al cargar la capa de referencia: ' + e.message,
      'error'
    );
  }
}

// Se ejecuta cada vez que cambia el tipo de caso o se termina de
// Se ejecuta cada vez que cambia el tipo de caso o se termina de
// cargar una UT: aplica el perfil correspondiente (ver
// CONFIG.CASOS_PERFIL) — decide si hace falta editar el límite a mano,
// si la geometría objetivo se fija sola (UT completa / fusión), y
// contra qué capa (manzana o sección) se va a calcular la N.
async function aplicarPerfilYCalcular() {
  const tipoCasoId = document.getElementById('sel-tipo-caso').value;
  const perfil = CONFIG.CASOS_PERFIL[tipoCasoId];
  const pendienteInfo = document.getElementById('caso-pendiente-info');

  if (!perfil) return;

  if (perfil.pendiente) {
    pendienteInfo.classList.remove('hidden');
    pendienteInfo.innerHTML =
      '⏳ Este tipo de caso (Combinación / Otros) todavía no tiene metodología de cálculo definida en el sistema. Está pendiente de definir — por ahora no es posible editar el límite ni analizar.';
    setEditarLimiteHabilitado(false, 'Pendiente de definir metodología para este tipo de caso.');
    document.getElementById('btn-analizar').disabled = true;
    return;
  }

  pendienteInfo.classList.add('hidden');
  state.capaAfectacion = perfil.capa;
  actualizarReferenciaUI();

  if (!state.selectedUT) {
    // Todavía no hay UT cargada: solo se deja preparado el modo de
    // edición; el resto se resuelve cuando llegue la UT.
    setEditarLimiteHabilitado(perfil.editable);
    return;
  }

  if (perfil.targetGeometry === 'zona_afectada') {
    // Inclusión/exclusión de manzanas/secciones: la geometría objetivo depende
    // de que la persona edite el límite y calcule la zona afectada.
    if (state.affectedFeature) resetDownstreamState();
    setEditarLimiteHabilitado(true);
    document.getElementById('btn-editar').disabled = false;
    return;
  }

  // targetGeometry es 'original' o 'merge': no hace falta editar nada,
  // se fija sola la geometría objetivo.
  setEditarLimiteHabilitado(
    false,
    'Este tipo de caso aplica la fórmula sobre ' +
      (perfil.targetGeometry === 'merge'
        ? 'la fusión de las UTs involucradas'
        : 'toda la Unidad Territorial') +
      ', no sobre una edición manual del límite.'
  );

  if (perfil.targetGeometry === 'original') {
    establecerGeometriaObjetivo(state.selectedUT, 'UT completa');
  } else if (perfil.targetGeometry === 'merge') {
    await fusionarUTsInvolucradas();
  }
}

// Bloquea (solo lectura) la clave de UT y el tipo de caso cuando
// llegaron por postMessage del sistema SAM, para que no se puedan
// modificar a mano en ese flujo.
function bloquearCamposExternos() {
  state.bloqueadoPorExterno = true;
  document.getElementById('ut-search').disabled = true;
  document.getElementById('btn-cargar-ut').disabled = true;
  document.getElementById('sel-tipo-caso').disabled = true;
  document.getElementById('lock-note').classList.remove('hidden');
}

function wireEvents() {
  actualizarReferenciaUI();
  const utSearch = document.getElementById('ut-search');
  const btnCargarUT = document.getElementById('btn-cargar-ut');
  const btnEditar = document.getElementById('btn-editar');
  const btnCalcularZona = document.getElementById('btn-calcular-zona');
  const btnAnalizar = document.getElementById('btn-analizar');
  const btnExportar = document.getElementById('btn-exportar');
  const chkReferencia = document.getElementById('chk-referencia');

  utSearch.addEventListener('input', () => {
    btnCargarUT.disabled = normalizeCveUt(utSearch.value) === '';
  });

  document
    .getElementById('sel-tipo-caso')
    .addEventListener('change', async () => {
      // Invalida cualquier consulta de referencia que siga en vuelo.
      state.referenceRequestId += 1;
      state.referenceLoaded = false;

      await aplicarPerfilYCalcular();

      if (
        document.getElementById('chk-referencia').checked &&
        state.selectedUT
      ) {
        await loadReferenceLayer();
      }
    });

  btnCargarUT.addEventListener('click', async () => {
    const cve = normalizeCveUt(utSearch.value);

    if (!cve) {
      setStatus('Escribe la clave de la UT antes de cargarla.', 'error');
      return;
    }

    btnCargarUT.disabled = true;

    try {
      setStatus(`Consultando geometría de la UT ${cve}…`);

      const response = await Api.getUTByCve(cve);

      let feature = null;

      if (response?.type === 'FeatureCollection') {
        feature = response.features?.[0] || null;
      } else if (response?.type === 'Feature') {
        feature = response;
      } else if (response?.features?.length) {
        feature = response.features[0];
      }

      if (!feature || !feature.geometry) {
        throw new Error(
          `La API no devolvió una geometría válida para la UT ${cve}.`
        );
      }

      const responseCve = normalizeCveUt(
        feature.properties?.cve_ut
      );

      if (responseCve && responseCve !== cve) {
        throw new Error(
          `La API devolvió la UT ${responseCve} en lugar de ${cve}.`
        );
      }

      state.referenceRequestId += 1;
      resetDownstreamState();
      state.selectedUT = feature;

      mapManager.loadOriginalUT(feature);

      btnEditar.textContent = 'Habilitar edición de vértices';
      btnEditar.classList.remove('btn-primary');

      const nombre = feature.properties?.nombre || '';

      setStatus(
        `UT cargada: ${responseCve || cve}${nombre ? ` — ${nombre}` : ''}`,
        'ok'
      );

      // Decide, según el tipo de caso ya elegido (o el que llegue por
      // postMessage), si hay que editar el límite a mano o si la
      // geometría objetivo se puede fijar sola (UT completa / fusión).
      await aplicarPerfilYCalcular();

      if (chkReferencia.checked) {
        await loadReferenceLayer();
      }

    } catch (e) {
      state.selectedUT = null;
      btnEditar.disabled = true;
      btnCalcularZona.disabled = true;
      setStatus(
        'Error al cargar la geometría de la UT: ' + e.message,
        'error'
      );
    } finally {
      btnCargarUT.disabled = state.bloqueadoPorExterno;
    }
  });

  chkReferencia.addEventListener('change', async () => {
    if (!state.selectedUT) return;

    if (chkReferencia.checked) {
      await loadReferenceLayer();
    } else {
      state.referenceRequestId += 1;
      state.referenceLoaded = false;
      mapManager.toggleReferenceVisible(false);
    }
  });

  btnEditar.addEventListener('click', () => {
    if (!mapManager.editingEnabled) {
      // Si ya había una zona/resultado calculado con la forma anterior,
      // se invalida: el polígono va a cambiar de nuevo.
      if (state.affectedFeature) {
        resetDownstreamState();
      }

      mapManager.enableEditing();
      btnEditar.textContent = 'Bloquear edición y continuar';
      btnEditar.classList.add('btn-primary');
      btnCalcularZona.disabled = true;

      setStatus(
        'Edición habilitada: arrastra los vértices del polígono azul. Cuando termines, presiona "Bloquear edición y continuar".'
      );
    } else {
      mapManager.disableEditing();
      btnEditar.textContent = 'Habilitar edición de vértices';
      btnEditar.classList.remove('btn-primary');
      btnCalcularZona.disabled = false;

      setStatus(
        'Edición bloqueada: el polígono ya no se puede modificar. Ahora puedes calcular la zona afectada.',
        'ok'
      );
    }
  });

  btnCalcularZona.addEventListener('click', () => {
    try {
      const original = mapManager.getOriginalGeoJSON();
      const edited = mapManager.getEditedGeoJSON();

      if (!original || !edited) {
        setStatus(
          'Carga una UT y edita su polígono antes de calcular la zona afectada.',
          'error'
        );
        return;
      }

      if (Diff.isUnchanged(original, edited)) {
        setStatus(
          'No se detectó ningún cambio en el polígono todavía.',
          'error'
        );
        return;
      }

      const { affected } = Diff.computeAffectedGeometry(
        original,
        edited
      );

      if (!affected) {
        setStatus(
          'No se pudo calcular una zona afectada válida a partir de la edición.',
          'error'
        );
        return;
      }

      state.affectedFeature = affected;
      mapManager.showAffected(affected);

      const areaM2 = turf.area(affected);
      const areaOriginalM2 = turf.area(original);
      const pctAreaUT =
        areaOriginalM2 > 0 ? (areaM2 / areaOriginalM2) * 100 : 0;

      const info = document.getElementById('zona-afectada-info');
      info.classList.remove('hidden');
      info.innerHTML =
        `Zona afectada calculada: <b>${areaM2.toLocaleString('es-MX', {
          maximumFractionDigits: 0
        })} m²</b> ` +
        `(<b>${pctAreaUT.toLocaleString('es-MX', {
          maximumFractionDigits: 1
        })}%</b> del área total de la UT). Lista para analizar.`;

      btnAnalizar.disabled = false;
      setStatus(
        'Zona afectada calculada. Puedes clasificar el caso y analizar.',
        'ok'
      );

    } catch (e) {
      setStatus(
        'Error al calcular la zona afectada: ' + e.message,
        'error'
      );
    }
  });

  btnAnalizar.addEventListener('click', analizar);
  btnExportar.addEventListener('click', exportarExcel);
}

async function analizar() {
  const btnAnalizar = document.getElementById('btn-analizar');

  if (!state.selectedUT || !state.affectedFeature) {
    setStatus('Primero calcula la zona afectada.', 'error');
    return;
  }

  btnAnalizar.disabled = true;

  try {
    setStatus(
      'Guardando la zona afectada en el servidor (caché)…'
    );

    const cacheResp = await Api.cacheStore(
      state.affectedFeature.geometry,
      state.selectedUT.properties.cve_ut,
      { origen: 'calculo_frontend_mgpc' }
    );

    const cacheId = cacheResp.cache_id;

    const usaSecciones = state.capaAfectacion === 'seccion';

    setStatus(
      usaSecciones
        ? 'Calculando secciones y localidades afectadas…'
        : 'Calculando manzanas y localidades afectadas…'
    );

    const [afectacionResp, localidadResp] = await Promise.all([
      usaSecciones
        ? Api.seccionesAfectadas({ cacheId })
        : Api.manzanasAfectadas({ cacheId }),
      Api.localidadesAfectadas({ cacheId })
    ]);

    state.localidadResult = localidadResp;
    state.manzanasResult = usaSecciones ? null : afectacionResp;
    state.seccionesResult = usaSecciones ? afectacionResp : null;

    // La Spatial API debería devolver, por manzana/sección, qué % de su
    // área cae dentro de la geometría objetivo — pero en la práctica ha
    // estado devolviendo 100% fijo (ver captura de ejemplo). Como el
    // frontend ya tiene ambas geometrías, se recalcula aquí con Turf.js
    // y se sobreescribe porcentaje_afectado con el valor real. Si por
    // alguna razón no se puede calcular (geometría inválida), se
    // conserva el valor que mandó la API como respaldo.
    let huboRecalculo = false;

    afectacionResp.features.forEach((f) => {
      if (!f?.geometry || !state.affectedFeature) return;

      const recalculado = Diff.computeOverlapPercentage(
        f.geometry,
        state.affectedFeature
      );

      if (recalculado !== null) {
        f.properties = f.properties || {};
        f.properties.porcentaje_afectado = recalculado;
        huboRecalculo = true;
      }
    });

    if (usaSecciones) {
      mapManager.showSeccionesResult(afectacionResp);
    } else {
      mapManager.showManzanasResult(afectacionResp);
    }
    mapManager.showLocalidadResult(localidadResp);

    let nAfectacion = 0;

    afectacionResp.features.forEach((f) => {
      const ln = getLN(f.properties);
      const pct =
        (f.properties.porcentaje_afectado ?? 100) / 100;
      nAfectacion += ln * pct;
    });

    let nLocalidades = 0;

    localidadResp.features.forEach((f) => {
      nLocalidades += getLN(f.properties);
    });

    const N = nAfectacion + nLocalidades;

    const params = readParamsFromUI();
    const sample = Sampling.computeSampleSize(N, params);

    const tipoCaso =
      document.getElementById('sel-tipo-caso').value;

    // Los checkboxes de contexto (COPACO, identidad cultural, desempate,
    // solicitud ciudadana, actualización cartográfica) se quitaron de
    // la interfaz; determinarModelo() usa sus defaults (todo false) y
    // sugiere el modelo base según el tipo de caso.
    const modelo = ModeloEncuesta.determinarModelo(tipoCaso);

    // El modelo sugerido ya no se muestra por separado antes del
    // análisis (duplicaba, de forma prematura, lo que renderResultados()
    // muestra abajo como "Modelo de encuesta"). La nota de COPACO
    // también se quitó de aquí: se maneja en otro apartado del sistema
    // que embebe esta página (SAM), no en este microservicio.
    renderResultados({
      N,
      nAfectacion,
      nLocalidades,
      usaSecciones,
      sample,
      modelo,
      params
    });

    // Snapshot del análisis completo: lo usan tanto la exportación a
    // Excel (botón "Exportar resultados") como el postMessage que se
    // manda al sistema padre al terminar el análisis.
    state.ultimoResultado = {
      N,
      nAfectacion,
      nLocalidades,
      usaSecciones,
      sample,
      modelo,
      params
    };

    setStatus(
      huboRecalculo
        ? `Análisis completado. (% de afectación por ${usaSecciones ? 'sección' : 'manzana'} recalculado localmente con Turf.js — ver nota en Resultados.)`
        : 'Análisis completado.',
      'ok'
    );

    // Le avisa al sistema que embebe esta página (SAM) que el análisis
    // de la Fase 2 ya terminó, adjuntando el mismo Excel que se le
    // ofrece descargar a la persona usuaria. Ver enviarResultadoAlPadre().
    await enviarResultadoAlPadre();

  } catch (e) {
    setStatus(
      'Error durante el análisis: ' + e.message,
      'error'
    );
  } finally {
    btnAnalizar.disabled = false;
  }
}

function renderResultados({
  N,
  nAfectacion,
  nLocalidades,
  usaSecciones,
  sample,
  modelo,
  params
}) {
  document.getElementById('panel-resultados').hidden = false;

  const badgeClass =
    sample.method === 'censo'
      ? 'badge-censo'
      : 'badge-muestreo';

  const metodoLabel =
    sample.method === 'censo'
      ? 'CENSO (100%)'
      : 'MUESTREO';

  document.getElementById('result-summary').innerHTML = `
    Población afectada total (N): <b>${N.toLocaleString('es-MX', {
      maximumFractionDigits: 1
    })}</b><br>
    &nbsp;&nbsp;· ${usaSecciones ? 'Secciones' : 'Manzanas'} (ponderada por % de área): ${nAfectacion.toLocaleString('es-MX', {
      maximumFractionDigits: 1
    })}<br>
    &nbsp;&nbsp;· Localidades: ${nLocalidades.toLocaleString('es-MX', {
      maximumFractionDigits: 1
    })}<br>
    Método aplicado: <span class="${badgeClass}">${metodoLabel}</span><br>
    <b>Encuestas requeridas: ${sample.n.toLocaleString('es-MX')}</b><br>
    Modelo de encuesta: ${modelo.label} — ${modelo.nota}<br>
    <span style="font-size:11px;color:var(--text-muted);">Fórmula de Cochran (Z=${params.Z}, p=q=${params.p}, d=${params.d}) aplicada directamente sobre la población afectada real, con censo si N≤${params.censusThreshold} — corrección propuesta al reparto proporcional en cascada del Documento Rector.</span>
  `;

  document.getElementById('wrap-tabla-manzanas').classList.toggle('hidden', usaSecciones);
  document.getElementById('wrap-tabla-secciones').classList.toggle('hidden', !usaSecciones);

  if (!usaSecciones) {
    const tbodyManzanas =
      document.querySelector('#tabla-manzanas tbody');
    tbodyManzanas.innerHTML = '';

    state.manzanasResult.features.forEach((f) => {
      const p = f.properties;
      const ln = getLN(p);
      const pct = p.porcentaje_afectado ?? 100;
      const ponderada = ln * (pct / 100);

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${p.manzana ?? '-'}</td>` +
        `<td>${p.seccion ?? '-'}</td>` +
        `<td>${ln}</td>` +
        `<td>${pct}%</td>` +
        `<td>${ponderada.toFixed(1)}</td>`;

      tbodyManzanas.appendChild(tr);
    });
  } else {
    const tbodySecciones =
      document.querySelector('#tabla-secciones tbody');
    tbodySecciones.innerHTML = '';

    state.seccionesResult.features.forEach((f) => {
      const p = f.properties;
      const ln = getLN(p);
      const pct = p.porcentaje_afectado ?? 100;
      const ponderada = ln * (pct / 100);

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${p.seccion ?? '-'}</td>` +
        `<td>${ln}</td>` +
        `<td>${pct}%</td>` +
        `<td>${ponderada.toFixed(1)}</td>`;

      tbodySecciones.appendChild(tr);
    });
  }

  const tbodyLocalidades =
    document.querySelector('#tabla-localidades tbody');
  tbodyLocalidades.innerHTML = '';

  state.localidadResult.features.forEach((f) => {
    const p = f.properties;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${p.localidad ?? '-'}</td>` +
      `<td>${p.seccion ?? '-'}</td>` +
      `<td>${getLN(p)}</td>`;

    tbodyLocalidades.appendChild(tr);
  });
}

// ---------------- Exportación a Excel ----------------

const COLOR_MORADO = 'FF4B2E83';
const COLOR_MORADO_CLARO = 'FFEFEAF7';
const COLOR_BLANCO = 'FFFFFFFF';
const BORDE_GRIS = { style: 'thin', color: { argb: 'FFDDD6EA' } };

// Le pone estilo de "encabezado" (fondo morado, texto blanco y negrita,
// centrado, con borde) a una fila completa. Se usa en los encabezados
// de columnas de las hojas de detalle y en los títulos de sección de
// la hoja Resumen.
function estilizarEncabezado(row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, color: { argb: COLOR_BLANCO } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_MORADO } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { top: BORDE_GRIS, bottom: BORDE_GRIS, left: BORDE_GRIS, right: BORDE_GRIS };
  });
  row.height = 20;
}

// Le pone borde gris claro a todas las celdas de una fila (para las
// filas de datos, sin el fondo morado del encabezado).
function bordearFila(row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: BORDE_GRIS, bottom: BORDE_GRIS, left: BORDE_GRIS, right: BORDE_GRIS };
  });
}

// Arma el libro de Excel (ExcelJS, con estilos reales: colores,
// negritas, bordes) con todo lo obtenido y calculado: una hoja
// "Resumen" con los datos generales del caso y del cálculo, y una hoja
// por cada tabla de detalle que ya se muestra en pantalla (Manzanas o
// Secciones, según el tipo de caso, y Localidades).
// Se usa tanto para el botón "Exportar resultados (Excel)" como para
// el postMessage que se le manda al sistema padre (enviarResultadoAlPadre).
// Devuelve una Promise<ExcelJS.Workbook> (o Promise<null> si no hay
// resultado calculado todavía).
async function construirLibroExcel() {
  const r = state.ultimoResultado;
  if (!r) return null;

  const cve = state.selectedUT?.properties?.cve_ut || '';
  const nombreUT = state.selectedUT?.properties?.nombre || '';
  const tipoCasoId = document.getElementById('sel-tipo-caso').value;
  const tipoCasoLabel =
    ModeloEncuesta.TIPOS_CASO.find((t) => t.id === tipoCasoId)?.label || tipoCasoId;
  const folio = PostMessageBridge.getLastReceived()?.caseId ?? '';
  const metodoLabel = r.sample.method === 'censo' ? 'CENSO (100%)' : 'MUESTREO';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema de Cálculo de Encuestas — MGPC';
  wb.created = new Date();

  // --- Hoja: Resumen ---
  const hojaResumen = wb.addWorksheet('Resumen');
  hojaResumen.columns = [{ width: 32 }, { width: 46 }];

  const filaTitulo = hojaResumen.addRow(['Cálculo de Encuestas — Modificación de Límites Territoriales (MGPC)']);
  hojaResumen.mergeCells('A1:B1');
  filaTitulo.font = { bold: true, size: 13, color: { argb: COLOR_BLANCO } };
  filaTitulo.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_MORADO } };
  filaTitulo.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
  filaTitulo.height = 26;

  const filasDatosGenerales = [
    ['Fecha de análisis', new Date().toLocaleString('es-MX')],
    ['Folio/Caso', folio],
    ['Unidad Territorial (UT)', cve],
    ['Nombre de la UT', nombreUT],
    ['Tipo de caso', tipoCasoLabel]
  ];
  filasDatosGenerales.forEach(([k, v]) => {
    const row = hojaResumen.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    bordearFila(row);
  });

  hojaResumen.addRow([]);
  estilizarEncabezado(hojaResumen.addRow(['Resultado del cálculo', '']));

  const filasResultado = [
    [(r.usaSecciones ? 'Secciones' : 'Manzanas') + ' (ponderada por % de área)', Number(r.nAfectacion.toFixed(1))],
    ['Localidades', Number(r.nLocalidades.toFixed(1))],
    ['Población afectada total (N)', Number(r.N.toFixed(1))],
    ['Método aplicado', metodoLabel],
    ['Encuestas requeridas', r.sample.n]
  ];
  filasResultado.forEach(([k, v]) => {
    const row = hojaResumen.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_MORADO_CLARO } };
    row.getCell(2).font = { bold: true };
    bordearFila(row);
  });

  hojaResumen.addRow([]);
  estilizarEncabezado(hojaResumen.addRow(['Parámetros de muestreo', '']));

  const filasParametros = [
    ['Z', r.params.Z],
    ['p', r.params.p],
    ['q', r.params.q],
    ['d', r.params.d],
    ['Umbral de censo (N)', r.params.censusThreshold]
  ];
  filasParametros.forEach(([k, v]) => {
    const row = hojaResumen.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    bordearFila(row);
  });

  hojaResumen.views = [{ state: 'frozen', ySplit: 1 }];

  // --- Hoja: Manzanas o Secciones (según el tipo de caso) ---
  if (!r.usaSecciones && state.manzanasResult?.features?.length) {
    const hoja = wb.addWorksheet('Manzanas afectadas');
    hoja.columns = [{ width: 12 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 14 }];
    estilizarEncabezado(hoja.addRow(['Manzana', 'Sección', 'LN', '% afectado', 'LN ponderada']));
    state.manzanasResult.features.forEach((f) => {
      const p = f.properties;
      const ln = getLN(p);
      const pct = p.porcentaje_afectado ?? 100;
      bordearFila(hoja.addRow([p.manzana ?? '', p.seccion ?? '', ln, pct, Number((ln * pct / 100).toFixed(2))]));
    });
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
  }

  if (r.usaSecciones && state.seccionesResult?.features?.length) {
    const hoja = wb.addWorksheet('Secciones afectadas');
    hoja.columns = [{ width: 10 }, { width: 10 }, { width: 12 }, { width: 14 }];
    estilizarEncabezado(hoja.addRow(['Sección', 'LN', '% afectado', 'LN ponderada']));
    state.seccionesResult.features.forEach((f) => {
      const p = f.properties;
      const ln = getLN(p);
      const pct = p.porcentaje_afectado ?? 100;
      bordearFila(hoja.addRow([p.seccion ?? '', ln, pct, Number((ln * pct / 100).toFixed(2))]));
    });
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // --- Hoja: Localidades ---
  if (state.localidadResult?.features?.length) {
    const hoja = wb.addWorksheet('Localidades afectadas');
    hoja.columns = [{ width: 24 }, { width: 10 }, { width: 10 }];
    estilizarEncabezado(hoja.addRow(['Localidad', 'Sección', 'LN']));
    state.localidadResult.features.forEach((f) => {
      const p = f.properties;
      bordearFila(hoja.addRow([p.localidad ?? '', p.seccion ?? '', getLN(p)]));
    });
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
  }

  return wb;
}

function nombreArchivoExcel() {
  const cve = state.selectedUT?.properties?.cve_ut || 'ut';
  return `desglose_afectacion_${cve}.xlsx`;
}

async function exportarExcel() {
  const wb = await construirLibroExcel();
  if (!wb) return;
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivoExcel();
  a.click();
  URL.revokeObjectURL(url);
}

// Convierte un ArrayBuffer a base64 sin depender de Buffer (no existe
// en el navegador) ni de FileReader (evita la vuelta async extra).
function arrayBufferABase64(buffer) {
  let binario = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binario += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binario);
}

// ---------------- Integración vía postMessage ----------------

// Al terminar el análisis, le avisa al sistema que embebe esta página
// (SAM) que la Fase 2 concluyó, y le adjunta —en base64, dentro del
// mismo JSON— el Excel que se le ofrece descargar a la persona usuaria
// desde el botón "Exportar resultados (Excel)", para que el sistema
// padre pueda guardarlo/adjuntarlo al expediente sin que la persona
// tenga que descargarlo y volver a subirlo a mano.
//
// NOTA para el equipo del sistema que embebe esta página: falta que
// ESE sistema implemente el manejador que reciba este postMessage
// (window.addEventListener('message', ...)), valide el origen, y
// decodifique/guarde el Excel adjunto. Aquí solo se envía.
async function enviarResultadoAlPadre() {
  const wb = await construirLibroExcel();
  if (!wb) return;

  let excelBase64;
  try {
    const buffer = await wb.xlsx.writeBuffer();
    excelBase64 = arrayBufferABase64(buffer);
  } catch (e) {
    console.error('No se pudo generar el Excel para el postMessage al padre:', e);
    return;
  }

  const r = state.ultimoResultado;
  const cve = state.selectedUT?.properties?.cve_ut || '';
  const tipoCasoId = document.getElementById('sel-tipo-caso').value;
  const folio = PostMessageBridge.getLastReceived()?.caseId ?? null;

  const payload = {
    fase: 2,
    tipo: 'MGPC_FASE_2_COMPLETADA',
    folio,
    claveUT: cve,
    tipoCaso: tipoCasoId,
    resultado: {
      N: r.N,
      nAfectacion: r.nAfectacion,
      nLocalidades: r.nLocalidades,
      usaSecciones: r.usaSecciones,
      metodo: r.sample.method,
      encuestasRequeridas: r.sample.n,
      modelo: r.modelo.label
    },
    excel: {
      filename: nombreArchivoExcel(),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: excelBase64
    }
  };

  const enviado = PostMessageBridge.enviarASistemaPadre(payload);

  // Se guarda también localmente (aparte del panel de diagnóstico de
  // postmessage.js) para poder mostrarlo en el apartado temporal de
  // verificación de envío (ver renderEnvioDebug en index.html/app.js).
  registrarEnvioDebug(payload, enviado);
}

// APARTADO TEMPORAL de verificación — pinta en el panel
// #postmessage-envio-debug si el postMessage de Fase 2 (con el Excel
// adjunto) se logró enviar o no, y con qué datos, para comprobar la
// integración mientras el sistema padre no tenga todavía su propio
// listener. Se puede quitar junto con el panel HTML cuando ya no haga
// falta.
function registrarEnvioDebug(payload, enviado) {
  const el = document.getElementById('postmessage-envio-debug');
  if (!el) return;

  const resumenPayload = {
    fase: payload.fase,
    tipo: payload.tipo,
    folio: payload.folio,
    claveUT: payload.claveUT,
    tipoCaso: payload.tipoCaso,
    resultado: payload.resultado,
    excel: {
      filename: payload.excel.filename,
      mimeType: payload.excel.mimeType,
      base64: `(${payload.excel.base64.length} caracteres — omitido aquí por espacio)`
    }
  };

  const linea = document.createElement('div');
  linea.style.borderBottom = '1px solid #eee';
  linea.style.padding = '4px 0';
  linea.style.color = enviado ? 'var(--green)' : 'var(--red)';

  const encabezado = document.createElement('div');
  encabezado.style.fontWeight = '700';
  encabezado.textContent = enviado
    ? `[${new Date().toLocaleTimeString('es-MX')}] Enviado correctamente al sistema padre.`
    : `[${new Date().toLocaleTimeString('es-MX')}] NO se pudo enviar (¿modo standalone, sin iframe padre?).`;
  linea.appendChild(encabezado);

  const cuerpo = document.createElement('pre');
  cuerpo.style.whiteSpace = 'pre-wrap';
  cuerpo.style.margin = '4px 0 0';
  cuerpo.style.color = 'var(--text)';
  cuerpo.textContent = JSON.stringify(resumenPayload, null, 2);
  linea.appendChild(cuerpo);

  if (el.textContent.trim() === 'Todavía no se ha enviado ningún resultado.') {
    el.textContent = '';
  }
  el.prepend(linea);
}


// Se llama cuando PostMessageBridge recibe datos válidos del sistema
// externo (ver js/postmessage.js). Simula lo que haría la persona a
// mano: selecciona el tipo de caso, escribe la clave de UT y da clic
// en "Cargar UT" (lo que a su vez dispara aplicarPerfilYCalcular() al
// terminar), y guarda utInvolucradas para el caso Fusión. Al final
// bloquea ambos campos para que no se puedan modificar a mano.
function aplicarDatosExternos({ cveUt, tipoCasoId, utInvolucradas }) {
  state.utInvolucradas = Array.isArray(utInvolucradas) ? utInvolucradas : [];

  if (tipoCasoId) {
    const sel = document.getElementById('sel-tipo-caso');
    const opcionExiste = Array.from(sel.options).some(
      (o) => o.value === tipoCasoId
    );
    if (opcionExiste) {
      sel.value = tipoCasoId;
    }
  }

  if (cveUt) {
    const utSearch = document.getElementById('ut-search');
    utSearch.value = cveUt;
    utSearch.dispatchEvent(new Event('input'));
    document.getElementById('btn-cargar-ut').click();
  }

  // Se bloquea DESPUÉS de disparar el clic: un <button disabled> no
  // dispara 'click', pero deshabilitarlo después de ya haberlo
  // disparado no cancela la carga en curso.
  bloquearCamposExternos();
}

// ---------------- Init ----------------

async function initAppMap() {
  // Si nos están cargando dentro de un <iframe> (modo microservicio
  // embebido, ej. dentro de SCCMGPC/SAM), se oculta el encabezado
  // propio y se ajustan los márgenes: el sistema que nos embebe ya
  // muestra su propio título de fase, y el espacio dentro del iframe
  // suele ser más reducido.
  try {
    if (window.self !== window.top) {
      document.body.classList.add('is-embedded');
    }
  } catch (e) {
    // Acceso a window.top bloqueado por política de origen cruzado:
    // asumimos que si eso pasa, sí estamos embebidos.
    document.body.classList.add('is-embedded');
  }

  mapManager = new MapManager('map');
  populateTipoCasoSelect();
  populateParamInputs();
  wireEvents();
  PostMessageBridge.init(aplicarDatosExternos);
}

function initMap() {
  initAppMap();
}

window.initMap = initMap;
window.initAppMap = initAppMap;
