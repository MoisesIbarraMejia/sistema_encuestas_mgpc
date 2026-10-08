/* Offline projection/lifecycle checks for the survey density overlay. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/survey-heat.js'), 'utf8');

function runtime() {
  const frames = new Map(), overlays = [], observers = [], canvases = [];
  let nextFrame = 0;
  class Canvas {
    constructor() {
      this.style = {}; this.attributes = {}; this.width = this.height = 0; this.parentNode = null;
      const context = {
        fills:[],transforms:[],puts:[],globalAlpha:1,
        setTransform(...args) { this.transforms.push(args); },
        clearRect() { this.fills = []; },
        createRadialGradient(x,y,r0,x1,y1,radius) { return {x,y,radius,stops:[],addColorStop(value,color){this.stops.push({value,color});}}; },
        fillRect(...rect) { this.fills.push({rect,alpha:this.globalAlpha,gradient:this.fillStyle,composite:this.globalCompositeOperation}); },
        getImageData() {
          // Sample each halo center, compositing all contributing radial gradients.
          const data = new Uint8ClampedArray(this.fills.length * 4);
          this.fills.forEach((sample,index) => {
            let alpha = 0;
            this.fills.forEach(fill => {
              const distance = Math.hypot(sample.gradient.x-fill.gradient.x,sample.gradient.y-fill.gradient.y);
              const contribution = fill.alpha * Math.max(0,1-distance/fill.gradient.radius);
              alpha = contribution + alpha * (1-contribution);
            });
            data[index * 4 + 3] = Math.round(alpha * 255);
          });
          return {data};
        },
        putImageData(pixels,x,y) { this.puts.push({data:Array.from(pixels.data),x,y}); }
      };
      this.context = context;
      canvases.push(this);
    }
    getContext(type) { assert.equal(type,'2d'); return this.context; }
    setAttribute(name,value) { this.attributes[name]=value; }
    remove() { if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;} }
  }
  class MapFake {
    constructor() {
      this.container={clientWidth:200,clientHeight:150}; this.listeners=[];
      this.offset={x:20,y:30}; this.scale=1; this.corner={lat:0,lng:0};
      this.pane={children:[],appendChild(node){this.children.push(node);node.parentNode=this;}};
    }
    getDiv() { return this.container; }
    addListener(name,fn) {
      const handle={name,fn,removed:false,remove(){this.removed=true;}};
      this.listeners.push(handle);return handle;
    }
    trigger(name) { this.listeners.filter(listener=>!listener.removed&&listener.name===name).forEach(listener=>listener.fn()); }
  }
  class LatLng { constructor(lat,lng){this.lat=lat;this.lng=lng;} }
  class OverlayView {
    constructor(){overlays.push(this);this.map=null;}
    setMap(map){if(map===this.map)return;if(this.map)this.onRemove();this.map=map;if(map){this.onAdd();this.draw();}}
    getMap(){return this.map;}
    getPanes(){return {overlayLayer:this.map.pane};}
    getProjection(){
      if(this.map.noProjection)return null;
      return {
        fromContainerPixelToLatLng:point=>({lat:this.map.corner.lat+point.y/this.map.scale,lng:this.map.corner.lng+point.x/this.map.scale}),
        fromLatLngToDivPixel:point=>({x:point.lng*this.map.scale+this.map.offset.x,y:point.lat*this.map.scale+this.map.offset.y})
      };
    }
  }
  const sandbox={google:{maps:{OverlayView,LatLng,Point:class{constructor(x,y){this.x=x;this.y=y;}}}},document:{createElement:tag=>{assert.equal(tag,'canvas');return new Canvas();}},
    devicePixelRatio:3,
    requestAnimationFrame(fn){const id=++nextFrame;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);},
    ResizeObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnected=true;}},console};
  sandbox.window=sandbox;
  vm.runInNewContext(source,sandbox,{filename:'js/survey-heat.js'});
  return {api:sandbox.MGPCSurveyHeat,MapFake,frames,overlays,observers,canvases,sandbox,flush(){while(frames.size){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());}}};
}
const point=(lng,lat,weight)=>({position:{lat,lng},weight});

test('weighted halos remain beneath labels, ignore pointer events, and cap opacity at 35%',()=>{
  const r=runtime(),map=new r.MapFake();map.container.clientWidth=400;
  r.api.create(map,[point(20,40,2),point(160,40,8)]);r.flush();
  const canvas=r.canvases[0],context=canvas.context;
  assert.equal(map.pane.children[0],canvas);
  assert.equal(canvas.style.pointerEvents,'none');assert.equal(canvas.attributes['aria-hidden'],'true');
  assert.deepEqual(context.fills.map(fill=>fill.alpha),[0.25,1]);
  assert.ok(context.fills.every(fill=>fill.composite==='source-over'));
  const pixels=context.puts.at(-1).data;
  assert.ok(pixels[3]<pixels[7]);assert.equal(pixels[7],89);
  assert.ok(pixels[0]<pixels[4]);assert.ok(pixels[2]>pixels[6]);
});

test('overlapping lower-weight points accumulate density without opaque halos',()=>{
  const r=runtime(),map=new r.MapFake();map.container.clientWidth=400;
  r.api.create(map,[point(20,40,2),point(20,40,2),point(160,40,4)]);r.flush();
  const data=r.canvases[0].context.puts.at(-1).data;
  // Two 50% contributions make 75% density, while the maximum point is 100%.
  assert.equal(data[3],67);assert.equal(data[7],67);assert.equal(data[11],89);
});

test('heat anchors stay at original geographic points during pan and zoom',()=>{
  const r=runtime(),map=new r.MapFake();
  r.api.create(map,[point(100,40,5)]);r.flush();
  const canvas=r.canvases[0];
  function displayedPoint(){const gradient=canvas.context.fills[0].gradient;return {x:parseFloat(canvas.style.left)+gradient.x,y:parseFloat(canvas.style.top)+gradient.y};}
  assert.deepEqual(displayedPoint(),{x:120,y:70});
  map.offset={x:-30,y:15};map.corner={lat:8,lng:12};r.overlays[0].draw();r.flush();
  assert.deepEqual(displayedPoint(),{x:70,y:55});
  map.scale=2;r.overlays[0].draw();r.flush();
  assert.deepEqual(displayedPoint(),{x:170,y:95});
  assert.equal(canvas.context.fills[0].gradient.radius,64);
});

test('zero, invalid and distant values create no halo and cannot affect maximum weight',()=>{
  const r=runtime(),map=new r.MapFake();
  r.api.create(map,[point(20,30,0),point(20,30,-3),point(20,30,NaN),point(NaN,20,400),point(700,30,600),point(20,30,2)]);r.flush();
  const context=r.canvases[0].context;
  assert.equal(context.fills.length,1);assert.equal(context.fills[0].alpha,1);
  // A valid geographic point can still be far outside this viewport after zoom.
  r.overlays[0].setMap(null);map.scale=10;
  r.api.create(map,[point(160,60,5)]);r.flush();
  assert.equal(r.canvases.at(-1).context.fills.length,0);
  assert.equal(r.canvases.at(-1).context.puts.length,0);
});

test('resize uses viewport dimensions, capped device pixels and one pending redraw',()=>{
  const r=runtime(),map=new r.MapFake();
  r.api.create(map,[point(20,30,2)]);r.overlays[0].draw();map.trigger('idle');
  assert.equal(r.frames.size,1);r.flush();
  const canvas=r.canvases[0];assert.equal(canvas.width,(200+128)*2);assert.equal(canvas.height,(150+128)*2);
  assert.equal(r.observers[0].node,map.container);
  map.container.clientWidth=320;r.observers[0].fn();r.flush();assert.equal(canvas.width,(320+128)*2);
  map.container.clientWidth=0;r.observers[0].fn();r.flush();assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});

test('detach cancels pending work, removes listeners and backing memory, and allows reattachment',()=>{
  const r=runtime(),map=new r.MapFake();
  const handle=r.api.create(map,[point(20,30,2)]);
  assert.equal(r.frames.size,1);handle.remove();
  assert.equal(r.frames.size,0);assert.equal(map.pane.children.length,0);
  assert.equal(map.listeners[0].removed,true);assert.equal(r.observers[0].disconnected,true);
  assert.equal(r.canvases[0].width,0);assert.equal(r.canvases[0].height,0);
  handle.setMap(map);r.flush();assert.equal(map.pane.children.length,1);assert.equal(r.canvases[1].context.fills.length,1);
  const secondMap=new r.MapFake();handle.setMap(secondMap);r.flush();
  assert.equal(map.pane.children.length,0);assert.equal(secondMap.pane.children.length,1);
  handle.setMap(null);handle.remove();assert.equal(secondMap.pane.children.length,0);
});

test('loading is independent of Google until create and points are copied without moving the source labels',()=>{
  const standalone={window:{}};vm.runInNewContext(source,standalone);
  assert.equal(typeof standalone.window.MGPCSurveyHeat.create,'function');
  assert.throws(()=>standalone.window.MGPCSurveyHeat.create({},[]),/mapa debe estar cargado/);
  const r=runtime(),map=new r.MapFake(),points=[point(20,30,2)];
  r.api.create(map,points);points[0].position.lng=500;points[0].weight=0;
  map.noProjection=true;r.flush();assert.equal(r.canvases[0].context.fills.length,0);
  map.noProjection=false;r.overlays[0].draw();r.flush();assert.equal(r.canvases[0].context.fills.length,1);
  assert.equal(r.canvases[0].context.fills[0].alpha,1);
});
