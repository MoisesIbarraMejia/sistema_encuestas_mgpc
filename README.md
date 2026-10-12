# MGPC · Propuesta territorial y encuestas

Aplicación independiente en HTML, JavaScript y CSS nativos con una API PHP. Integra la preparación territorial, el cálculo de encuestas y la revisión de la propuesta en una sola sesión. Conserva las herramientas de edición de límites y el ajuste de puntos sobre referencias del mapa.

## Abrir en XAMPP

Con Apache iniciado, abrir `http://localhost/sistema_encuestas_mgpc/`. No abrir los HTML mediante `file://`: el catálogo necesita PHP y todas las pantallas deben compartir origen y ruta base.

Seleccionar **distrito, unidad territorial y tipo de caso**. El recorrido es:

1. **Prepara la propuesta:** modifica los límites o selecciona las UT/secciones que participarán.
2. **Calcula la muestra:** revisa el territorio considerado y calcula el número estimado de personas a consultar.
3. **Revisa y confirma:** compara los límites, verifica la muestra y guarda o exporta el resultado.

| Tipo de caso | Preparación | Territorio para la muestra |
| --- | --- | --- |
| División | Modificar los límites antes de calcular | Toda la UT original |
| Fusión | Elegir al menos una UT adicional entre las cercanas, consultadas con un buffer de 20 m | Unión de las UT elegidas |
| Nomenclatura | Conservar límites; nombre propuesto opcional | Toda la UT original |
| Incluir o quitar secciones | Seleccionar secciones en el mapa o la lista y revisar la vista previa | Zona que cambia |
| Ajustar límites y manzanas | Editar los límites y revisar la propuesta | Zona que cambia |

Combinación y otros casos permanecen deshabilitados. La confirmación del usuario **no constituye una aprobación oficial del IECM**.

En fusión, los contactos puntuales entre un límite interior y el exterior son válidos cuando la zona permanece conectada. Se corrigió el falso aviso de líneas cruzadas en `13-058 + 13-030` y `07-046 + 07-301`, conservando sus límites interiores. Los cruces reales siguen bloqueados; si vienen de una UT de origen, el mensaje identifica cuál requiere revisión.

## Ajuste automático de puntos

