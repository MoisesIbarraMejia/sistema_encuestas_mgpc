/* Offline collision/layout and map-label interaction tests. No Google Maps/network calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(__dirname,'../js/map-labels.js');
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = (id,layer,x,y,width=80,height=24) => ({id,layer,key:id,text:id,x,y,width,height});

function runtime() {
  const frames = [], overlays = [], infos = [], htmlAssignments = [], prevented = [];
  const descendants = node => [node,...node.children.flatMap(descendants)];
  class Element {
    constructor(tag='div') {
      this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;
      this.attributes={};this.dataset={};this.events={};this._text='';this._html='';
      this.style={setProperty(name,value){this[name]=String(value)},removeProperty(name){delete this[name]}};
      this.hidden=false;this.className='';
      this.classList={
        add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(' ')},
        remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ')},
        contains:name=>this.className.split(/\s+/).includes(name),
        toggle:(name,on)=>{const next=on??!this.classList.contains(name);this.classList[next?'add':'remove'](name);return next}
      };
    }
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this.replaceChildren();this._text=String(value??'');}
    get innerHTML(){return this._html;}
    set innerHTML(value){htmlAssignments.push(String(value));this.replaceChildren();this._html=String(value);}
    get innerText(){return this.textContent;}
    set innerText(value){this.textContent=value;}
    append(...children){for(const raw of children){const child=typeof raw==='string'?Object.assign(new Element('#text'),{textContent:raw}):raw;child.remove();child.parentNode=this;this.children.push(child)}}
    appendChild(child){this.append(child);return child;}
    replaceChildren(...children){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...children);}
    removeChild(child){const index=this.children.indexOf(child);if(index>=0)this.children.splice(index,1);child.parentNode=null;return child;}
    remove(){if(this.parentNode)this.parentNode.removeChild(this);}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='class')this.className=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=String(value);}
    getAttribute(name){return this.attributes[name]??null;}
    addEventListener(name,callback){(this.events[name]??=[]).push(callback);}
    removeEventListener(name,callback){this.events[name]=(this.events[name]||[]).filter(fn=>fn!==callback);}
    dispatchEvent(event){event.target??=this;event.currentTarget=this;event.preventDefault??=()=>{event.defaultPrevented=true};event.stopPropagation??=()=>{event.stopped=true};for(const fn of this.events[event.type]||[])fn(event);return !event.defaultPrevented;}
    click(){this.dispatchEvent({type:'click'});}
    focus(){document.activeElement=this;}
    matches(selector){if(selector[0]==='.')return this.classList.contains(selector.slice(1));if(selector[0]==='#')return this.id===selector.slice(1);if(selector==='[role="button"]')return this.getAttribute('role')==='button';return this.tagName===selector.toUpperCase();}
    querySelectorAll(selector){return descendants(this).slice(1).filter(node=>selector.split(',').some(part=>node.matches(part.trim())));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    get offsetWidth(){return parseFloat(this.style.width)||Math.max(36,this.textContent.length*7+24);}
    get offsetHeight(){return parseFloat(this.style.height)||28;}
    get clientWidth(){return this.offsetWidth;}
    get clientHeight(){return this.offsetHeight;}
    getBoundingClientRect(){const width=this.offsetWidth,height=this.offsetHeight;return {x:0,y:0,top:0,left:0,right:width,bottom:height,width,height};}
  }
  const document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),
    createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>Object.assign(new Element('#text'),{textContent:text}),
    body:new Element('body'),head:new Element('head'),activeElement:null};
  const listeners=new WeakMap();
  function listen(target,event,callback){let events=listeners.get(target);if(!events){events={};listeners.set(target,events)}(events[event]??=[]).push(callback);return {remove(){events[event]=events[event].filter(fn=>fn!==callback)}}}
  function trigger(target,event,...args){for(const fn of listeners.get(target)?.[event]||[])fn(...args);}
  class LatLng {
    constructor(lat,lng){this._lat=typeof lat==='object'?(typeof lat.lat==='function'?lat.lat():lat.lat):lat;this._lng=typeof lat==='object'?(typeof lat.lng==='function'?lat.lng():lat.lng):lng}
    lat(){return this._lat} lng(){return this._lng} toJSON(){return {lat:this._lat,lng:this._lng}}
  }
  class Bounds {constructor(){this.positions=[]}extend(point){this.positions.push(point);return this}isEmpty(){return !this.positions.length}getCenter(){return new LatLng(0,0)}}
  class MapFake {
    constructor(){this.zoom=0;this.pane=new Element('pane');this.container=new Element('map');this.center=new LatLng(0,0);this.pans=[];this.fits=[];}
    addListener(name,callback){return listen(this,name,callback)}
    getZoom(){return this.zoom}setZoom(value){this.zoom=value;trigger(this,'zoom_changed');trigger(this,'idle');for(const overlay of overlays)if(overlay.map===this)overlay.draw?.()}
    getDiv(){return this.container}getCenter(){return this.center}panTo(point){this.pans.push(point);this.center=new LatLng(point)}setCenter(point){this.panTo(point)}
    fitBounds(bounds){this.fits.push(bounds)}getBounds(){return new Bounds()}
  }
  class OverlayView {
    constructor(){overlays.push(this)}
    setMap(map){if(this.map===map)return;if(this.map)this.onRemove?.();this.map=map;if(map){this.onAdd?.();frames.push(()=>this.draw?.())}}
    getMap(){return this.map}
    getPanes(){return {overlayMouseTarget:this.map.pane,overlayLayer:this.map.pane,floatPane:this.map.pane}}
    getProjection(){const map=this.map;return {fromLatLngToDivPixel(point){const p=new LatLng(point);const scale=2**map.getZoom();return {x:p.lng()*scale,y:p.lat()*scale}},fromLatLngToContainerPixel(point){return this.fromLatLngToDivPixel(point)},fromDivPixelToLatLng(point){const scale=2**map.getZoom();return new LatLng(point.y/scale,point.x/scale)}}}
    static preventMapHitsAndGesturesFrom(node){prevented.push(node)}
    static preventMapHitsFrom(node){prevented.push(node)}
  }
  class InfoWindow {
    constructor(options={}){Object.assign(this,options);this.content=options.content;infos.push(this)}
    setContent(content){this.content=content}setPosition(position){this.position=position}open(...args){this.opened=args}close(){this.closed=true}addListener(name,callback){return listen(this,name,callback)}
  }
  const maps={OverlayView,InfoWindow,LatLng,LatLngBounds:Bounds,Point:class{constructor(x,y){this.x=x;this.y=y}},
    event:{addListener:listen,addListenerOnce:listen,removeListener:handle=>handle.remove(),trigger,addDomListener:(node,name,fn)=>{node.addEventListener(name,fn);return{remove(){node.removeEventListener(name,fn)}}}}};
  let frameId=0;
  const sandbox={console,document,google:{maps},Map,Set,WeakMap,Math,Number,String,Object,Array,JSON,Date,
    requestAnimationFrame(fn){frames.push(fn);return ++frameId},cancelAnimationFrame(){},setTimeout(fn){frames.push(fn);return ++frameId},clearTimeout(){},
    addEventListener(){},removeEventListener(){},getComputedStyle:node=>({width:node.offsetWidth+'px',height:node.offsetHeight+'px'}),
    ResizeObserver:class{observe(){}disconnect(){}},URL};
  sandbox.window=sandbox;
  vm.runInNewContext(fs.readFileSync(modulePath,'utf8'),sandbox,{filename:'js/map-labels.js'});
  function flush(){let guard=0;while(frames.length){assert.ok(++guard<100,'label redraw queue must settle');const next=frames.splice(0);for(const fn of next)fn()}}
  function visible(node){return descendants(node).filter(el=>el!==node&&!el.hidden&&el.style.display!=='none'&&el.style.visibility!=='hidden')}
  return {api:sandbox.MGPCMapLabels,document,overlays,infos,htmlAssignments,prevented,MapFake,LatLng,trigger,flush,descendants,visible};
}

test('layout preserves a solitary label’s measured bounds and leaves its source untouched',()=>{
  const {api}=runtime();
  const source=[fixture('05-031','ut',80,40,219,31)];
  const before=JSON.stringify(source);
  const groups=api.layout(source);
  assert.equal(groups.length,1);
  assert.equal(groups[0].width,219);
  assert.equal(groups[0].height,31);
  assert.equal(groups[0].items[0].id,'05-031');
  assert.equal(JSON.stringify(source),before);
  assert.equal(api.layout([]).length,0);
});

test('layout groups actual overlapping label bounds and keeps distant labels separate',()=>{
  const {api}=runtime();
  const items=[fixture('a','ut',0,0,160,30),fixture('b','ut',120,0,160,30),fixture('c','ut',600,0,80,24)];
  const groups=api.layout(items);
  assert.deepEqual(plain(groups.map(g=>g.items.map(i=>i.id).sort()).sort((a,b)=>a[0].localeCompare(b[0]))),[['a','b'],['c']]);
  const cluster=groups.find(g=>g.items.length===2);
  assert.equal(cluster.width,140);
  assert.equal(cluster.height,40);
});

test('mixed layers form one stack with a counter row per layer, without dropping duplicate keys across layers',()=>{
  const {api}=runtime();
  const items=[fixture('same','ut',0,0),fixture('same','section',0,0),fixture('block','block',0,0),fixture('locality','locality',0,0)];
  const [group]=api.layout(items);
  assert.equal(group.items.length,4);
  assert.equal(group.width,140);
  assert.equal(group.height,28*4+12);
});

test('grouping repeats when a newly grown badge overlaps another label',()=>{
  const {api}=runtime();
  // Initial 20px labels a/b overlap; c is outside them, but inside their 140px badge.
  const groups=api.layout([fixture('a','ut',0,0,20,20),fixture('b','ut',5,0,20,20),fixture('c','section',65,0,20,20)]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].items.length,3);
  assert.equal(groups[0].height,68);
});

test('UT labels have separate key and name nodes, render names as text and preserve adaptive height',()=>{
  const r=runtime(),map=new r.MapFake(),controller=r.api.forMap(map);
  controller.add({layer:'ut',key:'05-029',text:'05-029',name:'NOMBRE LARGO <img src=x> DE LA UNIDAD',position:{lat:0,lng:0}});
  r.flush();
  const key=map.pane.querySelector('.mgpc-label-key'),name=map.pane.querySelector('.mgpc-label-name');
  assert.equal(key.textContent,'05-029');
  assert.equal(name.textContent,'NOMBRE LARGO <img src=x> DE LA UNIDAD');
  assert.equal(key.parentNode,name.parentNode);
  assert.deepEqual(r.htmlAssignments,[]);
  const css=fs.readFileSync(path.join(__dirname,'../css/map-labels.css'),'utf8');
  assert.match(css,/\.mgpc-map-label\.mgpc-label-ut\s*\{[^}]*width:160px[^}]*height:auto/);
  assert.match(css,/\.mgpc-label-ut \.mgpc-label-name\s*\{[^}]*display:block[^}]*overflow-wrap:anywhere/);
});

test('one controller groups overlapping labels, separates them on zoom and releases hidden entries',()=>{
  const r=runtime(),map=new r.MapFake(),controller=r.api.forMap(map);
  assert.equal(r.api.forMap(map),controller);
  assert.equal(r.overlays.length,1);
  const first=controller.add({layer:'section',key:'1',text:'1',position:{lat:0,lng:0}});
  const second=controller.add({layer:'section',key:'2',text:'2',position:{lat:0,lng:10}});
  r.flush();assert.equal(map.pane.querySelectorAll('.mgpc-map-cluster').length,1);
  map.setZoom(5);r.flush();
  assert.equal(map.pane.querySelectorAll('.mgpc-map-cluster').length,0);
  assert.equal(map.pane.querySelectorAll('.mgpc-map-label').length,2);
  second.setMap(null);r.flush();assert.equal(map.pane.querySelectorAll('.mgpc-map-label').length,1);
  second.setMap(map);r.flush();assert.equal(map.pane.querySelectorAll('.mgpc-map-label').length,2);
  first.remove();second.remove();r.flush();assert.equal(map.pane.querySelectorAll('.mgpc-map-label').length,0);
});

test('same feature in references and results counts once, without combining different layers or block sections',()=>{
  const r=runtime(),map=new r.MapFake(),controller=r.api.forMap(map);
  const base={layer:'block',key:'412:1',text:'1',position:{lat:0,lng:0}};
  const reference=controller.add({...base,variant:'reference'});
  const result=controller.add({...base,variant:'results'});
  controller.add({...base,key:'413:1'});
  controller.add({...base,layer:'section',key:'412',text:'412'});
  r.flush();
  const cluster=map.pane.querySelector('.mgpc-map-cluster');
  assert.match(cluster.textContent,/2 manzanas/);assert.match(cluster.textContent,/1 sección/);
  result.remove();r.flush();assert.match(map.pane.querySelector('.mgpc-map-cluster').textContent,/2 manzanas/);
  reference.remove();r.flush();assert.match(map.pane.querySelector('.mgpc-map-cluster').textContent,/1 manzana/);
});

test('group clicks open a readable per-layer list without selecting geometry; member actions stay explicit',()=>{
  const r=runtime(),map=new r.MapFake(),controller=r.api.forMap(map);
  let selected=0;
  controller.add({layer:'ut',key:'05-001',text:'05-001',name:'UT principal',position:{lat:0,lng:0},onClick:()=>selected++});
  controller.add({layer:'locality',key:'a',text:'LOCALIDAD',image:'img/localidad.png',position:{lat:0,lng:0},onClick:()=>selected++});
  r.flush();const cluster=map.pane.querySelector('.mgpc-map-cluster');cluster.click();
  assert.equal(selected,0);
  const panel=r.infos.at(-1).content;
  assert.match(panel.textContent,/UT/);assert.match(panel.textContent,/localidad/);
  panel.querySelector('.mgpc-cluster-member').click();assert.equal(selected,1);
  assert.ok(r.prevented.includes(cluster));
});

test('survey cards show labeled values safely and keep the existing plain locality icon',()=>{
  const r=runtime(),map=new r.MapFake(),controller=r.api.forMap(map);
  const details=[{label:'LN',value:186},{label:'Num. encuestas',value:0},{label:'Nota',value:'<img src=x onerror=alert(1)>'}];
  controller.add({layer:'block',key:'1512:3',text:'3',position:{lat:0,lng:0},details});
  details[0].value=999;
  controller.add({layer:'locality',key:'plain',text:'Localidad',position:{lat:0,lng:2000}});
  r.flush();
  const card=map.pane.querySelector('.mgpc-label-card');
  assert.equal(card.querySelector('.mgpc-label-key').textContent,'Manzana: 3');
  assert.deepEqual(card.querySelectorAll('.mgpc-label-detail').map(node=>node.textContent),['LN: 186','Num. encuestas: 0','Nota: <img src=x onerror=alert(1)>']);
  assert.match(card.getAttribute('aria-label'),/Num\. encuestas: 0/);
  assert.equal(card.querySelectorAll('img').length,0);
  assert.equal(map.pane.querySelectorAll('.mgpc-locality-icon').length,1);
  assert.deepEqual(r.htmlAssignments,[]);
});

test('survey card clusters retain each member allocation and its explicit action',()=>{
  const r=runtime(),map=new r.MapFake(),controller=r.api.forMap(map);
  const selected=[];
  for(const [layer,text,amount] of [['block','3',12],['section','1512',7],['locality','El pueblo',2]]){
    controller.add({layer,key:text,text,position:{lat:0,lng:0},details:[{label:'LN',value:186},{label:'Num. encuestas',value:amount}],onClick:()=>selected.push(text)});
  }
  r.flush();map.pane.querySelector('.mgpc-map-cluster').click();
  assert.deepEqual(selected,[]);
  const members=r.infos.at(-1).content.querySelectorAll('.mgpc-cluster-member');
  assert.equal(members.length,3);
  const manzana=members.find(node=>node.textContent.startsWith('Manzana: 3'));
  assert.match(manzana.textContent,/LN: 186Num\. encuestas: 12/);
  assert.ok(members.some(node=>node.textContent.startsWith('Sección: 1512')));
  assert.ok(members.some(node=>node.textContent.startsWith('Localidad: El pueblo')));
  manzana.click();assert.deepEqual(selected,['3']);
});

test('survey card fallback dimensions group overlapping tall cards before DOM measurement is available',()=>{
  const r=runtime(),create=r.document.createElement;
  r.document.createElement=tag=>{
    const node=create(tag);node.getBoundingClientRect=()=>({width:0,height:0});return node;
  };
  const map=new r.MapFake(),controller=r.api.forMap(map);
  for(const [text,lat] of [['1',0],['2',60]]){
    controller.add({layer:'block',key:text,text,position:{lat,lng:0},details:[{label:'LN',value:186},{label:'Num. encuestas',value:12}]});
  }
  r.flush();assert.equal(map.pane.querySelectorAll('.mgpc-map-cluster').length,1);
  map.setZoom(1);r.flush();
  assert.equal(map.pane.querySelectorAll('.mgpc-map-cluster').length,0);
  assert.equal(map.pane.querySelectorAll('.mgpc-label-card').length,2);
});
