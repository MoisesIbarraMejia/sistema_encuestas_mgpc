// ============================================================
// app.js — orquesta la interfaz: selección directa de UT,
// edición del polígono, cálculo de zona afectada, consultas API
// y cálculo final de la muestra.
// ============================================================

const state = {
  selectedUT: null,
  affectedFeature: null,
  referenceLoaded: false,
  manzanasResult: null,
  localidadResult: null
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
  state.referenceLoaded = false;

  document.getElementById('zona-afectada-info').classList.add('hidden');
  document.getElementById('modelo-sugerido').classList.add('hidden');
  document.getElementById('panel-resultados').hidden = true;
  document.getElementById('btn-analizar').disabled = true;

  mapManager.clearDownstream();
}

function wireEvents() {
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

      resetDownstreamState();
      state.selectedUT = feature;

      mapManager.loadOriginalUT(feature);

      btnEditar.disabled = false;
      btnCalcularZona.disabled = false;

      const nombre = feature.properties?.nombre || '';

      setStatus(
        `UT cargada: ${responseCve || cve}${nombre ? ` — ${nombre}` : ''}`,
        'ok'
      );

      if (chkReferencia.checked) {
        await loadReferenceManzanas();
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
      btnCargarUT.disabled = false;
    }
  });

  chkReferencia.addEventListener('change', async () => {
    if (!state.selectedUT) return;

    if (chkReferencia.checked) {
      if (!state.referenceLoaded) {
        await loadReferenceManzanas();
      } else {
        mapManager.toggleReferenceVisible(true);
      }
    } else {
      mapManager.toggleReferenceVisible(false);
    }
  });

  btnEditar.addEventListener('click', () => {
    mapManager.enableEditing();
    setStatus(
      'Edición habilitada: arrastra los vértices del polígono azul para proponer el nuevo límite.'
    );
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
      const info = document.getElementById('zona-afectada-info');
      info.classList.remove('hidden');
      info.innerHTML =
        `Zona afectada calculada: <b>${areaM2.toLocaleString('es-MX', {
          maximumFractionDigits: 0
        })} m²</b>. Lista para analizar.`;

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
  btnExportar.addEventListener('click', exportarCSV);
}

async function loadReferenceManzanas() {
  try {
    setStatus('Cargando manzanas de referencia…');

    const original = mapManager.getOriginalGeoJSON();
    const fc = await Api.manzanasDeReferencia(original.geometry);

    mapManager.showReferenceManzanas(fc);
    state.referenceLoaded = true;

    setStatus(
      `Manzanas de referencia cargadas: ${fc.count ?? fc.features.length}.`,
      'ok'
    );

  } catch (e) {
    setStatus(
      'Error al cargar manzanas de referencia: ' + e.message,
      'error'
    );
  }
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

    setStatus(
      'Calculando manzanas y localidades afectadas…'
    );

    const [manzanasResp, localidadResp] = await Promise.all([
      Api.manzanasAfectadas({ cacheId }),
      Api.localidadesAfectadas({ cacheId })
    ]);

    state.manzanasResult = manzanasResp;
    state.localidadResult = localidadResp;

    mapManager.showManzanasResult(manzanasResp);
    mapManager.showLocalidadResult(localidadResp);

    let nManzanas = 0;

    manzanasResp.features.forEach((f) => {
      const ln = Number(f.properties.ln) || 0;
      const pct =
        (f.properties.porcentaje_afectado ?? 100) / 100;
      nManzanas += ln * pct;
    });

    let nLocalidades = 0;

    localidadResp.features.forEach((f) => {
      nLocalidades += Number(f.properties.ln) || 0;
    });

    const N = nManzanas + nLocalidades;

    const params = readParamsFromUI();
    const sample = Sampling.computeSampleSize(N, params);

    const tipoCaso =
      document.getElementById('sel-tipo-caso').value;

    const modelo = ModeloEncuesta.determinarModelo(
      tipoCaso,
      {
        existeCopaco:
          document.getElementById('chk-copaco').checked,
        causaIdentidadCultural:
          document.getElementById('chk-identidad').checked,
        esDesempate:
          document.getElementById('chk-desempate').checked,
        esSolicitudCiudadana:
          document.getElementById('chk-solicitud').checked,
        esActualizacionCartografica:
          document.getElementById('chk-actualizacion').checked
      }
    );

    renderModeloSugerido(modelo);

    renderResultados({
      N,
      nManzanas,
      nLocalidades,
      sample,
      modelo
    });

    setStatus('Análisis completado.', 'ok');

  } catch (e) {
    setStatus(
      'Error durante el análisis: ' + e.message,
      'error'
    );
  } finally {
    btnAnalizar.disabled = false;
  }
}

