
const API_PROXY = CONFIG.API_BASE;
const workflowContext = MGPCWorkflow.requireContext('proposal');
let draftSnapshot = workflowContext ? MGPCWorkflow.getDraft() : null;
MGPCWorkflow.renderHeader('proposal');

let proposalChoices = null;
let proposalReady = false;
let leavingToSurvey = false;
const manualCase = ['division','inc_exc_manzanas'].includes(workflowContext?.caseType);
const primaryReference = workflowContext?.caseType === 'fusion' ? 'ut' : workflowContext?.caseType === 'inc_exc_secciones' ? 'section' : null;
let primaryReferencesOwner = null;

// Tablas de la API
const TABLA_UT = 'uts_mgpc';
const TABLA_SECCIONES = 'secciones';
const TABLA_MANZANAS = 'manzana';

// Umbrales para decidir completa/parcial según % de área dentro de la UT
const SECCION_COMPLETA_PCT = 99.5;
const SECCION_MIN_PCT = 0.5;
const MANZANA_COMPLETA_PCT = 99.5;
const MANZANA_MIN_PCT = 0.5;

/* ============================================================
   API
   ============================================================ */

function proxyUrl(endpoint, params, mode) {
    let url = API_PROXY + '?endpoint=' + encodeURIComponent(endpoint);

    if (mode === 'escritura') {
        url += '&modo=escritura';
    }

    if (params) {
        Object.keys(params).forEach(k => {
            url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        });
    }

    return url;
}


async function readApiResponse(response) {
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch (_) { throw new Error('La API devolvió una respuesta no válida (HTTP ' + response.status + ').'); }
  if (!response.ok || data?.success === false || data?.error) {
    const error = new Error(data?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || 'La solicitud falló (HTTP ' + response.status + ').');
    error.httpStatus = response.status;
    throw error;
  }
  if (data === null) throw new Error('La API devolvió una respuesta vacía.');
  return data;
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function apiGet(endpoint, params) {
  return fetch(proxyUrl(endpoint, params), {headers:{Accept:'application/json'}}).then(readApiResponse);
}


// POST de lectura (usa la clave de lectura en el proxy)
function apiPost(endpoint, body) {
    return fetch(proxyUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(readApiResponse);
}

// Intersección espacial en el servidor (sin cache: se manda la geometría)
function intersectar(tabla, geo, opts = {}) {
    return apiPost('intersect/' + tabla, {
        geometry: geo,
        mode: 'intersects',
        include_percentage: false, // el default de la API es true
        ...opts,
    });
}

/* ============================================================
   TOAST
   ============================================================ */

function showToast(msg, type = 'info', duration = 3500) {
    const c = document.getElementById('toast-container');

    if (!c) return;

    const t = document.createElement('div');

    t.className = 'toast toast-' + type;

    t.textContent = msg;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');

    c.appendChild(t);

    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateX(20px)';
        t.style.transition = 'all .3s';

        setTimeout(() => t.remove(), 300);
    }, duration);
}

/* ============================================================
   STATUS
   ============================================================ */

function setStatus(msg, st = 'ok') {
    const text = document.getElementById('editor-status-text');

    if (text) {
        text.textContent = msg;
    }

    const dot = document.getElementById('editor-status-dot');

    if (dot) {
        dot.className =
            'status-dot' + (st === 'error' ? ' error' : st === 'loading' ? ' loading' : '');
    }
}

/* ============================================================
   ESTADO
   ============================================================ */



const state = {
    distrito: workflowContext ? String(workflowContext.district) : '',

    cveUt: workflowContext?.ut.key || '',

    // Se conserva el identificador del expediente.
    idCaso: workflowContext?.caseId ?? null,

    utInvolucradas: workflowContext?.relatedUTs || [],

    // Nombre del tipo de caso seleccionado.
    clasificacion: ({division:'División',fusion:'Fusión',nomenclatura:'Cambio de Nomenclatura',inc_exc_secciones:'Inclusión/Exclusión de Secciones electorales',inc_exc_manzanas:'Inclusión/Exclusión de Manzanas electorales',combinacion:'Combinación',otros:'Otros'})[workflowContext?.caseType] || workflowContext?.caseType || '',

    features: [],

    // Lista oficial de secciones de la UT (uts_mgpc.secciones = completas,
    // uts_mgpc.secciones1 = parciales). Se llena al cargar el polígono.
    utSeccionesOficiales: null,

    // Propiedades completas de la UT (uts_mgpc) para el panel de información.
    utProps: null,
};

/* ============================================================
   EDITOR DE GEOMETRÍA
   ============================================================ */

const editorPoly = {
    map: null,

    polygons: [],

    mapPolygons: [],

    editMode: false,

    listener: null,

    original: null,

    guardado: null,

    cambios: false,

    seccionesLayer: null,

    seccionLabels: [],

    activePolygonIndex: 0,

    activeRingIndex: 0,

    geometryControl: null,

    colindanciasUTLayer: null,

    colindanciasUTLabels: [],

    colindanciasSeccionesLayer: null,

    colindanciasSeccionesLabels: [],

    manzanasLayer: null,

    manzanasLabels: [],

    // Historial para "Revert" (deshacer): copias de editorPoly.polygons
    historial: [],

    snapshotActual: null,

    historialTimer: null,
};

const HISTORIAL_MAX = 50;

// Un arrastre de vértice dispara muchos eventos; se agrupan en un solo paso
// cuando pasa este tiempo sin nuevos cambios.
const HISTORIAL_DEBOUNCE_MS = 500;
const editorSnap = {pointerDown:false,mutating:false,pending:null,uts:[],secciones:[],manzanas:[]};

function referenciasDeAjuste() {
    const references=[];
    const visible=layer=>layer?.getMap()===editorPoly.map;
    if (editorPoly.original && visible(editorPoly.originalLayer)) references.push({geometry:editorPoly.original,source:'límite original'});
    const add=(items,source)=>items.forEach(feature=>references.push({geometry:feature.geometry,source}));
    if (document.getElementById('chk-colindancias-ut').checked && visible(editorPoly.colindanciasUTLayer)) add(editorSnap.uts,'UT vecina');
    if (document.getElementById('chk-colindancias-secciones').checked) {
        if (visible(editorPoly.seccionesLayer)) add(state.features.map(item=>item.feature),'sección de la UT');
        if (visible(editorPoly.colindanciasSeccionesLayer)) add(editorSnap.secciones,'sección vecina');
    }
    if (document.getElementById('chk-manzanas').checked && visible(editorPoly.manzanasLayer)) add(editorSnap.manzanas,'manzana');
    return MGPCSnapping.build(references);
}

function finalizarEdicion() {
    const pending=editorSnap.pending;
    if (!pending) return true;
    clearTimeout(editorPoly.historialTimer);
    editorPoly.historialTimer=null;
    editorSnap.pending=null;
    let note=pending.index===null?'Punto eliminado. Puedes deshacer este cambio.':'Punto colocado. Puedes deshacer este movimiento.';
    if (pending.index!==null && document.getElementById('chk-editor-snap').checked) {
        const current=pending.path.getAt(pending.index);
        const point=[current.lng(),current.lat()];
        const meters=Math.min(10,Math.max(1,Number(document.getElementById('editor-snap-distance').value)||5));
        const match=MGPCSnapping.nearest(point,referenciasDeAjuste(),{meters,pixels:12,zoom:editorPoly.map.getZoom()});
        if (match) {
            try {
                MGPCSnapping.applyVertex(editorToGeometry(),pending,match.coordinate,ProposalChoices.validate);
                editorSnap.mutating=true;
                pending.path.setAt(pending.index,new google.maps.LatLng(match.coordinate[1],match.coordinate[0]));
                sincronizarAnilloDesdeMapa(pending.polygonIndex,pending.ringIndex,pending.path);
                note='Ajustado '+(match.kind==='vertex'?'a un punto':'al borde')+' de '+match.source+' ('+match.distance.toFixed(2)+' m).';
            } catch (error) {
                note='El ajuste automático no se aplicó: '+error.message;
            } finally {editorSnap.mutating=false;}
        } else note='Sin referencia visible dentro de la distancia de ajuste. Se conserva tu posición.';
    }
    try {ProposalChoices.validate(editorToGeometry());}
    catch (error) {
        editorPoly.polygons=pending.before;
        editorPoly.cambios=JSON.stringify(editorToGeometry())!==JSON.stringify(editorPoly.guardado);
        dibujar();actualizar();
        const message='Se deshizo el movimiento para conservar un límite válido. '+error.message;
        document.getElementById('editor-snap-status').textContent=message;
        showProposalError(message);
        return false;
    }
    if (JSON.stringify(pending.before)!==JSON.stringify(editorPoly.polygons)) {
        editorPoly.snapshotActual=pending.before;
        commitHistorial();
    }
    editorPoly.cambios=JSON.stringify(editorToGeometry())!==JSON.stringify(editorPoly.guardado);
    actualizar();
    document.getElementById('editor-snap-status').textContent=note;
    return true;
}

