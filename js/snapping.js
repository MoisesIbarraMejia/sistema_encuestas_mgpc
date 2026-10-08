/* Ajuste de puntos a referencias. Opera sobre copias y no modifica las capas. */
(function (root) {
  'use strict';
  const radians = Math.PI / 180;
  const metersPerDegree = 6371008.8 * radians;
  const valid = point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  function build(references) {
    const vertices = [], segments = [];
    for (const reference of references) {
      const geometry = reference.geometry || reference.feature?.geometry;
      const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
      for (const rings of polygons) for (const ring of rings) {
        for (let index = 0; index < ring.length - 1; index++) {
          const a = ring[index], b = ring[index+1];
          if (!valid(a) || !valid(b)) continue;
          const source = reference.source || 'capa de referencia';
          vertices.push({coordinate:a.slice(0,2),source});
          if (a[0] !== b[0] || a[1] !== b[1]) segments.push({a:a.slice(0,2),b:b.slice(0,2),source});
        }
      }
    }
    return {vertices,segments};
  }
  function nearest(point, references, {meters = 5, pixels = 12, zoom = 16} = {}) {
    if (!valid(point) || !(meters > 0) || !(pixels > 0) || !Number.isFinite(zoom)) return null;
    const cos = Math.max(.000001, Math.cos(point[1]*radians));
    // Límite físico y visual: evita saltos grandes al alejar el mapa.
    const tolerance = Math.min(meters, pixels*156543.03392804097*cos/2**zoom);
    const local = coordinate => [(coordinate[0]-point[0])*metersPerDegree*cos,(coordinate[1]-point[1])*metersPerDegree];
    let vertex = null, edge = null;
    for (const entry of references.vertices) {
      const distance = Math.hypot(...local(entry.coordinate));
      if (distance <= tolerance && (!vertex || distance < vertex.distance)) vertex = {...entry,distance,kind:'vertex'};
    }
    // Una esquina cercana tiene prioridad sobre un punto intermedio del borde.
    if (vertex) return vertex;
    for (const segment of references.segments) {
      const a=local(segment.a), b=local(segment.b), dx=b[0]-a[0], dy=b[1]-a[1];
      const lengthSquared=dx*dx+dy*dy;
      if (!lengthSquared) continue;
      const t=Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/lengthSquared));
      const distance=Math.hypot(a[0]+t*dx,a[1]+t*dy);
      if (distance <= tolerance && (!edge || distance < edge.distance)) {
        edge={coordinate:[segment.a[0]+t*(segment.b[0]-segment.a[0]),segment.a[1]+t*(segment.b[1]-segment.a[1])],distance,kind:'edge',source:segment.source};
      }
    }
    return edge;
  }
  function applyVertex(geometry, {polygonIndex,ringIndex,index}, coordinate, validate) {
    if (!valid(coordinate)) throw new Error('El punto de referencia no es válido.');
    const result=JSON.parse(JSON.stringify(geometry));
    const polygons=result.type==='Polygon'?[result.coordinates]:result.coordinates;
    const ring=polygons?.[polygonIndex]?.[ringIndex];
    if (!ring || !Number.isInteger(index) || index<0 || index>=ring.length-1) throw new Error('No se encontró el punto que se está editando.');
    const count=ring.length-1;
    const previous=ring[(index+count-1)%count], next=ring[(index+1)%count];
    if ([previous,next].some(p=>p[0]===coordinate[0]&&p[1]===coordinate[1])) throw new Error('El ajuste juntaría dos puntos consecutivos. Acerca el punto a otro lugar del límite.');
    ring[index]=coordinate.slice(0,2);
    if (index===0) ring[count]=coordinate.slice(0,2);
    validate(result);
    return result;
  }
  root.MGPCSnapping=Object.freeze({build,nearest,applyVertex});
})(window);
