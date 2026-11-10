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
  ['review-representante','review-contacto','review-solicitantes'].forEach(id => { document.getElementById(id).disabled = review.saving || review.completed; });
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
      nomenclatura:'Se conserva el límite original. La revisión se registrará en el historial de ajustes con la geometría sin cambios.',
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
const RECEIPT_PURPLE = [75,46,131], RECEIPT_GREEN = [8,125,115], RECEIPT_INK = [34,34,40], RECEIPT_MUTED = [112,110,122], RECEIPT_LINE = [208,203,220];

function receiptRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(receiptRings);
  return [];
}
function receiptMercator(lng, lat, zoom) {
  const scale = 256 * Math.pow(2, zoom), sin = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}
// Zoom más cercano que deja todos los puntos dentro de width×height px (con margen) y el centro del encuadre.
function receiptView(points, width, height, padding) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
  let zoom = 19;
  for (; zoom > 1; zoom--) {
    const a = receiptMercator(west, north, zoom), b = receiptMercator(east, south, zoom);
    if (b[0] - a[0] <= width - 2 * padding && b[1] - a[1] <= height - 2 * padding) break;
  }
  const a = receiptMercator(west, north, zoom), b = receiptMercator(east, south, zoom), scale = 256 * Math.pow(2, zoom);
  const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return {zoom, center, lng:center[0] / scale * 360 - 180, lat:180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * center[1] / scale)))};
}
function receiptImage(url, timeout = 8000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, {signal:controller.signal}).then(response => {
      if (!response.ok) return response.text().then(body => { throw new Error('HTTP ' + response.status + (body ? ' - ' + body.slice(0,200) : '')); });
    return response.blob();
  }).then(blob => {
    if (!/^image\//.test(blob.type)) throw new Error('Respuesta no válida');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
      reader.readAsDataURL(blob);
    });
  }).finally(() => clearTimeout(timer));
}