/* ============================================================
   UTILIDADES
   ============================================================ */

function clonarObjeto(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/* ============================================================
   CONVERTIR GEOJSON -> ESTRUCTURA DEL EDITOR
   ============================================================ */

function geometryToEditor(geometry) {
    editorPoly.polygons = [];

    if (!geometry || !geometry.type) {
        return;
    }

    const construirRings = polygonCoords =>
        polygonCoords.map((ring, ringIndex) => {
            const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
            const abierto = closed ? ring.slice(0, -1) : ring.slice();

            return abierto.map((coord, vertexIndex) => ({
                lat: Number(coord[1]),
                lng: Number(coord[0]),
                idx: vertexIndex,
                ringIndex: ringIndex,
            }));
        });

    if (geometry.type === 'Polygon') {
        if (!Array.isArray(geometry.coordinates)) {
            return;
        }

        editorPoly.polygons.push({
            rings: construirRings(geometry.coordinates),
        });
    } else if (geometry.type === 'MultiPolygon') {
        if (!Array.isArray(geometry.coordinates)) {
            return;
        }

        geometry.coordinates.forEach(polygonCoords => {
            editorPoly.polygons.push({
                rings: construirRings(polygonCoords),
            });
        });
    }

    editorPoly.activePolygonIndex = 0;
    editorPoly.activeRingIndex = 0;
}

/* ============================================================
   ESTRUCTURA DEL EDITOR -> GEOJSON
   ============================================================ */

function editorToGeometry() {
    const originalType = editorPoly.original?.type || 'Polygon';

    const polygonsCoords = editorPoly.polygons.map(poly => {
        return poly.rings.map(ring => {
            const coords = ring.map(v => [Number(v.lng), Number(v.lat)]);

            if (coords.length > 0) {
                coords.push([coords[0][0], coords[0][1]]);
            }

            return coords;
        });
    });

    if (originalType === 'MultiPolygon' || polygonsCoords.length > 1) {
        return {
            type: 'MultiPolygon',
            coordinates: polygonsCoords,
        };
    }

    return {
        type: 'Polygon',
        coordinates: polygonsCoords[0] || [],
    };
}

/* ============================================================
   TOTAL DE VÉRTICES
   ============================================================ */

function obtenerTotalVertices() {
    let total = 0;

    editorPoly.polygons.forEach(poly => {
        poly.rings.forEach(ring => {
            total += ring.length;
        });
    });

    return total;
}

/* ============================================================
   OBTENER ANILLO ACTIVO
   ============================================================ */

function obtenerAnilloActivo() {
    const p = editorPoly.polygons[editorPoly.activePolygonIndex];

    if (!p) return null;

    return p.rings[editorPoly.activeRingIndex] || null;
}

/* ============================================================
   OBTENER NOMBRE DEL ANILLO
   ============================================================ */

function nombreAnillo(polygonIndex, ringIndex) {
    if (ringIndex === 0) {
        return `Zona ${polygonIndex + 1} · Límite exterior`;
    }

    return `Zona ${polygonIndex + 1} · Límite interior ${ringIndex}`;
}

/* ============================================================
   ÁREA
   ============================================================ */

function calcularAreaM2() {
    let areaM2 = 0;

    editorPoly.polygons.forEach(polyData => {
        polyData.rings.forEach((ring, ringIndex) => {
            if (ring.length < 3) {
                return;
            }

            const path = ring.map(v => ({
                lat: v.lat,
                lng: v.lng,
            }));

            const area = google.maps.geometry.spherical.computeArea(path);

            if (ringIndex === 0) {
                areaM2 += area;
            } else {
                areaM2 -= area;
            }
        });
    });

    return Math.max(0, areaM2);
}

function calcularAreaKm2() {
    return calcularAreaM2() / 1000000;
}

/* ============================================================
   ESTILO DE SECCIONES
   ============================================================ */

function strokeStyleBySeccion(tiposecc) {
    // La clasificación C/P se conserva internamente, pero todas las secciones
    // se representan igual en el mapa para simplificar la lectura.
    return {
        strokeColor: '#2563EB',
        strokeWeight: 2.5,
        strokeOpacity: 1,
    };
}

/* ============================================================
   CARGAR SECCIONES DE LA UT
   Completas/parciales salen de uts_mgpc (secciones / secciones1);
   la geometría viene de intersect sobre la tabla "secciones".
   Si la UT no trae lista oficial, se usa el % de área como respaldo.
   ============================================================ */

function parseListaSecciones(txt) {
    return String(txt ?? '')
        .split(/[,;\s]+/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite);
}

async function cargarFeaturesEditor() {
    if (!editorPoly.original) return;

    const resp = primaryReference==='section' && proposalChoices
        ? {features:proposalChoices.getCandidateFeatures()}
        : await intersectar(TABLA_SECCIONES, editorPoly.original, {include_percentage:true});

    const of = state.utSeccionesOficiales;
    const hayOficial = !!of && of.completas.length + of.parciales.length > 0;
    const setC = new Set(of ? of.completas : []);
    const setP = new Set(of ? of.parciales : []);

    let candidatas = resp.features || [];

    if (hayOficial) {
        // Se usa la asignación oficial de uts_mgpc; la geometría solo aporta el dibujo
        candidatas = candidatas.filter(f => {
            const s = Number(f.properties.seccion);
            return setC.has(s) || setP.has(s);
        });

        const halladas = new Set(candidatas.map(f => Number(f.properties.seccion)));
        const faltan = [...setC, ...setP].filter(s => !halladas.has(s));

        if (faltan.length) {
            console.warn('Secciones oficiales sin geometría en intersect:', faltan);
            showToast('Secciones sin geometría: ' + faltan.join(', '), 'warn', 5000);
        }
    } else {
        // Respaldo: sin lista oficial se decide por % de área
        candidatas = candidatas.filter(f => (f.porcentaje_afectado ?? 0) >= SECCION_MIN_PCT);
    }

    state.features = candidatas.map(f => {
        const s = Number(f.properties.seccion);

        const tiposecc = hayOficial
            ? setP.has(s) ? 'P' : 'C'
            : f.porcentaje_afectado >= SECCION_COMPLETA_PCT ? 'C' : 'P';

        f.properties = {
            ...f.properties,
            tiposecc,
            cve_ut: state.cveUt,
            pct: f.porcentaje_afectado,
        };

        return { seccion: f.properties.seccion, tiposecc, cve_ut: state.cveUt, feature: f };
    });

    renderSeccionesInfo();
}

/* ============================================================
   INFORMACIÓN DE LA UT
   ============================================================ */

function renderUtInfo() {
    const props = state.utProps || {};

    const setTxt = (id, valor) => {
        const el = document.getElementById(id);

        if (el) el.textContent = valor;
    };

    setTxt('ut-info-cve', state.cveUt || '—');
    setTxt('ut-info-distrito', state.distrito || props.distrito || props.dtto || '—');
    setTxt('ut-info-nombre', obtenerNombreUTDesdeProperties(props) || '—');
}

/* ============================================================
   INFORMACIÓN DE SECCIONES
   ============================================================ */

function renderSeccionesInfo() {
    const completas = [];
    const parciales = [];

    state.features.forEach(f => {
        const tipo = String(f.tiposecc || '')
            .trim()
            .toUpperCase();

        if (tipo === 'P') {
            parciales.push(f.seccion);
        } else {
            completas.push(f.seccion);
        }
    });

    completas.sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
    parciales.sort((a, b) => (Number(a) || 0) - (Number(b) || 0));

    const totalCompletas = document.getElementById('secc-total-completas');
    const totalParciales = document.getElementById('secc-total-parciales');
    const totalSecciones = document.getElementById('secc-total-secciones');

    if (totalCompletas) totalCompletas.textContent = completas.length;
    if (totalParciales) totalParciales.textContent = parciales.length;
    if (totalSecciones) totalSecciones.textContent = completas.length + parciales.length;

    const pintarLista = (contenedorId, lista, color) => {
        const cont = document.getElementById(contenedorId);

        if (!cont) return;

        cont.innerHTML = '';

        if (!lista.length) {
            cont.innerHTML = `<span style="color:var(--text-dim);font-style:italic;font-size:12px">Sin secciones en esta categoría</span>`;

            return;
        }

        lista.forEach(seccion => {
            const chip = document.createElement('span');

            chip.style.cssText = `
                display:inline-flex;
                align-items:center;
                padding:3px 9px;
                border-radius:12px;
                font-size:12px;
                font-weight:600;
                color:#000;
                background:${color}22;
                border:1px solid ${color}66
            `;

            chip.textContent = seccion;

            cont.appendChild(chip);
        });
    };

    pintarLista('secciones-completas-lista', completas, '#16A34A');
    pintarLista('secciones-parciales-lista', parciales, '#DC2626');
}

/* ============================================================
   CARGAR POLÍGONO / MULTIPOLÍGONO
   ============================================================ */

function asGeometry(value) {
    if (!value) return null;
    if (value.type === 'Feature') return value.geometry;
    return value;
}
function geometryIsValid(geometry) {
    if (!geometry || !['Polygon','MultiPolygon'].includes(geometry.type)) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return Array.isArray(polygons) && polygons.length > 0 && polygons.every(polygon =>
        Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring => {
            if (!Array.isArray(ring) || ring.length < 4) return false;
            if (!ring.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) return false;
            if (ring[0][0] !== ring[ring.length-1][0] || ring[0][1] !== ring[ring.length-1][1]) return false;
            return new Set(ring.slice(0,-1).map(p=>p[0]+','+p[1])).size >= 3;
        }));
}
async function cargarPolyGeometria() {
    setStatus('Cargando límites de la UT…', 'loading');
    const data = await Api.getUTByCve(state.cveUt);
    const selected = data.features?.find(f=>String(f.properties?.cve_ut).trim() === String(state.cveUt));
    const official = selected?.geometry;
    const propsUT = selected?.properties || workflowContext.ut.properties || {};
    if (!geometryIsValid(official)) throw new Error('No se pudieron recuperar los límites de esta UT. Vuelve a intentar.');
    if (draftSnapshot && JSON.stringify(draftSnapshot.geometries.original) !== JSON.stringify(official)) {
        MGPCWorkflow.invalidateDraft();
        draftSnapshot = null;
        showToast('Los límites de origen se actualizaron. Prepara de nuevo la propuesta sobre la versión actual.', 'warn', 7000);
    }
    editorPoly.original = clonarObjeto(official);
    state.utProps = propsUT;
    state.utSeccionesOficiales = {completas:parseListaSecciones(propsUT.secciones),parciales:parseListaSecciones(propsUT.secciones1)};
    renderUtInfo();
    const prior = asGeometry(draftSnapshot?.geometries?.proposed);
    const initial = geometryIsValid(prior) ? prior : official;
    editorPoly.guardado = clonarObjeto(initial);
    geometryToEditor(initial);
    editorPoly.cambios = false;
    reiniciarHistorial();
    editorPoly.originalLayer = new google.maps.Data({map:editorPoly.map});
    editorPoly.originalLayer.addGeoJson({type:'Feature',properties:{},geometry:official});
    const sectionCase=primaryReference==='section';
    editorPoly.originalLayer.setStyle({strokeColor:'#4b2e83',strokeWeight:sectionCase?6:2,strokeOpacity:1,
        fillOpacity:sectionCase?0:.035,fillColor:'#4b2e83',clickable:false,zIndex:sectionCase?80:10});
    document.getElementById('section-map-legend').hidden=!sectionCase;
    dibujar();
    actualizar();
    document.getElementById('editor-geometry-source').textContent = sectionCase
        ? 'El contorno morado grueso marca tu UT actual. Consulta la simbología del mapa para distinguir las secciones y tus cambios.'
        : draftSnapshot ? 'Retomamos los límites que preparaste. Puedes revisarlos o continuar.' : 'Morado: límite actual. Verde: tu propuesta.';
    if (!manualCase) {
        proposalChoices = await ProposalChoices.create({context:workflowContext,original:official,map:editorPoly.map,draft:draftSnapshot,
          onChange(result) {
            geometryToEditor(result.geometry);
            editorPoly.cambios = JSON.stringify(result.geometry) !== JSON.stringify(editorPoly.guardado);
            dibujar(); actualizar();
          },
          onError(error) {showProposalError(error.message);}
        });
    }
    renderReferenciaPrincipal();
    proposalReady = true;
    actualizar();
    setStatus(manualCase ? 'Mueve los puntos del límite para preparar tu propuesta' : 'Elige las zonas que formarán tu propuesta', 'ok');
    if (manualCase) toggleModo();
}

