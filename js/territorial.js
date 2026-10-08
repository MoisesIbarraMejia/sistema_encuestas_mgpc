/* Revisión final de límites y encuestas de la propuesta. */
const API_PROXY = CONFIG.API_BASE;
const ENDPOINT_HISTORIAL_AJUSTES_WRITE = 'create/historial_ajustes_ut';

function proxyUrl(endpoint, params, mode) {
  let url = API_PROXY + '?endpoint=' + encodeURIComponent(endpoint);
  if (mode === 'escritura') url += '&modo=escritura';
  if (params) Object.keys(params).forEach(k => url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  return url;
}

async function readApiResponse(response) {
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch (_) { throw new Error('La API devolvió una respuesta no válida (HTTP ' + response.status + ').'); }
  if (!response.ok || data?.success === false || data?.status === 'error' || data?.error) {
    const error = new Error(data?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || 'La solicitud falló (HTTP ' + response.status + ').');
    error.httpStatus = response.status;
    throw error;
  }
  if (data === null) throw new Error('La API devolvió una respuesta vacía.');
  return data;
}

const CASE_LABELS = {
  division:'División de UT', fusion:'Fusión de UTs', nomenclatura:'Cambio de nomenclatura',
  inc_exc_secciones:'Inclusión o exclusión de secciones',
  inc_exc_manzanas:'Inclusión o exclusión de manzanas'
};
const CASE_CLASSIFICATIONS = {
  division:'División',fusion:'Fusión',nomenclatura:'Cambio de Nomenclatura',
  inc_exc_secciones:'Inclusión/Exclusión de Secciones electorales',
  inc_exc_manzanas:'Inclusión/Exclusión de Manzanas electorales'
};
const review = { bundle:null, map:null, mapsReady:false, saving:false, completed:false, pendingSave:null };

function reviewBundle() {
  const context = MGPCWorkflow.getContext();
  const draft = MGPCWorkflow.getDraft();
  const survey = MGPCWorkflow.getSurvey();
  const sameCase = item => item && context && String(item.district) === String(context.district) &&
    item.ut?.key === context.ut?.key && item.caseType === context.caseType;
  if (!sameCase(draft) || !sameCase(survey) || !draft.preparedAt || survey.draftPreparedAt !== draft.preparedAt) {
    throw new Error('La propuesta y la muestra no corresponden al mismo caso. Vuelve a calcular la muestra.');
  }
  if (!['Polygon','MultiPolygon'].includes(draft.geometries?.original?.type) ||
      !['Polygon','MultiPolygon'].includes(draft.geometries?.proposed?.type)) {
    throw new Error('Faltan los límites de la propuesta. Regresa al paso de preparación.');
  }
  if (context.caseType === 'nomenclatura' && JSON.stringify(draft.geometries.original) !== JSON.stringify(draft.geometries.proposed)) {
    throw new Error('Un cambio de nomenclatura debe conservar los límites originales. Revisa el caso.');
  }
  if (!Number.isFinite(survey.N) || survey.N < 0 || !Number.isFinite(survey.sample?.n) || survey.sample.n < 0 ||
      !Number.isInteger(survey.sample.n) || survey.sample.n > Math.ceil(survey.N)) {
    throw new Error('El cálculo de encuestas está incompleto. Regresa a la muestra antes de confirmar.');
  }
  if (JSON.stringify(survey.geometries?.proposed) !== JSON.stringify(draft.geometries?.proposed)) {
    throw new Error('Los límites cambiaron después del cálculo. Vuelve a calcular la muestra.');
  }
  return {context,draft,survey};
}
function reviewIdentity(bundle) {
  return JSON.stringify([bundle.context.district,bundle.context.ut.key,bundle.context.caseType,bundle.draft.preparedAt,bundle.survey.analysisDate]);
}
function storedReview(bundle) {
  const saved = MGPCWorkflow.getTerritorial()?.proposal;
  return saved && saved.draftPreparedAt === bundle.draft.preparedAt &&
    saved.surveyAnalysisDate === bundle.survey.analysisDate &&
    ['saved','confirmed-local'].includes(saved.status) ? saved : null;
}
function reviewGeometryInfo(geometry) {
  if (!geometry || !['Polygon','MultiPolygon'].includes(geometry.type)) throw new Error('La propuesta no contiene un polígono válido.');
  const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let vertices = 0;
  if (!Array.isArray(parts) || !parts.length) throw new Error('La propuesta no contiene límites.');
  parts.forEach(rings => {
    if (!Array.isArray(rings) || !rings.length) throw new Error('La propuesta contiene un polígono vacío.');
    rings.forEach(ring => {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error('La propuesta contiene un anillo incompleto.');
      ring.forEach(point => {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
          Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error('La propuesta contiene coordenadas inválidas.');
      });
      const first = ring[0], last = ring[ring.length-1];
      if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('Los límites de la propuesta deben estar cerrados.');
      vertices += ring.length - 1;
    });
  });
  if (typeof turf === 'undefined') throw new Error('No se pudo cargar el cálculo de área. Recarga la página antes de guardar.');
  const areaKm2 = turf.area({type:'Feature',properties:{},geometry}) / 1000000;
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) throw new Error('La propuesta no tiene un área válida.');
  return {vertices,areaKm2};
}
function updateReviewButton() {
  const button = document.getElementById('btn-save-review');
  button.disabled = !review.bundle || !document.getElementById('review-confirm').checked || review.saving || review.completed;
  button.textContent = review.saving ? 'Guardando…' : review.pendingSave ? 'Conservar confirmación en esta pestaña' :
    review.bundle?.context.caseType === 'nomenclatura' ? 'Finalizar revisión' : 'Guardar propuesta revisada';
  document.getElementById('review-confirm').disabled = review.saving || review.completed;
  document.getElementById('btn-correct-review').disabled = review.saving;
  document.getElementById('btn-review-survey').disabled = review.saving;
}
function renderFinalReview() {
  const error = document.getElementById('review-error');
  error.textContent = '';
  try {
    const bundle = reviewBundle();
    review.bundle = bundle;
    const {context,draft,survey} = bundle;
    const nameOnly = context.caseType === 'nomenclatura';
    document.getElementById('action-distrito-label').textContent = context.district;
    document.getElementById('action-ut-label').textContent = context.ut.key;
    document.getElementById('action-ut-name').textContent = context.ut.name || context.ut.key;
    document.getElementById('review-case').textContent = CASE_LABELS[context.caseType] || context.caseType;
    const scope = {
      division:'La muestra corresponde a la población de la UT que se propone dividir.',
      fusion:'La muestra corresponde al conjunto de UTs que integran la fusión propuesta.',
      nomenclatura:'La muestra corresponde a la UT completa. Sus límites permanecen sin cambios.',
      inc_exc_secciones:'La muestra corresponde al territorio de las secciones incluidas o excluidas.',
      inc_exc_manzanas:'La muestra corresponde a la zona modificada entre el límite original y el propuesto.'
    };
    document.getElementById('review-scope').textContent = scope[context.caseType] || '';
    const changes = [];
    if (context.caseType === 'fusion') {
      const labels = [context.ut.key,...(draft.relatedUTs || []).map(ut => ut.key || ut.claveUT || ut.cve_ut || ut.properties?.cve_ut).filter(Boolean)];
      changes.push('UTs de la fusión: ' + [...new Set(labels)].join(', ') + '.');
    }
    if (context.caseType === 'inc_exc_secciones') {
      (draft.sectionChanges || []).forEach(change => {
        const action = change.action || change.operation || change.accion || '';
        const include = ['include','add','incluir','inclusion'].includes(action);
        const exclude = ['exclude','remove','excluir','quitar','exclusion'].includes(action);
        const section = change.seccion ?? change.section ?? change.key ?? change.feature?.properties?.seccion ?? change.id ?? 'sin identificador';
        changes.push((include ? 'Incluir' : exclude ? 'Excluir' : 'Revisar') + ' sección ' + section + '.');
      });
    }
    const newName = draft.newName || context.newName;
    if (nameOnly && newName) changes.push('Nombre propuesto: ' + newName + '.');
    document.getElementById('review-changes').textContent = changes.join(' ');
    const population = Number.isInteger(survey.sample.N) && survey.sample.N >= 0 ? survey.sample.N : Math.round(survey.N);
    document.getElementById('review-population').textContent = population.toLocaleString('es-MX', { maximumFractionDigits: 0 });
    document.getElementById('review-sample').textContent = survey.sample.n.toLocaleString('es-MX');
    const method = {censo:'Censo: consultar a toda la población considerada',muestreo:'Muestreo',sin_poblacion:'Sin población registrada'};
    document.getElementById('review-method').textContent = method[survey.sample.method] || survey.sample.method || 'Sin método';
    const margin = Number(survey.params?.d);
    document.getElementById('review-sample-note').textContent = survey.sample.method === 'censo'
      ? 'Se requieren encuestas a todas las personas consideradas en el cálculo.'
      : survey.sample.method === 'sin_poblacion' ? 'El cálculo no asignó encuestas a esta zona.'
      : Number.isFinite(margin) ? 'Margen de error utilizado: ' + (margin*100).toLocaleString('es-MX',{maximumFractionDigits:2}) + '%.' : '';
    const date = new Date(survey.analysisDate);
    document.getElementById('review-analysis-date').textContent = Number.isFinite(date.getTime()) ? 'Muestra calculada: ' + date.toLocaleString('es-MX') + '.' : '';
    document.getElementById('review-proposed-legend').hidden = nameOnly;
    document.getElementById('review-map-note').textContent = nameOnly
      ? 'Se conserva el límite original. Esta confirmación quedará en la pestaña y en el resumen que exportes.'
      : 'Morado: límite original. Verde: propuesta preparada. El guardado registra un ajuste; no sustituye el límite oficial.';
    const saved = storedReview(bundle);
    review.completed = !!saved;
    if (saved) {
      document.getElementById('review-confirm').checked = true;
      document.getElementById('review-status').textContent = saved.status === 'confirmed-local'
        ? 'Revisión finalizada en esta pestaña. Exporta el resumen para conservarla. No se modificó el nombre oficial en la base de datos.'
        : 'Propuesta revisada y guardada en el historial' + (saved.serverResponse?.id ? ' con folio ' + saved.serverResponse.id : '') + '.';
    }
    updateReviewButton();
    if (review.mapsReady && !review.map) renderReviewMap();
  } catch (failure) {
    review.bundle = null; review.completed = false;
    document.getElementById('review-status').textContent = '';
    error.textContent = failure.message;
    updateReviewButton();
  }
}
function renderReviewMap() {
  if (!review.bundle || !review.mapsReady) return;
  const {context,draft} = review.bundle;
  review.map = new google.maps.Map(document.getElementById('review-map'), {
    center:{lat:19.4326,lng:-99.1332},zoom:12,mapTypeControl:true,streetViewControl:false,fullscreenControl:true
  });
  const geometries = [{role:'original',geometry:draft.geometries.original}];
  if (context.caseType !== 'nomenclatura') geometries.push({role:'proposed',geometry:draft.geometries.proposed});
  review.map.data.addGeoJson({type:'FeatureCollection',features:geometries.map(item => ({
    type:'Feature',properties:{reviewRole:item.role},geometry:item.geometry
  }))});
  const bounds = new google.maps.LatLngBounds();
  review.map.data.forEach(feature => {if (feature.getGeometry()) processGeometry(feature.getGeometry(),bounds);});
  if (!bounds.isEmpty()) review.map.fitBounds(bounds,36);
  review.map.data.setStyle(feature => {
    const proposed = feature.getProperty('reviewRole') === 'proposed';
    return {
      visible:document.getElementById(proposed ? 'review-show-proposed' : 'review-show-original').checked,
      strokeColor:proposed ? '#087d73' : '#573684',fillColor:proposed ? '#16a394' : '#8062a8',
      strokeWeight:proposed ? 3 : 5,fillOpacity:proposed ? 0.2 : 0.04,zIndex:proposed ? 2 : 1,clickable:false
    };
  });
}
async function saveFinalReview() {
  if (review.saving || review.completed) return;
  const error = document.getElementById('review-error');
  const status = document.getElementById('review-status');
  error.textContent = '';
  if (!document.getElementById('review-confirm').checked) {
    error.textContent = 'Confirma que revisaste los límites y la muestra antes de continuar.';
    return;
  }
  review.saving = true; updateReviewButton();
  try {
    const bundle = reviewBundle();
    const identity = reviewIdentity(bundle);
    const {context,draft,survey} = bundle;
    const nameOnly = context.caseType === 'nomenclatura';
    let proposal;
    if (review.pendingSave && review.pendingSave.identity !== identity) {
      throw new Error('La propuesta cambió mientras se guardaba. Revisa el historial antes de volver a confirmar.');
    }
    if (review.pendingSave) proposal = review.pendingSave.proposal;
    else if (nameOnly) {
      proposal = {status:'confirmed-local',kind:'nomenclatura',newName:draft.newName || context.newName || '',geometry:draft.geometries.proposed};
    } else {
      const metrics = reviewGeometryInfo(draft.geometries.proposed);
      const properties = {
        cve_ut:context.ut.key,distrito:String(context.district),clasificacion_caso:CASE_CLASSIFICATIONS[context.caseType] || context.caseType,
        area_km2:metrics.areaKm2,num_vertices:metrics.vertices,usuario:String(context.district),
        origen_propuesta:context.caseId == null ? '' : String(context.caseId)
      };
      const response = await fetch(proxyUrl(ENDPOINT_HISTORIAL_AJUSTES_WRITE,null,'escritura'), {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({geometry:draft.geometries.proposed,properties})
      });
      const serverResponse = await readApiResponse(response);
      if (!Number.isInteger(Number(serverResponse.id)) || Number(serverResponse.id) <= 0) {
        throw new Error('La API no confirmó el folio del ajuste. Verifica el historial antes de intentar otro guardado.');
      }
      proposal = {status:'saved',geometry:draft.geometries.proposed,areaKm2:metrics.areaKm2,registro:properties,serverResponse};
      review.pendingSave = {identity,proposal};
    }
    if (reviewIdentity(reviewBundle()) !== identity) throw new Error('El caso cambió durante el guardado. Revisa la propuesta antes de continuar.');
    proposal = {...proposal,draftPreparedAt:draft.preparedAt,surveyAnalysisDate:survey.analysisDate,confirmedAt:new Date().toISOString(),
      relatedUTs:draft.relatedUTs || [],sectionChanges:draft.sectionChanges || [],N:survey.N,sample:survey.sample};
    MGPCWorkflow.saveTerritorial({proposal});
    review.pendingSave = null;
    renderFinalReview();
  } catch (failure) {
    error.textContent = review.pendingSave
      ? 'El ajuste ya está registrado en la API, pero no se pudo conservar la confirmación en esta pestaña. ' + failure.message
      : 'No se completó la revisión: ' + failure.message;
    status.textContent = '';
  } finally {
    review.saving = false; updateReviewButton();
  }
}
function exportReviewSummary() {
  try {
    const bundle = reviewBundle();
    const summary = {
      district:bundle.context.district,ut:bundle.context.ut,caseType:bundle.context.caseType,
      relatedUTs:bundle.draft.relatedUTs || [],sectionChanges:bundle.draft.sectionChanges || [],newName:bundle.draft.newName || '',
      geometries:bundle.draft.geometries,N:bundle.survey.N,sample:bundle.survey.sample,params:bundle.survey.params,
      preparedAt:bundle.draft.preparedAt,analysisDate:bundle.survey.analysisDate,review:storedReview(bundle),
      exportedAt:new Date().toISOString()
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(summary,null,2)],{type:'application/json;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url; link.download = 'MGPC_revision_' + bundle.context.ut.key + '.json';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  } catch (error) { document.getElementById('review-error').textContent = error.message; }
}
function processGeometry(geom, bounds) {
  const t = geom.getType();
  if (t==='Point') bounds.extend(geom.get());
  else if (t==='LineString'||t==='LinearRing') geom.getArray().forEach(pt=>bounds.extend(pt));
  else if (t==='Polygon') geom.getArray().forEach(r=>r.getArray().forEach(pt=>bounds.extend(pt)));
  else if (t==='MultiPolygon') geom.getArray().forEach(p=>p.getArray().forEach(r=>r.getArray().forEach(pt=>bounds.extend(pt))));
  else if (t==='GeometryCollection') geom.getArray().forEach(g=>processGeometry(g,bounds));
}

document.getElementById('btn-action-back').addEventListener('click',() => {window.location.href = MGPCWorkflow.paths.home;});
document.getElementById('review-confirm').addEventListener('change',updateReviewButton);
document.getElementById('btn-save-review').addEventListener('click',saveFinalReview);
document.getElementById('btn-export-review').addEventListener('click',exportReviewSummary);
document.getElementById('btn-correct-review').addEventListener('click',() => {
  window.location.href = review.bundle?.context.caseType === 'nomenclatura' ? MGPCWorkflow.paths.home : MGPCWorkflow.paths.proposal;
});
document.getElementById('btn-review-survey').addEventListener('click',() => {window.location.href = MGPCWorkflow.paths.survey;});
['review-show-original','review-show-proposed'].forEach(id => document.getElementById(id).addEventListener('change',() => {
  if (review.map) review.map.data.setStyle(review.map.data.getStyle());
}));

function initMap() {
  review.mapsReady = true;
  renderReviewMap();
}

window.addEventListener('beforeunload', event => {
  if (review.saving || review.pendingSave) {event.preventDefault(); event.returnValue = '';}
});
const workflowContext = MGPCWorkflow.requireContext('review');
MGPCWorkflow.renderHeader('review');
if (workflowContext) renderFinalReview();
