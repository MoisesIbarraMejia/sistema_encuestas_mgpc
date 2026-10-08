// ============================================================
// mapManager.js
// Google Maps + edición de polígonos
// ============================================================

class MapManager {
  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  formatInfoNumber(value) {
    if (value == null || String(value).trim() === '') return '-';
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString('es-MX', { maximumFractionDigits: 2, useGrouping: false })
      : this.escapeHtml(value);
  }

  constructor(elementId) {
    if (typeof MGPCMapLabels === 'undefined' || typeof MGPCMapLabels.forMap !== 'function') {
      throw new Error('No se pudo cargar el sistema de etiquetas del mapa. Recarga la página.');
    }

    this.map = new google.maps.Map(document.getElementById(elementId), {
      center: { lat: CONFIG.MAP.center[0], lng: CONFIG.MAP.center[1] },
      zoom: CONFIG.MAP.zoom,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy'
    });

    this.labels = MGPCMapLabels.forMap(this.map);
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

        if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
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

  // Todas las etiquetas participan en la misma agrupacion por capa.
  // Sus claves son estables entre referencias y resultados.
  createFeatureLabel(feature, layer, variant = 'reference', percentage = null) {
    let position;
    try {
      const [lng, lat] = turf.centroid(feature).geometry.coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      position = { lat, lng };
    } catch (error) {
      console.warn('No se pudo calcular la etiqueta del feature:', error);
      return null;
    }
    const p = feature.properties || {};
    const isSection = layer === 'section';
    const text = String((isSection ? p.seccion : p.manzana) ?? '-');
    const identifier = isSection ? String(p.seccion ?? '-') : `${p.seccion ?? '-'}:${p.manzana ?? '-'}`;
    const key = p.seccion == null || (!isSection && p.manzana == null)
      ? `${identifier}:${position.lng},${position.lat}` : identifier;
    const title = isSection ? 'Sección' : 'Manzana';
    const content = `<strong>${title}: ${this.escapeHtml(text)}</strong><br>` +
      (isSection ? '' : `Sección: ${this.escapeHtml(p.seccion ?? '-')}<br>`) +
      `Lista Nominal: ${this.formatInfoNumber(p.LN ?? p.ln)}` +
      (percentage === null ? '' : `<br>% dentro de la zona afectada: ${this.formatInfoNumber(percentage)}%`);
    return this.labels.add({
      layer, key, text, position, variant,
      color: variant==='results'?(isSection?'#C06A00':'#C00000'):(isSection?'#C06A00':'#8A3880'),
      name: `${title} ${text}`,
      onClick: () => this.showInfoWindow(null, content, new google.maps.LatLng(position.lat, position.lng))
    });
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
        strokeColor: '#4b2e83',
        strokeOpacity: 1,
        strokeWeight: 4,
        fillColor: '#4B2E83',
        fillOpacity: 0.05,
        editable: false,
        clickable: false
      });

