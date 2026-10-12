# Endpoints y tablas utilizados por MGPC

Inventario del cliente actual y del proxy PHP. Hay **7 endpoints activos y 6 tablas involucradas**, incluida la caché temporal. La consulta del catálogo por distrito y la de una UT individual comparten un endpoint. Esto describe las llamadas del código; no confirma que todas las tablas o los permisos de escritura estén disponibles en cada instalación. La revisión del backend y las comprobaciones de lectura están en [API-REVIEW.md](API-REVIEW.md).

## Cómo se llama a la API

El navegador utiliza `api-proxy_local.php`, que delega en `api-proxy.php`. La ruta de la API se transmite mediante el parámetro `endpoint`; el método HTTP se conserva. Por ejemplo:

```text
GET /sistema_encuestas_mgpc/api-proxy_local.php?endpoint=filter_2%2Futs_mgpc&cve_ut=02-001&limit=1000&offset=0
```

Los filtros de GET van en la URL y **no llevan cuerpo JSON**. POST usa `Content-Type: application/json`. Las credenciales las incorpora PHP; no se envían desde JavaScript. El proxy determina el permiso de escritura por la ruta, no por el parámetro de compatibilidad `modo=escritura`.

## Operaciones activas

| Método y endpoint | Tabla | Finalidad y filtros o cuerpo relevante |
| --- | --- | --- |
| `GET /filter_2/uts_mgpc` | `uts_mgpc` | Dos usos: catálogo por distrito mediante `dtto_loc` (1–33), y límites oficiales de una UT mediante `cve_ut`. Páginas con `limit=1000` y `offset`. |
| `POST /intersect/uts_mgpc` | `uts_mgpc` | Buscar UT vecinas para fusión y mostrar colindancias. `geometry`, `mode:"intersects"`, `buffer_meters:20`, `include_percentage:false`. |
| `POST /intersect/secciones` | `secciones` | Selección de secciones con buffer de 20 m; información de secciones de la UT sin buffer; colindancias con 20 m; referencia visual de encuestas con 50 m. Para calcular se envía `cache_id`, `mode:"intersects"`, `include_percentage:true`. |
| `POST /intersect/manzana` | `manzana` | Capas del editor sobre la geometría actual, con porcentaje o buffer de 20 m; referencia visual de encuestas con 50 m. Para calcular se envía `cache_id`, `mode:"intersects"`, `include_percentage:true`. El reparto por manzana de los casos de secciones consulta `geometry` del área considerada, `buffer_meters:0`, `mode:"intersects"`, `include_percentage:false`; calcula la afectación localmente y conserva la cuota de cada sección. |
| `POST /intersect/localidad` | `localidad` | Localidades consideradas en el cálculo. `cache_id`, `mode:"within"`, `include_percentage:false`. |
| `POST /cache/store` | `geom_cache` | Conservar temporalmente la geometría que se analizará. `geometry`, `cve_ut`, `meta`, `ttl_minutes:120`. Devuelve `cache_id`. |
| `POST /create/historial_ajustes_ut` | `historial_ajustes_ut` | Registrar la propuesta geométrica al confirmarla. `geometry` propuesta y `properties` con `cve_ut`, `distrito`, `clasificacion_caso`, `area_km2`, `num_vertices`, `usuario`, `origen_propuesta`. |

Las seis tablas son `uts_mgpc`, `secciones`, `manzana`, `localidad`, `geom_cache` e `historial_ajustes_ut`.

## Ejemplos de solicitudes

Son ejemplos de estructura; las coordenadas ilustrativas deben sustituirse por la geometría del caso. No se han ejecutado escrituras remotas para elaborar este inventario.

### Consultar el catálogo de un distrito

```http
GET /sistema_encuestas_mgpc/api-proxy_local.php?endpoint=filter_2%2Futs_mgpc&dtto_loc=5&limit=1000&offset=0
```

