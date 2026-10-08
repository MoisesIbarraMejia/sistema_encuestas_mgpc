/* Geometry operations and guided choices for the preparation step. No writes to the API. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  // Los límites compartidos traen diferencias de coma flotante: 10 decimales
  // (~0.01 mm) evita anillos degenerados al unirlos sin alterar el original.
  const feature = geometry => library().truncate({type:'Feature',properties:{},geometry},{precision:10,mutate:false});
  function library() {
    if (!root.turf) throw new Error('No se pudieron cargar las herramientas del mapa. Recarga la página para reintentar.');
    return root.turf;
  }
  function geometryError(reason, advice = 'Deshaz el último cambio y revisa los puntos del límite.') {
    return Object.assign(new Error(reason + (advice ? ' ' + advice : '')), {reason});
  }
  function validate(geometry) {
    const t = library();
    if (!geometry || !['Polygon','MultiPolygon'].includes(geometry.type)) throw geometryError('La propuesta debe conservar una zona con superficie.');
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length || !polygons.every(p => Array.isArray(p) && p.length && p.every(r =>
      Array.isArray(r) && r.length >= 4 && r.every(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90) &&
      r[0][0] === r[r.length-1][0] && r[0][1] === r[r.length-1][1] && new Set(r.slice(0,-1).map(c=>c[0]+','+c[1])).size >= 3))) {
      throw geometryError('El límite debe cerrar y conservar al menos tres puntos distintos.');
    }
    // Check the source coordinates before precision normalization. Snapping two
    // consecutive points together must not silently leave a zero-length edge.
    if (polygons.some(p => p.some(r => r.some((point,index) => index > 0 && point[0] === r[index-1][0] && point[1] === r[index-1][1])))) {
      throw geometryError('Hay dos puntos seguidos en el mismo lugar.', 'Deshaz el último cambio o quita uno de ellos.');
    }
    // Turf 6 kinks also reports a hole touching the exterior at one point.
    // Check each ring for self-crossings; validate relations between rings below.
    if (polygons.some(rings => rings.some(ring => t.kinks(feature({type:'Polygon',coordinates:[ring]})).features.length))) {
      throw geometryError('Hay líneas cruzadas en el límite.', 'Deshaz el último cambio y mueve los puntos de nuevo.');
    }
    const parts = polygons.map(coordinates => feature({type:'Polygon',coordinates}));
    const hasArea = polygon => polygon && t.area(polygon) > 0;
    for (const coordinates of polygons) {
      const exterior = feature({type:'Polygon',coordinates:[coordinates[0]]});
      if (!hasArea(exterior)) throw geometryError('Cada zona necesita un contorno con superficie.');
      const holes = coordinates.slice(1).map(ring => feature({type:'Polygon',coordinates:[ring]}));
      const boundaries = [exterior,...holes].map(polygon => t.lineString(polygon.geometry.coordinates[0]));
      let filled = exterior;
      for (let i = 0; i < holes.length; i++) {
        if (!hasArea(holes[i])) throw geometryError('Un límite interior quedó sin superficie.');
        if (hasArea(t.difference(holes[i],exterior))) {
          throw geometryError('Un límite interior salió de su zona.', 'Deshaz el último cambio y mantenlo dentro del contorno.');
        }
        for (let j = 0; j < i; j++) {
          if (hasArea(t.intersect(holes[i],holes[j]))) {
            throw geometryError('Dos zonas interiores se superponen.');
          }
        }
        for (let j = 0; j <= i; j++) {
          // lineOverlap defaults to zero tolerance: exact shared segments only.
          if (t.lineOverlap(boundaries[i+1],boundaries[j]).features.length) {
            throw geometryError('Dos límites de la misma zona comparten un tramo.');
          }
        }
        filled = filled && t.difference(filled,holes[i]);
      }
      // Several point contacts can disconnect the interior. A Polygon must
      // remain one connected filled area; never discard or silently join parts.
      if (!hasArea(filled) || (filled.geometry.type === 'MultiPolygon' && filled.geometry.coordinates.length > 1)) {
        throw geometryError('Los límites interiores separan la zona en partes desconectadas.');
      }
    }
    // Compare filled areas (respecting holes), so islands inside holes and
    // boundary contacts are accepted while overlapping MultiPolygon parts are not.
    for (let i = 0; i < parts.length; i++) {
      for (let j = 0; j < i; j++) {
        if (hasArea(t.intersect(parts[i],parts[j]))) {
          throw geometryError('Dos partes de la propuesta se superponen.');
        }
      }
    }
    if (!(t.area(feature(geometry)) > .01)) throw geometryError('La propuesta debe conservar una zona con superficie.');
    return geometry;
  }
  function changedArea(original, proposed) {
    const t = library();
    const a = t.difference(feature(original),feature(proposed));
    const b = t.difference(feature(proposed),feature(original));
    const affected = a && b ? t.union(a,b) : a || b;
    return {affected:affected?.geometry || null,area:affected ? t.area(affected) : 0};
  }
  function merge(original, selected, originalKey = '') {
    const t = library();
    const inputs = [{geometry:original,label:'la UT principal'+(originalKey?' '+originalKey:'')},
      ...selected.map(item=>({geometry:item.geometry,label:'la UT '+(item.key || item.claveUT || item.properties?.cve_ut || 'colindante')}))];
    for (const item of inputs) {
      try {validate(item.geometry);}
      catch (error) {
        throw new Error('No se puede preparar la fusión: '+item.label+' necesita revisión en sus datos de origen. '+
          (error.reason || error.message)+' Solicita revisar ese límite antes de unirlo.');
      }
    }
    try {
      let result=feature(original);
      for (const item of selected) result=t.union(result,feature(item.geometry));
      if (!result) throw new Error('La unión no devolvió una zona con superficie.');
      return validate(result.geometry);
    } catch (error) {
      throw new Error('No se pudo crear un límite válido al unir '+inputs.map(item=>item.label).join(' y ')+'. '+
        (error.reason || error.message)+' Revisa esta combinación de UT; se conserva la selección anterior.');
    }
  }
  function sections(original, changes) {
    const t = library();
    let result=feature(original);
    for (const change of changes.filter(c=>c.action==='include')) result=t.union(result,feature(change.feature.geometry));
    for (const change of changes.filter(c=>c.action==='exclude')) {
      result=result && t.difference(result,feature(change.feature.geometry));
    }
    if (!result) throw new Error('No puedes quitar toda la UT. Conserva al menos una zona.');
    return validate(result.geometry);
  }
  function prepareDraft(context, original, proposed, choices = {}) {
    validate(original); validate(proposed);
    const diff=changedArea(original,proposed);
    const originalArea=library().area(feature(original));
    if (diff.area < 1 || diff.area/originalArea < .00001) throw new Error('La propuesta aún conserva los mismos límites o el cambio es demasiado pequeño. Revisa los puntos antes de continuar.');
    const relatedUTs=choices.relatedUTs || [];
    const sectionChanges=choices.sectionChanges || [];
    if (context.caseType==='fusion' && !relatedUTs.some(u=>(u.key || u.claveUT)!==context.ut.key)) throw new Error('Selecciona al menos otra UT para unirla a la principal.');
    if (context.caseType==='inc_exc_secciones' && !sectionChanges.length) throw new Error('Selecciona una sección para incluirla o quitarla.');
    return {...copy(context), relatedUTs:copy(relatedUTs),sectionChanges:copy(sectionChanges),
      geometries:{original:copy(original),proposed:copy(proposed),affected:diff.affected},preparedAt:new Date().toISOString()};
  }

  async function create(options) {
    const {context,original,map,draft,onChange,onError}=options;
    const isFusion=context.caseType==='fusion';
    const panel=document.getElementById('proposal-choices');
    const list=document.getElementById('proposal-choice-list');
    const status=document.getElementById('proposal-choice-status');
    panel.hidden=false;
    document.getElementById('proposal-choice-title').textContent=isFusion?'Elige las UT que quieres unir':'Elige las secciones que cambiarán';
    document.getElementById('proposal-choice-description').textContent=isFusion
      ? 'La UT principal ya está incluida. Elige otra UT cercana en la lista o directamente en el mapa.'
      : 'Una sección electoral es una zona del mapa. Puedes incluirla completa o quitar la parte que está dentro de tu UT.';
    status.textContent='Cargando opciones cercanas…';
    const data=await Api.intersect(isFusion?'uts_mgpc':'secciones',{geometry:original,bufferMeters:20,includePercentage:!isFusion});
    const candidates=new Map();
    for (const item of data.features || []) {
      if (!item.geometry || !['Polygon','MultiPolygon'].includes(item.geometry.type)) continue;
      const key=String(isFusion ? item.properties?.cve_ut : item.properties?.seccion ?? '').trim();
      if (!key || key==='undefined' || (isFusion && key===context.ut.key)) continue;
      if (!candidates.has(key)) candidates.set(key,copy(item));
    }
    const selection=new Map(), history=[];
    for (const item of (isFusion ? draft?.relatedUTs : draft?.sectionChanges) || []) {
      const key=String(item.key || item.claveUT || item.seccion);
      if (candidates.has(key)) selection.set(key,isFusion?'include':item.action);
    }
    const layer=new google.maps.Data({map});
    layer.addGeoJson({type:'FeatureCollection',features:[...candidates].map(([key,item])=>({...item,properties:{...item.properties,choiceKey:key}}))});
    const controls=new Map();
    const inside=new Map();
    const sectionStyles={
      inside: {strokeColor:'#2563eb',strokeWeight:2,fillColor:'#2563eb',fillOpacity:.22},
      outside: {strokeColor:'#64748b',strokeWeight:1.5,fillColor:'#64748b',fillOpacity:.025},
      partial: {strokeColor:'#b7791f',strokeWeight:2,fillColor:'#f2b544',fillOpacity:.22},
      include: {strokeColor:'#117d76',strokeWeight:3,fillColor:'#117d76',fillOpacity:.28},
      exclude: {strokeColor:'#c44458',strokeWeight:3,fillColor:'#c44458',fillOpacity:.28}
    };
    const sectionState=key=>selection.get(key) || (inside.get(key)>.995?'inside':inside.get(key)>.005?'partial':'outside');
    const t=library();
    for (const [key,item] of candidates) {
      if (!isFusion) {
        const intersection=t.intersect(feature(original),feature(item.geometry));
        const total=t.area(item), overlap=intersection?t.area(intersection):0;
        inside.set(key,total>0?overlap/total:0);
      }
    }
    function result() {
      if (isFusion) {
        const relatedUTs=[...selection.keys()].map(key=>{
          const f=candidates.get(key); return {key,claveUT:key,name:f.properties?.nombreut || f.properties?.nombre || key,geometry:copy(f.geometry),properties:copy(f.properties || {})};
        });
        return {geometry:merge(original,relatedUTs,context.ut.key),relatedUTs,sectionChanges:[]};
      }
      const sectionChanges=[...selection].map(([key,action])=>({key,seccion:key,action,feature:copy(candidates.get(key))}));
      return {geometry:sections(original,sectionChanges),sectionChanges,relatedUTs:[]};
    }
    function paint() {
      for (const [key,control] of controls) {
        if (isFusion) control.input.checked=selection.has(key); else control.input.value=selection.get(key) || '';
        control.card.classList.toggle('is-selected',selection.has(key));
        if (!isFusion) {
          const state=sectionState(key);
          control.card.dataset.sectionState=state;
          control.card.style.setProperty('--section-choice-color',sectionStyles[state].strokeColor);
          control.meta.textContent=control.originalDescription+(state==='include'?' · Se incluirá completa.':state==='exclude'?' · Se quitará de la UT.':'');
        }
      }
      layer.setStyle(f=>{
        const key=f.getProperty('choiceKey');
        if (!isFusion) return {...sectionStyles[sectionState(key)],strokeOpacity:.95,zIndex:60,clickable:true};
        return {strokeColor:selection.has(key)?'#117d76':'#7B2CBF',strokeWeight:selection.has(key)?3:1.5,
          fillColor:selection.has(key)?'#117d76':'#7B2CBF',fillOpacity:selection.has(key)?.25:.09,zIndex:60,clickable:true};
      });
      status.textContent=candidates.size ? selection.size+' '+(isFusion?'UT adicionales seleccionadas':'secciones con cambios') : 'No se encontraron opciones cercanas. Vuelve al inicio para revisar la UT elegida.';
    }
    function apply(key,value) {
      const before=[...selection];
      if (value) selection.set(key,value); else selection.delete(key);
      try {
        const next=result();
        history.push(before); paint(); onChange(next);
      } catch(error) {selection.clear();before.forEach(([k,v])=>selection.set(k,v));paint();onError(error);}
    }
    list.replaceChildren();
    for (const [key,item] of [...candidates].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}))) {
      const card=document.createElement('label');card.className='proposal-choice';
      const label=document.createElement('span');label.className='proposal-choice-copy';
      const title=document.createElement('strong');title.textContent=isFusion ? key+' · '+(item.properties?.nombreut || item.properties?.nombre || 'Unidad Territorial') : 'Sección '+key;
      const meta=document.createElement('span');meta.className='proposal-choice-meta';
      meta.textContent=isFusion?'Selecciona para unir a la UT principal':inside.get(key)>.995?'Actualmente dentro de la UT':inside.get(key)>.005?'Una parte está dentro de la UT':'Actualmente fuera de la UT';
      label.append(title,meta);
      const input=document.createElement(isFusion?'input':'select');
      input.setAttribute('aria-label',isFusion?'Unir UT '+key:'Cambio para sección '+key);
      if (isFusion) {input.type='checkbox';input.addEventListener('change',()=>apply(key,input.checked?'include':''));}
      else {
        for (const [value,text] of [['','Sin cambio'],...(inside.get(key)<.995?[['include','Incluir completa']]:[]),...(inside.get(key)>.005?[['exclude','Quitar de la UT']]:[])]) {
          const option=document.createElement('option');option.value=value;option.textContent=text;input.append(option);
        }
        input.addEventListener('change',()=>apply(key,input.value));
      }
      card.append(input,label);list.append(card);controls.set(key,{input,card,meta,originalDescription:meta.textContent});
    }
    function toggleChoice(key) {
      key=String(key);
      if (!candidates.has(key)) return;
      const value=selection.has(key)?'':isFusion?'include':inside.get(key)>.995?'exclude':'include';
      apply(key,value);
      controls.get(key)?.input.focus();
    }
    layer.addListener('click',event=>toggleChoice(event.feature.getProperty('choiceKey')));
    function candidateFeatures() {
      return [...candidates].map(([key,item])=> {
        const result=copy(item);
        if (!isFusion) {
          // El buffer sirve para descubrir candidatos. La pertenencia se mide
          // contra la UT ORIGINAL, también para la información y sus etiquetas.
          result.porcentaje_afectado=(inside.get(key) || 0)*100;
          result.properties.porcentaje_afectado=result.porcentaje_afectado;
        }
        return result;
      });
    }
    function referenceFeatures() {
      const references=candidateFeatures();
      if (isFusion) references.unshift({type:'Feature',properties:{...copy(context.ut.properties || {}),cve_ut:context.ut.key,nombre:context.ut.name},geometry:copy(original)});
      return references;
    }
    paint();
    if (selection.size) onChange(result());
    return {getResult:result,getCandidateFeatures:candidateFeatures,getReferenceFeatures:referenceFeatures,
      ensureVisible(){layer.setMap(map);},toggleChoice,hasChanges:()=>selection.size>0,canUndo:()=>history.length>0,
      undo(){if(!history.length)return;selection.clear();history.pop().forEach(([k,v])=>selection.set(k,v));paint();onChange(result());},
      reset(){history.push([...selection]);selection.clear();paint();onChange(result());}};
  }
  root.ProposalChoices=Object.freeze({validate,changedArea,merge,sections,prepareDraft,create});
})(window);
