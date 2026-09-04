// ============================================================
// mapManager.js
// Google Maps + edición de polígonos
// ============================================================

class MapManager {
  constructor(elementId) {
    this.map = new google.maps.Map(document.getElementById(elementId), {
      center: { lat: CONFIG.MAP.center[0], lng: CONFIG.MAP.center[1] },
      zoom: CONFIG.MAP.zoom,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy'
    });

    this.originalPolygons = [];
    this.editablePolygons = [];
    this.referenceObjects = [];
    this.affectedObjects = [];
    this.manzanasResultObjects = [];
    this.localidadResultObjects = [];
    this.drawingPath = null;
    this.drawingPolyline = null;
    this.drawingClickListener = null;
    this.drawingDblClickListener = null;
    this.rectangle = null;
    this.rectangleStart = null;
    this.rectangleClickListener = null;
    this.infoWindow = null;
    this.editingEnabled = false;

    this.createDrawingControls();
  }

  createDrawingControls() {
    const control = document.createElement('div');
    control.className = 'map-drawing-controls';

    const polygonButton = document.createElement('button');
    polygonButton.textContent = 'Dibujar polígono';
    polygonButton.className = 'map-control-button';
    polygonButton.type = 'button';
    polygonButton.addEventListener('click', () => this.startPolygonDrawing());

    const rectangleButton = document.createElement('button');
    rectangleButton.textContent = 'Dibujar rectángulo';
    rectangleButton.className = 'map-control-button';
    rectangleButton.type = 'button';
    rectangleButton.addEventListener('click', () => this.startRectangleDrawing());

    control.appendChild(polygonButton);
    control.appendChild(rectangleButton);
    this.map.controls[google.maps.ControlPosition.TOP_RIGHT].push(control);
  }

  startPolygonDrawing() {
    this.stopDrawing();
    this.drawingPath = [];
    this.drawingPolyline = new google.maps.Polyline({
      map: this.map,
      path: this.drawingPath,
      strokeColor: '#1565c0',
      strokeOpacity: 1,
      strokeWeight: 2
    });

    this.drawingClickListener = this.map.addListener('click', (event) => {
      this.drawingPath.push(event.latLng);
      this.drawingPolyline.setPath(this.drawingPath);
    });

    this.drawingDblClickListener = this.map.addListener('dblclick', () => {
      this.finishPolygonDrawing();
    });
  }

  finishPolygonDrawing() {
    if (!this.drawingPath || this.drawingPath.length < 3) {
      this.stopDrawing();
      return;
    }

    const polygon = new google.maps.Polygon({
      map: this.map,
      paths: this.drawingPath,
      strokeColor: '#1565c0',
      strokeOpacity: 1,
      strokeWeight: 2,
      fillColor: '#cfe0fb',
      fillOpacity: 0.25,
      editable: true
    });

    this.editablePolygons.push(polygon);
    this.stopDrawing();
  }

  startRectangleDrawing() {
    this.stopDrawing();
    this.rectangle = new google.maps.Rectangle({
      map: this.map,
      strokeColor: '#1565c0',
      strokeOpacity: 1,
      strokeWeight: 2,
      fillColor: '#cfe0fb',
      fillOpacity: 0.25,
      editable: true,
      draggable: false
    });

    this.rectangleStart = null;
    this.rectangleClickListener = this.map.addListener('click', (event) => {
      if (!this.rectangleStart) {
        this.rectangleStart = event.latLng;
        return;
      }

      const bounds = new google.maps.LatLngBounds(this.rectangleStart, event.latLng);
      this.rectangle.setBounds(bounds);
      this.stopDrawing();
    });
  }

  stopDrawing() {
    if (this.drawingClickListener) {
      google.maps.event.removeListener(this.drawingClickListener);
      this.drawingClickListener = null;
    }

    if (this.drawingDblClickListener) {
      google.maps.event.removeListener(this.drawingDblClickListener);
      this.drawingDblClickListener = null;
    }

    if (this.rectangleClickListener) {
      google.maps.event.removeListener(this.rectangleClickListener);
      this.rectangleClickListener = null;
    }

    if (this.drawingPolyline) {
      this.drawingPolyline.setMap(null);
      this.drawingPolyline = null;
    }

    this.drawingPath = null;
    this.rectangleStart = null;
  }

  // ------------------------------------------------------------
  // GEOJSON -> GOOGLE MAPS
  // Un Polygon se representa como un conjunto de rings.
  // Un MultiPolygon se representa como varios conjuntos de rings.
  // ------------------------------------------------------------