Al entrar al paso 1 en **división** o **ajuste de límites y manzanas**, se abre una guía ilustrada para mover, agregar y quitar puntos, usar el ajuste automático y deshacer cambios. Puede cerrarse con Escape, la × o «Entendido, ir al mapa», y abrirse otra vez desde **Cómo editar los límites**. Se agrega un punto arrastrando el control intermedio del tramo; el clic derecho sobre un punto lo elimina, conservando un mínimo de tres. Son los controles de los [polígonos editables de Google Maps](https://developers.google.com/maps/documentation/javascript/shapes#user_editable_shapes), con eliminación y validación incorporadas en el editor.

En división y ajuste de límites, el editor incluye **Ajustar puntos a límites cercanos**, activado por defecto. Al soltar un punto lo acerca a un vértice o borde de las referencias visibles: el límite original y las capas activadas de UT vecinas, secciones y manzanas. No requiere consultas adicionales a la API.

La distancia máxima predeterminada es de **5 metros** y puede cambiarse a 1, 3 o 10 metros. También se exige cercanía visual de 12 píxeles; acercar el mapa permite trabajar con más precisión. El interruptor desactiva el ajuste si necesitas colocar un punto libremente.

Cada movimiento se puede deshacer en un solo paso. Se rechazan ajustes que colapsen puntos consecutivos; si el movimiento deja cruces, límites interiores fuera de su contorno o partes superpuestas, se recupera la posición anterior. Las referencias oficiales permanecen intactas. El ajuste trabaja punto por punto: no recorre automáticamente todos los segmentos de una colindancia ni certifica la topología del conjunto de UT del distrito.

La implementación usa los eventos `insert_at`, `set_at` y `remove_at` de [MVCArray de Google Maps](https://developers.google.com/maps/documentation/javascript/reference/event) y agrupa los cambios de un arrastre antes de validar y registrar el paso de deshacer. `js/snapping.js` contiene la búsqueda geométrica; el editor incorpora visibilidad de capas, controles y el historial.

Las etiquetas del mapa muestran el número de sección (de uno a cuatro dígitos) o de manzana. Las localidades del cálculo usan el icono `img/localidad.png`. Los cuadros emergentes conservan la información detallada de cada elemento.

Las UT muestran su clave y, debajo, su nombre en una caja de **160 px de ancho y altura adaptable**. En fusión, la referencia de UT se activa y bloquea; en inclusión/exclusión de secciones ocurre lo mismo con las secciones. Estas referencias reutilizan los candidatos consultados sobre la UT original y permanecen visibles al seleccionar, deshacer o cambiar una capa adicional.

`js/map-labels.js` agrupa las etiquetas que se superponen, tanto en preparación como en encuestas. Cada grupo indica cuántas UT, secciones, manzanas o localidades contiene, con una fila y color por capa. Al acercar el mapa se separan; pulsar el grupo permite consultar todos sus elementos y acercarse a esa zona. Una misma referencia presente en resultados y capas adicionales se cuenta una sola vez. Las manzanas de distintas secciones conservan identidades distintas aunque tengan el mismo número.

El agrupador usa un [OverlayView de Google Maps](https://developers.google.com/maps/documentation/javascript/customoverlays), mide el tamaño visible de las etiquetas y actualiza su distribución al mover o acercar el mapa. `map-labels.js` debe cargarse antes que los controladores del editor y de encuestas; sus estilos se encuentran en `css/map-labels.css`.

## Distribución de encuestas por manzana

En el **paso 2**, después de calcular o recuperar una muestra, «Ver distribución en el mapa» abre una ventana con el área considerada, tarjetas de **Manzana y Núm. de encuestas**, y una tabla navegable con sección y LN. Las tarjetas se agrupan cuando se superponen. El mapa de calor utiliza sus ubicaciones originales y el número asignado como peso, con opacidad limitada al 35%. Se pueden ocultar el calor o las tarjetas y descargar el reparto en CSV.

La cuota ideal es `muestra × LN considerada / suma de LN considerada`. La LN considerada es la lista nominal multiplicada por la proporción de área afectada. Se asigna la parte entera de cada cuota y las encuestas restantes se entregan a las mayores fracciones, con desempate estable por clave. El total asignado conserva la muestra y ninguna fila supera el techo de su población considerada. Las localidades mantienen una cuota propia. En inclusión/exclusión de secciones se asignan primero las cuotas por sección y después se distribuye cada cuota entre sus manzanas.

Para casos que ya calculan sobre manzanas se reutilizan los resultados; para secciones, al abrir la ventana se consulta `POST /intersect/manzana` sobre el área considerada, sin buffer. Si faltan manzanas o su población disponible no permite ubicar toda una cuota, se indica explícitamente cuántas encuestas quedan sin asignar. El reparto es orientativo, no altera la muestra guardada y se vuelve a preparar cuando cambia el cálculo; el CSV permite conservarlo.

### Propuesta de recorrido

La pestaña **Recorrido** de esa ventana permite elegir inicio, prioridad («Menos traslados» o «Más encuestas primero»), traslado a pie/vehículo y regreso opcional. Visita exclusivamente las manzanas y localidades con encuestas asignadas, sin alterar cantidades. Las encuestas pendientes de asignar se señalan y aún no forman parte del recorrido. Las paradas ordenadas se pueden acercar en el mapa y descargar en CSV.

El orden inicial usa distancias geográficas, vecino más cercano y mejoras 2-opt acotadas para reducir traslados; la alternativa de carga prioriza la llegada a zonas con más encuestas. Es una propuesta heurística, no una garantía del recorrido vial óptimo. La línea punteada representa ese orden entre puntos de referencia de manzanas; deben comprobarse los accesos a la vía pública.

Después se revisa el **recorrido real por calles**. Se toman los puntos ajustados a la vía por Google y se adelantan las visitas a manzanas junto a las que ya pasa el recorrido (tolerancia de 10 m). Esta revisión considera todas las paradas, incluso si la consulta se divide por superar 25 intermedios. Se vuelve a consultar la alternativa y se conserva únicamente si mejora sin aumentar la distancia ni los tramos repetidos estimados. Con «Más encuestas primero» también se comprueba la llegada ponderada por el número de encuestas. La lista, los enlaces a Google Maps y el CSV utilizan el orden finalmente aceptado; las asignaciones permanecen intactas. No se eliminan visitas para acortar la ruta. Los puntos ajustados por Google son referencias viales, no accesos domiciliarios confirmados; sentidos de circulación, calles sin salida o barreras pueden exigir pasar otra vez por una calle.

La vista predeterminada **Tramo a tramo** presenta un traslado fijo entre dos paradas: salida **A**, llegada **B**, encuestas en la llegada y distancia/tiempo del tramo real. Los botones **Anterior**, **Siguiente**, el selector y la lista de paradas permiten recorrer el itinerario; el mapa retira el tramo anterior y encuadra el seleccionado. El regreso al inicio se identifica sin contar encuestas adicionales. **Ruta completa** muestra la vista general sin flechas repetidas y permite regresar al tramo seleccionado. La presentación no usa animaciones ni temporizadores. Todos los controles reutilizan la respuesta recibida, sin nuevas consultas. Si faltan los tramos detallados, se muestra únicamente la ruta general con un aviso, sin fabricar traslados entre manzanas; si no se dispone de calles, la referencia sigue punteada y se identifica como línea directa.

Al pulsar «Proponer recorrido» se consulta la [Routes Library de Google Maps](https://developers.google.com/maps/documentation/javascript/routes/start) mediante la misma clave del mapa. Para trazar por calles se requiere **Routes API** habilitada y permitida para esa clave, además de Maps JavaScript API. No se habilita facturación ni se cambia la configuración de Google Cloud desde este proyecto. Las consultas utilizan un máximo de 25 paradas intermedias, se dividen en tramos continuos para recorridos mayores, conservan el orden y descartan el resultado completo si falla cualquier tramo. El mapa muestra entonces distancia/tiempo de traslado por calles y los avisos del proveedor; el tiempo no incluye realizar las encuestas. Las consultas en vehículo no usan tráfico en tiempo real.

Cada propuesta consulta el recorrido inicial y, si hay una alternativa de orden, como máximo un recorrido adicional completo; no utiliza matrices de todas las parejas. Si falla la alternativa o faltan sus datos, se conserva el recorrido inicial con un aviso. Si tampoco está disponible ese recorrido, se conservan el orden orientativo y los enlaces para abrir indicaciones en Google Maps. Los [enlaces Maps URLs](https://developers.google.com/maps/documentation/urls/get-started) se dividen con hasta tres paradas intermedias para compatibilidad móvil, sin omitir visitas. Cerrar el modal, quitar el recorrido, cambiar opciones o recalcular invalida las respuestas pendientes. No se guardan rutas en PHP ni se publican recorridos.

## Sesión y guardado

La selección, el borrador y la muestra se conservan en `sessionStorage` de la pestaña. Cambiar el caso, la UT o el borrador invalida los resultados anteriores; volver sin modificarlo los conserva. La muestra queda vinculada a la revisión exacta del borrador que la produjo.

Al confirmar un caso con cambios territoriales se registra la propuesta en el historial de ajustes; no se sobrescribe la UT oficial. Nomenclatura finaliza la revisión localmente y permite exportarla; no modifica el nombre oficial en la base de datos. Exporta el resumen para conservar los datos fuera de la pestaña. El proyecto ya no utiliza comunicación con sistemas padres ni requiere estar embebido.

## Archivos principales

| Archivo | Responsabilidad |
| --- | --- |
| `index.html`, `js/selection.js` | Distrito, UT y tipo de caso; catálogo y recuperación de sesión. |
| `editor-territorial.html`, `js/editor-territorial.js` | Preparación de límites y herramientas del mapa. |
| `js/editor-help.js`, `css/editor-help.css` | Guía inicial de edición y acceso para volver a consultarla. |
| `js/map-labels.js`, `css/map-labels.css` | Etiquetas de todas las capas, ancho de UT y agrupación visual compartida. |
| `js/proposal-choices.js` | Selección y composición de UT y secciones. |
| `js/snapping.js` | Ajuste a vértices y bordes de referencia, distancias y conservación de anillos. |
| `encuestas.html`, `js/app.js`, `js/sampling.js` | Análisis de población, muestra y exportación Excel. |
| `js/survey-allocation.js`, `js/survey-distribution.js`, `css/survey-distribution.css` | Reparto proporcional entero y ventana de distribución de encuestas. |
| `js/survey-heat.js` | Densidad de encuestas con Canvas y OverlayView, bajo las etiquetas. |
| `js/survey-route-plan.js`, `js/survey-route-optimize.js`, `js/survey-route-service.js`, `js/survey-route-view.js`, `js/survey-routes.js` | Orden inicial y revisión por calles, conexión con Google Routes, visor por tramos y controles del modal. |
| `territorial.html`, `js/territorial.js` | Revisión final y guardado de la propuesta. |
| `js/workflow.js` | Orden de navegación, sesión e invalidación de resultados. |
| `js/config.js`, `js/maps-loader.js` | Configuración del cliente y carga de Google Maps. |
| `css/shared.css`, `css/territorial-shared.css` | Identidad visual y componentes comunes. |
| `api-proxy.php`, `api-proxy_local.php` | Proxy PHP único; rutas, métodos y filtros permitidos. |

Google Maps, Turf y ExcelJS son bibliotecas que ya utilizaban los proyectos; no se incorporó un framework ni un proceso de compilación. Se versionan los archivos locales y se solicita revalidación con `.htaccess` para evitar mezclar controladores antiguos y pantallas nuevas. Los errores de carga cartográfica se muestran en la pantalla.

## API y despliegue

El [inventario de endpoints y tablas](docs/API-ENDPOINTS.md) detalla las llamadas actuales, sus parámetros, ejemplos JSON y qué datos se conservan en la API o solo en la sesión.

El flujo utiliza 7 endpoints activos sobre 6 tablas. El catálogo consulta `filter_2/uts_mgpc` con `dtto_loc` del 1 al 33; la lectura individual utiliza el mismo endpoint con `cve_ut`. El registro de propuestas utiliza `historial_ajustes_ut`.

El catálogo muestra `nombre` y conserva `dem_territ`; obtiene las secciones asociadas de `secciones` y `secciones1`, aceptando valores nulos y listas separadas por comas. Los atributos `ln_30_abr` y `pobtot` no sustituyen la población calculada a partir de las capas de afectación para la encuesta.

Consultar [API-REVIEW.md](docs/API-REVIEW.md) para contratos, configuración de Apache, comprobaciones reales de lectura y pendientes del backend. Las credenciales se configuran en PHP mediante variables de entorno. Seleccionar un distrito no autentica al usuario; el despliegue debe conservar el control de acceso institucional.

El cálculo usa lista nominal y ponderación por superficie. Los parámetros y la interpretación poblacional deben corresponder a la metodología institucional; la aplicación no certifica la calidad del padrón. La revisión local de límites tampoco sustituye el procedimiento de aprobación de la modificación.

## Verificación

Desde la raíz, con Node y PHP disponibles:

```powershell
node --test --test-isolation=none tests/*.test.cjs
C:\xampp\php\php.exe -l api-proxy.php
C:\xampp\php\php.exe -l api-proxy_local.php
```

La prueba del proxy inicia servidores temporales en loopback; `PHP_BINARY` permite indicar otra ruta de PHP. Las pruebas automatizadas simulan la API y no escriben en la base remota. `tests/geometry-real.test.cjs` usa Turf 6.5.0 real si está en `.test-output/turf.min.js` o en la ruta indicada por `TURF_TEST_BUNDLE`; si falta, señala esa prueba como omitida.

Recorrido de aceptación en navegador: iniciar cada caso; preparar, calcular y revisar; volver y modificar la propuesta; comprobar invalidación de la muestra; reintentar errores de API; probar teclado y tamaños 390, 768 y 1440 px. Google Maps requiere una clave válida para el dominio. Las pruebas de lógica no sustituyen esta verificación visual ni confirman permisos de escritura en la API desplegada.

## Procedencia

La integración territorial deriva de [mrvyoapi](https://github.com/samycarrada-lang/mrvyoapi), commit `b3a98199badb954931145fd3dc889756938a555a`. Se revisó [SPATIAL-API](https://github.com/MoisesIbarraMejia/SPATIAL-API), commit `0624ae2a99885538a46e89c91a43460a1bd92f68`.

Las copias de revisión están en `.integration-source/`, excluida de Git. Los cambios están en este proyecto local; no se publicaron cambios a los repositorios remotos.
