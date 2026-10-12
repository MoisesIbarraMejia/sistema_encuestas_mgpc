/* Static route inspector: one actual street leg at a time, no animation. */
(function(root) {
  'use strict';
  const ui=id=>document.getElementById(id);
  const name=stop=>(stop.kind==='locality'?'Localidad ':'Manzana ')+stop.name;
  const caption=stop=>name(stop)+' · Sección '+stop.section;
  const number=value=>Number(value).toLocaleString('es-MX',{maximumFractionDigits:2});
  const meters=value=>value<1000?number(Math.round(value))+' m':number(value/1000)+' km';
  const time=value=>Number.isFinite(value)?value<60?'menos de 1 min':number(Math.ceil(value/60))+' min':'tiempo no disponible';
  const pointValid=p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
  const position=stop=>stop.routePosition||stop.position;
  function create({map,onSelection=()=>{}}) {
    let route=null,road=null,paths=[],legs=[],index=0,street=false;
    let lines=[],overview=[],active=[],pins=null;
    const isOverview=()=>ui('route-view').value==='overview'||!legs.length;
    function currentStopKey() {return !isOverview()&&legs[index]?legs[index].to.key:null;}
    function clear() {
      lines.forEach(line=>line.setMap(null));lines=[];overview=[];active=[];
      pins?.setMap(null);pins=null;
      route=null;road=null;paths=[];legs=[];index=0;
      ui('route-inspector').hidden=true;ui('route-map-key').hidden=true;
      ui('route-leg-directions').hidden=true;ui('route-leg-directions').removeAttribute('href');
      ['route-view','route-leg-select','route-prev','route-next','route-focus'].forEach(id=>{ui(id).disabled=true;});
      ui('route-leg-select').replaceChildren();
      onSelection(null);
    }
    function collectLegs() {
      const expected=route.stops.length-1+(route.roundTrip&&route.stops.length>1?1:0);
      if(!street||!Array.isArray(road?.legs)||road.legs.length!==expected)return [];
      const result=[];
      for(let i=0;i<expected;i++) {
        const source=road.legs[i],from=route.stops[i],to=route.stops[(i+1)%route.stops.length];
        if(!source||source.fromKey!==from.key||source.toKey!==to.key||!Array.isArray(source.path)||!source.path.length||
          !source.path.every(pointValid)||!Number.isFinite(source.distanceMeters)||source.distanceMeters<0)return [];
        result.push({...source,from,to,path:source.path.map(p=>({lat:p.lat,lng:p.lng})),returning:i===route.stops.length-1});
      }
      return result;
    }
    function showPins(from,to,start,end) {
      pins.forEach(feature=>pins.remove(feature));
      const shared=Math.abs(start.lat-end.lat)<1e-8&&Math.abs(start.lng-end.lng)<1e-8;
      const feature=(role,point,label,title)=>({type:'Feature',properties:{role,label,title},geometry:{type:'Point',coordinates:[point.lng,point.lat]}});
      pins.addGeoJson({type:'FeatureCollection',features:shared
        ?[feature('both',start,'A/B',caption(from)+' / '+caption(to))]
        :[feature('from',start,'A','Salida: '+caption(from)),feature('to',end,'B','Llegada: '+caption(to))]});
      pins.setStyle(feature=>({clickable:false,zIndex:60,title:feature.getProperty('title'),
        label:{text:feature.getProperty('label'),color:'#fff',fontSize:'11px',fontWeight:'700'},
        icon:{path:google.maps.SymbolPath.CIRCLE,scale:feature.getProperty('role')==='both'?15:12,
          fillColor:feature.getProperty('role')==='to'?'#c75b45':'#117d76',fillOpacity:1,strokeColor:'#fff',strokeOpacity:1,strokeWeight:2}}));
    }
    function focus() {
      if(!route)return;
      const displayed=isOverview()?paths:[legs[index].path];
      const all=displayed.flat().filter(pointValid);
      if(!all.length)all.push(...route.stops.map(position));
      if(!all.length)return;
      if(all.every(p=>Math.abs(p.lat-all[0].lat)<1e-8&&Math.abs(p.lng-all[0].lng)<1e-8)) {
        map.panTo(all[0]);map.setZoom(18);return;
      }
      const bounds=new google.maps.LatLngBounds();all.forEach(p=>bounds.extend(p));
      map.fitBounds(bounds,65);
    }
    function render(fit=true) {
      if(!route)return;
      const whole=isOverview(),leg=legs[index];
      overview.forEach(line=>line.setMap(whole?map:null));
      active.forEach(line=>{line.setPath(leg?.path||[]);line.setMap(whole?null:map);});
      const from=whole?route.stops[0]:leg.from;
      const to=whole?(route.roundTrip?route.stops[0]:route.stops.at(-1)):leg.to;
      const start=whole?(paths[0]?.[0]||position(from)):(leg.startLocation||leg.path[0]);
      const end=whole?(paths.at(-1)?.at(-1)||position(to)):(leg.endLocation||leg.path.at(-1));
      showPins(from,to,start,end);
      ui('route-leg-mode').textContent=(route.travelMode==='driving'?'En vehículo':'A pie')+(street?' · Google Maps':' · orden orientativo');
      ui('route-leg-counter').textContent=whole?route.stops.length+' paradas · vista general':'Tramo '+(index+1)+' de '+legs.length;
      ui('route-leg-from').textContent=caption(from);ui('route-leg-to').textContent=caption(to);
      ui('route-leg-surveys').textContent=whole?number(route.stops.reduce((sum,stop)=>sum+stop.count,0))+' encuestas en todo el recorrido'
        :leg.returning?'Regreso al inicio · sin encuestas adicionales':number(to.count)+' encuestas en la llegada';
      ui('route-leg-metrics').textContent=whole?(street?meters(road.distanceMeters)+' · '+time(road.durationSeconds)+' de traslado'
        :meters(route.distanceMeters)+' en línea directa'):
        meters(leg.distanceMeters)+' · '+time(leg.durationSeconds)+' de traslado';
      ui('route-detail-note').textContent=!street?'Referencia en línea recta: no representa indicaciones por calles.'
        :!legs.length?'Solo está disponible la vista general. Consulta la lista de paradas o vuelve a proponer el recorrido.'
        :whole?'Elige «Tramo a tramo» para revisar cada traslado sin superponer el resto de la ruta.'
        :leg.returning?'Este tramo vuelve al punto donde comenzó el recorrido.':'Sigue la línea de A a B por las calles indicadas. A y B son referencias sobre la vía; el tiempo no incluye aplicar las encuestas.';
      const directions=ui('route-leg-directions');directions.hidden=whole||!street;
      if(!directions.hidden) {
        const url=new URL('https://www.google.com/maps/dir/');
        url.searchParams.set('api','1');url.searchParams.set('origin',start.lat+','+start.lng);
        url.searchParams.set('destination',end.lat+','+end.lng);
        url.searchParams.set('travelmode',route.travelMode==='driving'?'driving':'walking');
        directions.href=url.href;
      } else directions.removeAttribute('href');
      ui('route-leg-select').value=String(index);ui('route-leg-select').disabled=whole;
      ui('route-prev').disabled=whole||index===0;ui('route-next').disabled=whole||index===legs.length-1;
      ui('route-focus').disabled=false;ui('route-focus').textContent=whole?'Encuadrar ruta':'Encuadrar tramo';
      ui('route-map-kind').textContent=whole?(street?'Ruta completa por calles':'Orden orientativo · sin calles'):'Tramo '+(index+1)+' · de A a B';
      ui('route-map-start').textContent='Salida';ui('route-map-end').textContent='Llegada';
      onSelection(currentStopKey());
      if(fit)focus();
    }
    function select(value) {
      if(!legs.length)return;
      const next=Number(value);if(!Number.isInteger(next))return;
      index=Math.max(0,Math.min(legs.length-1,next));ui('route-view').value='leg';render();
    }
    function selectStop(key) {
      if(!legs.length)return false;
      const next=key===route.stops[0].key?0:legs.findIndex(leg=>leg.to.key===key);
      if(next<0)return false;select(next);return true;
    }
    function setRoute(value) {
      clear();route=value.route;road=value.road;street=value.street;paths=value.paths;
      if(!route.stops.length)return;
      legs=collectLegs();
      const add=(options,group)=>{const line=new google.maps.Polyline({map,clickable:false,...options});lines.push(line);group.push(line);};
      paths.forEach(path=>{
        if(path.length<2)return;
        const dash={icon:{path:'M 0,-1 0,1',strokeColor:'#087f8c',strokeOpacity:.8,scale:2},offset:'0',repeat:'14px'};
        add({path,geodesic:!street,strokeColor:'#087f8c',strokeOpacity:street ? .7 : 0,strokeWeight:3,zIndex:30,icons:street?[]:[dash]},overview);
      });
      add({path:[],strokeColor:'#fff',strokeOpacity:.95,strokeWeight:7,zIndex:45},active);
      add({path:[],strokeColor:'#087f8c',strokeOpacity:1,strokeWeight:4,zIndex:46,
        icons:[{icon:{path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:2.5,strokeColor:'#087f8c',fillColor:'#fff',fillOpacity:1,strokeWeight:1},offset:'60%'}]},active);
      pins=new google.maps.Data({map});
      legs.forEach((leg,i)=>{
        const option=document.createElement('option');option.value=String(i);
        option.textContent=(i+1)+'. '+name(leg.from)+' → '+name(leg.to)+(leg.returning?' (regreso)':'');
        ui('route-leg-select').append(option);
      });
      ui('route-view').value=legs.length?'leg':'overview';ui('route-view').disabled=!legs.length;
      ui('route-inspector').hidden=false;ui('route-map-key').hidden=false;
      ui('route-map-key').classList.toggle('is-direct',!street);
      ui('route-map-key').classList.remove('is-loop');
      render();ui('distribution-route-panel').scrollTop=0;
    }
    ui('route-view').addEventListener('change',()=>render());
    ui('route-leg-select').addEventListener('change',()=>select(ui('route-leg-select').value));
    ui('route-prev').addEventListener('click',()=>select(index-1));
    ui('route-next').addEventListener('click',()=>select(index+1));
    ui('route-focus').addEventListener('click',focus);
    return Object.freeze({setRoute,clear,selectStop,currentStopKey});
  }
  root.MGPCSurveyRouteView=Object.freeze({create});
})(window);