  geoJsonToGooglePaths(geometry) {
    if (!geometry) return [];

    if (typeof geometry === 'string') {
      try {
        geometry = JSON.parse(geometry);
      } catch (e) {
        throw new Error('La geometría recibida no es un JSON válido.');
      }
    }

    if (geometry.type === 'Feature') {
      return this.geoJsonToGooglePaths(geometry.geometry);
    }

    if (geometry.type === 'FeatureCollection') {
      return (geometry.features || []).flatMap((feature) =>
        this.geoJsonToGooglePaths(feature)
      );
    }

    if (geometry.type === 'Polygon') {
      return [this.convertRings(geometry.coordinates)];
    }

    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.map((polygon) =>
        this.convertRings(polygon)
      );
    }

    throw new Error('Geometría no compatible: ' + geometry.type);
  }

  convertRings(rings) {
    if (!Array.isArray(rings)) {
      throw new Error('Las coordenadas de la geometría no son un arreglo válido.');
    }

    return rings.map((ring) => {
      if (!Array.isArray(ring)) {
        throw new Error('Un anillo de la geometría no es válido.');
      }

      return ring.map((coordinate) => {
        if (!Array.isArray(coordinate) || coordinate.length < 2) {
          throw new Error('Una coordenada GeoJSON no es válida.');
        }

        const lng = Number(coordinate[0]);
        const lat = Number(coordinate[1]);

        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          throw new Error(
            `Coordenada inválida recibida: [${coordinate[0]}, ${coordinate[1]}]`
          );
        }

        return { lat, lng };
      });
    });
  }

  // ------------------------------------------------------------
  // GOOGLE MAPS -> GEOJSON
  // ------------------------------------------------------------

  googlePolygonToGeoJSON(polygon) {
    const coordinates = [];

    polygon.getPaths().forEach((path) => {
      const ring = [];

      for (let i = 0; i < path.getLength(); i++) {
        const point = path.getAt(i);
        ring.push([point.lng(), point.lat()]);
      }

      if (ring.length > 0) {
        const first = ring[0];
        const last = ring[ring.length - 1];

        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([first[0], first[1]]);
        }
      }

      coordinates.push(ring);
    });

    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates }
    };
  }

  createPolygon(paths, options = {}) {
    return new google.maps.Polygon({ map: this.map, paths, ...options });
  }

  // ------------------------------------------------------------
  // CARGAR UT ORIGINAL + COPIA EDITABLE
  // ------------------------------------------------------------

  loadOriginalUT(feature) {
    this.clearAll();

    const geometry = feature?.geometry;
    if (!geometry) {
      throw new Error('La UT no contiene una geometría.');
    }

    const pathSets = this.geoJsonToGooglePaths(geometry);

    pathSets.forEach((paths) => {
      const originalPolygon = this.createPolygon(paths, {
        strokeColor: '#4B2E83',
        strokeOpacity: 1,
        strokeWeight: 2,
        fillColor: '#4B2E83',
        fillOpacity: 0.05,
        editable: false
      });

      const editablePolygon = this.createPolygon(paths, {
        strokeColor: '#1565c0',
        strokeOpacity: 1,
        strokeWeight: 2,
        fillColor: '#cfe0fb',
        fillOpacity: 0.15,
        editable: false
      });

      this.originalPolygons.push(originalPolygon);
      this.editablePolygons.push(editablePolygon);
    });

    const bounds = new google.maps.LatLngBounds();

    this.originalPolygons.forEach((polygon) => {
      polygon.getPaths().forEach((path) => {
        path.forEach((point) => bounds.extend(point));
      });
    });

    if (!bounds.isEmpty()) {
      this.map.fitBounds(bounds, 30);
    }
  }

  enableEditing() {
    this.editingEnabled = true;
    this.editablePolygons.forEach((polygon) => polygon.setEditable(true));
  }

  disableEditing() {
    this.editingEnabled = false;
    this.editablePolygons.forEach((polygon) => polygon.setEditable(false));
  }

  polygonsToGeoJSON(polygons) {
    if (polygons.length === 0) return null;

    if (polygons.length === 1) {
      return this.googlePolygonToGeoJSON(polygons[0]);
    }

    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: polygons.map((polygon) =>
          this.googlePolygonToGeoJSON(polygon).geometry.coordinates
        )
      }
    };
  }

  getOriginalGeoJSON() {
    return this.polygonsToGeoJSON(this.originalPolygons);
  }

  getEditedGeoJSON() {
    return this.polygonsToGeoJSON(this.editablePolygons);
  }

  // ------------------------------------------------------------
  // REFERENCIA: MANZANAS
  // ------------------------------------------------------------

  showReferenceManzanas(featureCollection) {
    this.clearObjects(this.referenceObjects);

    if (!featureCollection?.features) return;

    featureCollection.features.forEach((feature) => {
      if (!feature?.geometry) return;

      const pathSets = this.geoJsonToGooglePaths(feature.geometry);

      pathSets.forEach((paths) => {
        const polygon = this.createPolygon(paths, {
          strokeColor: '#999999',
          strokeOpacity: 1,
          strokeWeight: 1,
          fillColor: '#999999',
          fillOpacity: 0.04,
          clickable: false
        });

        this.referenceObjects.push(polygon);
      });
    });
  }

  // ------------------------------------------------------------
  // ZONA AFECTADA
  // ------------------------------------------------------------

  showAffected(feature) {
    this.clearObjects(this.affectedObjects);
    if (!feature?.geometry) return;

    const pathSets = this.geoJsonToGooglePaths(feature.geometry);

    pathSets.forEach((paths) => {
      const polygon = this.createPolygon(paths, {
        strokeColor: '#C00000',
        strokeOpacity: 1,
        strokeWeight: 2,
        fillColor: '#ff6b6b',
        fillOpacity: 0.45
      });

      this.affectedObjects.push(polygon);
    });

    const bounds = new google.maps.LatLngBounds();

    this.affectedObjects.forEach((polygon) => {
      polygon.getPaths().forEach((path) => {
        path.forEach((point) => bounds.extend(point));
      });
    });

    if (!bounds.isEmpty()) {
      this.map.fitBounds(bounds, 40);
    }
  }

  // ------------------------------------------------------------
  // RESULTADOS: MANZANAS
  // ------------------------------------------------------------

  showManzanasResult(featureCollection) {
    this.clearObjects(this.manzanasResultObjects);

    if (!featureCollection?.features) return;

    featureCollection.features.forEach((feature) => {
      if (!feature?.geometry) return;

      const pct = feature.properties?.porcentaje_afectado ?? 100;
      const pathSets = this.geoJsonToGooglePaths(feature.geometry);

      pathSets.forEach((paths) => {
        const polygon = this.createPolygon(paths, {
          strokeColor: '#C00000',
          strokeOpacity: 1,
          strokeWeight: 1,
          fillColor: '#ff5050',
          fillOpacity: Math.min(0.85, Math.max(0.15, pct / 100))
        });

        polygon.addListener('click', () => {
          const p = feature.properties || {};
          const content =
            `<strong>Manzana ${p.manzana ?? ''}</strong><br>` +
            `Sección: ${p.seccion ?? '-'}<br>` +
            `Lista Nominal: ${p.LN ?? '-'}<br>` +
            `% dentro de la zona afectada: ${pct}%`;
          this.showInfoWindow(polygon, content);
        });

        this.manzanasResultObjects.push(polygon);
      });
    });
  }

  // ------------------------------------------------------------
  // RESULTADOS: LOCALIDADES
  // ------------------------------------------------------------

  showLocalidadResult(featureCollection) {
    this.clearObjects(this.localidadResultObjects);

    if (!featureCollection?.features) return;

    featureCollection.features.forEach((feature) => {
      if (feature?.geometry?.type !== 'Point') return;

      const [lngRaw, latRaw] = feature.geometry.coordinates || [];
      const lng = Number(lngRaw);
      const lat = Number(latRaw);

      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

      const marker = new google.maps.Marker({
        map: this.map,
        position: { lat, lng }
      });

      marker.addListener('click', () => {
        const p = feature.properties || {};
        const content =
          `<strong>Localidad: ${p.localidad ?? ''}</strong><br>` +
          `Sección: ${p.seccion ?? '-'}<br>` +
          `Lista Nominal: ${p.LN ?? '-'}`;
        this.showInfoWindow(marker, content);
      });

      this.localidadResultObjects.push(marker);
    });
  }

  showInfoWindow(object, content) {
    if (this.infoWindow) this.infoWindow.close();

    this.infoWindow = new google.maps.InfoWindow({ content });
    this.infoWindow.open({ map: this.map, anchor: object });
  }

  toggleReferenceVisible(visible) {
    this.referenceObjects.forEach((object) => {
      object.setMap(visible ? this.map : null);
    });
  }

  clearDownstream() {
    this.clearObjects(this.affectedObjects);
    this.clearObjects(this.manzanasResultObjects);
    this.clearObjects(this.localidadResultObjects);
  }

  clearAll() {
    this.clearObjects(this.originalPolygons);
    this.clearObjects(this.editablePolygons);
    this.clearObjects(this.referenceObjects);
    this.clearObjects(this.affectedObjects);
    this.clearObjects(this.manzanasResultObjects);
    this.clearObjects(this.localidadResultObjects);

    if (this.rectangle) {
      this.rectangle.setMap(null);
      this.rectangle = null;
    }

    this.stopDrawing();

    if (this.infoWindow) {
      this.infoWindow.close();
      this.infoWindow = null;
    }
  }

  clearObjects(objects) {
    objects.forEach((object) => {
      if (object?.setMap) object.setMap(null);
    });

    objects.length = 0;
  }
}