function renderModeloSugerido(modelo) {
  const el = document.getElementById('modelo-sugerido');
  el.classList.remove('hidden');

  el.innerHTML =
    `<b>Modelo sugerido:</b> ${modelo.label}<br>${modelo.nota}` +
    (
      modelo.usaPoblacionAfectada
        ? ''
        : '<br><em>Nota: en este caso la encuesta es a integrantes del COPACO, no a la población general — la N calculada abajo es informativa/para desempate, no la cifra directa a encuestar.</em>'
    );
}

function renderResultados({
  N,
  nManzanas,
  nLocalidades,
  sample,
  modelo
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
    &nbsp;&nbsp;· Manzanas (ponderada por % de área): ${nManzanas.toLocaleString('es-MX', {
      maximumFractionDigits: 1
    })}<br>
    &nbsp;&nbsp;· Localidades: ${nLocalidades.toLocaleString('es-MX', {
      maximumFractionDigits: 1
    })}<br>
    Método aplicado: <span class="${badgeClass}">${metodoLabel}</span><br>
    <b>Encuestas requeridas: ${sample.n.toLocaleString('es-MX')}</b><br>
    Modelo de encuesta: ${modelo.label}
  `;

  const tbodyManzanas =
    document.querySelector('#tabla-manzanas tbody');
  tbodyManzanas.innerHTML = '';

  state.manzanasResult.features.forEach((f) => {
    const p = f.properties;
    const ln = Number(p.ln) || 0;
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

  const tbodyLocalidades =
    document.querySelector('#tabla-localidades tbody');
  tbodyLocalidades.innerHTML = '';

  state.localidadResult.features.forEach((f) => {
    const p = f.properties;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${p.localidad ?? '-'}</td>` +
      `<td>${p.seccion ?? '-'}</td>` +
      `<td>${Number(p.ln) || 0}</td>`;

    tbodyLocalidades.appendChild(tr);
  });
}

function exportarCSV() {
  if (!state.manzanasResult && !state.localidadResult) return;

  const lines = [];
  lines.push(
    'tipo,identificador,seccion,ln,porcentaje_afectado,ln_ponderada'
  );

  (state.manzanasResult?.features || []).forEach((f) => {
    const p = f.properties;
    const ln = Number(p.ln) || 0;
    const pct = p.porcentaje_afectado ?? 100;

    lines.push(
      `manzana,${p.manzana ?? ''},${p.seccion ?? ''},${ln},${pct},${(ln * pct / 100).toFixed(2)}`
    );
  });

  (state.localidadResult?.features || []).forEach((f) => {
    const p = f.properties;
    const ln = Number(p.ln) || 0;

    lines.push(
      `localidad,${p.localidad ?? ''},${p.seccion ?? ''},${ln},100,${ln}`
    );
  });

  const blob = new Blob(
    [lines.join('\n')],
    { type: 'text/csv;charset=utf-8;' }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const cve =
    state.selectedUT?.properties?.cve_ut || 'ut';

  a.href = url;
  a.download = `desglose_afectacion_${cve}.csv`;
  a.click();

  URL.revokeObjectURL(url);
}

// ---------------- Init ----------------

async function initAppMap() {
  mapManager = new MapManager('map');
  populateTipoCasoSelect();
  populateParamInputs();
  wireEvents();
}

function initMap() {
  initAppMap();
}

window.initMap = initMap;
window.initAppMap = initAppMap;
