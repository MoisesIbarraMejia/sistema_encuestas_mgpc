// ============================================================
// mapManager.js — mapa Leaflet, capas y edición del polígono
// ============================================================
class MapManager {
  constructor(elementId) {
    this.map = L.map(elementId).setView(CONFIG.MAP.center, CONFIG.MAP.zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: CONFIG.MAP.maxZoom,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    // Polígono original de la UT (solo lectura, referencia)
    this.originalLayer = L.geoJSON(null, {
      style: { color: '#4B2E83', weight: 2, dashArray: '6,4', fillOpacity: 0.05 }
    }).addTo(this.map);

    // Copia editable (Leaflet.draw la controla)
    this.editableGroup = new L.FeatureGroup().addTo(this.map);

    // Manzanas de referencia (contexto visual, opcional)
    this.referenceLayer = L.geoJSON(null, {
      style: { color: '#999999', weight: 1, fillOpacity: 0.04 }
    }).addTo(this.map);

    // Zona afectada calculada (diferencia simétrica)
    this.affectedLayer = L.geoJSON(null, {
      style: { color: '#C00000', weight: 2, fillColor: '#ff6b6b', fillOpacity: 0.45 }
    }).addTo(this.map);

    // Resultado: manzanas afectadas (coloreadas por % de afectación)
    this.manzanasResultLayer = L.geoJSON(null, {
      style: (f) => this._styleManzanaResult(f),
      onEachFeature: (f, layer) => this._bindManzanaPopup(f, layer)
    }).addTo(this.map);

    // Resultado: localidades (puntos) afectadas
    this.localidadResultLayer = L.geoJSON(null, {
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        radius: 7, color: '#006100', weight: 2, fillColor: '#8fd19e', fillOpacity: 0.9
      }),
      onEachFeature: (f, layer) => this._bindLocalidadPopup(f, layer)
    }).addTo(this.map);

    this.drawControl = null;
  }

  _styleManzanaResult(feature) {
    const pct = feature.properties?.porcentaje_afectado ?? 100;
    return {
      color: '#C00000',
      weight: 1,
      fillColor: '#ff5050',
      fillOpacity: Math.min(0.85, Math.max(0.15, pct / 100))
    };
  }

  _bindManzanaPopup(feature, layer) {
    const p = feature.properties || {};
    const pct = p.porcentaje_afectado ?? 100;
    layer.bindPopup(
      `<strong>Manzana ${p.manzana ?? ''}</strong><br>` +
      `Sección: ${p.seccion ?? '-'}<br>` +
      `Lista Nominal: ${p.LN ?? '-'}<br>` +
      `% dentro de la zona afectada: ${pct}%`
    );
  }

  _bindLocalidadPopup(feature, layer) {
    const p = feature.properties || {};
    layer.bindPopup(
      `<strong>Localidad: ${p.localidad ?? ''}</strong><br>` +
      `Sección: ${p.seccion ?? '-'}<br>` +
      `Lista Nominal: ${p.LN ?? '-'}`
    );
  }

  loadOriginalUT(feature) {
    this.clearAll();
    this.originalLayer.addData(feature);
    if (this.originalLayer.getBounds().isValid()) {
      this.map.fitBounds(this.originalLayer.getBounds(), { padding: [30, 30] });
    }

    // Copia editable independiente (deep clone para no compartir referencia)
    const editable = JSON.parse(JSON.stringify(feature));
    const layer = L.geoJSON(editable, {
      style: { color: '#1565c0', weight: 2, fillOpacity: 0.08 }
    });
    layer.eachLayer((l) => this.editableGroup.addLayer(l));
  }

  enableEditing() {
    if (this.drawControl) return;
    this.drawControl = new L.Control.Draw({
      position: 'topright',
      draw: false, // no permitir dibujar polígonos nuevos, solo editar el existente
      edit: {
        featureGroup: this.editableGroup,
        remove: false
      }
    });
    this.map.addControl(this.drawControl);
  }

  disableEditing() {
    if (this.drawControl) {
      this.map.removeControl(this.drawControl);
      this.drawControl = null;
    }
  }

  getOriginalGeoJSON() {
    const layers = this.originalLayer.getLayers();
    return layers[0] ? layers[0].toGeoJSON() : null;
  }

  getEditedGeoJSON() {
    const layers = this.editableGroup.getLayers();
    return layers[0] ? layers[0].toGeoJSON() : null;
  }

  showReferenceManzanas(featureCollection) {
    this.referenceLayer.clearLayers();
    if (featureCollection) this.referenceLayer.addData(featureCollection);
  }

  showAffected(feature) {
    this.affectedLayer.clearLayers();
    if (feature) {
      this.affectedLayer.addData(feature);
      if (this.affectedLayer.getBounds().isValid()) {
        this.map.fitBounds(this.affectedLayer.getBounds(), { padding: [40, 40] });
      }
    }
  }

  showManzanasResult(featureCollection) {
    this.manzanasResultLayer.clearLayers();
    if (featureCollection) this.manzanasResultLayer.addData(featureCollection);
  }

  showLocalidadResult(featureCollection) {
    this.localidadResultLayer.clearLayers();
    if (featureCollection) this.localidadResultLayer.addData(featureCollection);
  }

  toggleReferenceVisible(visible) {
    if (visible) this.map.addLayer(this.referenceLayer);
    else this.map.removeLayer(this.referenceLayer);
  }

  // Limpia solo lo derivado del análisis (zona afectada + resultados),
  // conservando el polígono original y el editable tal como están.
  clearDownstream() {
    this.affectedLayer.clearLayers();
    this.manzanasResultLayer.clearLayers();
    this.localidadResultLayer.clearLayers();
  }

  clearAll() {
    this.originalLayer.clearLayers();
    this.editableGroup.clearLayers();
    this.referenceLayer.clearLayers();
    this.affectedLayer.clearLayers();
    this.manzanasResultLayer.clearLayers();
    this.localidadResultLayer.clearLayers();
    this.disableEditing();
  }
}
