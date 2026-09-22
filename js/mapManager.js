// ============================================================
// mapManager.js
// Google Maps + edición de polígonos
// ============================================================

// ============================================================
// MapLabelOverlay — etiqueta de texto (HTML) anclada a un punto del
// mapa. Google Maps no trae un "tooltip" nativo multilínea, así que
// se implementa como un OverlayView estándar (patrón oficial de la
// API v3): se posiciona sola en cada draw() usando la proyección del
// mapa, y no intercepta clics (pointer-events: none en el CSS) para
// no tapar el polígono que tiene debajo.
//
// La clase se define de forma PEREZOSA (ensureMapLabelOverlayClass)
// en vez de con "class MapLabelOverlay extends google.maps.OverlayView"
// a nivel de archivo: ese "extends" se evalúa en cuanto el script se
// carga, y como el script de Google Maps se carga async con
// callback=initMap, en ese momento "google" todavía no existe —
// tronaba con "google is not defined" y dejaba sin definir todo lo
// que venía después en el archivo (incluida la clase MapManager).
// Aquí se define hasta que MapManager se construye (dentro de
// initMap(), cuando "google" ya existe seguro).
// ============================================================
let MapLabelOverlay = null;

function ensureMapLabelOverlayClass() {
  if (MapLabelOverlay) return;

  MapLabelOverlay = class extends google.maps.OverlayView {
    constructor(position, html, map, className = '') {
      super();
      this.position = position;
      this.html = html;
      this.className = className;
      this.div = null;
      this.setMap(map);
    }

    onAdd() {
      this.div = document.createElement('div');
      this.div.className = `map-feature-label ${this.className}`.trim();
      this.div.innerHTML = this.html;
      this.getPanes().overlayLayer.appendChild(this.div);
    }

    draw() {
      if (!this.div) return;
      const projection = this.getProjection();
      if (!projection) return;

      const point = projection.fromLatLngToDivPixel(this.position);
      if (!point) return;

      this.div.style.left = `${point.x}px`;
      this.div.style.top = `${point.y}px`;
    }

    onRemove() {
      if (this.div?.parentNode) {
        this.div.parentNode.removeChild(this.div);
      }
      this.div = null;
    }
  };
}

class MapManager {
  constructor(elementId) {
    ensureMapLabelOverlayClass();

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
    this.seccionesResultObjects = [];
    this.infoWindow = null;
    this.editingEnabled = false;
  }

  // ------------------------------------------------------------
  // GEOJSON -> GOOGLE MAPS
  // Un Polygon = [rings]
  // Un MultiPolygon = [[rings], [rings], ...]
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

      const converted = ring.map((coordinate) => {
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

      if (converted.length < 3) {
        throw new Error('Un anillo necesita al menos tres coordenadas válidas.');
      }

      return converted;
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
    return new google.maps.Polygon({
      map: this.map,
      paths,
      ...options
    });
  }

  // Crea una etiqueta de texto centrada en el centroide (turf.centroid)
  // del feature. Devuelve null si no se pudo calcular (geometría
  // inválida) en vez de lanzar, para no tumbar el resto del renderizado.
  createFeatureLabel(feature, html, className) {
    try {
      const centroid = turf.centroid(feature);
      const [lng, lat] = centroid.geometry.coordinates;

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      return new MapLabelOverlay(
        new google.maps.LatLng(lat, lng),
        html,
        this.map,
        className
      );
    } catch (error) {
      console.warn('No se pudo calcular la etiqueta del feature:', error);
      return null;
    }
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
        strokeColor: '#000000',
        strokeOpacity: 1,
        strokeWeight: 4,
        fillColor: '#4B2E83',
        fillOpacity: 0.05,
        editable: false,
        clickable: false
      });