function showProposalError(message) {
    const target=document.getElementById('proposal-error');
    target.textContent=message;
    target.hidden=!message;
    if (message) {showToast(message,'error',6000);setStatus(message,'error');}
}



/* ============================================================
   OVERLAY DE SECCIONES
   ============================================================ */

// Las secciones propias de la UT solo se ven cuando está activo el
// checkbox "Secciones" de Colindancias (junto con las colindantes).
function seccionesUTVisibles() {
    return !!document.getElementById('chk-colindancias-secciones')?.checked;
}

function ocultarSeccionesUTEnMapa() {
    if (editorPoly.seccionesLayer) editorPoly.seccionesLayer.setMap(null);
    editorPoly.seccionLabels.forEach(l => l.setMap(null));
}

function mostrarSeccionesUTEnMapa() {
    if (editorPoly.seccionesLayer) editorPoly.seccionesLayer.setMap(editorPoly.map);
    editorPoly.seccionLabels.forEach(l => l.setMap(editorPoly.map));
}

function cargarSeccionesOverlayEnEditor() {
    if (primaryReference==='section') {renderReferenciaPrincipal();return;}
    if (!editorPoly.map) {
        return;
    }

    if (editorPoly.seccionesLayer) {
        editorPoly.seccionesLayer.forEach(f => editorPoly.seccionesLayer.remove(f));
    } else {
        editorPoly.seccionesLayer = new google.maps.Data({
            map: seccionesUTVisibles() ? editorPoly.map : null,
        });

        editorPoly.seccionesLayer.addListener('click', event => {
            const props = {};

            event.feature.forEachProperty((v, k) => {
                props[k] = v;
            });

            showToast(
                `Sección ${props.seccion} · ${
                    String(props.tiposecc).toUpperCase() === 'P' ? 'Parcial' : 'Completa'
                }`,
                'info',
                2000,
            );
        });
    }

    if (!state.features.length) {
        renderSeccionLabelsEditor();

        return;
    }

    const geojson = {
        type: 'FeatureCollection',
        features: state.features.map(f => f.feature),
    };

    editorPoly.seccionesLayer.addGeoJson(geojson);

    editorPoly.seccionesLayer.setStyle(function (feature) {
        const stroke = strokeStyleBySeccion(feature.getProperty('tiposecc'));

        return {
            fillColor: '#2563EB',
            fillOpacity: 0.10,
            ...stroke,
            zIndex: 1,
        };
    });

    renderSeccionLabelsEditor();
}

/* ============================================================
   ETIQUETAS DE SECCIONES
   ============================================================ */

// Una sola etiqueta por elemento, dentro de su parte de mayor superficie.
// No se mezclan los anillos de islas diferentes ni se coloca el centro en un hueco.
function posicionEtiquetaReferencia(geometry) {
    if (!geometryIsValid(geometry) || typeof turf === 'undefined') return null;
    try {
        const parts = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates)
            .map(coordinates => ({type:'Feature',properties:{},geometry:{type:'Polygon',coordinates}}))
            .filter(part => turf.area(part) > 0)
            .sort((a,b) => turf.area(b) - turf.area(a));
        if (!parts.length) return null;
        const part = parts[0];
        const bounds = turf.bbox(part);
        const center = [(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];
        const inside = point => turf.booleanPointInPolygon(point,part,{ignoreBoundary:true});
        const position = point => ({lng:point[0],lat:point[1]});
        for (const point of [turf.centerOfMass(part).geometry.coordinates,center,turf.centroid(part).geometry.coordinates]) {
            if (inside(point)) return position(point);
        }
        // En contornos cóncavos o con huecos, buscar un punto interior próximo
        // al centro. La cuadrícula evita que un centro exterior tape otra zona.
        for (const divisions of [8,16,32]) {
            let best = null, distance = Infinity;
            for (let x = 0; x < divisions; x++) for (let y = 0; y < divisions; y++) {
                const point = [bounds[0]+(x+.5)*(bounds[2]-bounds[0])/divisions,bounds[1]+(y+.5)*(bounds[3]-bounds[1])/divisions];
                const candidateDistance = (point[0]-center[0])**2 + (point[1]-center[1])**2;
                if (candidateDistance < distance && inside(point)) {best=point;distance=candidateDistance;}
            }
            if (best) return position(best);
        }
        // Una franja muy estrecha puede no coincidir con la cuadrícula. El
        // respaldo queda sobre la superficie o su borde, nunca entre dos islas.
        return position(turf.pointOnFeature(part).geometry.coordinates);
    } catch (error) {
        console.warn('No se pudo ubicar una etiqueta de referencia.', error);
        return null;
    }
}

