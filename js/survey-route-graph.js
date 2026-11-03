/* Teoría de redes para el orden de visitas: grafo de proximidad, árbol de expansión mínima
 * (MST), caminos mínimos y diámetro. Funciones puras: sin mapa, sin red, sin mutar entradas. */
(function (global) {
  'use strict';
  const R = 6371008.8, RAD = Math.PI / 180;
  const MAX_NODES = 1500;      // Prim es O(n²): por encima de esto se devuelve null y se usa distancia recta.
  const MAX_GEODESIC = 700;    // Matriz completa de caminos mínimos: n² números.
  const validPoint = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

  /** Proyección equirectangular local en metros. Suficiente para una UT (error < 0.1 %). */
  function project(points) {
    const lat0 = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const lng0 = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
    const scale = Math.cos(lat0 * RAD);
    return points.map(p => ({ x: (p.lng - lng0) * RAD * R * scale, y: (p.lat - lat0) * RAD * R }));
  }

  /** k vecinos más cercanos de cada nodo. Devuelve listas ordenadas por distancia. */
  function nearestNeighbors(xy, k) {
    const n = xy.length;
    return xy.map((a, i) => {
      const list = [];
      for (let j = 0; j < n; j += 1) if (j !== i) list.push([j, Math.hypot(a.x - xy[j].x, a.y - xy[j].y)]);
      list.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
      return list.slice(0, k);
    });
  }

  /** MST de Prim sobre el grafo completo con peso weight(i, j). Determinista (desempata por índice). */
  function minimumSpanningTree(n, weight) {
    const edges = [], adjacency = Array.from({ length: n }, () => []);
    if (n < 2) return { edges, adjacency, weight: 0 };
    const inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1);
    best[0] = 0;
    let total = 0;
    for (let step = 0; step < n; step += 1) {
      let u = -1;
      for (let i = 0; i < n; i += 1) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
      inTree[u] = 1;
      if (parent[u] >= 0) {
        edges.push([parent[u], u, best[u]]);
        adjacency[parent[u]].push([u, best[u]]);
        adjacency[u].push([parent[u], best[u]]);
        total += best[u];
      }
      for (let v = 0; v < n; v += 1) {
        if (inTree[v]) continue;
        const w = weight(u, v);
        if (w < best[v]) { best[v] = w; parent[v] = u; }
      }
    }
    return { edges, adjacency, weight: total };
  }

  /** Caminos mínimos desde un origen en un grafo disperso (Dijkstra con montículo binario). */
  function dijkstra(adjacency, source) {
    const n = adjacency.length, dist = new Float64Array(n).fill(Infinity);
    const heap = [[0, source]];
    dist[source] = 0;
    const push = item => {
      heap.push(item);
      for (let i = heap.length - 1; i > 0;) {
        const up = (i - 1) >> 1;
        if (heap[up][0] <= heap[i][0]) break;
        [heap[up], heap[i]] = [heap[i], heap[up]];
        i = up;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      for (const [v, w] of adjacency[u]) if (d + w < dist[v]) { dist[v] = d + w; push([dist[v], v]); }
    }
    return dist;
  }

  /** Nodo más lejano a `from` dentro del árbol (BFS ponderado). */
  function farthestInTree(adjacency, from) {
    const dist = new Float64Array(adjacency.length).fill(-1), stack = [from];
    dist[from] = 0;
    let far = from;
    while (stack.length) {
      const u = stack.pop();
      if (dist[u] > dist[far] || (dist[u] === dist[far] && u < far)) far = u;
      for (const [v, w] of adjacency[u]) if (dist[v] < 0) { dist[v] = dist[u] + w; stack.push(v); }
    }
    return far;
  }

  /**
   * Recorrido en preorden del MST desde `start`. Es la semilla clásica de 2-aproximación para TSP
   * métrico: visita cada rama completa antes de salir de ella. Las ramas más profundas van al final
   * para que el recorrido no abandone a medias una zona grande.
   */
  function treeWalk(adjacency, start) {
    const n = adjacency.length, size = new Int32Array(n), parent = new Int32Array(n).fill(-1), order = [];
    const stack = [start];
    parent[start] = start;
    while (stack.length) {
      const u = stack.pop();
      order.push(u);
      for (const [v] of adjacency[u]) if (parent[v] < 0) { parent[v] = u; stack.push(v); }
    }
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const u = order[i];
      size[u] += 1;
      if (u !== start) size[parent[u]] += size[u];
    }
    const walk = [];
    const visit = [start];
    while (visit.length) {
      const u = visit.pop();
      walk.push(u);
      const children = adjacency[u].filter(([v]) => parent[v] === u && v !== u)
        .sort((a, b) => size[b[0]] - size[a[0]] || a[1] - b[1] || b[0] - a[0]);   // se apila al revés: sale primero la más chica
      for (const [v] of children) visit.push(v);
    }
    return walk;
  }

  /** Pares (i<j) del grafo de proximidad kNN ∪ MST: los únicos que vale la pena medir por calles. */
  function neighborPairs(points, { k = 5 } = {}) {
    if (!Array.isArray(points) || points.length < 2 || points.length > MAX_NODES || !points.every(validPoint)) return [];
    const xy = project(points), seen = new Set(), pairs = [];
    const add = (i, j) => { const a = Math.min(i, j), b = Math.max(i, j), id = a * points.length + b; if (!seen.has(id)) { seen.add(id); pairs.push([a, b]); } };
    minimumSpanningTree(points.length, (i, j) => Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y)).edges.forEach(([i, j]) => add(i, j));
    nearestNeighbors(xy, Math.min(k, points.length - 1)).forEach((list, i) => list.forEach(([j]) => add(i, j)));
    return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  }

  /**
   * create(points, { measured })
   *   points: [{lat, lng}]. Devuelve null con datos inválidos o más de 1500 nodos.
   *   measured: opcional [{a, b, meters}] con distancias reales (p. ej. por calles) de las aristas de
   *     neighborPairs(). Si cubren un grafo conexo, distance(i, j) es el camino mínimo sobre ellas;
   *     si no, se usa la distancia recta. Medir solo esas aristas (~25 % de los pares) conserva casi toda
   *     la mejora de una matriz completa (ver docs/ROUTE-NETWORK.md).
   *   distance(i, j): métrica de optimización. straight(i, j): línea recta, para mostrar al usuario.
   *   mstWeight: cota inferior de cualquier recorrido abierto que visite todos los nodos.
   *   peripheral: extremos del diámetro del MST, candidatos naturales de inicio.
   *   walk(start): preorden del MST desde start (semilla de 2-aproximación).
   */
  function create(points, { measured } = {}) {
    if (!Array.isArray(points) || !points.length || points.length > MAX_NODES || !points.every(validPoint)) return null;
    const n = points.length, xy = project(points);
    const straight = (i, j) => Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y);
    const tree = minimumSpanningTree(n, straight);
    let metric = straight, usesMeasured = false;
    if (Array.isArray(measured) && measured.length && n <= MAX_GEODESIC) {
      const adjacency = Array.from({ length: n }, () => new Map());
      for (const { a, b, meters } of measured) {
        if (Number.isInteger(a) && Number.isInteger(b) && a !== b && a >= 0 && b >= 0 && a < n && b < n && Number.isFinite(meters) && meters >= 0) {
          const w = Math.min(meters, adjacency[a].get(b) ?? Infinity);
          adjacency[a].set(b, w);
          adjacency[b].set(a, w);
        }
      }
      const sparse = adjacency.map(map => [...map]);
      const matrix = new Float64Array(n * n);
      for (let i = 0; i < n; i += 1) matrix.set(dijkstra(sparse, i), i * n);
      if (matrix.every(Number.isFinite)) { metric = (i, j) => matrix[i * n + j]; usesMeasured = true; }
    }
    const far = from => farthestInTree(tree.adjacency, from);
    const a = n > 1 ? far(far(0)) : 0, b = n > 1 ? far(a) : 0;
    return Object.freeze({
      size: n, usesMeasured,
      distance: (i, j) => i === j ? 0 : metric(i, j),
      straight: (i, j) => i === j ? 0 : straight(i, j),
      mstWeight: usesMeasured ? minimumSpanningTree(n, metric).weight : tree.weight,
      peripheral: Object.freeze([...new Set([b, a])]),
      walk: start => treeWalk(tree.adjacency, start)
    });
  }

  global.MGPCSurveyRouteGraph = Object.freeze({ create, neighborPairs, minimumSpanningTree, dijkstra, treeWalk, project });
})(window);