      const editablePolygon = this.createPolygon(paths, {
        strokeColor: '#117d76',
        strokeOpacity: 1,
        strokeWeight: 4,
        fillColor: '#d9eee9',
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

  // Restaurar una propuesta guardada al volver de la etapa cartográfica;
  // el polígono oficial original permanece disponible para la comparación.
  restoreEditedGeometry(featureOrGeometry) {
    const geometry = featureOrGeometry?.type === 'Feature'
      ? featureOrGeometry.geometry : featureOrGeometry;
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
      throw new Error('La propuesta guardada debe ser Polygon o MultiPolygon.');
    }
    const pathSets = this.geoJsonToGooglePaths(geometry);
    if (pathSets.length === 0 || pathSets.some((paths) => paths.length === 0)) {
      throw new Error('La propuesta guardada no contiene un polígono válido.');
    }
    const restored = [];
    try {
      pathSets.forEach((paths) => restored.push(this.createPolygon(paths, {
        strokeColor: '#117d76',
        strokeOpacity: 1,
        strokeWeight: 4,
        fillColor: '#d9eee9',
        fillOpacity: 0.15,
        editable: this.editingEnabled,
        clickable: this.editingEnabled
      })));
    } catch (error) {
      this.clearObjects(restored);
      throw error;
    }
    this.clearObjects(this.editablePolygons);
    this.editablePolygons = restored;
    return this.getEditedGeoJSON();
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
        const p = feature.properties || {};
        const pathSets = this.geoJsonToGooglePaths(feature.geometry);

        pathSets.forEach((paths) => {
          const polygon = this.createPolygon(paths, {
            strokeColor: esSeccion ? '#C06A00' : '#8A3880',
            strokeOpacity: 0.85,
            strokeWeight: esSeccion ? 2 : 1.2,
            fillColor: esSeccion ? '#C06A00' : '#8A3880',
            fillOpacity: esSeccion ? 0.05 : 0.05,
            clickable: true,
            zIndex: 1
          });

          polygon.addListener('click', (event) => {
            const title = esSeccion
              ? `Sección: ${this.escapeHtml(p.seccion ?? '-')}`
              : `Manzana: ${this.escapeHtml(p.manzana ?? '-')}`;
            const section = esSeccion ? '' : `Sección: ${this.escapeHtml(p.seccion ?? '-')}<br>`;
            this.showInfoWindow(polygon, `<strong>${title}</strong><br>${section}Lista Nominal: ${this.formatInfoNumber(p.LN ?? p.ln)}`, event?.latLng);
          });
          this.referenceObjects.push(polygon);
        });

        const label = this.createFeatureLabel(feature, esSeccion ? 'section' : 'block', 'reference');

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
        const rawPct = Number(feature.properties?.porcentaje_afectado ?? 100);
        const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 0;
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

          polygon.addListener('click', (event) => {
            const p = feature.properties || {};
            const content =
              `<strong>Manzana ${this.escapeHtml(p.manzana ?? '')}</strong><br>` +
              `Sección: ${this.escapeHtml(p.seccion ?? '-')}<br>` +
              `Lista Nominal: ${this.formatInfoNumber(p.LN ?? p.ln)}<br>` +
              `% dentro de la zona afectada: ${this.formatInfoNumber(pct)}%`;
            this.showInfoWindow(polygon, content, event?.latLng);
          });

          this.manzanasResultObjects.push(polygon);
        });

        const label = this.createFeatureLabel(feature, 'block', 'results', pct);

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
        const rawPct = Number(feature.properties?.porcentaje_afectado ?? 100);
        const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 0;
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

          polygon.addListener('click', (event) => {
            const p = feature.properties || {};
            const content =
              `<strong>Sección: ${this.escapeHtml(p.seccion ?? '')}</strong><br>` +
              `Lista Nominal: ${this.formatInfoNumber(p.LN ?? p.ln)}<br>` +
              `% dentro de la zona afectada: ${this.formatInfoNumber(pct)}%`;
            this.showInfoWindow(polygon, content, event?.latLng);
          });

          this.seccionesResultObjects.push(polygon);
        });

        const label = this.createFeatureLabel(feature, 'section', 'results', pct);

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

      const p = feature.properties || {};
      const content =
        `<strong>Localidad: ${this.escapeHtml(p.localidad ?? '')}</strong><br>` +
        `Sección: ${this.escapeHtml(p.seccion ?? '-')}<br>` +
        `Lista Nominal: ${this.formatInfoNumber(p.LN ?? p.ln)}`;
      const marker = this.labels.add({
        layer: 'locality',
        key: `${p.seccion ?? '-'}:${p.localidad ?? '-'}:${lng},${lat}`,
        text: String(p.localidad ?? '-'),
        name: `Localidad ${p.localidad ?? '-'}`,
        position: { lat, lng },
        image: 'img/localidad.png',
        variant: 'results',
        onClick: () => this.showInfoWindow(null, content, new google.maps.LatLng(lat, lng))
      });
      this.localidadResultObjects.push(marker);
    });
  }

  showInfoWindow(object, content, position) {
    if (this.infoWindow) this.infoWindow.close();

    this.infoWindow = new google.maps.InfoWindow({ content });
    if (position || object?.getPath) {
      // Polygon no es un ancla de InfoWindow; usar la posición del clic.
      this.infoWindow.setPosition(position || object.getPath().getAt(0));
      this.infoWindow.open({ map: this.map });
    } else {
      this.infoWindow.open({ map: this.map, anchor: object });
    }
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