function crearEtiquetaNumericaReferencia(value, geometry, {map,color='#2563EB',title='',layer='section',key} = {}) {
    const text=String(value ?? '').trim();
    if (!/^\d+$/.test(text) || !editorPoly.map) return null;
    const position=posicionEtiquetaReferencia(geometry);
    if (!position) return null;
    const handle=MGPCMapLabels.forMap(editorPoly.map).add({layer,key:key ?? text,text,position,color,variant:'reference'});
    handle.setMap(map ?? null);
    return handle;
}
function crearEtiquetaUTReferencia(ut) {
    const position=posicionEtiquetaReferencia(ut.feature?.geometry);
    if (!position) return null;
    return MGPCMapLabels.forMap(editorPoly.map).add({layer:'ut',key:String(ut.cveUt),text:String(ut.cveUt),
        name:ut.nombre || 'Unidad territorial',position,variant:'reference'});
}
function fijarReferenciaPrincipal() {
    if (!primaryReference) return;
    const checkbox=document.getElementById(primaryReference==='ut'?'chk-colindancias-ut':'chk-colindancias-secciones');
    checkbox.checked=true;checkbox.disabled=true;
    checkbox.setAttribute('aria-describedby','primary-reference-note');
}
function renderReferenciaPrincipal() {
    fijarReferenciaPrincipal();
    if (!primaryReference || !proposalChoices) return;
    proposalChoices.ensureVisible();
    if (primaryReferencesOwner===proposalChoices) return;
    const references=proposalChoices.getReferenceFeatures();
    const array=primaryReference==='ut'?'colindanciasUTLabels':'colindanciasSeccionesLabels';
    editorPoly[array].forEach(label=>label.setMap(null));editorPoly[array]=[];
    if (primaryReference==='ut') {
        const units=references.map(feature=>({cveUt:String(feature.properties.cve_ut),nombre:obtenerNombreUTDesdeProperties(feature.properties),feature}));
        pintarListaUTColindantes(units);
        units.forEach(ut=>{const label=crearEtiquetaUTReferencia(ut);if(label)editorPoly[array].push(label);});
    } else {
        const list=document.getElementById('colindancias-secciones-lista');list.replaceChildren();
        document.getElementById('colindancias-secc-count').textContent=references.length;
        references.forEach(feature=>{
            const number=feature.properties.seccion;
            pintarChip(list,String(number),'#2563EB');
            const label=crearEtiquetaNumericaReferencia(number,feature.geometry,{map:editorPoly.map});
            if(label)editorPoly[array].push(label);
        });
    }
    primaryReferencesOwner=proposalChoices;
}

function renderSeccionLabelsEditor() {
    editorPoly.seccionLabels.forEach(label => label.setMap(null));
    editorPoly.seccionLabels = [];
    if (!editorPoly.seccionesLayer) return;
    const map = seccionesUTVisibles() && editorPoly.seccionesLayer.getMap() === editorPoly.map ? editorPoly.map : null;
    state.features.forEach(item => {
        const marker = crearEtiquetaNumericaReferencia(item.seccion,item.feature?.geometry,{map,title:'Sección '+item.seccion});
        if (marker) editorPoly.seccionLabels.push(marker);
    });
}

/* ============================================================
   COLINDANCIAS (UT Y SECCIONES) — CALCULADAS EN EL SERVIDOR
   con /intersect y buffer_meters. Ya no se descarga todo el
   dataset ni se calculan distancias en JS.
   ============================================================ */

const COLINDANCIAS_BUFFER_M = 20;

// Intenta obtener un nombre legible de UT a partir de las
// propiedades que regrese el API. Si no encuentra, regresa null.
function obtenerNombreUTDesdeProperties(props) {
    if (!props) return null;

    const llaves = [
        'nombre_ut',
        'nombreUt',
        'nombre',
        'ut_nombre',
        'name',
        'descripcion',
        'desc_ut',
    ];

    for (const llave of llaves) {
        if (
            props[llave] !== undefined &&
            props[llave] !== null &&
            String(props[llave]).trim() !== ''
        ) {
            return String(props[llave]).trim();
        }
    }

    return null;
}

function pintarChip(contenedor, texto, colorHex) {
    const chip = document.createElement('span');

    chip.style.cssText = `
        display:inline-flex;align-items:center;padding:3px 9px;
        border-radius:12px;font-size:11px;font-weight:600;color:#000;
        background:${colorHex}22;border:1px solid ${colorHex}66
    `;

    chip.textContent = texto;

    contenedor.appendChild(chip);
}

function pintarListaUTColindantes(utsColindantes) {
    const cont = document.getElementById('colindancias-ut-lista');
    const count = document.getElementById('colindancias-ut-count');

    if (count) count.textContent = utsColindantes.length;
    if (!cont) return;

    cont.innerHTML = '';

    if (!utsColindantes.length) {
        cont.innerHTML = `<span style="color:var(--text-dim);font-style:italic;font-size:12px">Sin UT colindantes dentro del buffer</span>`;
        return;
    }

    utsColindantes.forEach(ut => {
        const chip=document.createElement('span');chip.className='reference-ut-card';
        const key=document.createElement('strong');key.textContent=ut.cveUt;
        const name=document.createElement('span');name.textContent=ut.nombre || 'Unidad territorial';
        chip.append(key,name);cont.append(chip);
    });
}

function pintarListaSeccionesColindantes(seccionesColindantes) {
    const cont = document.getElementById('colindancias-secciones-lista');
    const count = document.getElementById('colindancias-secc-count');

    // Un solo listado: secciones propias de la UT + secciones colindantes.
    // C/P se conserva en state.features, pero no se distingue visualmente.
    const numeros = new Set();
    state.features.forEach(f => numeros.add(String(f.seccion)));
    seccionesColindantes.forEach(f => {
        const seccion = f?.properties?.seccion;
        if (seccion !== undefined && seccion !== null) numeros.add(String(seccion));
    });

    const lista = [...numeros].sort((a, b) => (Number(a) || 0) - (Number(b) || 0));

    if (count) count.textContent = lista.length;
    if (!cont) return;

    cont.innerHTML = '';

    if (!lista.length) {
        cont.innerHTML = `<span style="color:var(--text-dim);font-style:italic;font-size:12px">Sin secciones para mostrar</span>`;
        return;
    }

    lista.forEach(seccion => pintarChip(cont, String(seccion), '#2563EB'));
}

// Capa de POLIGONOS DE UT vecinas (trazo grueso, sin relleno) con etiqueta.
function renderUTColindantesEnMapa(utsColindantes) {
    editorSnap.uts=utsColindantes.map(item=>item.feature).filter(Boolean);
    if (!editorPoly.map) return;

    if (!editorPoly.colindanciasUTLayer) {
        editorPoly.colindanciasUTLayer = new google.maps.Data({ map: editorPoly.map });

        editorPoly.colindanciasUTLayer.setStyle({
            fillOpacity: 0,
            strokeColor: '#7B2CBF',
            strokeWeight: 3,
            strokeOpacity: 0.85,
            zIndex: 3,
        });

        editorPoly.colindanciasUTLayer.addListener('click', event => {
            const props = {};
            event.feature.forEachProperty((v, k) => {
                props[k] = v;
            });

            const nombre = obtenerNombreUTDesdeProperties(props);

            showToast(
                `UT colindante \u00b7 ${props.cve_ut}` + (nombre ? ' \u00b7 ' + nombre : ''),
                'info',
                2200,
            );
        });
    } else {
        editorPoly.colindanciasUTLayer.forEach(f => editorPoly.colindanciasUTLayer.remove(f));
    }

    editorPoly.colindanciasUTLabels.forEach(l => l.setMap(null));
    editorPoly.colindanciasUTLabels = [];

    utsColindantes.forEach(ut => {
        if (!ut.feature) return;

        const featureConClave = {
            ...ut.feature,
            properties: { ...(ut.feature.properties || {}), cve_ut: ut.cveUt },
        };

        editorPoly.colindanciasUTLayer.addGeoJson(featureConClave);
    });

    utsColindantes.forEach(ut => {
        const label=crearEtiquetaUTReferencia(ut);
        if(label)editorPoly.colindanciasUTLabels.push(label);
    });
}

