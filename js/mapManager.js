// ============================================================
// mapManager.js
// Google Maps + edición de polígonos
// ============================================================

class MapManager {

  constructor(elementId) {

    this.map = new google.maps.Map(
      document.getElementById(elementId),
      {
        center: {
          lat: CONFIG.MAP.center[0],
          lng: CONFIG.MAP.center[1]
        },

        zoom: CONFIG.MAP.zoom,

        mapTypeControl: true,

        streetViewControl: false,

        fullscreenControl: true,

        gestureHandling: 'greedy'
      }
    );


    this.originalPolygons = [];

    this.editablePolygons = [];

    this.referenceObjects = [];

    this.affectedObjects = [];

    this.manzanasResultObjects = [];

    this.localidadResultObjects = [];


    this.editingEnabled = false;


    /*
    |--------------------------------------------------------------------------
    | CONTROLES PROPIOS
    |--------------------------------------------------------------------------
    */

    this.createDrawingControls();
  }


  /*
  |--------------------------------------------------------------------------
  | CONTROLES DE DIBUJO
  |--------------------------------------------------------------------------
  */

  createDrawingControls() {

    const control =
      document.createElement('div');

    control.className =
      'map-drawing-controls';


    const polygonButton =
      document.createElement('button');

    polygonButton.textContent =
      'Dibujar polígono';

    polygonButton.className =
      'map-control-button';


    const rectangleButton =
      document.createElement('button');

    rectangleButton.textContent =
      'Dibujar rectángulo';

    rectangleButton.className =
      'map-control-button';


    polygonButton.addEventListener(
      'click',
      () => this.startPolygonDrawing()
    );


    rectangleButton.addEventListener(
      'click',
      () => this.startRectangleDrawing()
    );


    control.appendChild(
      polygonButton
    );

    control.appendChild(
      rectangleButton
    );


    this.map.controls[
      google.maps.ControlPosition.TOP_RIGHT
    ].push(control);
  }


  /*
  |--------------------------------------------------------------------------
  | DIBUJAR POLÍGONO
  |--------------------------------------------------------------------------
  */

  startPolygonDrawing() {

    this.stopDrawing();

    this.drawingMode = 'polygon';

    this.drawingPath = [];

    this.drawingPolyline =
      new google.maps.Polyline({

        map: this.map,

        path: this.drawingPath,

        strokeColor: '#1565c0',

        strokeOpacity: 1,

        strokeWeight: 2
      });


    this.drawingClickListener =
      this.map.addListener(
        'click',
        (event) => {

          this.drawingPath.push(
            event.latLng
          );

          this.drawingPolyline.setPath(
            this.drawingPath
          );
        }
      );


    this.drawingDblClickListener =
      this.map.addListener(
        'dblclick',
        () => this.finishPolygonDrawing()
      );
  }


  finishPolygonDrawing() {

    if (
      !this.drawingPath ||
      this.drawingPath.length < 3
    ) {
      this.stopDrawing();
      return;
    }


    const polygon =
      new google.maps.Polygon({

        map: this.map,

        paths: this.drawingPath,

        strokeColor: '#1565c0',

        strokeOpacity: 1,

        strokeWeight: 2,

        fillColor: '#cfe0fb',

        fillOpacity: 0.25,

        editable: true
      });


    this.editablePolygons.push(
      polygon
    );


    this.stopDrawing();
  }


  /*
  |--------------------------------------------------------------------------
  | DIBUJAR RECTÁNGULO
  |--------------------------------------------------------------------------
  */

  startRectangleDrawing() {

    this.stopDrawing();

    this.drawingMode =
      'rectangle';


    this.rectangle =
      new google.maps.Rectangle({

        map: this.map,

        strokeColor: '#1565c0',

        strokeOpacity: 1,

        strokeWeight: 2,

        fillColor: '#cfe0fb',

        fillOpacity: 0.25,

        editable: true,

        draggable: false
      });


    this.rectangleStart =
      null;


    this.rectangleClickListener =
      this.map.addListener(
        'click',
        (event) => {

          if (!this.rectangleStart) {

            this.rectangleStart =
              event.latLng;

            return;
          }


          const bounds =
            new google.maps.LatLngBounds(
              this.rectangleStart,
              event.latLng
            );


          this.rectangle.setBounds(
            bounds
          );


          this.stopDrawing();
        }
      );
  }


  /*
  |--------------------------------------------------------------------------
  | DETENER DIBUJO
  |--------------------------------------------------------------------------
  */

