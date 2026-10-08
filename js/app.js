// Calcula y exporta la muestra de una propuesta preparada en el paso anterior.
const state = {
  context: null, draft: null, selectedUT: null, affectedFeature: null,
  capaAfectacion: 'manzana', revision: 0, referenceRequestId: 0,
  manzanasResult: null, seccionesResult: null, localidadResult: null, ultimoResultado: null
};
let mapManager = null;
let eventsWired = false;

function copyData(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function setStatus(message, type = '') {
  const status = document.getElementById('analizar-status');
  status.textContent = message;
  status.className = 'status-line' + (type ? ' ' + type : '');
  document.getElementById('log-footer').textContent = message;
}

function methodLabel(method) {
  return ({ censo: 'CENSO (100%)', muestreo: 'MUESTREO', sin_poblacion: 'SIN POBLACIÓN' })[method] || method;
}

function getLN(properties) {
  const raw = properties?.LN ?? properties?.ln ?? properties?.Ln ?? properties?.lN;
  if (raw === undefined || raw === null || typeof raw === 'boolean' ||
      !['string', 'number'].includes(typeof raw) || String(raw).trim() === '') {
    throw new Error('Falta la lista nominal de una zona. No se puede estimar su población.');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error('La lista nominal de una zona no es válida.');
  return value;
}

function populateParamInputs(params = CONFIG.SAMPLING) {
  for (const [id, key] of [['param-z', 'Z'], ['param-p', 'p'], ['param-q', 'q'], ['param-d', 'd'], ['param-umbral', 'censusThreshold']]) {
    document.getElementById(id).value = params[key];
  }
}

function readParamsFromUI() {
  const number = (id) => {
    const value = String(document.getElementById(id).value).trim();
    return value === '' ? NaN : Number(value);
  };
  return Sampling.validateParams({
    Z: number('param-z'), p: number('param-p'), q: number('param-q'),
    d: number('param-d'), censusThreshold: number('param-umbral')
  });
}

function clearResults(persist = true) {
  window.MGPCSurveyDistribution?.clear();
  state.revision += 1;
  state.ultimoResultado = null;
  state.manzanasResult = null;
  state.seccionesResult = null;
  state.localidadResult = null;
  document.getElementById('panel-resultados').hidden = true;
  document.getElementById('btn-analizar').disabled = !state.affectedFeature;
  mapManager?.clearDownstream();
  if (state.affectedFeature) mapManager?.showAffected(state.affectedFeature);
  if (persist) window.MGPCWorkflow.invalidateSurvey();
}

function getTargetGeometry(context, draft, original) {
  if (!draft || draft.ut?.key !== context.ut.key || String(draft.district) !== String(context.district) ||
      draft.caseType !== context.caseType || !draft.preparedAt) {
    throw new Error('Primero prepara los límites de este caso.');
  }
  if (JSON.stringify(draft.geometries?.original) !== JSON.stringify(original)) {
    throw new Error('Los límites originales cambiaron. Regresa a preparar la propuesta antes de calcular.');
  }
  const proposed = draft.geometries?.proposed;
  if (!['Polygon', 'MultiPolygon'].includes(proposed?.type)) throw new Error('La propuesta no tiene límites válidos.');
  switch (context.caseType) {
    case 'nomenclatura': return copyData(original);
    case 'division':
      if (Diff.isUnchanged(original, proposed)) throw new Error('Modifica los límites de la división antes de calcular.');
      return copyData(original);
    case 'fusion':
      if (!(draft.relatedUTs || []).some((ut) => (ut.claveUT || ut.key) !== context.ut.key)) {
        throw new Error('Selecciona otra UT para preparar la fusión.');
      }
      return copyData(proposed);
    case 'inc_exc_secciones':
      if (!(draft.sectionChanges || []).length) throw new Error('Selecciona las secciones que deseas incluir o quitar.');
      // Las secciones y las manzanas usan el territorio que cambia.
    case 'inc_exc_manzanas': {
      if (Diff.isUnchanged(original, proposed)) throw new Error('La propuesta debe contener cambios de límites.');
      const result = Diff.computeAffectedGeometry(original, proposed);
      if (!result.affected?.geometry) throw new Error('No se pudo identificar el territorio que cambia.');
      return copyData(result.affected.geometry);
    }
    default: throw new Error('Este tipo de caso no tiene una metodología de cálculo disponible.');
  }
}

function isCurrent(revision, preparedAt) {
  return revision === state.revision && window.MGPCWorkflow.getDraft()?.preparedAt === preparedAt;
}

async function loadContext(context = window.MGPCWorkflow.getContext()) {
  if (!context?.ut?.key) return;
  document.getElementById('btn-survey-retry').hidden = true;
  state.context = copyData(context);
  state.draft = null;
  state.selectedUT = null;
  state.affectedFeature = null;
  state.referenceRequestId += 1;
  clearResults(false);
  const revision = state.revision;
  mapManager.clearAll();
  setStatus('Preparando el territorio del caso…');
  try {
    const response = await Api.getUTByCve(context.ut.key);
    if (revision !== state.revision) return;
    const feature = response?.type === 'Feature' ? response : response?.features?.[0];
    if (!['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)) throw new Error('No se pudieron cargar los límites de la UT.');
    if (feature.properties?.cve_ut && String(feature.properties.cve_ut).trim() !== context.ut.key) {
      throw new Error('Los límites recibidos corresponden a otra UT.');
    }
    feature.properties = { ...feature.properties, cve_ut: context.ut.key };
    let draft = window.MGPCWorkflow.getDraft();
    if (!draft && context.caseType === 'nomenclatura') {
      draft = window.MGPCWorkflow.saveDraft({
        ...copyData(context), relatedUTs: [], sectionChanges: [],
        geometries: { original: copyData(feature.geometry), proposed: copyData(feature.geometry), affected: null }
      });
    }
    const target = getTargetGeometry(context, draft, feature.geometry);
    state.selectedUT = copyData(feature);
    state.draft = copyData(draft);
    state.affectedFeature = turf.feature(target);
    state.capaAfectacion = context.caseType === 'inc_exc_secciones' ? 'seccion' : 'manzana';
    document.getElementById('lbl-referencia').textContent = state.capaAfectacion === 'seccion' ? 'Ver secciones cercanas' : 'Ver manzanas cercanas';
    mapManager.loadOriginalUT(feature);
    mapManager.restoreEditedGeometry(draft.geometries.proposed);
    mapManager.disableEditing();
    mapManager.showAffected(state.affectedFeature);
    document.getElementById('btn-analizar').disabled = false;
    const saved = window.MGPCWorkflow.getSurvey();
    if (saved && saved.draftPreparedAt === draft.preparedAt && saved.caseType === context.caseType &&
        JSON.stringify(saved.geometries?.original) === JSON.stringify(feature.geometry) &&
        JSON.stringify(saved.geometries?.proposed) === JSON.stringify(draft.geometries.proposed)) {
      restoreSurvey(saved);
    } else {
      setStatus('La propuesta está lista. Calcula la muestra para continuar.', 'ok');
    }
    if (document.getElementById('chk-referencia').checked) await loadReferenceLayer();
  } catch (error) {
    if (revision !== state.revision) return;
    state.affectedFeature = null;
    state.draft = null;
    state.selectedUT = null;
    clearResults();
    mapManager.clearAll();
    setStatus(error.message, 'error');
    document.getElementById('btn-survey-retry').hidden = false;
  }
}

function restoreSurvey(snapshot) {
  Sampling.validateParams(snapshot.params);
  if (!snapshot.modelo || !Array.isArray(snapshot.localidadResult?.features) ||
      !Array.isArray((snapshot.usaSecciones ? snapshot.seccionesResult : snapshot.manzanasResult)?.features)) {
    window.MGPCWorkflow.invalidateSurvey();
    setStatus('Vuelve a calcular la muestra para actualizar el resultado.', 'ok');
    return;
  }
  populateParamInputs(snapshot.params);
  state.ultimoResultado = copyData(snapshot);
  state.manzanasResult = copyData(snapshot.manzanasResult);
  state.seccionesResult = copyData(snapshot.seccionesResult);
  state.localidadResult = copyData(snapshot.localidadResult);
  showResultsOnMap();
  renderResultados(snapshot);
  // Recuperar una vista no escribe ni invalida la propuesta o su revisión.
  setStatus('Muestra guardada recuperada para esta propuesta.', 'ok');
}

async function loadReferenceLayer() {
  if (!state.affectedFeature) return;
  const requestId = ++state.referenceRequestId;
  const revision = state.revision;
  const secciones = state.capaAfectacion === 'seccion';
  try {
    const response = secciones ? await Api.seccionesDeReferencia(state.affectedFeature.geometry)
      : await Api.manzanasDeReferencia(state.affectedFeature.geometry);
    if (requestId !== state.referenceRequestId || revision !== state.revision || !document.getElementById('chk-referencia').checked) return;
    if (secciones) mapManager.showReferenceSecciones(response);
    else mapManager.showReferenceManzanas(response);
  } catch (error) {
    if (requestId === state.referenceRequestId && revision === state.revision) setStatus('No se pudo mostrar la referencia: ' + error.message, 'error');
  }
}

async function analizar() {
  if (!state.selectedUT || !state.affectedFeature || !state.draft) return;
  let params;
  try { params = readParamsFromUI(); }
  catch (error) { setStatus(error.message, 'error'); return; }
  const context = copyData(state.context);
  const draft = copyData(state.draft);
  if (window.MGPCWorkflow.getDraft()?.preparedAt !== draft.preparedAt) {
    clearResults();
    document.getElementById('btn-analizar').disabled = true;
    setStatus('La propuesta cambió. Vuelve a abrir este paso para calcular sus límites actuales.', 'error');
    return;
  }
  const target = copyData(state.affectedFeature);
  const usaSecciones = state.capaAfectacion === 'seccion';
  clearResults();
  const revision = state.revision;
  document.getElementById('btn-analizar').disabled = true;
  try {
    setStatus('Preparando el cálculo de la muestra…');
    const cached = await Api.cacheStore(target.geometry, context.ut.key, { origen: 'calculo_frontend_mgpc', caso: context.caseType });
    if (!isCurrent(revision, draft.preparedAt)) return;
    if (!cached?.cache_id) throw new Error('No se pudo preparar el territorio para el cálculo.');
    setStatus(usaSecciones ? 'Calculando la población de las secciones consideradas…' : 'Calculando la población de las manzanas consideradas…');
    const [afectacion, localidades] = await Promise.all([
      usaSecciones ? Api.seccionesAfectadas({ cacheId: cached.cache_id }) : Api.manzanasAfectadas({ cacheId: cached.cache_id }),
      Api.localidadesAfectadas({ cacheId: cached.cache_id })
    ]);
    if (!isCurrent(revision, draft.preparedAt)) return;
    if (!Array.isArray(afectacion?.features) || !Array.isArray(localidades?.features)) throw new Error('La respuesta de población está incompleta.');
    let nAfectacion = 0;
    for (const feature of afectacion.features) {
      if (!feature?.geometry) throw new Error('Una zona no tiene límites válidos para calcular su afectación.');
      const percentage = Diff.computeOverlapPercentage(feature.geometry, target);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error('No se pudo calcular el porcentaje de afectación de una zona.');
      feature.properties = { ...feature.properties, porcentaje_afectado: percentage };
      nAfectacion += getLN(feature.properties) * percentage / 100;
    }
    const nLocalidades = localidades.features.reduce((total, feature) => total + getLN(feature.properties), 0);
    const N = nAfectacion + nLocalidades;
    const sample = Sampling.computeSampleSize(N, params);
    const result = {
      analysisDate: new Date().toISOString(), draftPreparedAt: draft.preparedAt,
      district: context.district, ut: copyData(context.ut), caseType: context.caseType,
      caseId: context.caseId ?? null, relatedUTs: copyData(draft.relatedUTs || []),
      sectionChanges: copyData(draft.sectionChanges || []), newName: draft.newName || context.newName || '',
      geometries: { original: copyData(draft.geometries.original), proposed: copyData(draft.geometries.proposed), affected: copyData(target.geometry) },
      N, nAfectacion, nLocalidades, usaSecciones, sample, params,
      modelo: ModeloEncuesta.determinarModelo(context.caseType),
      manzanasResult: usaSecciones ? null : afectacion,
      seccionesResult: usaSecciones ? afectacion : null,
      localidadResult: localidades
    };
    window.MGPCWorkflow.saveSurvey(copyData(result));
    state.ultimoResultado = result;
    state.manzanasResult = result.manzanasResult;
    state.seccionesResult = result.seccionesResult;
    state.localidadResult = result.localidadResult;
    showResultsOnMap();
    renderResultados(result);
    setStatus('Análisis completado. La muestra está lista para continuar.', 'ok');
  } catch (error) {
    if (isCurrent(revision, draft.preparedAt)) setStatus('No se pudo calcular la muestra: ' + error.message, 'error');
  } finally {
    if (revision === state.revision) document.getElementById('btn-analizar').disabled = !state.affectedFeature || !isCurrent(revision, draft.preparedAt);
  }
}

function showResultsOnMap() {
  if (state.ultimoResultado.usaSecciones) mapManager.showSeccionesResult(state.seccionesResult);
  else mapManager.showManzanasResult(state.manzanasResult);
  mapManager.showLocalidadResult(state.localidadResult);
}

function appendCells(row, values) {
  values.forEach((value) => {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    row.appendChild(cell);
  });
}

function renderResultados(result) {
  window.MGPCSurveyDistribution?.setResult(result);
  const { N, nAfectacion, nLocalidades, usaSecciones, sample, params } = result;
  // Usar la población entera del cálculo, también al recuperar resultados anteriores.
  const population = Number.isInteger(sample.N) && sample.N >= 0 ? sample.N : Math.round(N);
  const format = (number) => number.toLocaleString('es-MX', { maximumFractionDigits: 1 });
  const summary = document.getElementById('result-summary');
  summary.replaceChildren();
  for (const text of [
    `Población de referencia: ${population.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`,
    `${usaSecciones ? 'Secciones' : 'Manzanas'} ponderadas por porcentaje de área: ${format(nAfectacion)}`,
    `Localidades: ${format(nLocalidades)}`,
    `Método aplicado: ${methodLabel(sample.method)}`,
    `Muestra de población de referencia: ${sample.n.toLocaleString('es-MX')}`,
    'La población estimada se redondea a personas completas para calcular la muestra. Valida el contexto del caso antes de determinar una encuesta ciudadana o a integrantes del COPACO.',
    `Parámetros: Z=${params.Z}, p=${params.p}, q=${params.q}, d=${params.d}; censo si N≤${params.censusThreshold}.`
  ]) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    summary.appendChild(paragraph);
  }
  document.getElementById('panel-resultados').hidden = false;
  document.getElementById('titulo-tabla-manzanas').hidden = usaSecciones;
  document.getElementById('wrap-tabla-manzanas').classList.toggle('hidden', usaSecciones);
  document.getElementById('wrap-tabla-secciones').classList.toggle('hidden', !usaSecciones);
  for (const [selector, features, type] of [
    ['#tabla-manzanas tbody', result.manzanasResult?.features || [], 'manzana'],
    ['#tabla-secciones tbody', result.seccionesResult?.features || [], 'seccion'],
    ['#tabla-localidades tbody', result.localidadResult?.features || [], 'localidad']
  ]) {
    const body = document.querySelector(selector);
    body.replaceChildren();
    features.forEach((feature) => {
      const properties = feature.properties || {};
      const ln = getLN(properties);
      const percentage = Number(properties.porcentaje_afectado);
      const values = type === 'localidad' ? [properties.localidad ?? '-', properties.seccion ?? '-', ln]
        : [...(type === 'manzana' ? [properties.manzana ?? '-'] : []), properties.seccion ?? '-', ln, `${format(percentage)}%`, format(ln * percentage / 100)];
      const row = document.createElement('tr');
      appendCells(row, values);
      body.appendChild(row);
    });
  }
}

async function construirLibroExcel(result = state.ultimoResultado) {
  if (!result) return null;
  if (typeof ExcelJS === 'undefined') throw new Error('No se pudo cargar la herramienta de Excel. Recarga la página para descargar el archivo.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sistema MGPC';
  workbook.created = new Date(result.analysisDate);
  const summary = workbook.addWorksheet('Resumen');
  summary.columns = [{ width: 42 }, { width: 76 }];
  const title = ModeloEncuesta.TIPOS_CASO.find((type) => type.id === result.caseType)?.label || result.caseType;
  const rows = [
    ['Cálculo de la muestra', 'Propuesta MGPC'],
    ['Fecha de análisis', new Date(result.analysisDate).toLocaleString('es-MX')],
    ['Fecha de preparación', result.draftPreparedAt],
    ['Distrito', result.district], ['Unidad Territorial', result.ut.key], ['Nombre', result.ut.name],
    ['Tipo de caso', title], ['Folio', result.caseId ?? ''],
    ['Población de referencia', result.N],
    [result.usaSecciones ? 'Secciones ponderadas' : 'Manzanas ponderadas', result.nAfectacion],
    ['Localidades', result.nLocalidades], ['Método', methodLabel(result.sample.method)],
    ['Muestra de población de referencia', result.sample.n],
    ['Alcance', 'Estimación poblacional. Validar el contexto antes de determinar una encuesta ciudadana o COPACO.'],
    ['Z', result.params.Z], ['p', result.params.p], ['q', result.params.q], ['d', result.params.d],
    ['Umbral de censo', result.params.censusThreshold]
  ];
  rows.forEach((values) => summary.addRow(values));
  for (const [name, features, type] of [
    ['Manzanas', result.manzanasResult?.features || [], 'manzana'],
    ['Secciones', result.seccionesResult?.features || [], 'seccion'],
    ['Localidades', result.localidadResult?.features || [], 'localidad']
  ]) {
    if (!features.length) continue;
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(type === 'localidad' ? ['Localidad', 'Sección', 'LN']
      : [...(type === 'manzana' ? ['Manzana'] : []), 'Sección', 'LN', '% afectado', 'LN ponderada']);
    features.forEach(({ properties }) => {
      const ln = getLN(properties);
      const percentage = Number(properties.porcentaje_afectado);
      sheet.addRow(type === 'localidad' ? [properties.localidad ?? '', properties.seccion ?? '', ln]
        : [...(type === 'manzana' ? [properties.manzana ?? ''] : []), properties.seccion ?? '', ln, percentage, ln * percentage / 100]);
    });
    sheet.columns.forEach((column) => { column.width = 20; });
  }
  workbook.eachSheet((sheet) => {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4B2E83' } }; });
  });
  return workbook;
}

async function exportarExcel() {
  const snapshot = copyData(state.ultimoResultado);
  if (!snapshot) return;
  const button = document.getElementById('btn-exportar');
  button.disabled = true;
  try {
    const workbook = await construirLibroExcel(snapshot);
    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `muestra_${snapshot.ut.key}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setStatus('No se pudo descargar el Excel: ' + error.message, 'error');
  } finally { button.disabled = false; }
}

function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  document.getElementById('btn-analizar').addEventListener('click', analizar);
  document.getElementById('btn-exportar').addEventListener('click', exportarExcel);
  document.getElementById('btn-survey-retry').addEventListener('click', initAppMap);
  document.getElementById('chk-referencia').addEventListener('change', (event) => {
    if (event.target.checked) loadReferenceLayer();
    else { state.referenceRequestId += 1; mapManager.toggleReferenceVisible(false); }
  });
  for (const id of ['param-z', 'param-p', 'param-q', 'param-d', 'param-umbral']) {
    document.getElementById(id).addEventListener('input', () => {
      clearResults();
      setStatus('Los parámetros cambiaron. Vuelve a calcular la muestra.');
    });
  }
}

async function initAppMap() {
  const workflow = window.MGPCWorkflow;
  if (!workflow) { setStatus('No se pudo recuperar la propuesta. Vuelve al inicio.', 'error'); return; }
  const context = workflow.getContext();
  // survey-page.js ya aplica la guarda de navegación; no emitir otra redirección.
  if (!context || (!workflow.getDraft() && context.caseType !== 'nomenclatura')) return;
  wireEvents();
  try {
    if (typeof Sampling === 'undefined' || typeof Sampling.validateParams !== 'function') {
      throw new Error('No se cargó la versión actual del cálculo. Vuelve al inicio y recarga los archivos de la aplicación.');
    }
    if (typeof turf === 'undefined' || typeof turf.feature !== 'function') {
      throw new Error('No se pudieron cargar las herramientas del mapa. Revisa tu conexión y vuelve a abrir la página.');
    }
    if (!mapManager) mapManager = new MapManager('map');
    populateParamInputs();
    await loadContext(context);
  } catch (error) {
    document.getElementById('btn-analizar').disabled = true;
    document.getElementById('btn-survey-retry').hidden = false;
    setStatus(error.message, 'error');
  }
}

function initMap() { return initAppMap(); }
window.initMap = initMap;
window.initAppMap = initAppMap;
window.MGPCSurvey = { loadContext };