// Capa de SECCIONES colindantes con la misma simbología de las secciones propias.
function renderSeccionesColindantesEnMapa(features) {
    editorSnap.secciones=features;
    if (!editorPoly.map) return;

    if (!editorPoly.colindanciasSeccionesLayer) {
        editorPoly.colindanciasSeccionesLayer = new google.maps.Data({ map: editorPoly.map });

        editorPoly.colindanciasSeccionesLayer.setStyle({
            fillColor: '#2563EB',
            fillOpacity: 0.08,
            strokeColor: '#2563EB',
            strokeWeight: 2.5,
            strokeOpacity: 1,
            zIndex: 2,
        });

        editorPoly.colindanciasSeccionesLayer.addListener('click', event => {
            const props = {};
            event.feature.forEachProperty((v, k) => {
                props[k] = v;
            });

            showToast(`Secci\u00f3n colindante \u00b7 Secci\u00f3n ${props.seccion}`, 'info', 2200);
        });
    } else {
        editorPoly.colindanciasSeccionesLayer.forEach(f =>
            editorPoly.colindanciasSeccionesLayer.remove(f),
        );
    }

    editorPoly.colindanciasSeccionesLabels.forEach(l => l.setMap(null));
    editorPoly.colindanciasSeccionesLabels = [];

    if (!features.length) return;

    editorPoly.colindanciasSeccionesLayer.addGeoJson({ type: 'FeatureCollection', features });

    const map = seccionesUTVisibles() && editorPoly.colindanciasSeccionesLayer.getMap() === editorPoly.map ? editorPoly.map : null;
    features.forEach(feature => {
        const seccion = feature.properties?.seccion;
        const marker = crearEtiquetaNumericaReferencia(seccion,feature.geometry,{map,title:'Sección '+seccion,zIndex:999998});
        if (marker) editorPoly.colindanciasSeccionesLabels.push(marker);
    });
}

function ocultarUTColindantesEnMapa() {
    if (primaryReference==='ut') return;
    if (editorPoly.colindanciasUTLayer) editorPoly.colindanciasUTLayer.setMap(null);
    editorPoly.colindanciasUTLabels.forEach(l => l.setMap(null));
}

function mostrarUTColindantesEnMapa() {
    if (editorPoly.colindanciasUTLayer) editorPoly.colindanciasUTLayer.setMap(editorPoly.map);
    editorPoly.colindanciasUTLabels.forEach(l => l.setMap(editorPoly.map));
}

function ocultarSeccionesColindantesEnMapa() {
    if (primaryReference==='section') return;
    if (editorPoly.colindanciasSeccionesLayer) editorPoly.colindanciasSeccionesLayer.setMap(null);
    editorPoly.colindanciasSeccionesLabels.forEach(l => l.setMap(null));
}

function mostrarSeccionesColindantesEnMapa() {
    if (editorPoly.colindanciasSeccionesLayer)
        editorPoly.colindanciasSeccionesLayer.setMap(editorPoly.map);
    editorPoly.colindanciasSeccionesLabels.forEach(l => l.setMap(editorPoly.map));
}

// Punto central de colindancias: revisa ambos checkboxes (independientes)
// y consulta /intersect con buffer sobre la geometría ACTUAL del editor.
let colindanciasReqId = 0;

async function refrescarColindancias() {
    const reqId=++colindanciasReqId;
    renderReferenciaPrincipal();
    const chkUT=document.getElementById('chk-colindancias-ut');
    const chkSecc=document.getElementById('chk-colindancias-secciones');
    const quiereUT=primaryReference!=='ut' && !!chkUT.checked;
    const quiereSecc=primaryReference!=='section' && !!chkSecc.checked;
    if (!quiereUT && primaryReference!=='ut') {ocultarUTColindantesEnMapa();pintarListaUTColindantes([]);}
    if (primaryReference!=='section') {
        if (quiereSecc) mostrarSeccionesUTEnMapa();
        else {
            ocultarSeccionesUTEnMapa();ocultarSeccionesColindantesEnMapa();
            document.getElementById('colindancias-secc-count').textContent='—';
            document.getElementById('colindancias-secciones-lista').replaceChildren();
        }
    }
    if ((!quiereUT && !quiereSecc) || obtenerTotalVertices()<3) return;
    const geometry=editorToGeometry();
    try {
        const [respUT,respSecc]=await Promise.all([
            quiereUT?intersectar(TABLA_UT,geometry,{buffer_meters:COLINDANCIAS_BUFFER_M}):null,
            quiereSecc?intersectar(TABLA_SECCIONES,geometry,{buffer_meters:COLINDANCIAS_BUFFER_M}):null
        ]);
        if(reqId!==colindanciasReqId)return;
        if(respUT){
            const units=(respUT.features || []).filter(f=>String(f.properties?.cve_ut)!==String(state.cveUt))
                .map(feature=>({cveUt:String(feature.properties.cve_ut),nombre:obtenerNombreUTDesdeProperties(feature.properties),feature}));
            pintarListaUTColindantes(units);renderUTColindantesEnMapa(units);mostrarUTColindantesEnMapa();
        }
        if(respSecc){
            const own=new Set(state.features.map(f=>String(f.seccion)));
            const sections=(respSecc.features || []).filter(f=>!own.has(String(f.properties?.seccion)));
            pintarListaSeccionesColindantes(sections);renderSeccionesColindantesEnMapa(sections);mostrarSeccionesColindantesEnMapa();
        }
    } catch(error){
        if(reqId!==colindanciasReqId)return;
        console.warn(error);showToast('No se pudo cargar la referencia adicional. Vuelve a activarla para reintentar.','error');
        if(quiereUT){chkUT.checked=false;ocultarUTColindantesEnMapa();}
        if(quiereSecc){chkSecc.checked=false;ocultarSeccionesUTEnMapa();ocultarSeccionesColindantesEnMapa();}
        fijarReferenciaPrincipal();
    }
}

/* ============================================================
   MANZANAS ELECTORALES (tabla "manzana") — intersect con % de área
   ============================================================ */

let manzanasReqId = 0;

function limpiarEtiquetasManzanas() {
    editorPoly.manzanasLabels.forEach(label => label.setMap(null));
    editorPoly.manzanasLabels = [];
}

function ocultarManzanasEnMapa() {
    if (editorPoly.manzanasLayer) editorPoly.manzanasLayer.setMap(null);
    limpiarEtiquetasManzanas();
}

async function refrescarManzanas() {
    const reqId = ++manzanasReqId;
    const chk = document.getElementById('chk-manzanas');
    limpiarEtiquetasManzanas();

    if (!chk?.checked) {
        ocultarManzanasEnMapa();
        return;
    }

    if (obtenerTotalVertices() < 3) return;


    const countEl = document.getElementById('manzanas-count');
    if (countEl) countEl.textContent = '...';

    try {
        const geo = editorToGeometry();

        // 1) manzanas que caen en la UT (con % de área)
        // 2) manzanas dentro del buffer (para sacar las colindantes)
        const [respUT, respBuf] = await Promise.all([
            intersectar(TABLA_MANZANAS, geo, { include_percentage: true }),
            intersectar(TABLA_MANZANAS, geo, { buffer_meters: COLINDANCIAS_BUFFER_M }),
        ]);

        if (reqId !== manzanasReqId) return;

        // porcentaje_afectado viene al nivel de la feature, no en properties
        const enUT = (respUT.features || [])
            .filter(f => (f.porcentaje_afectado ?? 0) >= MANZANA_MIN_PCT)
            .map(f => ({
                ...f,
                properties: {
                    ...f.properties,
                    pct: f.porcentaje_afectado,
                    completa: f.porcentaje_afectado >= MANZANA_COMPLETA_PCT,
                    colindante: false,
                },
            }));

        const idsEnUT = new Set(enUT.map(f => String(f.id)));

        // Colindantes = las del buffer que no están (o solo tocan el borde) en la UT
        const colindantes = (respBuf.features || [])
            .filter(f => !idsEnUT.has(String(f.id)))
            .map(f => ({
                ...f,
                properties: { ...f.properties, pct: 0, completa: false, colindante: true },
            }));

        renderManzanas(enUT, colindantes);
    } catch (err) {
        if (reqId !== manzanasReqId) return;
        console.error(err);
        showToast('No se pudieron cargar las manzanas', 'error');
        chk.checked = false;
        ocultarManzanasEnMapa();
        if (countEl) countEl.textContent = '—';
    }
}