  stopDrawing() {

    if (
      this.drawingClickListener
    ) {

      google.maps.event.removeListener(
        this.drawingClickListener
      );

      this.drawingClickListener =
        null;
    }


    if (
      this.drawingDblClickListener
    ) {

      google.maps.event.removeListener(
        this.drawingDblClickListener
      );

      this.drawingDblClickListener =
        null;
    }


    if (
      this.rectangleClickListener
    ) {

      google.maps.event.removeListener(
        this.rectangleClickListener
      );

      this.rectangleClickListener =
        null;
    }


    if (
      this.drawingPolyline
    ) {

      this.drawingPolyline.setMap(
        null
      );

      this.drawingPolyline =
        null;
    }


    this.drawingPath =
      null;

    this.drawingMode =
      null;

    this.rectangleStart =
      null;
  }


  /*
  |--------------------------------------------------------------------------
  | GEOJSON → GOOGLE MAPS
  |--------------------------------------------------------------------------
  */

  geoJsonToGooglePaths(
    geometry
  ) {

    if (
      !geometry
    ) {
      return [];
    }


    if (
      geometry.type ===
      'Polygon'
    ) {

      return geometry.coordinates.map(
        ring => ring.map(
          coordinate => ({
            lat: coordinate[1],
            lng: coordinate[0]
          })
        )
      );
    }


    if (
      geometry.type ===
      'MultiPolygon'
    ) {

      return geometry.coordinates.flat(
        polygon => polygon.map(
          ring => ring.map(
            coordinate => ({
              lat: coordinate[1],
              lng: coordinate[0]
            })
          )
        )
      );
    }


    throw new Error(
      'Geometría no compatible: ' +
      geometry.type
    );
  }


  /*
  |--------------------------------------------------------------------------
  | GOOGLE MAPS → GEOJSON
  |--------------------------------------------------------------------------
  */

  googlePolygonToGeoJSON(
    polygon
  ) {

    const paths = [];

    polygon
      .getPaths()
      .forEach(
        path => {

          const ring = [];

          for (
            let i = 0;
            i < path.getLength();
            i++
          ) {

            const point =
              path.getAt(i);

            ring.push([
              point.lng(),
              point.lat()
            ]);
          }


          if (
            ring.length > 0
          ) {

            const first =
              ring[0];

            const last =
              ring[ring.length - 1];


            if (
              first[0] !== last[0] ||
              first[1] !== last[1]
            ) {

              ring.push([
                first[0],
                first[1]
              ]);
            }
          }


          paths.push(ring);
        }
      );


    return {
      type: 'Feature',

      properties: {},

      geometry: {
        type: 'Polygon',
        coordinates: paths
      }
    };
  }


  /*
  |--------------------------------------------------------------------------
  | CARGAR UT ORIGINAL
  |--------------------------------------------------------------------------
  */

  loadOriginalUT(
    feature
  ) {

    this.clearAll();


    const geometry =
      feature.geometry;


    const paths =
      this.geoJsonToGooglePaths(
        geometry
      );


    if (
      geometry.type ===
      'MultiPolygon'
    ) {

      paths.forEach(
        polygonPaths => {

          const polygon =
            this.createPolygon(
              polygonPaths,
              {
                strokeColor:
                  '#4B2E83',

                strokeOpacity: 1,

                strokeWeight: 2,

                fillColor:
                  '#4B2E83',

                fillOpacity: 0.05,

                editable: false
              }
            );


          this.originalPolygons.push(
            polygon
          );
        }
      );

    } else {

      const polygon =
        this.createPolygon(
          paths,
          {
            strokeColor:
              '#4B2E83',

            strokeOpacity: 1,

            strokeWeight: 2,

            fillColor:
              '#4B2E83',

            fillOpacity: 0.05,

            editable: false
          }
        );


      this.originalPolygons.push(
        polygon
      );
    }


    /*
    |--------------------------------------------------------------------------
    | CREAR COPIA EDITABLE
    |--------------------------------------------------------------------------
    */

    const editablePaths =
      this.geoJsonToGooglePaths(
        geometry
      );


    editablePaths.forEach(
      polygonPaths => {

        const polygon =
          this.createPolygon(
            polygonPaths,
            {
              strokeColor:
                '#1565c0',

              strokeOpacity: 1,

              strokeWeight: 2,

              fillColor:
                '#cfe0fb',

              fillOpacity: 0.15,

              editable: false
            }
          );


        this.editablePolygons.push(
          polygon
        );
      }
    );


    /*
    |--------------------------------------------------------------------------
    | ZOOM
    |--------------------------------------------------------------------------
    */

    const bounds =
      new google.maps.LatLngBounds();


    this.originalPolygons.forEach(
      polygon => {

        polygon
          .getPaths()
          .forEach(
            path => {

              path.forEach(
                point => {

                  bounds.extend(
                    point
                  );
                }
              );

            }
          );
      }
    );


    if (
      !bounds.isEmpty()
    ) {

      this.map.fitBounds(
        bounds,
        30
      );
    }
  }


