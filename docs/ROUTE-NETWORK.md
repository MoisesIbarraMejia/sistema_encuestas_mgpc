# Orden de visitas con teoría de redes

Archivos: `js/survey-route-graph.js` (grafo) · `js/survey-route-plan.js` (planificador) · `js/survey-route-service.js` (Google Routes).

## Modelo

Las manzanas y localidades con encuestas son los **nodos**; el recorrido es un **camino hamiltoniano de longitud mínima** (TSP abierto). El planificador combina:

| Concepto de redes | Uso |
| --- | --- |
| **Árbol de expansión mínima (MST, Prim)** | Su peso es una **cota inferior** de cualquier recorrido abierto. Su recorrido en preorden es una semilla de 2-aproximación que visita cada rama completa antes de salir de ella. |
| **Diámetro del MST** (doble barrido) | Sus extremos son candidatos de inicio, además de los extremos geográficos. |
| **Grafo de proximidad kNN ∪ MST** | Conjunto de aristas que vale la pena medir por calles (`neighborPairs`). |
| **Caminos mínimos (Dijkstra)** | Con aristas medidas, la distancia entre dos paradas es el camino mínimo sobre ellas. |
| **Búsqueda local** | 2-opt y **Or-opt** (tramos de 1–3 paradas, también invertidos) sobre cada semilla. |

Sin datos adicionales se usa distancia recta, como antes. `distanceMeters` sigue siendo la distancia recta entre puntos.

## Banco de pruebas

`node tests/bench/route-network.bench.cjs <plan-anterior.js>` simula una ciudad (retícula de 100 m, un río con dos puentes, calles cortadas) y mide la longitud **real por calles** de lo que produce cada planificador (≈55 instancias de 18–47 paradas, inicio fijo):

| Variante | Con río | Sin río |
| --- | --- | --- |
| Planificador anterior (vecino más cercano + 2-opt, recta) | 7.80 km | 7.06 km |
| MST + Or-opt, distancia recta | −3.5 % | −2.6 % |
| + aristas kNN medidas por calles (~24 % de los pares) | **−12.1 %** | **−5.3 %** |
| + matriz completa por calles (techo) | −13.1 % | −6.1 % |

Lectura: la mejora sin consultas adicionales es modesta (2–4 %). La mayor ganancia viene de conocer distancias reales, y medir solo las aristas del grafo de proximidad conserva ~90 % del techo con ~un cuarto de los pares. Es una ciudad sintética: confirma la dirección, no el porcentaje que se obtendrá en una UT real. Una distancia geodésica sobre kNN **sin medir** no mejoró frente a la recta (se descartó).

## Cómo conectar distancias reales (no activado)

`Plan.plan(rows, { measured })` acepta `[{a, b, meters}]` con `a`, `b` = posición en la lista de paradas **ordenada por `key`** (el orden interno de `plan`). `MGPCSurveyRouteGraph.neighborPairs(posiciones, { k: 5 })` indica qué pares medir. La consulta a Google (p. ej. `RouteMatrix` de la Routes Library, una petición por nodo hacia sus vecinos) **no está implementada**: tiene costo por elemento y debe validarse con la clave del proyecto antes de activarla.

## Comparación con Google

`MGPCSurveyRouteService.compute(stops, { improve, optimizeWithGoogle })`:

1. Ruta inicial por calles; cada traslado A→B se conserva como tramo propio (`legs`).
2. Con `improve`, una alternativa que visita las paradas en el orden en que la ruta ya pasa junto a ellas.
3. Con `optimizeWithGoogle`, una petición adicional con `optimizeWaypointOrder` (origen y destino fijos). Se adopta solo si `MGPCSurveyRouteOptimize.accept` confirma que mejora; si falla, se conserva la ruta anterior.

`survey-routes.js` pasa `optimizeWithGoogle: true`: es una petición más por propuesta. Cámbialo a `false` ahí si prefieres no usarla.