async function downloadReviewReceipt(bundle, proposal) {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDF) throw new Error('No se pudo cargar el generador de PDF.');
  const {context,draft} = bundle, nameOnly = context.caseType === 'nomenclatura', registro = proposal.registro || {};
  const text = id => document.getElementById(id).textContent.trim();
  const folioId = proposal.serverResponse && proposal.serverResponse.id;
  const when = new Date(proposal.confirmedAt || Date.now()).toLocaleString('es-MX',{dateStyle:'long',timeStyle:'short'});
  const original = receiptRings(draft.geometries.original), proposed = nameOnly ? [] : receiptRings(draft.geometries.proposed);
  const points = original.concat(proposed).flat();

  // Mapa base (Google Static Maps) y logo se piden en paralelo; si alguno falla el acuse se genera igual.
  const MAP = {w:640,h:300};
  const view = points.length ? receiptView(points, MAP.w, MAP.h, 46) : null;
  const mapUrl = view && CONFIG.GOOGLE_MAPS_API_KEY ? 'https://maps.googleapis.com/maps/api/staticmap?center=' + view.lat.toFixed(6) + ',' + view.lng.toFixed(6) +
    '&zoom=' + view.zoom + '&size=' + MAP.w + 'x' + MAP.h + '&scale=2&maptype=roadmap&language=es&region=MX' +
    '&style=' + encodeURIComponent('feature:poi|visibility:off') + '&style=' + encodeURIComponent('feature:transit|visibility:off') +
    '&key=' + encodeURIComponent(CONFIG.GOOGLE_MAPS_API_KEY) : null;
  const [mapResult, logoResult] = await Promise.allSettled([mapUrl ? receiptImage(mapUrl) : Promise.reject(new Error('sin mapa')), receiptImage('img/logo-iecm.png',4000)]);
  const mapImage = mapResult.status === 'fulfilled' ? mapResult.value : null;
  const logoImage = logoResult.status === 'fulfilled' ? logoResult.value : null;

  if (mapResult.status === 'rejected') console.warn('Acuse: no se pudo cargar el mapa base de Google.',mapResult.reason);
  const mapReason = mapResult.status === 'fulfilled' ? '' : ' (' + (/^HTTP \d+/.exec(mapResult.reason.message) || [mapResult.reason.name === 'AbortError' ? 'tiempo agotado' : 'bloqueado o sin red'])[0] + ')';

  const doc = new jsPDF({unit:'mm',format:'a4'}), L = 18, W = 174, R = L + W, BOTTOM = 270;
  doc.setProperties({title:'Acuse de propuesta revisada ' + context.ut.key,subject:'Historial de ajustes de unidades territoriales',author:'MGPC'});
  const ink = () => doc.setTextColor(...RECEIPT_INK), muted = () => doc.setTextColor(...RECEIPT_MUTED);
  let y = 0;
  const ensure = height => { if (y + height > BOTTOM) { doc.addPage(); y = 20; } };
  const section = title => {
    ensure(14); y += 4; doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...RECEIPT_PURPLE);
    doc.text(title.toUpperCase(),L,y,{charSpace:0.4}); y += 1.8; doc.setDrawColor(...RECEIPT_LINE); doc.setLineWidth(0.3); doc.line(L,y,R,y); y += 5;
  };
  // Campos en columnas: etiqueta pequeña arriba, valor abajo.
  const fields = (items, cols = 2) => {
    const step = W / cols;
    for (let i = 0; i < items.length; i += cols) {
      const row = items.slice(i,i + cols).map(([label,value]) => ({label,lines:doc.splitTextToSize(String(value || '-'),step - 6)}));
      const height = 4 + 4.6 * Math.max(...row.map(f => f.lines.length)) + 2.5; ensure(height);
      row.forEach((f,col) => {
        const x = L + col * step; doc.setFont('helvetica','normal'); doc.setFontSize(7); muted(); doc.text(f.label.toUpperCase(),x,y,{charSpace:0.2});
        doc.setFontSize(10); ink(); doc.text(f.lines,x,y + 4.4);
      });
      y += height;
    }
  };

  // Encabezado
  if (logoImage) doc.addImage(logoImage,'PNG',L,12,38,18.2);
  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(...RECEIPT_PURPLE); doc.text('ACUSE DE PROPUESTA REVISADA',R,19,{align:'right'});
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); muted();
  doc.text('Marco Geográfico de Participación Ciudadana',R,24.5,{align:'right'});
  doc.text('Historial de ajustes de unidades territoriales',R,29,{align:'right'});
  doc.setDrawColor(...RECEIPT_PURPLE); doc.setLineWidth(0.9); doc.line(L,34,R,34); doc.setLineWidth(0.25); doc.line(L,35.4,R,35.4);

  // Folio y fecha
  y = 42; doc.setDrawColor(...RECEIPT_LINE); doc.setLineWidth(0.3); doc.rect(L,y - 5,W,15); doc.line(L + 70,y - 5,L + 70,y + 10);
  doc.setFontSize(7); muted(); doc.text('FOLIO DE REGISTRO',L + 4,y,{charSpace:0.2}); doc.text('FECHA Y HORA DE REGISTRO',L + 74,y,{charSpace:0.2});
  doc.setFont('helvetica','bold'); doc.setFontSize(13); ink(); doc.text(folioId ? String(folioId) : 'Sin folio',L + 4,y + 7);
  doc.setFontSize(10.5); doc.text(when,L + 74,y + 7); y += 14;

  section('Datos del caso');
  fields([
    ['Distrito',String(context.district)],['Unidad territorial',context.ut.key + (context.ut.name ? ' - ' + context.ut.name : '')],
    ['Tipo de caso',text('review-case')],['Superficie propuesta (km cuadrados)',proposal.areaKm2 ? proposal.areaKm2.toLocaleString('es-MX',{maximumFractionDigits:4}) : 'No aplica']
  ]);
  ensure(14); doc.setFont('helvetica','normal'); doc.setFontSize(7); muted(); doc.text('CAMBIOS PROPUESTOS',L,y,{charSpace:0.2});
  doc.setFontSize(10); ink(); const changes = doc.splitTextToSize(text('review-changes') || 'Sin detalle adicional.',W); doc.text(changes,L,y + 4.4); y += 4.4 + 4.6 * changes.length + 2;

  if (registro.representante_propuesta || registro.contacto_representante || registro.num_solicitantes != null) {
    section('Quien presenta la propuesta');
    fields([['Representante',registro.representante_propuesta],['Contacto',registro.contacto_representante],
      ['Número de solicitantes',registro.num_solicitantes != null ? String(registro.num_solicitantes) : '']],3);
  }

  section('Alcance de la muestra');
  ensure(22); const cells = [['Personas consideradas (N)',text('review-population')],['Encuestas requeridas (n)',text('review-sample')],['Método',text('review-method')]];
  cells.forEach(([label,value],index) => {
    const x = L + index * 58;
    doc.setDrawColor(...RECEIPT_LINE); doc.setLineWidth(0.3); doc.rect(x,y,56,15);
    doc.setFont('helvetica','normal'); doc.setFontSize(7); muted(); doc.text(label.toUpperCase(),x + 3,y + 4.8,{charSpace:0.2});
    doc.setFont('helvetica','bold'); doc.setFontSize(11); ink(); doc.text(doc.splitTextToSize(value || '-',50)[0],x + 3,y + 11.5);
  });
  y += 18; const note = text('review-sample-note');
  if (note) { doc.setFont('helvetica','normal'); doc.setFontSize(8); muted(); const noteLines = doc.splitTextToSize(note,W); doc.text(noteLines,L,y); y += 4 * noteLines.length; }

  if (view) {
    const height = W * MAP.h / MAP.w; ensure(height + 22); section('Croquis de ubicación');
    const top = y;
    if (mapImage) doc.addImage(mapImage,/^data:image\/jpe?g/.test(mapImage) ? 'JPEG' : 'PNG',L,top,W,height);
    else { doc.setFillColor(244,243,247); doc.rect(L,top,W,height,'F'); }
    const toMm = p => {
      const px = receiptMercator(p[0],p[1],view.zoom);
      return [L + (px[0] - (view.center[0] - MAP.w / 2)) * W / MAP.w, top + (px[1] - (view.center[1] - MAP.h / 2)) * W / MAP.w];
    };
    const draw = (rings,color,width,halo) => rings.forEach(ring => {
      for (const [style,line] of [['halo',halo],['main',width]]) {
        if (style === 'halo') doc.setDrawColor(255,255,255); else doc.setDrawColor(...color);
        doc.setLineWidth(line);
        for (let i = 1; i < ring.length; i++) { const a = toMm(ring[i - 1]), b = toMm(ring[i]); doc.line(a[0],a[1],b[0],b[1]); }
      }
    });
    draw(original,RECEIPT_PURPLE,0.55,1.1); draw(proposed,RECEIPT_GREEN,0.55,1.1);
    doc.setDrawColor(...RECEIPT_LINE); doc.setLineWidth(0.3); doc.rect(L,top,W,height);
    y = top + height + 5; doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.setFillColor(...RECEIPT_PURPLE); doc.rect(L,y - 2.4,6,2.4,'F'); ink(); doc.text('Límite original',L + 8,y);
    if (!nameOnly) { doc.setFillColor(...RECEIPT_GREEN); doc.rect(L + 38,y - 2.4,6,2.4,'F'); doc.text('Propuesta revisada',L + 46,y); }
    muted(); doc.text(mapImage ? 'Mapa base: Google Maps' : 'Mapa base no disponible' + mapReason + '.',R,y,{align:'right'});
  }

  // Pie de página en todas las hojas
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page); doc.setDrawColor(...RECEIPT_LINE); doc.setLineWidth(0.3); doc.line(L,278,R,278);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); muted();
    doc.text(doc.splitTextToSize('Este acuse constata el registro del ajuste en el historial; no sustituye el límite oficial de la unidad territorial. Generado automáticamente por el sistema MGPC.',140),L,282.5);
    doc.text('Página ' + page + ' de ' + pages,R,282.5,{align:'right'});
  }
  doc.save('Acuse_MGPC_' + context.ut.key + '_' + (folioId || 'local') + '.pdf');
}
const REGISTRO_ESTADO = 'revisada';   // valor de historial_ajustes_ut.estado
const SMALLINT_MAX = 32767;            // num_vertices es smallint(6)
function sqlDateTime(date = new Date()) {
  const p = n => String(n).padStart(2,'0');
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) + ' ' + p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds());
}
function reviewRecord(bundle, metrics) {
  const {context,draft,survey} = bundle, nameOnly = context.caseType === 'nomenclatura';
  const clip = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const input = id => document.getElementById(id).value.trim();
  const changes = document.getElementById('review-changes').textContent.trim();
  const population = Number.isInteger(survey.sample.N) && survey.sample.N >= 0 ? survey.sample.N : Math.round(survey.N);
  const record = {
    cve_ut:clip(context.ut.key,50), distrito:clip(context.district,20),
    tipo_modificacion:clip(CASE_LABELS[context.caseType] || context.caseType,100),
    nombre_ut:clip(nameOnly ? (draft.newName || context.newName || context.ut.name || context.ut.key) : (context.ut.name || context.ut.key),150),
    origen_propuesta:clip(context.caseId,150),
    clasificacion_caso:clip(CASE_CLASSIFICATIONS[context.caseType] || context.caseType,100),
    descripcion:(CASE_LABELS[context.caseType] || context.caseType) + (changes ? ': ' + changes : '.') +
      ' Población (N): ' + population + '. Encuestas (n): ' + survey.sample.n + '. Método: ' + survey.sample.method + '.',
    area_km2:Number(metrics.areaKm2.toFixed(4)), num_vertices:Math.min(metrics.vertices,SMALLINT_MAX),
    fecha_registro:sqlDateTime(), usuario:clip(context.district,50), estado:REGISTRO_ESTADO
  };
  const representante = clip(input('review-representante'),150), contacto = clip(input('review-contacto'),150), solicitantes = input('review-solicitantes');
  if (representante) record.representante_propuesta = representante;
  if (contacto) record.contacto_representante = contacto;
  if (solicitantes !== '') {
    const count = Number(solicitantes);
    if (!Number.isInteger(count) || count < 0) throw new Error('El número de solicitantes debe ser un entero mayor o igual a 0.');
    record.num_solicitantes = count;
  }
  return record;
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
      else {
      // Sin cambio de límites (nomenclatura) se envía la geometría original tal cual.
      const geometry = nameOnly ? draft.geometries.original : draft.geometries.proposed;
      const metrics = reviewGeometryInfo(geometry);
      const properties = reviewRecord(bundle, metrics);
      const response = await fetch(proxyUrl(ENDPOINT_HISTORIAL_AJUSTES_WRITE,null,'escritura'), {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({geometry,properties})
      });
      const serverResponse = await readApiResponse(response);
      if (!Number.isInteger(Number(serverResponse.id)) || Number(serverResponse.id) <= 0) {
        throw new Error('La API no confirmó el folio del ajuste. Verifica el historial antes de intentar otro guardado.');
      }
      proposal = {status:'saved',kind:nameOnly ? 'nomenclatura' : undefined,newName:nameOnly ? (draft.newName || context.newName || '') : undefined,geometry,areaKm2:metrics.areaKm2,registro:properties,serverResponse};
      review.pendingSave = {identity,proposal};
    }
    if (reviewIdentity(reviewBundle()) !== identity) throw new Error('El caso cambió durante el guardado. Revisa la propuesta antes de continuar.');
    proposal = {...proposal,draftPreparedAt:draft.preparedAt,surveyAnalysisDate:survey.analysisDate,confirmedAt:new Date().toISOString(),
      relatedUTs:draft.relatedUTs || [],sectionChanges:draft.sectionChanges || [],N:survey.N,sample:survey.sample};
    MGPCWorkflow.saveTerritorial({proposal});
    review.pendingSave = null;
    let receiptNote = '';
    status.textContent = 'Generando acuse PDF...';
    try { await downloadReviewReceipt(bundle, proposal); }
    catch (receiptError) { receiptNote = ' No se pudo generar el acuse PDF: ' + receiptError.message; }
    renderFinalReview();
    if (receiptNote) document.getElementById('review-status').textContent += receiptNote;
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
