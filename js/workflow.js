/* Contexto autónomo del expediente, aislado por aplicación y pestaña. */
(function (root) {
  'use strict';
  const base = new URL('.', document.currentScript ? document.currentScript.src.replace(/js\/workflow\.js.*$/, '') : root.location.href);
  const key = 'mgpc.workflow.v1:' + base.pathname;
  const paths = Object.freeze({home:'index.html',proposal:'editor-territorial.html',editor:'editor-territorial.html',survey:'encuestas.html',review:'territorial.html',territorial:'territorial.html'});
  const supported = ['division','fusion','nomenclatura','inc_exc_secciones','inc_exc_manzanas'];
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function validContext(context) {
    return context && /^\d{1,2}$/.test(String(context.district)) && +context.district >= 1 && +context.district <= 33 && /^\d{2}-\d{3}$/.test(context.ut?.key || '');
  }
  function read() {
    try {
      const value = JSON.parse(root.sessionStorage.getItem(key) || 'null');
      if ([1,2].includes(value?.version) && validContext(value.context)) return value;
    } catch (_) { /* No recuperar resultados si la sesión está dañada. */ }
    return null;
  }
  function write(value) {
    value.version = 2;
    try { root.sessionStorage.setItem(key, JSON.stringify(value)); }
    catch (_) { throw new Error('No se pudo conservar la propuesta en esta pestaña. Habilita el almacenamiento del navegador o exporta tus resultados antes de continuar.'); }
    root.dispatchEvent(new CustomEvent('mgpc:workflow-change'));
  }
  function getContext() { return copy(read()?.context); }
  function identityMatches(item, context) {
    return item && context && item.ut?.key === context.ut.key && String(item.district) === String(context.district) && item.caseType === context.caseType;
  }
  function setContext(context) {
    if (!validContext(context) || !supported.includes(context.caseType)) throw new Error('Selecciona un distrito, una UT y un tipo de caso disponible.');
    const previous = read();
    const normalized = {...copy(context), district:String(+context.district), relatedUTs:copy(context.relatedUTs || []), caseId:context.caseId ?? null, newName:String(context.newName || '').trim()};
    const same = identityMatches(normalized, previous?.context) && normalized.newName === (previous.context.newName || '');
    const next = same ? previous : {version:2,draft:null,survey:null,territorial:null};
    next.context = same ? {...previous.context, ...normalized, relatedUTs:previous.context.relatedUTs || []} : normalized;
    write(next);
    return getContext();
  }
  function updateCase(patch) {
    const context = getContext();
    if (context) setContext({...context, ...copy(patch)});
  }
  function getDraft() {
    const value = read();
    return identityMatches(value?.draft,value?.context) ? copy(value.draft) : null;
  }
  function hasDraft() { return !!getDraft(); }
  function draftSignature(draft) {
    return JSON.stringify([draft?.geometries,draft?.relatedUTs || [],draft?.sectionChanges || [],draft?.newName || '']);
  }
  function saveDraft(draft) {
    const value = read();
    if (!identityMatches(draft,value?.context)) throw new Error('Los límites preparados no corresponden al caso seleccionado.');
    for (const name of ['original','proposed']) {
      if (!['Polygon','MultiPolygon'].includes(draft.geometries?.[name]?.type)) throw new Error('Faltan los límites originales o los propuestos.');
    }
    if (['division','inc_exc_manzanas'].includes(draft.caseType) && JSON.stringify(draft.geometries.original) === JSON.stringify(draft.geometries.proposed)) throw new Error('Primero modifica los límites de la propuesta.');
    if (draft.caseType === 'fusion' && !(draft.relatedUTs || []).some(ut => (ut.claveUT || ut.key) !== value.context.ut.key)) throw new Error('Selecciona al menos otra UT para la fusión.');
    if (draft.caseType === 'inc_exc_secciones' && !(draft.sectionChanges || []).length) throw new Error('Selecciona al menos una sección para incluir o quitar.');
    const unchanged = identityMatches(value.draft,value.context) && draftSignature(value.draft) === draftSignature(draft);
    const previousTime = Date.parse(value.draft?.preparedAt || '') || 0;
    value.draft = {...copy(draft),preparedAt:unchanged ? value.draft.preparedAt : new Date(Math.max(Date.now(), previousTime + 1)).toISOString()};
    value.context.relatedUTs = copy(draft.relatedUTs || []);
    if (!unchanged) {value.survey=null;value.territorial=null;}
    write(value);
    return getDraft();
  }
  function invalidateDraft() {
    const value=read();
    if (value) {value.draft=null;value.survey=null;value.territorial=null;write(value);}
  }
  function getSurvey() {
    const value=read(), draft=getDraft(), survey=value?.survey;
    return identityMatches(survey,value?.context) && draft && survey.draftPreparedAt===draft.preparedAt && Number.isFinite(survey.sample?.n) ? copy(survey) : null;
  }
  function hasSurvey() {return !!getSurvey();}
  function saveSurvey(snapshot,options={}) {
    const value=read(), draft=getDraft();
    if (!identityMatches(snapshot,value?.context) || !draft || snapshot.draftPreparedAt!==draft.preparedAt) throw new Error('La propuesta cambió. Vuelve a calcular la muestra con los límites actuales.');
    if (!Number.isFinite(snapshot.N) || snapshot.N<0 || !Number.isFinite(snapshot.sample?.n) || snapshot.sample.n<0) throw new Error('El resultado de encuestas está incompleto.');
    const previous=value.survey;
    value.survey=copy(snapshot);
    const restored=options.restoreTerritorial;
    const canRestore=restored?.ut?.key===snapshot.ut.key && String(restored.district)===String(snapshot.district) && restored.surveyAnalysisDate===snapshot.analysisDate;
    if (canRestore) value.territorial=copy(restored);
    else if (previous?.analysisDate!==snapshot.analysisDate) value.territorial=null;
    write(value);
    return true;
  }
  function invalidateSurvey() {
    const value=read();
    if (value?.survey || value?.territorial) {value.survey=null;value.territorial=null;write(value);}
  }
  function saveTerritorial(result) {
    const value=read(), survey=getSurvey();
    if (!survey) throw new Error('Primero calcula la muestra de esta propuesta.');
    value.territorial={...value.territorial,...copy(result),savedAt:new Date().toISOString(),surveyAnalysisDate:survey.analysisDate,district:value.context.district,ut:copy(value.context.ut),caseType:value.context.caseType};
    write(value);
  }
  const getTerritorial=()=>copy(read()?.territorial);
  function nextPath() {
    const context=getContext();
    if (!context || !supported.includes(context.caseType)) return paths.home;
    if (hasSurvey()) return paths.review;
    return hasDraft() || context.caseType==='nomenclatura' ? paths.survey : paths.proposal;
  }
  function redirectTo(path) {
    const target = new URL(path, base);
    const current = new URL(root.location.href);
    if (target.pathname === current.pathname) {
      // Una mezcla de archivos antiguos no debe convertir una guarda en un bucle.
      let notice = document.getElementById('workflow-route-error');
      if (!notice) {
        notice = document.createElement('section');
        notice.id = 'workflow-route-error';
        notice.className = 'workflow-route-error';
        notice.setAttribute('role', 'alert');
        const message = document.createElement('p');
        message.textContent = 'No se pudo abrir este paso. Vuelve al inicio para retomar tu propuesta con la versión actual.';
        const link = document.createElement('a');
        link.href = paths.home;
        link.textContent = 'Volver al inicio';
        notice.append(message, link);
        document.body.prepend(notice);
      }
      return;
    }
    root.location.replace(path);
  }
  function requireContext(stage) {
    const context=getContext();
    if (!context || !supported.includes(context.caseType)) {redirectTo(paths.home);return null;}
    if (stage==='proposal' || stage==='editor') {
      if (context.caseType==='nomenclatura') {redirectTo(paths.survey);return null;}
    } else if (stage==='survey') {
      if (!hasDraft() && context.caseType!=='nomenclatura') {redirectTo(paths.proposal);return null;}
    } else if (stage==='review' || stage==='territorial') {
      if (!hasSurvey()) {redirectTo(nextPath());return null;}
    }
    return context;
  }
  function renderHeader(stage) {
    let header=document.getElementById('workflow-header');
    if (!header) {header=document.createElement('header');header.id='workflow-header';document.body.prepend(header);}
    header.className='workflow-header';header.replaceChildren();
    const brand=document.createElement('a');brand.className='workflow-brand';brand.href=paths.home;
    const monogram=document.createElement('span');monogram.className='brand-mark';monogram.textContent='M';
    const title=document.createElement('span');title.innerHTML='<strong>MGPC</strong><small>Tu propuesta, paso a paso</small>';
    brand.append(monogram,title);header.append(brand);
    const nav=document.createElement('nav');nav.className='workflow-steps';nav.setAttribute('aria-label','Pasos de tu propuesta');
    const context=getContext();
    [['proposal',context?.caseType==='nomenclatura'?'Datos del caso':'Prepara la propuesta','1'],['survey','Calcula la muestra','2'],['review','Revisa y confirma','3']].forEach(([id,label,number])=>{
      const active=stage===id || (stage==='editor'&&id==='proposal') || (stage==='territorial'&&id==='review');
      const enabled=!!context && (id==='proposal' || (id==='survey'?(hasDraft()||context.caseType==='nomenclatura'):hasSurvey()));
      const item=document.createElement(enabled?'a':'span');
      item.className='workflow-step'+(active?' is-active':'')+(!enabled?' is-unavailable':'');
      if (enabled) item.href=id==='proposal'&&context.caseType==='nomenclatura'?paths.home:paths[id];else item.setAttribute('aria-disabled','true');
      if (active) item.setAttribute('aria-current','step');
      const badge=document.createElement('span');badge.textContent=number;item.append(badge,document.createTextNode(label));nav.append(item);
    });
    header.append(nav);
    if (context) {const info=document.createElement('a');info.className='workflow-context';info.href=paths.home;info.textContent='Distrito '+context.district.padStart(2,'0')+' · UT '+context.ut.key;info.title='Cambiar territorio o tipo de caso';header.append(info);}
    header.dataset.stage=stage;
  }
  root.addEventListener('mgpc:workflow-change',()=>{
    const header=document.getElementById('workflow-header');if(header)renderHeader(header.dataset.stage);
    const button=document.getElementById('btn-continuar-etapa2');if(button)button.disabled=!hasSurvey();
  });
  root.MGPCWorkflow=Object.freeze({paths,getContext,setContext,updateCase,getDraft,hasDraft,saveDraft,invalidateDraft,getSurvey,hasSurvey,saveSurvey,invalidateSurvey,saveTerritorial,getTerritorial,nextPath,requireContext,renderHeader});
})(window);
