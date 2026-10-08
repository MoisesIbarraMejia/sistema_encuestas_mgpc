# Revisión de la API y contrato de integración

Se revisó la implementación de `index.php` del repositorio SPATIAL-API, commit `0624ae2a99885538a46e89c91a43460a1bd92f68`. Se complementó con consultas reales de lectura desde Apache local. No se ejecutaron cache/store, escrituras de historial ni modificaciones sobre la API remota. La coincidencia exacta del commit desplegado y los permisos de escritura no se han confirmado.

## Contratos confirmados en el código

El flujo actual usa **7 endpoints activos sobre 6 tablas** para seleccionar territorio, preparar límites, calcular encuestas y confirmar la propuesta. El [inventario de endpoints](API-ENDPOINTS.md) contiene las rutas exactas, el mapeo del catálogo y ejemplos de solicitudes.

| Operación | Método y ruta | Solicitud y respuesta |
| --- | --- | --- |
| Catálogo distrito/UT y geometría individual | GET `filter_2/uts_mgpc` | `dtto_loc` (1–33) para el catálogo del distrito; `cve_ut` para recuperar una UT individual. Una misma ruta para ambos usos. Devuelve FeatureCollection con geometría y propiedades. |
| Intersecciones | POST `intersect/{tabla}` | Tablas `uts_mgpc`, `secciones`, `manzana` y `localidad`. Body con `geometry` o `cache_id`, `mode`, `include_percentage` y opcionalmente `buffer_meters`. |
| Geometría temporal | POST `cache/store` | `geometry`, `cve_ut`, `meta`, `ttl_minutes`. Respuesta 201 con `cache_id` y `expires_in_minutes`. TTL entre 1 y 1440 minutos; predeterminado 120. |
| Historial de propuestas | POST `create/historial_ajustes_ut` | Requiere `geometry` GeoJSON válida y `properties`. Respuesta 201 con `id`, `table`, `message`. |

`GET filter_2/secciones?clave=...` es un auxiliar exportado por `Api.getSeccionesDeUT()`, sin consumidores en las pantallas actuales. `GET filter/secciones?clave=...` también está permitido en el proxy y no se invoca. No se incluyen en el inventario activo; la existencia y significado de `clave` dependen del esquema desplegado.

La API implementa rutas genéricas para tablas permitidas por la clave. El código no define específicamente `historial_ajustes_ut` ni demuestra que esté creada. La configuración `config/api_config.php`, sus permisos y el esquema SQL no forman parte del repositorio recibido.

El esquema del catálogo proporcionado para la integración usa `cve_ut` como clave, `dtto_loc` como distrito, `nombre` como nombre y `dem_territ` como demarcación. Las secciones completas se leen de `secciones` y las parciales de `secciones1`; se admiten listas separadas por comas y valores nulos. Por ejemplo, `secciones:null` y `secciones1:"412,413"` aportan dos secciones distintas. `ln_30_abr` y `pobtot` son atributos del catálogo, no sustitutos de la lista nominal de las capas utilizadas para calcular la muestra.

### Diferencias que afectaban a la integración

- En `spatialIntersect`, `porcentaje_afectado`, `area_total_m2` y `area_interseccion_m2` son claves de cada **Feature**, fuera de properties (aproximadamente líneas 1538–1566). El frontend anterior buscaba el porcentaje únicamente en properties. `js/api.js` ahora conserva ambas representaciones.
- `filter` agrega los nombres de los filtros a los campos solicitados y devuelve esas columnas, más las indicadas en `fields` (líneas 474–578). Filtrar por clave podía omitir LN y seccion. El catálogo y la geometría oficial usan `filter_2` para conservar las columnas; las secciones del análisis se consultan mediante intersección espacial.
- `filter_2` utiliza por defecto un límite de 10 millones, acepta limit/offset y no aplica `getMaxLimit()` (líneas 794–845). Las consultas de encuestas y el catálogo solicitan páginas de 1000 hasta terminar; al superar 100000 filas se informa un error en lugar de devolver un resultado incompleto.
- Los filtros son igualdades combinadas con AND. `filter_2` no soporta el argumento fields ni los rangos del método filter.
- `within` se implementa como `ST_Contains(geometría_consulta, SHAPE)`, por lo que un punto exactamente sobre el límite no queda incluido. `intersects` utiliza ST_Intersects y sí incluye contactos de borde. Debe mantenerse una decisión metodológica explícita para localidades en los límites.
- El backend calcula la intersección real mediante ST_Intersection, aproxima metros cuadrados con grados y coseno de latitud, y el buffer mediante metros/111320. No transforma la geometría a un CRS métrico. El parámetro target_srid mencionado en comentarios no se utiliza en spatialIntersect.
- La API acepta `X-API-Key` además de api_key en query. El proxy utiliza ahora la cabecera para evitar incorporar las claves a URLs y parámetros registrados en logs.

