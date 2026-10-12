/* Recorridos sugeridos de campo: orden local y trazado opcional por calles. */
(function(root) {
  'use strict';
  const ui=id=>document.getElementById(id);
  const num=value=>Number(value).toLocaleString('es-MX',{maximumFractionDigits:2});
  const title=stop=>(stop.kind==='locality'?'Localidad ':'Manzana ')+stop.name;
  const description=stop=>title(stop)+' · Sección '+stop.section+' · '+num(stop.count)+' encuestas';
  const distance=value=>value<1000?num(Math.round(value))+' m':num(value/1000)+' km';
  function csvCell(value) {
    const text=String(value ?? '');
    const safe=/^[\s\u0000-\u001f]*[=+@\-]|^[\t\r\n]/.test(text)?"'"+text:text;
    return '"'+safe.replace(/"/g,'""')+'"';
  }
  function create({map,onSelect}) {
    let rows=[], unassigned=0, route=null, road=null, version=0, utKey='';
    let selectedTab='data';
    let stopButtons=[];
    const viewer=MGPCSurveyRouteView.create({map,onSelection:highlightStop});
    function highlightStop(key) {
      stopButtons.forEach(button=>{
        if(button.dataset.stopKey===key)button.setAttribute('aria-current','step');
        else button.removeAttribute('aria-current');
      });
    }
    const controls=['route-start','route-strategy','route-mode','route-roundtrip'];
    function tab(value,focus=false) {
      selectedTab=value;
      for (const id of ['data','route']) {
        const active=id===value,button=ui('distribution-tab-'+id);
        button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
        ui('distribution-'+id+'-panel').hidden=!active;
        if(active&&focus)button.focus();
      }
    }
    for (const id of ['data','route']) {
      ui('distribution-tab-'+id).addEventListener('click',()=>tab(id));
      ui('distribution-tab-'+id).addEventListener('keydown',event=>{
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        tab(event.key==='Home'?'data':event.key==='End'?'route':selectedTab==='data'?'route':'data',true);
      });
    }
    function clearLines() {viewer.clear();}
    function status(message) {ui('route-status').textContent=message;}
    function reset(message='Elige las opciones y pulsa «Proponer recorrido».') {
      version++;route=null;road=null;clearLines();
      ui('route-summary').hidden=true;ui('route-summary').replaceChildren();
      ui('route-warnings').hidden=true;ui('route-warnings').replaceChildren();
      ui('route-stops').replaceChildren();ui('route-links').replaceChildren();
      ui('route-generate').disabled=!rows.some(row=>row.count>0);
      ui('route-clear').disabled=true;ui('route-download').disabled=true;
      status(message);
    }
    function clear() {
      rows=[];unassigned=0;utKey='';reset('Calcula la distribución para planear un recorrido.');
      controls.forEach(id=>{ui(id).disabled=true;});
    }
    function setPlan(plan) {
      rows=plan.rows.map(row=>({...row,position:{...row.position}}));
      unassigned=plan.unassigned;utKey=plan.ut.key;
      const input=ui('route-start'),previous=input.value;
      input.replaceChildren();
      const automatic=document.createElement('option');automatic.value='auto';automatic.textContent='Elegir inicio por cercanía';input.append(automatic);
      rows.filter(row=>row.count>0).sort((a,b)=>a.section.localeCompare(b.section,'es',{numeric:true})||a.name.localeCompare(b.name,'es',{numeric:true})).forEach(row=>{
        const option=document.createElement('option');option.value=row.key;option.textContent=description(row);input.append(option);
      });
      input.value=rows.some(row=>row.key===previous&&row.count>0)?previous:'auto';
      const available=rows.some(row=>row.count>0);
      controls.forEach(id=>{ui(id).disabled=!available;});
      reset(available?'Elige el inicio y cómo prefieres recorrer las manzanas.':'No hay encuestas asignadas que requieran un recorrido.');
      tab('data');
    }
    function options() {
      return {startKey:ui('route-start').value==='auto'?undefined:ui('route-start').value,
        strategy:ui('route-strategy').value||'short',travelMode:ui('route-mode').value||'walking',roundTrip:ui('route-roundtrip').checked};
    }
    function draw(paths,street) {viewer.setRoute({route,road,paths,street});}
    function renderSummary() {
      const summary=ui('route-summary');summary.replaceChildren();summary.hidden=false;
      const texts=[route.stops.length+' paradas · '+num(route.stops.reduce((sum,stop)=>sum+stop.count,0))+' encuestas por aplicar',
        'Traslado: '+(route.travelMode==='driving'?'en vehículo.':'a pie.'),
        road?'Recorrido por calles: '+distance(road.distanceMeters)+' · '+num(Math.ceil(road.durationSeconds/60))+' min de traslado.':
          'Distancia entre puntos: '+distance(route.distanceMeters)+' en línea directa; no es distancia por calles.',
        route.roundTrip?'Regresa al punto de inicio.':'Termina en la última parada.'];
      if(road)texts.push('El tiempo de traslado no incluye la aplicación de encuestas.');
      if(road?.optimization?.status==='improved') {
        const saved=road.optimization.savedMeters;
        texts.push(saved>=1?'Visitas reordenadas por calles: '+distance(saved)+' menos que el recorrido inicial.':'Se mejoró el orden de visitas manteniendo la distancia del recorrido.');
      } else if(road?.optimization?.status==='unchanged') {
        texts.push('Se conservó el orden inicial: la alternativa no mejoró los criterios del recorrido.');
      }
      if(road?.optimization?.nativeStatus==='improved')texts.push('Orden mejorado con Google según la forma de traslado elegida.');
      else if(road?.optimization?.nativeStatus==='unchanged')texts.push('También se comparó el orden sugerido por Google y se conservó el mejor resultado.');
      if(unassigned)texts.push(num(unassigned)+' encuestas sin asignar quedan pendientes de incorporar al recorrido.');
      texts.forEach(text=>{const p=document.createElement('p');p.textContent=text;summary.append(p);});
    }
    function renderStops() {
      const list=ui('route-stops');list.replaceChildren();stopButtons=[];
      route.stops.forEach(stop=>{
        const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='distribution-row-link';
        button.textContent=description(stop);button.dataset.stopKey=stop.key;stopButtons.push(button);
        button.addEventListener('click',()=>{if(!viewer.selectStop(stop.key))onSelect(stop);});li.append(button);list.append(li);
      });
      highlightStop(viewer.currentStopKey());
      const links=ui('route-links');links.replaceChildren();
      const groups=MGPCSurveyRoutePlan.segmentLinks(route.stops,{roundTrip:route.roundTrip,travelMode:route.travelMode});
      if(groups.length) {
        const heading=document.createElement('p');heading.textContent='Abrir indicaciones en Google Maps por tramos:';links.append(heading);
        groups.forEach((group,index)=>{
          const link=document.createElement('a');link.href=group.url;link.target='_blank';link.rel='noopener noreferrer';
          link.textContent='Tramo '+(index+1)+' · paradas '+group.fromOrder+' a '+group.toOrder+(group.roundTrip?' (regreso)':'');
          links.append(link);
        });
      }
    }
    async function generate() {
      const settings=options();reset();
      const request=version;
      try {
        route={...MGPCSurveyRoutePlan.plan(rows,settings),travelMode:settings.travelMode};
        const plannedRoute=route;
        if (!route.stops.length) {status('No hay manzanas con encuestas asignadas.');return;}
        const path=route.stops.map(stop=>stop.position);
        if(route.roundTrip&&path.length>1)path.push({...path[0]});
        draw([path],false);renderSummary();renderStops();
        ui('route-clear').disabled=false;ui('route-download').disabled=false;
        if(route.stops.length<2) {status('Solo hay una parada: todas las encuestas están en esa zona.');return;}
        status('Orden sugerido listo. Consultando el recorrido por calles…');
        ui('route-generate').disabled=true;
        try {
          const result=await MGPCSurveyRouteService.compute(route.stops,{...settings,improve:true,optimizeWithGoogle:true,travelMode:settings.travelMode.toUpperCase(),isCurrent:()=>request===version,
            onProgress:message=>{if(request===version)status(message);}});
          if(request!==version)return;
          if(result.stops)route={...route,stops:result.stops};
          road=result;draw(result.segments.map(segment=>segment.path),true);renderSummary();renderStops();
          const warnings=ui('route-warnings');warnings.replaceChildren();
          result.warnings.forEach(text=>{const item=document.createElement('li');item.textContent=text;warnings.append(item);});
          warnings.hidden=!result.warnings.length;
          status(result.optimization?.status==='improved'?'Recorrido por calles listo con el orden de visitas revisado.':settings.strategy==='workload'?'Recorrido por calles listo, priorizando zonas con más encuestas.':'Recorrido por calles listo.');
        } catch(error) {
          if(request!==version)return;
          route=plannedRoute;road=null;draw([path],false);renderSummary();renderStops();
          status('Se conserva el orden sugerido con líneas punteadas. No se pudo consultar el recorrido por calles. Puedes abrir los tramos en Google Maps.');
          const warnings=ui('route-warnings');warnings.replaceChildren();
          const item=document.createElement('li');item.textContent=error.message;warnings.append(item);warnings.hidden=false;
        } finally {if(request===version)ui('route-generate').disabled=false;}
      } catch(error) {
        if(request!==version)return;
        reset('No se pudo proponer el recorrido: '+error.message);
      }
    }
    function download() {
      if(!route)return;
      const rows=[['Orden','Tipo','Manzana / localidad','Sección','Encuestas','Latitud','Longitud'],
        ...route.stops.map(stop=>{const point=stop.routePosition||stop.position;return [stop.order,stop.kind==='locality'?'Localidad':'Manzana',stop.name,stop.section,stop.count,point.lat,point.lng];}),
        ['Regresar al inicio',route.roundTrip?'Sí':'No'],['Transporte',route.travelMode==='walking'?'A pie':'En vehículo'],
        [road?'Distancia por calles (m)':'Distancia en línea directa (m)',road?road.distanceMeters:route.distanceMeters],
        ['Tiempo de traslado por calles (min)',road?Math.ceil(road.durationSeconds/60):'Sin datos'],['Encuestas pendientes de asignar',unassigned]];
      const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download='MGPC_recorrido_'+utKey+'.csv';document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
    }
    controls.forEach(id=>ui(id).addEventListener('change',()=>reset('Opciones actualizadas. Pulsa «Proponer recorrido» para aplicarlas.')));
    ui('route-generate').addEventListener('click',generate);
    ui('route-clear').addEventListener('click',()=>reset());
    ui('route-download').addEventListener('click',download);
    return Object.freeze({setPlan,clear});
  }
  root.MGPCSurveyRoutes=Object.freeze({create});
})(window);
