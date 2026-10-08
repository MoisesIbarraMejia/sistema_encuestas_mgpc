/* Reparto orientativo de la muestra. No modifica la muestra ni escribe en la API. */
(function (root) {
  'use strict';
  const ui = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const number = value => Number(value).toLocaleString('es-MX', {maximumFractionDigits:2});
  const sectionKey = value => /^\d+$/.test(String(value ?? '').trim()) ? String(Number(value)) : String(value ?? '').trim();
  let snapshot=null, plan=null, map=null, heat=null, routes=null, version=0, mapObjects=[], labels=[], returnFocus=null;

  function nominal(properties) {
    const raw=properties?.LN ?? properties?.ln ?? properties?.Ln ?? properties?.lN;
    if (!['number','string'].includes(typeof raw) || String(raw).trim()==='' || !Number.isFinite(Number(raw)) || Number(raw)<0) {
      throw new Error('Falta una lista nominal válida. No se puede repartir la muestra con datos incompletos.');
    }
    return Number(raw);
  }
  function interiorPoint(geometry) {
    if (geometry.type==='Point') {
      const [lng,lat]=geometry.coordinates;
      if (!Number.isFinite(lng)||!Number.isFinite(lat)||Math.abs(lng)>180||Math.abs(lat)>90) throw new Error('Una ubicación del reparto no es válida.');
      return {lat,lng};
    }
    const parts=(geometry.type==='MultiPolygon'?geometry.coordinates:[geometry.coordinates]).map(coordinates=>turf.polygon(coordinates));
    const polygon=parts.sort((a,b)=>turf.area(b)-turf.area(a))[0];
    const box=turf.bbox(polygon);
    const candidates=[turf.centerOfMass(polygon),turf.centroid(polygon),turf.point([(box[0]+box[2])/2,(box[1]+box[3])/2])];
    let chosen=candidates.find(point=>turf.booleanPointInPolygon(point,polygon,{ignoreBoundary:true}));
    for (const steps of [8,16,32]) {
      if (chosen) break;
      for (let x=1;x<steps&&!chosen;x++) for (let y=1;y<steps&&!chosen;y++) {
        const point=turf.point([box[0]+(box[2]-box[0])*x/steps,box[1]+(box[3]-box[1])*y/steps]);
        if (turf.booleanPointInPolygon(point,polygon,{ignoreBoundary:true})) chosen=point;
      }
    }
    const [lng,lat]=(chosen || turf.pointOnFeature(polygon)).geometry.coordinates;
    return {lat,lng};
  }
  function units(features,kind,target,useSavedPercentage) {
    if (!Array.isArray(features)) throw new Error('No se recibieron los datos del reparto. Vuelve a calcular la muestra.');
    const rows=[], seen=new Map();
    for (const feature of features) {
      const p=feature.properties || {}, ln=nominal(p), section=sectionKey(p.seccion);
      const name=String(kind==='block'?p.manzana ?? '':kind==='section'?p.seccion ?? '':p.localidad ?? 'Sin nombre');
      if (!name || (kind!=='locality'&&!section)) throw new Error('Una zona no tiene número de manzana o sección. Revisa sus datos antes de repartir.');
      let geometry, percentage=100;
      if (kind==='locality') {
        if (feature.geometry?.type!=='Point') throw new Error('Una localidad no tiene una ubicación válida.');
        geometry=feature.geometry;
      } else {
        const source=Diff.toFeature(feature.geometry);
        const clipped=turf.intersect(source,target);
        if (!clipped) continue;
        geometry=clipped.geometry;
        const saved=p.porcentaje_afectado;
        percentage=useSavedPercentage && Number.isFinite(saved) ? saved : Diff.computeOverlapPercentage(feature.geometry,target);
        if (!Number.isFinite(percentage)||percentage<0||percentage>100) throw new Error('No se pudo determinar la parte afectada de una zona.');
      }
      if (percentage===0) continue;
      const position=interiorPoint(geometry);
      if (kind==='locality'&&!turf.booleanPointInPolygon(turf.point([position.lng,position.lat]),target)) {
        throw new Error('Una localidad considerada quedó fuera del área de cálculo. Vuelve a calcular la muestra para actualizar sus datos.');
      }
      const identifier=kind==='section'?section:kind==='block'?sectionKey(name):name;
      const key=kind+':'+section+':'+identifier+(kind==='locality'?':'+position.lng+','+position.lat:'');
      const fingerprint=JSON.stringify([ln,percentage,feature.geometry]);
      if (seen.has(key)) {
        if (seen.get(key)!==fingerprint) throw new Error('Hay registros distintos con la misma clave: '+name+'. Revisa esos datos antes de repartir.');
        continue;
      }
      seen.set(key,fingerprint);
      const weight=ln*percentage/100;
      rows.push({key,kind,name,section,ln,percentage,weight,capacity:Math.ceil(weight),position,geometry});
    }
    return rows;
  }
  function buildPlan(result,blockCollection) {
    const target=Diff.toFeature(result.geometries.affected);
    const blocks=units(blockCollection?.features,'block',target,!result.usaSecciones);
    const localities=units(result.localidadResult?.features,'locality',target,true);
    const primary=result.usaSecciones?units(result.seccionesResult?.features,'section',target,true):blocks;
    const expected=primary.concat(localities).reduce((sum,row)=>sum+row.weight,0);
    if (Math.abs(expected-result.N)>Math.max(0.000001,Math.abs(result.N)*0.000001)) {
      throw new Error('Los datos disponibles no corresponden a la población de esta muestra. Vuelve a calcular antes de repartir.');
    }
    const allocation=MGPCSurveyAllocation.allocate([...primary,...localities],result.sample.n);
    let rows=[], unassigned=allocation.unassigned;
    const missing=[];
    for (const row of allocation.rows) {
      if (row.kind!=='section') { rows.push(row);continue; }
      const sectionBlocks=blocks.filter(block=>block.section===row.section);
      const portion=MGPCSurveyAllocation.allocate(sectionBlocks,row.count);
      rows.push(...portion.rows.map(block=>({...block,sectionQuota:row.count})));
      unassigned+=portion.unassigned;
      if (portion.unassigned) missing.push('Sección '+row.name+': '+number(portion.unassigned)+' encuestas pendientes de ubicar en manzanas.');
    }
    rows.sort((a,b)=>b.count-a.count || a.section.localeCompare(b.section,'es',{numeric:true}) || a.name.localeCompare(b.name,'es',{numeric:true}));
    return {rows,total:allocation.total,assigned:rows.reduce((sum,row)=>sum+row.count,0),unassigned,missing,bySection:!!result.usaSecciones,
      area:clone(result.geometries.affected),analysisDate:result.analysisDate,ut:clone(result.ut)};
  }
  function clearMap() {
    routes?.clear();
    heat?.remove();heat=null;
    labels.forEach(label=>label.remove());labels=[];
    mapObjects.forEach(object=>object.setMap(null));mapObjects=[];
  }
  function clear() {
    snapshot=null;plan=null;version++;
    if (ui('distribution-dialog').open) ui('distribution-dialog').close();
    clearMap();
    ui('btn-survey-distribution').disabled=true;
  }
  function setResult(result) {
    const same=snapshot?.analysisDate===result.analysisDate && snapshot?.draftPreparedAt===result.draftPreparedAt;
    snapshot=clone(result);
    if (!same) {
      plan=null;version++;clearMap();
      if (ui('distribution-dialog').open) ui('distribution-dialog').close();
    }
    ui('btn-survey-distribution').disabled=false;
  }
  function focusRow(row) {
    map.panTo(row.position);
    map.setZoom(Math.max(map.getZoom() || 16,18));
    ui('distribution-selected').textContent=(row.kind==='locality'?'Localidad: ':'Manzana: ')+row.name+' · Sección: '+row.section+' · LN: '+number(row.ln)+' · Núm. encuestas: '+number(row.count);
  }
  function fitArea() {
    if (!map||!plan) return;
    const bounds=new google.maps.LatLngBounds();
    const polygons=plan.area.type==='MultiPolygon'?plan.area.coordinates:[plan.area.coordinates];
    polygons.forEach(rings=>rings.forEach(ring=>ring.forEach(([lng,lat])=>bounds.extend({lat,lng}))));
    if (!bounds.isEmpty()) map.fitBounds(bounds,65);
  }
  function paintMap() {
    clearMap();
    if (!map) map=new google.maps.Map(ui('distribution-map'),{center:CONFIG.MAP.center?{lat:CONFIG.MAP.center[0],lng:CONFIG.MAP.center[1]}:{lat:19.43,lng:-99.13},zoom:15,mapTypeControl:true,streetViewControl:false,fullscreenControl:false,gestureHandling:'greedy'});
    const area=new google.maps.Data({map});
    area.addGeoJson({type:'Feature',properties:{},geometry:plan.area});
    area.setStyle({strokeColor:'#4b2e83',strokeWeight:3,fillColor:'#4b2e83',fillOpacity:.035,clickable:false,zIndex:1});
    const blocks=new google.maps.Data({map});
    blocks.addGeoJson({type:'FeatureCollection',features:plan.rows.filter(row=>row.kind==='block').map(row=>({type:'Feature',properties:{key:row.key},geometry:row.geometry}))});
    blocks.setStyle({strokeColor:'#64748b',strokeWeight:1,strokeOpacity:.75,fillOpacity:0,clickable:true,zIndex:2});
    blocks.addListener('click',event=>{const row=plan.rows.find(item=>item.key===event.feature.getProperty('key'));if(row)focusRow(row);});
    mapObjects.push(area,blocks);
    const controller=MGPCMapLabels.forMap(map);
    for (const row of plan.rows) {
      const handle=controller.add({layer:row.kind,key:row.key,text:row.name,position:row.position,variant:'results',
        details:[{label:'Núm. encuestas',value:number(row.count)}],onClick:()=>focusRow(row)});
      if (!ui('distribution-labels').checked) handle.setMap(null);
      labels.push(handle);
    }
    heat=MGPCSurveyHeat.create(map,plan.rows.map(row=>({position:row.position,weight:row.count})));
    if (!ui('distribution-heat').checked) heat.setMap(null);
    if (!routes && root.MGPCSurveyRoutes) routes=root.MGPCSurveyRoutes.create({map,onSelect:focusRow});
    routes?.setPlan(plan);
    fitArea();
  }
  function renderPlan() {
    ui('distribution-status').textContent=plan.unassigned
      ? number(plan.assigned)+' de '+number(plan.total)+' encuestas ubicadas. Faltan datos para repartir '+number(plan.unassigned)+'. '+plan.missing.join(' ')
      : number(plan.assigned)+' de '+number(plan.total)+' encuestas distribuidas · UT '+plan.ut.key;
    ui('distribution-status').className=plan.unassigned?'distribution-status is-warning':'distribution-status';
    ui('distribution-method').textContent=plan.bySection
      ? 'Se conserva la cuota de cada sección y se reparte entre sus manzanas según la LN de la parte afectada. Las localidades mantienen su propia cuota.'
      : 'El reparto es proporcional a la LN de la parte afectada de cada manzana. Las localidades mantienen su propia cuota.';
    ui('distribution-selected').textContent='Selecciona una fila o una etiqueta para acercarte. Las etiquetas cercanas se agrupan.';
    const body=ui('distribution-rows');body.replaceChildren();
    for (const row of plan.rows) {
      const tr=document.createElement('tr');
      const name=document.createElement('td'),button=document.createElement('button');button.type='button';
      button.className='distribution-row-link';button.textContent=(row.kind==='locality'?'Localidad ':'Manzana ')+row.name;
      button.addEventListener('click',()=>focusRow(row));name.append(button);tr.append(name);
      for (const value of [row.section,number(row.ln),number(row.weight),number(row.count)]) {
        const cell=document.createElement('td');cell.textContent=value;tr.append(cell);
      }
      body.append(tr);
    }
    ui('distribution-total').textContent=number(plan.assigned);
    ui('distribution-count').textContent=plan.rows.filter(row=>row.kind==='block').length+' manzanas · '+plan.rows.filter(row=>row.kind==='locality').length+' localidades';
    ui('distribution-content').hidden=false;
    paintMap();
    ui('distribution-download').disabled=false;
    ui('distribution-fit').disabled=false;
  }
  async function open() {
    if (!snapshot) return;
    const dialog=ui('distribution-dialog');
    if (!dialog.open) {returnFocus=document.activeElement;dialog.showModal();}
    ui('distribution-title').focus();
    const request=++version, source=snapshot;
    ui('distribution-retry').hidden=true;
    ui('distribution-download').disabled=true;
    ui('distribution-fit').disabled=true;
    ui('distribution-status').className='distribution-status';
    ui('distribution-status').textContent='Preparando las manzanas y el reparto de encuestas…';
    try {
      if (!plan) {
        const blocks=source.usaSecciones
          ? await Api.intersect('manzana',{geometry:source.geometries.affected,bufferMeters:0,includePercentage:false})
          : source.manzanasResult;
        if (request!==version || !dialog.open) return;
        plan=buildPlan(source,blocks);
      }
      if (request!==version || !dialog.open) return;
      renderPlan();
    } catch (error) {
      if (request!==version || !dialog.open) return;
      clearMap();plan=null;ui('distribution-content').hidden=true;
      ui('distribution-download').disabled=true;ui('distribution-fit').disabled=true;
      ui('distribution-status').className='distribution-status is-warning';
      ui('distribution-status').textContent='No se pudo preparar el reparto. '+error.message;
      ui('distribution-retry').hidden=false;
    }
  }
  function download() {
    if (!plan) return;
    const cell=value=>{
      const text=String(value ?? '');
      const safe=/^[\s\u0000-\u001f]*[=+@\-]|^[\t\r\n]/.test(text)?"'"+text:text;
      return '"'+safe.replace(/"/g,'""')+'"';
    };
    const rows=[['Tipo','Sección','Manzana / localidad','LN','LN considerada','Encuestas'],
      ...plan.rows.map(row=>[row.kind==='locality'?'Localidad':'Manzana',row.section,row.name,row.ln,row.weight,row.count]),
      ['Total distribuido','','','','',plan.assigned],['Sin asignar','','','','',plan.unassigned],['Muestra total','','','','',plan.total]];
    const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='MGPC_reparto_'+plan.ut.key+'.csv';
    document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
  }
  ui('btn-survey-distribution').addEventListener('click',open);
  ui('distribution-close').addEventListener('click',()=>ui('distribution-dialog').close());
  ui('distribution-dialog').addEventListener('close',()=>{version++;clearMap();returnFocus?.focus();});
  ui('distribution-retry').addEventListener('click',open);
  ui('distribution-fit').addEventListener('click',fitArea);
  ui('distribution-download').addEventListener('click',download);
  ui('distribution-labels').addEventListener('change',event=>labels.forEach(label=>label.setMap(event.target.checked?map:null)));
  ui('distribution-heat').addEventListener('change',event=>heat?.setMap(event.target.checked?map:null));
  root.MGPCSurveyDistribution=Object.freeze({setResult,clear,open,buildPlan,interiorPoint});
})(window);
