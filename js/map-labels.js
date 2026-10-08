/* Etiquetas y agrupación por colisión visual. JavaScript nativo, sin consultas. */
(function (root) {
  'use strict';
  const controllers = new WeakMap();
  const layers = Object.freeze({
    ut:{singular:'UT',plural:'UT',color:'#7B2CBF'},
    section:{singular:'sección',plural:'secciones',color:'#2563EB'},
    block:{singular:'manzana',plural:'manzanas',color:'#0891B2'},
    locality:{singular:'localidad',plural:'localidades',color:'#237443'}
  });
  const layerOrder = Object.keys(layers);
  const coordinates = value => ({lat:Number(typeof value.lat==='function'?value.lat():value.lat),lng:Number(typeof value.lng==='function'?value.lng():value.lng)});
  const identity = item => item.layer+'\u0000'+item.key;
  const counts = items => layerOrder.map(layer=>({layer,count:items.filter(item=>item.layer===layer).length})).filter(item=>item.count);
  function group(items) {
    const total=items.length;
    return {items,x:items.reduce((sum,item)=>sum+item.x,0)/total,y:items.reduce((sum,item)=>sum+item.y,0)/total,
      width:total===1?items[0].width:140,height:total===1?items[0].height:counts(items).length*28+12};
  }
  // Group actual rectangles, not a fixed geographic distance. Repeat after
  // merging because a mixed-layer badge can grow and meet a nearby label.
  function layout(items) {
    let groups=items.map(item=>group([item]));
    for (;;) {
      const parent=groups.map((_,i)=>i);
      const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
      let changed=false;
      const ordered=groups.map((value,index)=>({value,index,left:value.x-value.width/2,right:value.x+value.width/2})).sort((a,b)=>a.left-b.left);
      let active=[];
      for(const current of ordered){
        active=active.filter(previous=>previous.right+6>=current.left);
        for(const previous of active){
          if(Math.abs(previous.value.y-current.value.y)>(previous.value.height+current.value.height)/2+6)continue;
          const a=find(previous.index),b=find(current.index);
          if(a!==b){parent[b]=a;changed=true;}
        }
        active.push(current);
      }
      if(!changed)return groups;
      const joined=new Map();
      groups.forEach((value,i)=>{const key=find(i);if(!joined.has(key))joined.set(key,[]);joined.get(key).push(...value.items);});
      groups=[...joined.values()].map(group);
    }
  }
  function element(tag,className,text) {
    const node=document.createElement(tag);node.className=className;
    if(text!==undefined)node.textContent=String(text);
    return node;
  }
  function setColor(node,item) {
    const color=/^#[0-9a-f]{6}$/i.test(item.color || '')?item.color:layers[item.layer].color;
    node.style.setProperty('--label-color',color);
  }
  function cardTitle(item) {
    const titles={ut:'UT',section:'Sección',block:'Manzana',locality:'Localidad'};
    return titles[item.layer]+': '+item.text;
  }
  function appendDetails(node,item) {
    const details=element('span','mgpc-label-details');
    for(const detail of item.details){
      const row=element('span','mgpc-label-detail');
      row.append(element('span','mgpc-detail-name',detail.label+': '),element('strong','mgpc-detail-value',detail.value));
      details.append(row);
    }
    node.append(details);
  }
  function singleNode(item) {
    const node=element(item.onClick?'button':'div','mgpc-map-label mgpc-label-'+item.layer+(item.details.length?' mgpc-label-card':''));
    if(item.onClick){node.type='button';node.addEventListener('click',event=>{event.stopPropagation();item.onClick();});}
    setColor(node,item);
    if(item.details.length){
      node.append(element('strong','mgpc-label-key',cardTitle(item)));
      if(item.name)node.append(element('span','mgpc-label-name',item.name));
      appendDetails(node,item);
    } else if(item.layer==='locality'){
      const img=element('img','mgpc-locality-icon');img.src=item.image || 'img/localidad.png';img.alt='';img.width=33;img.height=32;node.append(img);
    } else {
      node.append(element('strong','mgpc-label-key',item.text));
      if(item.layer==='ut')node.append(element('span','mgpc-label-name',item.name || 'Unidad territorial'));
    }
    node.title=layers[item.layer].singular+' '+item.text+(item.name?' · '+item.name:'');
    if(item.details.length)node.title+=' · '+item.details.map(detail=>detail.label+': '+detail.value).join(' · ');
    node.setAttribute('aria-label',node.title);
    return node;
  }
  function shield(node) {
    // Clicking a group must not also select the polygon below or start a drag.
    google.maps.OverlayView.preventMapHitsAndGesturesFrom(node);
  }
  class Controller {
    constructor(map) {
      this.map=map;this.entries=new Set();this.container=null;this.pending=false;this.info=null;
      const owner=this;
      this.overlay=new (class extends google.maps.OverlayView {
        onAdd(){owner.container=element('div','mgpc-label-pane');this.getPanes().overlayMouseTarget.appendChild(owner.container);owner.schedule();}
        draw(){owner.render();}
        onRemove(){owner.container?.remove();owner.container=null;owner.info?.close();}
      })();
      this.overlay.setMap(map);
      this.listener=map.addListener('idle',()=>this.schedule());
    }
    schedule() {
      if(this.pending)return;
      this.pending=true;
      const enqueue=root.requestAnimationFrame || (fn=>setTimeout(fn,0));
      enqueue(()=>{this.pending=false;this.render();});
    }
    add(options) {
      if(!layers[options.layer])throw new Error('Capa de etiquetas desconocida.');
      const position=coordinates(options.position);
      if(!Number.isFinite(position.lat)||!Number.isFinite(position.lng))throw new Error('La etiqueta necesita una posición válida.');
      const details=Array.isArray(options.details)?options.details.filter(detail=>detail && detail.label!=null && detail.value!=null).map(detail=>({label:String(detail.label),value:String(detail.value)})):[];
      const item={...options,details,position,key:String(options.key),text:String(options.text ?? options.key),node:null};
      let owner=null;
      const handle={
        setMap:map=>{
          if(owner?.map===map)return;
          if(owner){owner.entries.delete(item);owner.closeDetails();owner.schedule();item.node?.remove();}
          owner=map?forMap(map):null;
          if(owner){owner.entries.add(item);owner.schedule();}
        },
        remove:()=>handle.setMap(null),
        getMap:()=>owner?.map || null,
        getPosition:()=>new google.maps.LatLng(position.lat,position.lng)
      };
      handle.setMap(this.map);
      return handle;
    }
    closeDetails(){if(this.info){this.info.close();this.info=null;}}
    render() {
      const projection=this.overlay.getProjection();
      if(!this.container || !projection)return;
      const previousFocus=document.activeElement;
      const focusKey=previousFocus?.dataset?.clusterKey;
      this.container.replaceChildren();
      const unique=new Map();
      for(const item of this.entries){
        const key=identity(item),previous=unique.get(key);
        if(!previous || item.variant==='results' || previous.variant!=='results')unique.set(key,item);
      }
      const projected=[];
      for(const item of unique.values()){
        const point=projection.fromLatLngToDivPixel(new google.maps.LatLng(item.position.lat,item.position.lng));
        if(!point || !Number.isFinite(point.x)||!Number.isFinite(point.y))continue;
        if(!item.node){item.node=singleNode(item);if(item.onClick)shield(item.node);}
        const node=item.node;node.style.visibility='hidden';this.container.append(node);
        const rectangle=node.getBoundingClientRect();
        const fallbackWidth=item.details.length?150:item.layer==='ut'?160:item.layer==='locality'?33:Math.max(28,item.text.length*9+14);
        const detailLines=item.details.reduce((sum,detail)=>sum+Math.max(1,Math.ceil((detail.label.length+detail.value.length+2)/18)),0);
        const cardLines=Math.max(1,Math.ceil(cardTitle(item).length/18))+(item.name?Math.ceil(item.name.length/18):0);
        const fallbackHeight=item.details.length?20+18*(cardLines+detailLines)+6:item.layer==='ut'?58:item.layer==='locality'?32:28;
        projected.push({...item,x:point.x,y:point.y,width:rectangle.width || fallbackWidth,height:rectangle.height || fallbackHeight});
      }
      const groups=layout(projected);
      this.container.replaceChildren();
      for(const value of groups){
        let node;
        if(value.items.length===1)node=value.items[0].node;
        else {
          node=element('button','mgpc-map-cluster');node.type='button';
          const summary=counts(value.items);
          for(const count of summary){
            const badge=element('span','mgpc-cluster-badge mgpc-layer-'+count.layer,count.count+' '+(count.count===1?layers[count.layer].singular:layers[count.layer].plural));
            setColor(badge,value.items.find(item=>item.layer===count.layer));node.append(badge);
          }
          node.setAttribute('aria-label','Ver grupo: '+summary.map(item=>item.count+' '+(item.count===1?layers[item.layer].singular:layers[item.layer].plural)).join(', '));
          node.title='Ver elementos del grupo y acercar el mapa';
          node.dataset.clusterKey=value.items.map(identity).sort().join('|');
          node.addEventListener('click',event=>{event.stopPropagation();this.showDetails(value);});shield(node);
        }
        node.style.left=value.x+'px';node.style.top=value.y+'px';node.style.visibility='visible';this.container.append(node);
        if(focusKey && node.dataset.clusterKey===focusKey)node.focus({preventScroll:true});
      }
    }
    showDetails(value) {
      this.closeDetails();
      const panel=element('div','mgpc-cluster-details');
      panel.append(element('h3','','Elementos en esta zona'));
      const zoom=element('button','mgpc-cluster-zoom','Acercar al grupo');zoom.type='button';
      zoom.addEventListener('click',()=>{
        const bounds=new google.maps.LatLngBounds();value.items.forEach(item=>bounds.extend(item.position));
        const current=this.map.getZoom() ?? 12;
        google.maps.event.addListenerOnce(this.map,'idle',()=>{
          if((this.map.getZoom() ?? current)<=current)this.map.setZoom(Math.min(current+2,22));
        });
        this.map.fitBounds(bounds,80);
        this.closeDetails();
      });panel.append(zoom);
      const list=element('div','mgpc-cluster-members');
      for(const count of counts(value.items)){
        const heading=element('h4','mgpc-cluster-layer-title',count.count+' '+(count.count===1?layers[count.layer].singular:layers[count.layer].plural));
        setColor(heading,value.items.find(item=>item.layer===count.layer));list.append(heading);
        const members=value.items.filter(item=>item.layer===count.layer).sort((a,b)=>a.text.localeCompare(b.text,'es',{numeric:true}));
        for(const item of members){
          const button=element('button','mgpc-cluster-member');button.type='button';
          button.append(element('strong','',item.details.length?cardTitle(item):item.text));
          if(item.name)button.append(element('span','',item.name));
          if(item.details.length)appendDetails(button,item);
          if(item.layer==='block')button.title='Manzana '+item.text+' · referencia '+item.key;
          button.addEventListener('click',()=>{
            this.closeDetails();
            if(item.onClick)item.onClick();
            else {this.map.panTo(item.position);this.map.setZoom(Math.min((this.map.getZoom() ?? 12)+2,22));}
          });list.append(button);
        }
      }
      panel.append(list);
      const position=this.overlay.getProjection().fromDivPixelToLatLng(new google.maps.Point(value.x,value.y));
      this.info=new google.maps.InfoWindow({content:panel,position,maxWidth:320});
      this.info.open({map:this.map});
    }
  }
  function forMap(map){
    if(!map)throw new Error('Se necesita un mapa para las etiquetas.');
    if(!controllers.has(map))controllers.set(map,new Controller(map));
    return controllers.get(map);
  }
  root.MGPCMapLabels=Object.freeze({forMap,layout});
})(window);