function renderManzanas(manzanas, colindantes = []) {
    editorSnap.manzanas=[...manzanas,...colindantes];
    limpiarEtiquetasManzanas();
    const map = document.getElementById('chk-manzanas').checked ? editorPoly.map : null;
    const completas = manzanas.filter(m => m.properties.completa);
    const parciales = manzanas.filter(m => !m.properties.completa);

    document.getElementById('manzanas-count').textContent = manzanas.length;
    document.getElementById('manzanas-completas').textContent = completas.length;
    document.getElementById('manzanas-parciales').textContent = parciales.length;
    document.getElementById('manzanas-colindantes').textContent = colindantes.length;

    const lista = document.getElementById('manzanas-lista');
    lista.innerHTML = '';

    parciales
        .sort(
            (a, b) =>
                a.properties.seccion - b.properties.seccion ||
                a.properties.manzana - b.properties.manzana,
        )
        .forEach(m => {
            const p = m.properties;
            pintarChip(
                lista,
                `Secc. ${p.seccion} \u00b7 Mz ${p.manzana} (${Number(p.pct).toFixed(0)}%)`,
                '#0ea5e9',
            );
        });

    if (!editorPoly.manzanasLayer) {
        editorPoly.manzanasLayer = new google.maps.Data({ map });

        editorPoly.manzanasLayer.setStyle(f => {
            if (f.getProperty('colindante')) {
                return {
                    fillColor: '#64748b',
                    fillOpacity: 0.10,
                    strokeColor: '#64748B',
                    strokeWeight: 2,
                    strokeOpacity: 0.9,
                    zIndex: 3,
                };
            }

            const completa = !!f.getProperty('completa');
            return {
                fillColor: completa ? '#0891B2' : '#EA580C',
                fillOpacity: completa ? 0.16 : 0.14,
                strokeColor: completa ? '#0891B2' : '#EA580C',
                strokeWeight: completa ? 2 : 2.5,
                strokeOpacity: 0.9,
                zIndex: 4,
            };
        });

        editorPoly.manzanasLayer.addListener('click', e => {
            const base =
                `Secc. ${e.feature.getProperty('seccion')} \u00b7 Mz ${e.feature.getProperty('manzana')}`;

            if (e.feature.getProperty('colindante')) {
                showToast(`Manzana colindante \u00b7 ${base}`, 'info', 3000);
            } else {
                showToast(
                    `${base} \u00b7 ${Number(e.feature.getProperty('pct')).toFixed(1)}% dentro`,
                    'info',
                    3000,
                );
            }
        });
    } else {
        editorPoly.manzanasLayer.forEach(f => editorPoly.manzanasLayer.remove(f));
        editorPoly.manzanasLayer.setMap(map);
    }

    editorPoly.manzanasLayer.addGeoJson({
        type: 'FeatureCollection',
        features: [...manzanas, ...colindantes],
    });
    [...manzanas,...colindantes].forEach(feature => {
        const number = feature.properties?.manzana;
        const marker = crearEtiquetaNumericaReferencia(number,feature.geometry,{
            map,color:'#0891B2',title:'Manzana '+number,layer:'block',key:String(feature.properties?.seccion ?? '-')+':'+number
        });
        if (marker) editorPoly.manzanasLabels.push(marker);
    });
}

// Se llama después de cada edición del polígono (actualizar()).
// Debounce: mientras el usuario arrastra un vértice se dispara una vez
// por micro-movimiento; solo se consulta al API cuando se detiene.
let colindanciasDebounceTimer = null;

const COLINDANCIAS_DEBOUNCE_MS = 600;

function actualizarColindanciasSiVisible() {
    const activo = id => !!document.getElementById(id)?.checked;

    const colind = activo('chk-colindancias-ut') || activo('chk-colindancias-secciones');
    const manz = activo('chk-manzanas');

    if (!colind && !manz) return;

    clearTimeout(colindanciasDebounceTimer);

    colindanciasDebounceTimer = setTimeout(() => {
        colindanciasDebounceTimer = null;

        if (colind) refrescarColindancias();
        if (manz) refrescarManzanas();
    }, COLINDANCIAS_DEBOUNCE_MS);
}

/* ============================================================
   CREAR CONTROLES DE GEOMETRÍA
   ============================================================ */

function crearControlesGeometria() {
    if (editorPoly.geometryControl) {
        return;
    }

    const control = document.createElement('div');

    control.innerHTML = `<div id="editor-geometry-selection"></div>`;

    editorPoly.map.controls[google.maps.ControlPosition.TOP_RIGHT].push(control);

    editorPoly.geometryControl = control;
}

/* ============================================================
   ACTUALIZAR INDICADOR DE ANILLO ACTIVO
   ============================================================ */

function actualizarIndicadorGeometria() {
    const el = document.getElementById('editor-geometry-selection');

    if (!el) {
        return;
    }

    el.textContent = nombreAnillo(editorPoly.activePolygonIndex, editorPoly.activeRingIndex);
}

/* ============================================================
   DIBUJAR GEOMETRÍA (POLÍGONOS EDITABLES NATIVOS)
   ============================================================ */

function dibujar() {
    editorPoly.mapPolygons.forEach(p => {
        p.getPaths().forEach(path => {
            google.maps.event.clearInstanceListeners(path);
        });
        p.setMap(null);
    });

    editorPoly.mapPolygons = [];

    if (!editorPoly.polygons.length) {
        return;
    }

    const sectionCase=primaryReference==='section';
    const showProposal=!sectionCase || (proposalChoices ? proposalChoices.hasChanges() : !!draftSnapshot?.sectionChanges?.length);
    editorPoly.polygons.forEach((polyData, polygonIndex) => {
        if (!polyData.rings.length) return;

        const paths = polyData.rings.map(ring => ring.map(v => ({ lat: v.lat, lng: v.lng })));

        const mapPolygon = new google.maps.Polygon({
            paths: paths,
            map: editorPoly.map,
            editable: editorPoly.editMode,
            draggable: false,
            geodesic: true,
            clickable: manualCase,
            strokeColor: '#117d76',
            strokeOpacity: showProposal ? 1 : 0,
            strokeWeight: sectionCase ? 3 : editorPoly.editMode ? 5 : 4,
            fillColor: '#117d76',
            fillOpacity: sectionCase ? 0 : editorPoly.editMode ? 0.12 : 0.07,
            zIndex: sectionCase ? 90 : 49,
        });

        mapPolygon.addListener('click', event => {
            if (!editorPoly.editMode) return;

            editorPoly.activePolygonIndex = polygonIndex;

            // event.path trae el índice del anillo (0 = exterior, 1+ = hueco)
            // cuando el clic cae sobre un vértice o borde de ese anillo.
            editorPoly.activeRingIndex = typeof event.path === 'number' ? event.path : 0;

            actualizarIndicadorGeometria();

            showToast(
                `Seleccionado: ${nombreAnillo(polygonIndex, editorPoly.activeRingIndex)}`,
                'info',
                1500,
            );
        });

        mapPolygon.addListener('rightclick', event => {
            if (!editorPoly.editMode || typeof event.vertex !== 'number') return;
            const ring=mapPolygon.getPaths().getAt(event.path || 0);
            if (ring.getLength() <= 3) {showToast('Cada zona necesita al menos tres puntos.','warn');return;}
            ring.removeAt(event.vertex);
        });
        mapPolygon.getPaths().forEach((path, ringIndex) => {
            ['insert_at', 'remove_at', 'set_at'].forEach(evt => {
                google.maps.event.addListener(path, evt, index => {
                    if (editorSnap.mutating) return;
                    const before=editorSnap.pending?.before || clonarPolygonsEditor();
                    editorSnap.pending={path,polygonIndex,ringIndex,index:evt==='remove_at'?null:index,before};
                    sincronizarAnilloDesdeMapa(polygonIndex, ringIndex, path);

                    programarCommitHistorial();

                    editorPoly.activePolygonIndex = polygonIndex;
                    editorPoly.activeRingIndex = ringIndex;
                    editorPoly.cambios = true;

                    actualizarIndicadorGeometria();
                    actualizar();
                });
            });
        });

        editorPoly.mapPolygons.push(mapPolygon);
    });

    const bounds = new google.maps.LatLngBounds();
    let tienePuntos = false;

    editorPoly.polygons.forEach(poly =>
        poly.rings.forEach(ring =>
            ring.forEach(v => {
                bounds.extend({ lat: v.lat, lng: v.lng });
                tienePuntos = true;
            }),
        ),
    );

    if (tienePuntos && !editorPoly.editMode) {
        editorPoly.map.fitBounds(bounds, 50);
    }

    actualizarIndicadorGeometria();
}