  /*
  |--------------------------------------------------------------------------
  | CREAR POLÍGONO
  |--------------------------------------------------------------------------
  */

  createPolygon(
    paths,
    options
  ) {

    return new google.maps.Polygon({
      map: this.map,

      paths,

      ...options
    });
  }


  /*
  |--------------------------------------------------------------------------
  | EDICIÓN
  |--------------------------------------------------------------------------
  */

  enableEditing() {

    this.editingEnabled =
      true;


    this.editablePolygons.forEach(
      polygon => {

        polygon.setEditable(
          true
        );
      }
    );
  }


  disableEditing() {

    this.editingEnabled =
      false;


    this.editablePolygons.forEach(
      polygon => {

        polygon.setEditable(
          false
        );
      }
    );
  }


  /*
  |--------------------------------------------------------------------------
  | GEOJSON ORIGINAL
  |--------------------------------------------------------------------------
  */

  getOriginalGeoJSON() {

    if (
      this.originalPolygons.length === 0
    ) {
      return null;
    }


    if (
      this.originalPolygons.length === 1
    ) {

      return this.googlePolygonToGeoJSON(
        this.originalPolygons[0]
      );
    }


    return {
      type: 'Feature',

      properties: {},

      geometry: {
        type: 'MultiPolygon',

        coordinates:
          this.originalPolygons.map(
            polygon => {

              return polygon
                .getPaths()
                .getArray()
                .map(
                  path => {

                    const ring = [];

                    for (
                      let i = 0;
                      i < path.getLength();
                      i++
                    ) {

                      const point =
                        path.getAt(i);

                      ring.push([
                        point.lng(),
                        point.lat()
                      ]);
                    }

                    return ring;
                  }
                );
            }
          )
      }
    };
  }


  /*
  |--------------------------------------------------------------------------
  | GEOJSON EDITADO
  |--------------------------------------------------------------------------
  */

  getEditedGeoJSON() {

    if (
      this.editablePolygons.length === 0
    ) {
      return null;
    }


    if (
      this.editablePolygons.length === 1
    ) {

      return this.googlePolygonToGeoJSON(
        this.editablePolygons[0]
      );
    }


    return {
      type: 'Feature',

      properties: {},

      geometry: {
        type: 'MultiPolygon',

        coordinates:
          this.editablePolygons.map(
            polygon => {

              return polygon
                .getPaths()
                .getArray()
                .map(
                  path => {

                    const ring = [];

                    for (
                      let i = 0;
                      i < path.getLength();
                      i++
                    ) {

                      const point =
                        path.getAt(i);

                      ring.push([
                        point.lng(),
                        point.lat()
                      ]);
                    }

                    return ring;
                  }
                );
            }
          )
      }
    };
  }


  /*
  |--------------------------------------------------------------------------
  | REFERENCIA
  |--------------------------------------------------------------------------
  */

  showReferenceManzanas(
    featureCollection
  ) {

    this.clearObjects(
      this.referenceObjects
    );


    if (
      !featureCollection ||
      !featureCollection.features
    ) {
      return;
    }


    featureCollection.features.forEach(
      feature => {

        if (
          !feature.geometry
        ) {
          return;
        }


        const paths =
          this.geoJsonToGooglePaths(
            feature.geometry
          );


        paths.forEach(
          polygonPaths => {

            const polygon =
              this.createPolygon(
                polygonPaths,
                {
                  strokeColor:
                    '#999999',

                  strokeOpacity: 1,

                  strokeWeight: 1,

                  fillColor:
                    '#999999',

                  fillOpacity: 0.04,

                  clickable: false
                }
              );


            this.referenceObjects.push(
              polygon
            );
          }
        );
      }
    );
  }


  /*
  |--------------------------------------------------------------------------
  | ZONA AFECTADA
  |--------------------------------------------------------------------------
  */

  showAffected(
    feature
  ) {

    this.clearObjects(
      this.affectedObjects
    );


    if (!feature) {
      return;
    }


    const paths =
      this.geoJsonToGooglePaths(
        feature.geometry
      );


    paths.forEach(
      polygonPaths => {

        const polygon =
          this.createPolygon(
            polygonPaths,
            {
              strokeColor:
                '#C00000',

              strokeOpacity: 1,

              strokeWeight: 2,

              fillColor:
                '#ff6b6b',

              fillOpacity: 0.45
            }
          );


        this.affectedObjects.push(
          polygon
        );
      }
    );


    const bounds =
      new google.maps.LatLngBounds();


    this.affectedObjects.forEach(
      polygon => {

        polygon
          .getPaths()
          .forEach(
            path => {

              path.forEach(
                point => {

                  bounds.extend(
                    point
                  );
                }
              );
            }
          );
      }
    );


    if (
      !bounds.isEmpty()
    ) {

      this.map.fitBounds(
        bounds,
        40
      );
    }
  }