### Lista nominal: alcance de la verificación

El repositorio no define el nombre exacto del campo de lista nominal: consulta las columnas existentes y las devuelve sin normalizar. No contiene definiciones de esas tablas, migraciones ni una equivalencia formal entre LN, ln y otros nombres. Las consultas reales de lectura realizadas sobre una UT mostraron `ln` en manzanas y secciones; no se obtuvo una localidad que permita verificar sus propiedades.

La interfaz admite los alias de lista nominal que define su normalizador. Los datos ausentes o inválidos deben impedir presentar un muestreo como completo. No debe inferirse LN a partir del área ni considerarse automáticamente cero. Tampoco se ha confirmado si la lista nominal de localidades representa una población adicional o ya incluida en las manzanas/secciones: sumar ambas capas sin esa definición puede duplicar personas.

### Comprobaciones reales de lectura

El 5 de octubre de 2026 se verificó el catálogo nuevo `filter_2/uts_mgpc?dtto_loc=26&limit=1000&offset=0` desde el proxy local: HTTP 200, 74 UT y todos los registros con `dtto_loc=26`. Incluyó `03-173`, con `nombre`, `dem_territ`, `secciones:null` y `secciones1:"412, 413"`. El selector conserva esos atributos y muestra dos secciones para ese registro.

En la revisión previa, la consulta individual `filter_2/uts_mgpc?cve_ut=02-001` devolvió geometría Polygon y propiedades como `dtto_loc=5`, `nombre`, `ln_30_abr`, `pobtot` y `secciones`. Las consultas POST de intersección —operaciones de lectura— devolvieron 9 manzanas y 11 secciones con propiedad `ln` y `porcentaje_afectado` en la raíz de cada Feature. La consulta de localidades devolvió cero features. Esta evidencia corresponde a una UT individual; no debe interpretarse como una verificación completa del catálogo por `dtto_loc`. Tampoco confirma cobertura, exactitud poblacional de todos los distritos ni disponibilidad/permisos de `historial_ajustes_ut`.

## Cambios locales

El recorrido integrado exige preparar la propuesta antes de calcular la muestra. División utiliza la UT original como territorio de cálculo; fusión utiliza la unión preparada; secciones y ajustes de límites utilizan la zona que cambia. El historial se escribe únicamente en la revisión final. El editor ya no requiere un resultado de encuesta previo.

El 2 de octubre se verificó por HTTP local la búsqueda `intersect/uts_mgpc` e `intersect/secciones` con `buffer_meters: 20` sobre la UT `02-001`: devolvieron respectivamente 7 y 12 features (incluyen contactos y la UT de partida, que la selección debe distinguir). Las cuatro páginas del flujo respondieron HTTP 200 con `Cache-Control: no-cache, must-revalidate`.

Para la UT `05-031`, reportada durante la depuración, la API devolvió un Polygon, 7 UT cercanas y 24 secciones. Se verificaron localmente con Turf 6.5.0 las 6 uniones con UT adicionales, 17 inclusiones y 10 exclusiones posibles de secciones. Tres uniones fallaban con las coordenadas originales por residuos de coma flotante en límites compartidos. Las operaciones ahora trabajan con copias a 10 decimales (aproximadamente 0.01 mm), conservando intacta la geometría oficial almacenada. Se añadió una pareja de límites como fixture de regresión; no se realizaron escrituras remotas.