/* ============================================================
   SINCRONIZAR: MVCArray del polígono nativo -> estructura interna
   ============================================================ */

function sincronizarAnilloDesdeMapa(polygonIndex, ringIndex, path) {
    const poly = editorPoly.polygons[polygonIndex];
    if (!poly) return;

    const ring = [];

    path.forEach((latLng, i) => {
        ring.push({
            lat: latLng.lat(),
            lng: latLng.lng(),
            idx: i,
            ringIndex: ringIndex,
        });
    });

    if (ring.length < 3) {
        showToast('Una zona debe conservar al menos 3 puntos.', 'warn');
    }

    poly.rings[ringIndex] = ring;
}

/* ============================================================
   ACTIVAR / DESACTIVAR EDICIÓN
   ============================================================ */

function toggleModo() {
    if (!manualCase) return;
    if (!finalizarEdicion()) return;
    if (obtenerTotalVertices() < 3) {
        showToast('No hay suficientes puntos.', 'warn');

        return;
    }

    editorPoly.editMode = !editorPoly.editMode;

    const btn = document.getElementById('btn-editor-modo');

    if (editorPoly.editMode) {
        if (btn) {
            btn.textContent = 'Terminar de mover puntos';

            btn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
        }

        crearControlesGeometria();

        dibujar();

        showToast(
            'Arrastra un punto del límite. Arrastra un punto intermedio para añadir otro. Para quitar un punto, haz clic derecho sobre él. Puedes deshacer cada cambio.',
            'info',
            7000,
        );
    } else {
        if (btn) {
            btn.textContent = 'Mover puntos';

            btn.style.background = '';
        }

        dibujar();

        showToast('Edición desactivada', 'warn');
    }

    actualizar();
}

/* ============================================================
   REVERTIR
   ============================================================ */

function clonarPolygonsEditor() {
    return clonarObjeto(editorPoly.polygons);
}

// Deja el historial vacío tomando la geometría actual como punto de partida
function reiniciarHistorial() {
    clearTimeout(editorPoly.historialTimer);

    editorPoly.historialTimer = null;
    editorSnap.pending = null;
    editorPoly.historial = [];
    editorPoly.snapshotActual = clonarPolygonsEditor();
}

function programarCommitHistorial() {
    clearTimeout(editorPoly.historialTimer);
    editorPoly.historialTimer = null;
    if (!editorSnap.pointerDown) editorPoly.historialTimer = setTimeout(finalizarEdicion, HISTORIAL_DEBOUNCE_MS);
}

// Guarda el estado ANTERIOR al movimiento y toma el actual como nuevo punto
function commitHistorial() {
    clearTimeout(editorPoly.historialTimer);

    editorPoly.historialTimer = null;

    if (!editorPoly.snapshotActual) return;

    editorPoly.historial.push(editorPoly.snapshotActual);

    if (editorPoly.historial.length > HISTORIAL_MAX) {
        editorPoly.historial.shift();
    }

    editorPoly.snapshotActual = clonarPolygonsEditor();
}

// "Revert": deshace el último movimiento (uno por clic)
function revertir() {
    if (proposalChoices) {proposalChoices.undo();return;}
    if (!finalizarEdicion()) return;

    if (!editorPoly.historial.length) {
        showToast('No hay movimientos que deshacer.', 'info');

        return;
    }

    editorPoly.polygons = editorPoly.historial.pop();

    editorPoly.snapshotActual = clonarPolygonsEditor();

    editorPoly.activePolygonIndex = 0;
    editorPoly.activeRingIndex = 0;

    // Sin pasos pendientes = igual que la última geometría guardada/cargada
    editorPoly.cambios = JSON.stringify(editorToGeometry()) !== JSON.stringify(editorPoly.guardado);

    dibujar();
    actualizar();

    showToast(
        editorPoly.historial.length
            ? '↩ Movimiento deshecho.'
            : '↩ Movimiento deshecho (sin más cambios pendientes).',
        'info',
    );
}

/* ============================================================
   GUARDAR
   ============================================================ */

// Ya no hay formulario: al guardar, el registro se arma solo con los
// contexto compartido y se continúa al cálculo de muestra.
function guardar() {
    if (!finalizarEdicion()) return;
    if (!proposalReady || !workflowContext) return;
    const button=document.getElementById('btn-editor-save');
    button.disabled=true;
    try {
        const proposed=editorToGeometry();
        const choices=proposalChoices ? proposalChoices.getResult() : {};
        const draft=ProposalChoices.prepareDraft(workflowContext,editorPoly.original,proposed,choices);
        MGPCWorkflow.saveDraft(draft);
        editorPoly.guardado=clonarObjeto(proposed);
        editorPoly.cambios=false;
        leavingToSurvey=true;
        window.location.href=MGPCWorkflow.paths.survey;
    } catch(error) {
        showProposalError(error.message || 'No se pudo conservar la propuesta. Intenta de nuevo.');
        button.disabled=false;
    }
}



/* ============================================================
   RECOLECTAR REGISTRO
   ============================================================ */

// Los metadatos acompañan la exportación local de la propuesta.
function recolectarRegistro() {
    return {
        distrito: state.distrito || '',

        cve_ut: state.cveUt || '',

        id_caso: state.idCaso,

        clasificacion_caso: state.clasificacion || '',

        ut_involucradas: clonarObjeto(state.utInvolucradas || []),
    };
}



/* ============================================================
   EXPORTAR GEOJSON
   ============================================================ */

function exportarPropuestaGeoJSON(registro) {
    if (!finalizarEdicion()) return;
    if (obtenerTotalVertices() < 3) {
        showToast('Se necesitan al menos 3 puntos para exportar.', 'warn');

        return;
    }

    const geometry = editorToGeometry();

    const areaKm2 = +calcularAreaKm2().toFixed(4);

    const geojson = {
        type: 'FeatureCollection',

        features: [
            {
                type: 'Feature',

                properties: {
                    cve_ut: state.cveUt,

                    distrito: state.distrito,

                    fecha_exportacion: new Date().toISOString(),

                    num_vertices: obtenerTotalVertices(),

                    area_km2: areaKm2,

                    tipo_geometria: geometry.type,

                    num_partes: editorPoly.polygons.length,

                    estado: editorPoly.cambios ? 'propuesta_sin_guardar' : 'coincide_con_guardado',

                    origen: 'Portal Geográfico Participativo · IECM (exportación local, sin escribir en BD)',

                    registro: registro || null,
                },

                geometry: geometry,
            },
        ],
    };

    const blob = new Blob([JSON.stringify(geojson, null, 2)], {
        type: 'application/geo+json',
    });

    const url = URL.createObjectURL(blob);

    const fechaArchivo = new Date().toISOString().slice(0, 10);

    const a = document.createElement('a');

    a.href = url;

    a.download = `propuesta_UT_${state.cveUt}_${fechaArchivo}.geojson`;

    document.body.appendChild(a);

    a.click();

    document.body.removeChild(a);

    URL.revokeObjectURL(url);

    showToast('📥 Propuesta exportada como GeoJSON', 'success');
}

/* ============================================================
   RESTAURAR ORIGINAL
   ============================================================ */