  /*
  |--------------------------------------------------------------------------
  | RESULTADOS MANZANAS
  |--------------------------------------------------------------------------
  */

  showManzanasResult(
    featureCollection
  ) {

    this.clearObjects(
      this.manzanasResultObjects
    );


    if (
      !featureCollection?.features
    ) {
      return;
    }


    featureCollection.features.forEach(
      feature => {

        const pct =
          feature.properties
            ?.porcentaje_afectado ??
          100;


        const paths =
          this.geoJsonToGooglePaths(
            feature.geometry
          );


        paths.forEach(
          polygonPaths => {

            const polygon =
              this.createPolygon(
                polygonPaths,
                {
                  strokeColor:
                    '#C00000',

                  strokeOpacity: 1,

                  strokeWeight: 1,

                  fillColor:
                    '#ff5050',

                  fillOpacity:
                    Math.min(
                      0.85,
                      Math.max(
                        0.15,
                        pct / 100
                      )
                    )
                }
              );


            polygon.addListener(
              'click',
              () => {

                const p =
                  feature.properties || {};


                const content =
                  `<strong>Manzana ${p.manzana ?? ''}</strong><br>` +
                  `Sección: ${p.seccion ?? '-'}<br>` +
                  `Lista Nominal: ${p.ln ?? '-'}<br>` +
                  `% dentro de la zona afectada: ${pct}%`;


                this.showInfoWindow(
                  polygon,
                  content
                );
              }
            );


            this.manzanasResultObjects.push(
              polygon
            );
          }
        );
      }
    );
  }


  /*
  |--------------------------------------------------------------------------
  | RESULTADOS LOCALIDADES
  |--------------------------------------------------------------------------
  */

  showLocalidadResult(
    featureCollection
  ) {

    this.clearObjects(
      this.localidadResultObjects
    );


    if (
      !featureCollection?.features
    ) {
      return;
    }


    featureCollection.features.forEach(
      feature => {

        if (
          feature.geometry?.type !==
          'Point'
        ) {
          return;
        }


        const [
          lng,
          lat
        ] =
          feature.geometry.coordinates;


        const marker =
          new google.maps.Marker({

            map: this.map,

            position: {
              lat,
              lng
            }
          });


        marker.addListener(
          'click',
          () => {

            const p =
              feature.properties || {};


            const content =
              `<strong>Localidad: ${p.localidad ?? ''}</strong><br>` +
              `Sección: ${p.seccion ?? '-'}<br>` +
              `Lista Nominal: ${p.ln ?? '-'}`;


            this.showInfoWindow(
              marker,
              content
            );
          }
        );


        this.localidadResultObjects.push(
          marker
        );
      }
    );
  }


  /*
  |--------------------------------------------------------------------------
  | INFO WINDOW
  |--------------------------------------------------------------------------
  */

  showInfoWindow(
    object,
    content
  ) {

    if (
      this.infoWindow
    ) {

      this.infoWindow.close();
    }


    this.infoWindow =
      new google.maps.InfoWindow({
        content
      });


    this.infoWindow.open({

      map: this.map,

      anchor: object
    });
  }


  /*
  |--------------------------------------------------------------------------
  | VISIBILIDAD REFERENCIA
  |--------------------------------------------------------------------------
  */

  toggleReferenceVisible(
    visible
  ) {

    this.referenceObjects.forEach(
      object => {

        object.setMap(
          visible
            ? this.map
            : null
        );
      }
    );
  }


  /*
  |--------------------------------------------------------------------------
  | LIMPIEZA
  |--------------------------------------------------------------------------
  */

  clearDownstream() {

    this.clearObjects(
      this.affectedObjects
    );

    this.clearObjects(
      this.manzanasResultObjects
    );

    this.clearObjects(
      this.localidadResultObjects
    );
  }


  clearAll() {

    this.clearObjects(
      this.originalPolygons
    );

    this.clearObjects(
      this.editablePolygons
    );

    this.clearObjects(
      this.referenceObjects
    );

    this.clearObjects(
      this.affectedObjects
    );

    this.clearObjects(
      this.manzanasResultObjects
    );

    this.clearObjects(
      this.localidadResultObjects
    );


    this.stopDrawing();


    if (
      this.infoWindow
    ) {

      this.infoWindow.close();
    }
  }


  clearObjects(
    objects
  ) {

    objects.forEach(
      object => {

        if (
          object.setMap
        ) {

          object.setMap(
            null
          );
        }
      }
    );


    objects.length = 0;
  }
}