La respuesta esperada es una `FeatureCollection`. El cliente pagina hasta recibir menos de 1000 elementos, comprueba `dtto_loc` y presenta una entrada por `cve_ut`. Para recuperar una UT individual se usa el mismo endpoint con `cve_ut`, como en el primer ejemplo de este documento.

### Mapeo de los datos del catálogo

El catálogo utiliza el esquema de `uts_mgpc` proporcionado para esta integración:

| Campo de `properties` | Uso en el catálogo |
| --- | --- |
| `cve_ut` | Clave de la UT y valor conservado al seleccionarla. |
| `dtto_loc` | Distrito local utilizado para filtrar y comprobar la pertenencia al distrito elegido, del 1 al 33. El distrito no se deduce del prefijo de `cve_ut`. |
| `nombre` | Nombre mostrado en la lista, la búsqueda y el contexto del caso. |
| `dem_territ` | Demarcación territorial conservada como dato de contexto. |
| `secciones` | Lista de secciones completas asociadas a la UT. |
| `secciones1` | Lista de secciones parciales asociadas a la UT. |
| `ln_30_abr`, `pobtot` | Atributos del catálogo; no determinan por sí solos la población de encuestas. |

Las listas de secciones admiten valores nulos o texto separado por comas. Por ejemplo, `secciones:null` y `secciones1:"412,413"` aportan las secciones 412 y 413; un valor nulo no genera una sección. Se consideran las claves distintas al resumir las secciones asociadas.

La muestra sigue calculándose a partir de las capas de afectación consultadas para el caso. No se infiere su población a partir de `pobtot`, del número de secciones ni de `ln_30_abr`; tampoco se interpreta un dato ausente como población cero.

### Buscar UT candidatas para una fusión

```http
POST /sistema_encuestas_mgpc/api-proxy_local.php?endpoint=intersect%2Futs_mgpc
Content-Type: application/json
```

```json
{
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-99.140,19.430],[-99.130,19.430],[-99.130,19.440],[-99.140,19.440],[-99.140,19.430]]]
  },
  "mode": "intersects",
  "include_percentage": false,
  "buffer_meters": 20
}
```

El cliente excluye la UT principal de las candidatas. La persona selecciona al menos otra UT; JavaScript compone la unión de sus límites para preparar la propuesta. El buffer solo sirve para encontrar candidatas y no amplía la geometría final guardada.

### Preparar la geometría para calcular encuestas

```http
POST /sistema_encuestas_mgpc/api-proxy_local.php?endpoint=cache%2Fstore
Content-Type: application/json
```

```json
{
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-99.140,19.430],[-99.130,19.430],[-99.130,19.440],[-99.140,19.440],[-99.140,19.430]]]
  },
  "cve_ut": "02-001",
  "meta": {
    "origen": "calculo_frontend_mgpc",
    "caso": "fusion"
  },
  "ttl_minutes": 120
}
```

Se toma el `cache_id` devuelto por la API y se utiliza en las consultas siguientes. En este ejemplo, `CACHE_ID_DEVUELTO` representa ese valor real:

```http
POST /sistema_encuestas_mgpc/api-proxy_local.php?endpoint=intersect%2Fmanzana
Content-Type: application/json
```

```json
{
  "cache_id": "CACHE_ID_DEVUELTO",
  "mode": "intersects",
  "include_percentage": true
}
```

Para inclusión o exclusión de secciones se consulta `intersect/secciones` con el mismo formato. También se consulta `intersect/localidad` con `mode:"within"` e `include_percentage:false`. El cliente obtiene la lista nominal, calcula la afectación por superficie y aplica la fórmula de muestreo.

`cache/store` **sí escribe** en `geom_cache`, aunque el proxy lo autentica con la clave de lectura. En el backend revisado inserta la geometría temporal y elimina registros vencidos; no es un guardado permanente del expediente.

## Qué queda guardado y qué permanece en la sesión

Al confirmar una modificación geométrica, `historial_ajustes_ut` recibe los límites propuestos y los metadatos enumerados en la tabla. No se sobrescribe la geometría oficial de `uts_mgpc`.