Las fusiones `13-058 + 13-030` y `07-046 + 07-301` se reprodujeron el 5 de octubre con geometrías consultadas en modo lectura. La unión produjo respectivamente 7 y 4 anillos; `turf.kinks` aplicado al Polygon completo señaló 9 y 4 contactos como cruces. Cada anillo individual tenía cero autocruces: el problema era un contacto puntual entre límites interiores y exteriores. El [contrato de salida de polygon-clipping](https://github.com/mfogel/polygon-clipping/blob/main/README.md#output) permite contactos entre anillos, sin cruces.

La validación comprueba ahora los autocruces por anillo y conserva las comprobaciones de contención, superficie y superposición. También rechaza tramos compartidos y contactos que desconecten el interior. Ambas fusiones pasan sin eliminar anillos ni cambiar el resultado de la unión; las pruebas verifican la preparación y el cálculo local de la zona afectada. Si una UT tiene un defecto real en su límite de origen, la interfaz identifica su clave y solicita revisar los datos. Los límites oficiales no se reparan ni se sobrescriben automáticamente.

- `api-proxy.php` centraliza perfiles, métodos, validación de JSON, errores HTTP y las rutas utilizadas por el flujo. `api-proxy_local.php` es un alias del mismo código con perfil local.
- Las operaciones activas usan GET y POST; el proxy conserva el body JSON de POST. La clave de escritura se determina por la ruta; el parámetro modo del navegador no puede cambiar una operación de lectura a clave de escritura.
- Los filtros de consulta están restringidos por ruta: `dtto_loc` para el catálogo y `cve_ut` para la UT individual en `filter_2/uts_mgpc`; `clave` para los auxiliares de secciones. Se exige un filtro permitido y se rechazan arreglos/columnas arbitrarias. Se validan distrito 1–33, limit 1–10000 y offset 0–1000000. Esto impide que parámetros libres lleguen a la construcción SQL débil de filter_2. Se conserva el límite por defecto del backend cuando el frontend no lo especifica para no truncar silenciosamente consultas heredadas.
- Se eliminó de las rutas permitidas `update/uts_mgpc`: los ajustes del editor se registran en historial, sin sobrescribir el polígono oficial desde la integración.
- `js/api.js` valida los contratos de GeoJSON/cache, pagina el catálogo, normaliza métricas y presenta fallos de red, HTTP y errores declarados por la API.
- `js/diff.js` deja de convertir errores de recorte/unión en geometrías vacías o parciales. Procesa todas las geometrías de una FeatureCollection y exige polígonos cerrados.
- `js/mapManager.js` escapa datos de API en etiquetas y popups, posiciona InfoWindow correctamente para polígonos y permite restaurar una propuesta conservando la geometría original.

## Configuración del servidor

Las variables se configuran en Apache/PHP, nunca en archivos JavaScript:

| Variable | Uso |
| --- | --- |
| `MGPC_API_ENV` | local, development o production. |
| `MGPC_API_BASE_URL` | URL base absoluta, incluyendo index.php cuando corresponda. |
| `MGPC_API_HOST` | Cabecera Host requerida por el virtual host de la intranet; puede estar vacía. |
| `MGPC_API_KEY` | Clave de lectura. |
| `MGPC_API_WRITE_KEY` | Clave de escritura. |
| `MGPC_API_VERIFY_SSL` | true/false; habilitar con certificados válidos. |
| `MGPC_API_CAINFO` | Archivo de autoridades certificadoras utilizado por cURL. |

Se conservaron destinos y credenciales heredados como respaldo para no romper la conexión de intranet existente. No se añadieron credenciales nuevas. El perfil local mantiene el servidor usado por encuestas; development y production conservan los destinos institucionales anteriores. Si ambas etapas están en distintos servidores, deben desplegarse las tablas necesarias en la API elegida o acordarse explícitamente su distribución: una sesión compartida no sincroniza bases diferentes.

Para URLs nuevas, la verificación TLS está activada por defecto. Los destinos heredados mantienen su comportamiento previo hasta configurar certificados. Las credenciales ya presentes en código deben rotarse y trasladarse a variables de entorno antes de una publicación fuera del entorno autorizado.

## Hallazgos pendientes en el backend

1. **Concurrencia al crear historial:** createFeature calcula `MAX(OGR_FID) + 1` sin transacción/serialización. Dos creaciones simultáneas pueden competir por el mismo identificador. Corregir con AUTO_INCREMENT u otra asignación atómica en el repositorio API.
2. **Autorización por usuario/distrito:** el backend valida permisos de la clave y tablas, pero no vincula la selección de distrito del frontend a una sesión de usuario. La integración conserva ese modelo; el selector no sustituye autenticación. El servidor debe restringir el acceso según las políticas de despliegue.
3. **Recursos y estabilidad del catálogo:** filter_2 no impone el máximo por clave ni ordena los resultados. Las páginas pueden variar si se modifica la tabla durante la lectura. spatialIntersect no limita cantidad de resultados.
4. **Validación/errores:** filter_2 valida identificadores de forma menos estricta que los endpoints de escritura y presupone valores escalares. Algunos handlers devuelven mensajes de PDO al cliente. Conviene validar columnas contra el esquema y no exponer detalles internos.
5. **Configuración y esquema pendientes:** confirmar disponibilidad y permisos de `historial_ajustes_ut` y `geom_cache`. `getSeccionesDeUT` conserva el filtro heredado `clave`; esa consulta auxiliar no fue ejercitada por el flujo probado, por lo que la existencia/semántica de dicha columna no queda confirmada. Las secciones del análisis se obtienen mediante intersección espacial.

Estas observaciones no implican modificaciones sobre el repositorio API clonado ni sobre la base remota.

## Validación reproducible

- `C:\xampp\php\php.exe -l api-proxy.php` y el alias local.
- `node --test --test-isolation=none tests/api-geometry.test.cjs`: contratos de API, paginación, métricas, propagación de errores geométricos, conservación del polígono oficial y escape de popups. Turf y Maps usan fixtures para probar el comportamiento del código; no sustituyen una validación numérica de Turf.
- `node --test --test-isolation=none tests/proxy.test.cjs`: levanta PHP y un backend simulado exclusivamente en loopback, verifica métodos/body, selección de claves, allowlist y errores. Puede requerir permiso para iniciar procesos locales en entornos restringidos.