function restaurar() {
    if (proposalChoices) {proposalChoices.reset();return;}
    if (!editorPoly.original) {
        showToast('No existe geometría original.', 'error');

        return;
    }

    if (!confirm('¿Volver a los límites originales y descartar los cambios de la vista?')) {
        return;
    }

    geometryToEditor(editorPoly.original);

    editorPoly.cambios = JSON.stringify(editorPoly.original) !== JSON.stringify(editorPoly.guardado);

    reiniciarHistorial();

    editorPoly.editMode = false;

    const btn = document.getElementById('btn-editor-modo');

    if (btn) {
        btn.textContent = 'Mover puntos';

        btn.style.background = '';
    }

    if (editorPoly.listener) {
        google.maps.event.removeListener(editorPoly.listener);

        editorPoly.listener = null;
    }

    dibujar();

    actualizar();

    showToast('Restaurado localmente (BD no modificada)', 'success');
}

/* ============================================================
   ACTUALIZAR PANEL
   ============================================================ */

function actualizar() {
    const totalVertices = obtenerTotalVertices();
    document.getElementById('proposal-error').hidden = true;

    const verticesEl = document.getElementById('editor-vertices-count');

    if (verticesEl) {
        verticesEl.textContent = totalVertices;
    }

    const cambiosEl = document.getElementById('editor-cambios-status');

    if (cambiosEl) {
        cambiosEl.textContent = editorPoly.cambios ? ' Sí' : '✓ No';
    }

    const areaEl = document.getElementById('editor-area-value');

    if (areaEl) {
        areaEl.textContent = totalVertices >= 3 ? calcularAreaKm2().toFixed(2) + ' km²' : '—';
    }

    const utAreaEl = document.getElementById('ut-info-area');

    if (utAreaEl) {
        utAreaEl.textContent = totalVertices >= 3 ? calcularAreaKm2().toFixed(2) + ' km²' : '—';
    }

    const btnRevert = document.getElementById('btn-editor-revert');

    if (btnRevert) {
        btnRevert.disabled = proposalChoices ? !proposalChoices.canUndo() : !(editorPoly.historial.length || editorSnap.pending);
    }

    const btnSave = document.getElementById('btn-editor-save');

    if (btnSave) {
        btnSave.disabled = !proposalReady || !geometryIsValid(editorToGeometry()) || (!draftSnapshot && !editorPoly.cambios) || (proposalChoices && !proposalChoices.hasChanges());
    }

    actualizarIndicadorGeometria();

    actualizarColindanciasSiVisible();
}

/* ============================================================
   CERRAR EDITOR
   ============================================================ */

function cerrarEditor() {
    if (!finalizarEdicion()) return;
    if (
        editorPoly.cambios &&
        !confirm(
            '¿Volver al inicio? Los cambios que aún no confirmaste se descartarán.',
        )
    ) {
        return;
    }

    window.location.href = MGPCWorkflow.paths.home;
}

/* ============================================================
   INICIAR EDITOR
   ============================================================ */

function iniciarEditorStandalone() {
    if (!state.cveUt) {
        showToast('No se recibió ninguna UT. Regresa a la selección de UT.', 'error');

        setTimeout(() => {
            window.location.href = MGPCWorkflow.paths.home;
        }, 1500);

        return;
    }

    const utLabel = document.getElementById('editor-ut-label');

    if (utLabel) {
        utLabel.textContent = state.cveUt;
    }

    const d = document.getElementById('editor-distrito-label');

    if (d) {
        d.textContent = state.distrito || '—';
    }

    editorPoly.map = new google.maps.Map(document.getElementById('editor-map-container'), {
        center: {
            lat: 19.4326,
            lng: -99.1332,
        },

        zoom: 13,

        mapTypeId: 'roadmap',

        streetViewControl: true,

        fullscreenControl: true,

        mapTypeControl: true,
    });

    return cargarPolyGeometria()
        .then(() => cargarFeaturesEditor().then(cargarSeccionesOverlayEnEditor).catch(error=>{
            showToast('Los límites están listos, pero no se pudo cargar la capa informativa de secciones.','warn');
            console.warn(error);
        }))
        .catch(error => {
            proposalReady=false;
            showProposalError(error.message || 'No se pudieron cargar los límites. Recarga para reintentar.');
            document.getElementById('btn-editor-save').disabled=true;
            document.getElementById('btn-proposal-retry').hidden=false;
        });
}



/* ============================================================
   EVENTOS
   ============================================================ */

document.getElementById('btn-volver-poligono').addEventListener('click', cerrarEditor);

document.getElementById('btn-editor-modo').addEventListener('click', toggleModo);

document.getElementById('btn-editor-revert').addEventListener('click', revertir);

document.getElementById('btn-editor-save').addEventListener('click', guardar);

document
    .getElementById('btn-editor-export')
    .addEventListener('click', () => exportarPropuestaGeoJSON());

document.getElementById('btn-editor-restore').addEventListener('click', restaurar);

['chk-colindancias-ut', 'chk-colindancias-secciones'].forEach(id => {
    const chk = document.getElementById(id);
    if (chk) chk.addEventListener('change', refrescarColindancias);
});

document.getElementById('chk-manzanas').addEventListener('change', refrescarManzanas);

document.getElementById('btn-proposal-retry').addEventListener('click',()=>window.location.reload());

// MVCArray notifica también los cambios que realiza setAt: la bandera mutating
// evita que un ajuste automático se vuelva a ajustar a sí mismo.
function iniciarArrastre(event) {
    if (event.isPrimary===false) return;
    // Recupera un gesto cuya liberación ocurrió fuera de la ventana.
    if (editorSnap.pending) finalizarEdicion();
    editorSnap.pointerDown=true;
}
document.addEventListener('pointerdown',iniciarArrastre,true);
function terminarArrastre(event) {
    if (event?.isPrimary===false) return;
    editorSnap.pointerDown=false;
    if (editorSnap.pending) {
        clearTimeout(editorPoly.historialTimer);
        editorPoly.historialTimer=setTimeout(finalizarEdicion,0);
    }
}
document.addEventListener('pointerup',terminarArrastre,true);
document.addEventListener('pointercancel',terminarArrastre,true);
document.addEventListener('lostpointercapture',terminarArrastre,true);
document.addEventListener('pointermove',event=>{
    if (editorSnap.pointerDown && event.buttons===0) terminarArrastre(event);
},true);
document.addEventListener('visibilitychange',()=>{if(document.hidden)terminarArrastre();});
window.addEventListener('pointerup',terminarArrastre,true);
window.addEventListener('blur',terminarArrastre);
document.getElementById('chk-editor-snap').addEventListener('change',event=>{
    document.getElementById('editor-snap-status').textContent=event.target.checked
        ? 'Ajuste activado para los siguientes movimientos.' : 'Ajuste desactivado. Los puntos se colocan donde los sueltes.';
});
document.getElementById('editor-snap-distance').addEventListener('change',()=>{
    document.getElementById('editor-snap-status').textContent='La nueva distancia se aplicará al siguiente movimiento.';
});

function setupProposalUI() {
    if (!workflowContext) return;
    // actualizar() carga las referencias activas cuando la geometría está lista.
    if (workflowContext.caseType==='inc_exc_manzanas') document.getElementById('chk-manzanas').checked=true;
    fijarReferenciaPrincipal();
    const note=document.getElementById('primary-reference-note');
    note.hidden=!primaryReference;
    note.textContent=primaryReference==='ut'?'UT: referencia principal de la fusión. Siempre visible.':primaryReference==='section'?'Secciones: referencia principal de este caso. Siempre visible.':'';
    if(primaryReference)document.getElementById('territorial-reference-options').open=true;
    const caseInfo=CONFIG.CASES?.[workflowContext.caseType] || {};
    document.getElementById('proposal-page-title').textContent=caseInfo.label || state.clasificacion;
    document.getElementById('editor-case-label').textContent=workflowContext.ut.name || state.cveUt;
    document.getElementById('editor-survey-summary').textContent=caseInfo.instruction || (manualCase ? 'Mueve los puntos para definir cómo cambiará el límite. Después calcularemos la muestra.' : 'Elige las zonas de la propuesta. El mapa mostrará cómo quedan los nuevos límites.');
    document.getElementById('proposal-step-one').textContent=manualCase?'Mueve los puntos del límite':workflowContext.caseType==='fusion'?'Elige las UT que se unirán':'Elige las secciones que cambiarán';
    document.getElementById('btn-editor-modo').hidden=!manualCase;
    document.getElementById('editor-snap-controls').hidden=!manualCase;
    document.getElementById('btn-editor-save').disabled=true;
}
setupProposalUI();
window.initMap = function () {
    if (workflowContext) return iniciarEditorStandalone();
};


window.addEventListener('beforeunload', event => {
    if (editorPoly.cambios && !leavingToSurvey) {event.preventDefault();event.returnValue = '';}
});
