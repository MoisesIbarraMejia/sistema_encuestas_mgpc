/* Recorridos sugeridos de campo: orden local y trazado opcional por calles. */
(function(root) {
  'use strict';
  const ui=id=>document.getElementById(id);
  const num=value=>Number(value).toLocaleString('es-MX',{maximumFractionDigits:2});
  const title=stop=>(stop.kind==='locality'?'Localidad ':'Manzana ')+stop.name;
  const description=stop=>title(stop)+' · Sección '+stop.section+' · '+num(stop.count)+' encuestas';
  const distance=value=>value<1000?num(Math.round(value))+' m':num(value/1000)+' km';
  const ROUTE_COLOR='#087f8c';
  function csvCell(value) {
    const text=String(value ?? '');
    const safe=/^[\s\u0000-\u001f]*[=+@\-]|^[\t\r\n]/.test(text)?"'"+text:text;
    return '"'+safe.replace(/"/g,'""')+'"';
  }
  function create({map,onSelect}) {
    let rows=[], unassigned=0, route=null, road=null, lines=[], version=0, utKey='';
    let selectedTab='data';
    let animationFrame=null, motionWanted=true, playback=null, progress=0, previewFrame=null;
    let overviewLines=[],trailLines=[],arrowLayer=null,arrowFeature=null;
    const reducedMotion=root.matchMedia?.('(prefers-reduced-motion: reduce)');
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
    function stopMotion() {
      if(animationFrame!==null)root.cancelAnimationFrame?.(animationFrame);
      animationFrame=null;
    }
    function syncMotion() {
      stopMotion();
      const button=ui('route-motion');
      const available=playback?.totalMeters>0&&ui('route-view').value!=='overview'&&!reducedMotion?.matches&&typeof root.requestAnimationFrame==='function';
      const running=available&&motionWanted&&!document.hidden;
      button.disabled=!available;
      button.setAttribute('aria-pressed',String(running));
      button.textContent=reducedMotion?.matches?'Movimiento reducido':running?'Pausar':progress>=1?'Reproducir de nuevo':'Reproducir';
      if(!running)return;
      let lastTick=null;
      // Preview duration is deliberately unrelated to the estimated field time.
      const duration=Math.max(30000,Math.min(90000,playback.totalMeters*10));
      function tick(time) {
        animationFrame=null;
        if(!motionWanted||document.hidden||reducedMotion?.matches||!playback||ui('route-view').value==='overview')return;
        if(lastTick===null)lastTick=time;
        if(time-lastTick>=80) {
          progress=Math.min(1,progress+Math.min(time-lastTick,200)/duration);
          lastTick=time;
          renderFrame();
          if(progress>=1) {motionWanted=false;syncMotion();return;}
        }
        animationFrame=root.requestAnimationFrame(tick);
      }
      animationFrame=root.requestAnimationFrame(tick);
    }
    function clearLines() {
      stopMotion();playback=null;previewFrame=null;progress=0;
      lines.forEach(line=>line.setMap(null));lines=[];
      overviewLines=[];trailLines=[];
      arrowLayer?.setMap(null);arrowLayer=null;arrowFeature=null;
      ui('route-map-key').hidden=true;
      ui('route-playback').hidden=true;
      ['route-progress','route-restart','route-focus','route-view'].forEach(id=>{ui(id).disabled=true;});
      syncMotion();
    }
    function renderFrame() {
      if(!playback)return;
      const latitude=previewFrame?.head?.lat ?? route.stops[0].position.lat;
      const metersPerPixel=156543.03392*Math.cos(latitude*Math.PI/180)/2**(map.getZoom()||16);
      previewFrame=MGPCSurveyRoutePlayback.frame(playback,progress,Math.max(12,Math.min(150,metersPerPixel*70)));
      trailLines.forEach(line=>line.set('path',previewFrame.path));
      if(previewFrame.head&&arrowFeature) {
        arrowFeature.setGeometry(new google.maps.Data.Point(previewFrame.head));
        arrowLayer.setStyle({clickable:false,zIndex:60,title:'Dirección del recorrido (vista previa)',
          icon:{path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:4.5,rotation:previewFrame.bearing,strokeColor:'#ffffff',strokeWeight:2,strokeOpacity:1,fillColor:ROUTE_COLOR,fillOpacity:1}});
      }
      const percent=Math.round(progress*100)+' %';
      ui('route-progress').value=String(Math.round(progress*1000));
      ui('route-progress').setAttribute('aria-valuetext',percent+' del recorrido en la vista previa');
      ui('route-progress-label').textContent=percent;
    }
    function updateView() {
      if(!playback)return;
      const overview=ui('route-view').value==='overview';
      overviewLines.forEach(line=>line.setMap(overview?map:null));
      trailLines.forEach(line=>line.setMap(overview?null:map));
      arrowLayer?.setMap(overview?null:map);
      ui('route-progress').disabled=overview||!playback.totalMeters;
      ui('route-restart').disabled=overview||!playback.totalMeters;
      ui('route-focus').disabled=overview||!previewFrame?.head;
      ui('route-map-kind').textContent=overview?'Recorrido completo por calles':'Recorrido por calles · vista previa';
      syncMotion();
    }
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
    function draw(paths,street) {
      clearLines();
      function addLine(options,group) {
        const line=new google.maps.Polyline({map,clickable:false,...options});
        lines.push(line);group?.push(line);return line;
      }
      paths.forEach((path,index)=>{
        if(path.length<2) return;
        const base={path,geodesic:!street};
        const dash=(color,scale)=>({icon:{path:'M 0,-1 0,1',strokeColor:color,strokeOpacity:1,strokeWeight:2,scale},offset:'0',repeat:'14px'});
        // The complete view has no repeated arrows and stays hidden in playback mode.
        addLine({...base,strokeColor:'#ffffff',strokeOpacity:street ? .85 : 0,strokeWeight:6,zIndex:30,icons:street?[]:[dash('#ffffff',3.5)]},overviewLines);
        addLine({...base,strokeColor:ROUTE_COLOR,strokeOpacity:street ? .8 : 0,strokeWeight:3,zIndex:31,icons:street?[]:[dash(ROUTE_COLOR,2)]},overviewLines);
        const endpoints=[];
        if(index===0) endpoints.push({icon:{path:google.maps.SymbolPath.CIRCLE,scale:7,fillColor:'#117d76',fillOpacity:1,strokeColor:'#fff',strokeOpacity:1,strokeWeight:2.5},offset:'0'});
        if(index===paths.length-1&&!route.roundTrip) endpoints.push({icon:{path:'M -1,-1 L 1,-1 L 1,1 L -1,1 Z',scale:6,fillColor:'#c75b45',fillOpacity:1,strokeColor:'#fff',strokeOpacity:1,strokeWeight:2.5},fixedRotation:true,offset:'100%'});
        if(endpoints.length)addLine({...base,strokeOpacity:0,zIndex:40,icons:endpoints});
      });
      const key=ui('route-map-key');key.hidden=!lines.length;
      key.classList.toggle('is-direct',!street);key.classList.toggle('is-loop',route.roundTrip);
      ui('route-map-kind').textContent=street?'Recorrido por calles':'Orden orientativo · sin calles';
      ui('route-map-end').textContent=route.roundTrip?'Regreso al inicio':'Fin';
      if(street) {
        playback=MGPCSurveyRoutePlayback.prepare(paths);
        addLine({path:[],strokeColor:'#ffffff',strokeOpacity:.95,strokeWeight:8,zIndex:45},trailLines);
        addLine({path:[],strokeColor:ROUTE_COLOR,strokeOpacity:1,strokeWeight:4.5,zIndex:46},trailLines);
        arrowLayer=new google.maps.Data({map});
        const head=paths.find(path=>path.length)?.[0];
        if(head) [arrowFeature]=arrowLayer.addGeoJson({type:'Feature',properties:{role:'route-preview'},geometry:{type:'Point',coordinates:[head.lng,head.lat]}});
        ui('route-playback').hidden=false;ui('route-view').disabled=false;
        renderFrame();updateView();
        ui('distribution-route-panel').scrollTop=0;
      }
      const bounds=new google.maps.LatLngBounds();
      paths.forEach(path=>path.forEach(point=>bounds.extend(point)));
      route.stops.forEach(stop=>bounds.extend(stop.position));
      if(!bounds.isEmpty())map.fitBounds(bounds,70);
    }
    function renderSummary() {
      const summary=ui('route-summary');summary.replaceChildren();summary.hidden=false;
      const texts=[route.stops.length+' paradas · '+num(route.stops.reduce((sum,stop)=>sum+stop.count,0))+' encuestas por aplicar',
        road?'Recorrido por calles: '+distance(road.distanceMeters)+' · '+num(Math.ceil(road.durationSeconds/60))+' min de traslado.':
          'Distancia entre puntos: '+distance(route.distanceMeters)+' en línea directa; no es distancia por calles.',
        route.roundTrip?'Regresa al punto de inicio.':'Termina en la última parada.'];
      if(road)texts.push('El tiempo de traslado no incluye la aplicación de encuestas.');
      if(unassigned)texts.push(num(unassigned)+' encuestas sin asignar quedan pendientes de incorporar al recorrido.');
      texts.forEach(text=>{const p=document.createElement('p');p.textContent=text;summary.append(p);});
    }
    function renderStops() {
      const list=ui('route-stops');list.replaceChildren();
      route.stops.forEach(stop=>{
        const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='distribution-row-link';
        button.textContent=description(stop);button.addEventListener('click',()=>onSelect(stop));li.append(button);list.append(li);
      });
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
        if (!route.stops.length) {status('No hay manzanas con encuestas asignadas.');return;}
        const path=route.stops.map(stop=>stop.position);
        if(route.roundTrip&&path.length>1)path.push({...path[0]});
        draw([path],false);renderSummary();renderStops();
        ui('route-clear').disabled=false;ui('route-download').disabled=false;
        if(route.stops.length<2) {status('Solo hay una parada: todas las encuestas están en esa zona.');return;}
        status('Orden sugerido listo. Consultando el recorrido por calles…');
        ui('route-generate').disabled=true;
        try {
          const result=await MGPCSurveyRouteService.compute(route.stops,{...settings,travelMode:settings.travelMode.toUpperCase(),isCurrent:()=>request===version});
          if(request!==version)return;
          road=result;draw(result.segments.map(segment=>segment.path),true);renderSummary();
          const warnings=ui('route-warnings');warnings.replaceChildren();
          result.warnings.forEach(text=>{const item=document.createElement('li');item.textContent=text;warnings.append(item);});
          warnings.hidden=!result.warnings.length;
          status(settings.strategy==='workload'?'Recorrido por calles listo, priorizando zonas con más encuestas.':'Recorrido por calles listo siguiendo el orden sugerido por proximidad.');
        } catch(error) {
          if(request!==version)return;
          road=null;draw([path],false);renderSummary();
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
        ...route.stops.map(stop=>[stop.order,stop.kind==='locality'?'Localidad':'Manzana',stop.name,stop.section,stop.count,stop.position.lat,stop.position.lng]),
        ['Regresar al inicio',route.roundTrip?'Sí':'No'],['Transporte',route.travelMode==='walking'?'A pie':'En vehículo'],
        [road?'Distancia por calles (m)':'Distancia en línea directa (m)',road?road.distanceMeters:route.distanceMeters],
        ['Tiempo de traslado por calles (min)',road?Math.ceil(road.durationSeconds/60):'Sin datos'],['Encuestas pendientes de asignar',unassigned]];
      const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download='MGPC_recorrido_'+utKey+'.csv';document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
    }
    controls.forEach(id=>ui(id).addEventListener('change',()=>reset('Opciones actualizadas. Pulsa «Proponer recorrido» para aplicarlas.')));
    ui('route-motion').addEventListener('click',()=>{
      if(progress>=1){progress=0;motionWanted=true;renderFrame();}else motionWanted=!motionWanted;
      syncMotion();
    });
    ui('route-view').addEventListener('change',updateView);
    ui('route-progress').addEventListener('input',()=>{
      progress=Math.max(0,Math.min(1,Number(ui('route-progress').value)/1000));motionWanted=false;renderFrame();syncMotion();
    });
    ui('route-restart').addEventListener('click',()=>{progress=0;motionWanted=true;renderFrame();syncMotion();});
    ui('route-focus').addEventListener('click',()=>{if(previewFrame?.head)map.panTo(previewFrame.head);});
    map.addListener('zoom_changed',renderFrame);
    document.addEventListener('visibilitychange',syncMotion);
    reducedMotion?.addEventListener('change',syncMotion);
    ui('route-generate').addEventListener('click',generate);
    ui('route-clear').addEventListener('click',()=>reset());
    ui('route-download').addEventListener('click',download);
    return Object.freeze({setPlan,clear});
  }
  root.MGPCSurveyRoutes=Object.freeze({create});
})(window);