      const editablePolygon = this.createPolygon(paths, {
        strokeColor: '#1565c0',
        strokeOpacity: 1,
        strokeWeight: 4,
        fillColor: '#cfe0fb',
        fillOpacity: 0.15,
        editable: false,
        clickable: false
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

  showReferenceFeatures(featureCollection, tipoCapa = 'manzana') {
    this.clearObjects(this.referenceObjects);

    if (!featureCollection?.features) return;

    const esSeccion = tipoCapa === 'seccion';

    featureCollection.features.forEach((feature) => {
      if (!feature?.geometry) return;

      try {
        const pathSets = this.geoJsonToGooglePaths(feature.geometry);

        pathSets.forEach((paths) => {
          const polygon = this.createPolygon(paths, {
            strokeColor: esSeccion ? '#C06A00' : '#8A3880',
            strokeOpacity: 0.85,
            strokeWeight: esSeccion ? 2 : 1.2,
            fillColor: esSeccion ? '#C06A00' : '#8A3880',
            fillOpacity: esSeccion ? 0.05 : 0.05,
            clickable: false,
            zIndex: 1
          });

          this.referenceObjects.push(polygon);
        });

        const p = feature.properties || {};
        const html = esSeccion
          ? `Sección: ${p.seccion ?? '-'}`
          : `Manzana: ${p.manzana ?? '-'}<br>Sección: ${p.seccion ?? '-'}<br>LN: ${p.LN ?? p.ln ?? '-'}`;

        const label = this.createFeatureLabel(
          feature,
          html,
          esSeccion ? 'label-seccion label-referencia' : 'label-manzana label-referencia'
        );

        if (label) this.referenceObjects.push(label);
      } catch (error) {
        console.warn(
          esSeccion
            ? 'Sección de referencia omitida por geometría inválida:'
            : 'Manzana de referencia omitida por geometría inválida:',
          error
        );
      }
    });
  }

  showReferenceManzanas(featureCollection) {
    this.showReferenceFeatures(featureCollection, 'manzana');
  }

  showReferenceSecciones(featureCollection) {
    this.showReferenceFeatures(featureCollection, 'seccion');
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
        fillOpacity: 0.45,
        zIndex: 4
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

      try {
        const pct = feature.properties?.porcentaje_afectado ?? 100;
        const pathSets = this.geoJsonToGooglePaths(feature.geometry);

        pathSets.forEach((paths) => {
          const polygon = this.createPolygon(paths, {
            strokeColor: '#C00000',
            strokeOpacity: 1,
            strokeWeight: 1,
            fillColor: '#ff5050',
            fillOpacity: Math.min(0.85, Math.max(0.20, pct / 100)),
            zIndex: 5
          });

          polygon.addListener('click', () => {
            const p = feature.properties || {};
            const content =
              `<strong>Manzana ${p.manzana ?? ''}</strong><br>` +
              `Sección: ${p.seccion ?? '-'}<br>` +
              `Lista Nominal: ${p.LN ?? p.ln ?? '-'}<br>` +
              `% dentro de la zona afectada: ${pct}%`;
            this.showInfoWindow(polygon, content);
          });

          this.manzanasResultObjects.push(polygon);
        });

        const p = feature.properties || {};
        const label = this.createFeatureLabel(
          feature,
          `Manzana: ${p.manzana ?? '-'}<br>Sección: ${p.seccion ?? '-'}<br>LN: ${p.LN ?? p.ln ?? '-'}`,
          'label-manzana'
        );

        if (label) this.manzanasResultObjects.push(label);
      } catch (error) {
        console.warn('Manzana resultado omitida por geometría inválida:', error);
      }
    });
  }

  // ------------------------------------------------------------
  // RESULTADOS: SECCIONES (caso IV: inclusión/exclusión de secciones)
  // ------------------------------------------------------------

  showSeccionesResult(featureCollection) {
    this.clearObjects(this.seccionesResultObjects);

    if (!featureCollection?.features) return;

    featureCollection.features.forEach((feature) => {
      if (!feature?.geometry) return;

      try {
        const pct = feature.properties?.porcentaje_afectado ?? 100;
        const pathSets = this.geoJsonToGooglePaths(feature.geometry);

        pathSets.forEach((paths) => {
          const polygon = this.createPolygon(paths, {
            strokeColor: '#C06A00',
            strokeOpacity: 1,
            strokeWeight: 1,
            fillColor: '#ffa550',
            fillOpacity: Math.min(0.85, Math.max(0.20, pct / 100)),
            zIndex: 5
          });

          polygon.addListener('click', () => {
            const p = feature.properties || {};
            const content =
              `<strong>Sección: ${p.seccion ?? ''}</strong><br>` +
              `Lista Nominal: ${p.LN ?? p.ln ?? '-'}<br>` +
              `% dentro de la zona afectada: ${pct}%`;
            this.showInfoWindow(polygon, content);
          });

          this.seccionesResultObjects.push(polygon);
        });

        const p = feature.properties || {};
        const label = this.createFeatureLabel(
          feature,
          `Sección: ${p.seccion ?? '-'}`,
          'label-seccion'
        );

        if (label) this.seccionesResultObjects.push(label);
      } catch (error) {
        console.warn('Sección resultado omitida por geometría inválida:', error);
      }
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
        position: { lat, lng },
        zIndex: 6
      });

      marker.addListener('click', () => {
        const p = feature.properties || {};
        const content =
          `<strong>Localidad: ${p.localidad ?? ''}</strong><br>` +
          `Sección: ${p.seccion ?? '-'}<br>` +
          `Lista Nominal: ${p.LN ?? p.ln ?? '-'}`;
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
    this.clearObjects(this.seccionesResultObjects);
  }

  clearAll() {
    this.clearObjects(this.originalPolygons);
    this.clearObjects(this.editablePolygons);
    this.clearObjects(this.referenceObjects);
    this.clearObjects(this.affectedObjects);
    this.clearObjects(this.manzanasResultObjects);
    this.clearObjects(this.localidadResultObjects);
    this.clearObjects(this.seccionesResultObjects);

    this.editingEnabled = false;

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