Actualmente **no se envían a una tabla de encuestas** la población `N`, la muestra `n`, los parámetros del cálculo, los resultados por manzana o sección, ni el expediente completo. Estos datos, la selección de UT/secciones y la vinculación entre borrador y muestra permanecen en `sessionStorage` de la pestaña. El resumen JSON y el archivo Excel permiten conservar los datos exportados fuera de esa sesión.

El cambio de nomenclatura se confirma localmente y puede exportarse. **No hay una llamada que actualice el nombre oficial de la UT** ni un registro remoto de ese cambio en el flujo actual.

## Auxiliares permitidos, sin uso activo

| Método y endpoint | Estado |
| --- | --- |
| `GET /filter_2/secciones?clave=...` | `Api.getSeccionesDeUT()` está exportado, pero ninguna pantalla actual lo invoca. La existencia y significado de la columna `clave` requieren confirmación en el esquema desplegado. |
| `GET /filter/secciones?clave=...` | Permitido en el proxy; no tiene llamadas desde el cliente actual. |

Estas dos rutas no se incluyen en el total de 7 endpoints activos. El cliente tampoco invoca un endpoint para leer una caché por su identificador: utiliza `cache_id` directamente en las intersecciones.

### Recorridos del modal de distribución

El trazado solicita `polylineQuality: 'HIGH_QUALITY'` para recibir más detalle en curvas y cruces. El visor por tramos utiliza los `legs` recibidos: cambiar de tramo, encuadrarlo o pasar a vista completa no genera nuevas consultas. Cada ficha muestra las métricas de su propio trayecto; el regreso al inicio no suma encuestas adicionales. Si faltan los detalles entre paradas, se conserva únicamente la vista general sin inventar tramos. [Referencia de la calidad del trazado](https://developers.google.com/maps/documentation/javascript/reference/route#PolylineQuality).

Para revisar el orden por calles se solicita además `legs`, con los caminos, distancias, tiempos y ubicaciones inicial/final de cada visita. La aplicación propone un orden global por la primera pasada junto a los puntos viales y, si cambia el orden, consulta esa alternativa. Se realizan como máximo dos recorridos completos (cada uno dividido en solicitudes de hasta 25 intermedios); no se añade otro servicio ni una matriz de rutas. Se valida la alternativa con distancias devueltas y repetición espacial estimada antes de aceptarla. Si falla esta revisión, sigue disponible el recorrido inicial. [Referencia de los trayectos entre paradas](https://developers.google.com/maps/documentation/javascript/reference/route#RouteLeg).

Los recorridos no añaden endpoints al proxy PHP ni consultas a tablas. El orden por proximidad/carga se calcula en JavaScript con las manzanas y localidades ya repartidas. Al pulsar «Proponer recorrido», `js/survey-route-service.js` carga la biblioteca `routes` de Google Maps y llama a `Route.computeRoutes` con origen, destino, hasta 25 puntos intermedios, `travelMode` (`WALKING`/`DRIVING`) y los campos `path`, `distanceMeters`, `durationMillis`, `warnings`. Los recorridos largos se consultan en tramos consecutivos. La clave de navegador necesita Routes API habilitada y permitida en sus restricciones; se utiliza la misma configuración de Google Maps, sin exponer las credenciales PHP. Si no está disponible, se muestra el orden orientativo y enlaces a Google Maps. [Documentación oficial de Routes Library](https://developers.google.com/maps/documentation/javascript/routes/start).

## Archivos que definen estas llamadas

- [js/api.js](../js/api.js): catálogo, geometría, caché e intersecciones.
- [js/proposal-choices.js](../js/proposal-choices.js): selección de UT y secciones.
- [js/editor-territorial.js](../js/editor-territorial.js): capas informativas y preparación.
- [js/app.js](../js/app.js): cálculo de población y muestra.
- [js/territorial.js](../js/territorial.js): revisión final y confirmación de la propuesta.
- [api-proxy.php](../api-proxy.php): rutas, métodos y filtros permitidos.
