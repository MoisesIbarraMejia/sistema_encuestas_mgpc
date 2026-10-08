/* Un único punto de configuración de Google Maps para ambas etapas. */
(function () {
  'use strict';
  const message = 'No se pudo cargar el mapa. Revisa tu conexión y la configuración de Google Maps.';
  function failed(detail) {
    const text = typeof detail === 'string' ? detail : message;
    const target = document.getElementById('map-error');
    if (target) { target.hidden = false; target.textContent = text; }
    const status = document.getElementById('log-footer') || document.getElementById('editor-status-text');
    if (status) status.textContent = text;
  }
  window.gm_authFailure = failed;
  const initialize = window.initMap;
  if (typeof initialize !== 'function') {
    failed('No se pudo iniciar la pantalla. Vuelve al inicio para cargar la versión actual de la aplicación.');
    return;
  }
  window.mgpcMapsReady = function () {
    try {
      return Promise.resolve(initialize()).catch(error => failed('No se pudo iniciar el mapa: ' + error.message));
    } catch (error) { failed('No se pudo iniciar el mapa: ' + error.message); }
  };
  if (!CONFIG.GOOGLE_MAPS_API_KEY) { failed(); return; }
  const script = document.createElement('script');
  const url = new URL('https://maps.googleapis.com/maps/api/js');
  url.search = new URLSearchParams({ key: CONFIG.GOOGLE_MAPS_API_KEY, loading: 'async', libraries: 'geometry', callback: 'mgpcMapsReady', v: 'quarterly', language: 'es', region: 'MX' });
  script.src = url.toString(); script.async = true; script.onerror = failed;
  document.head.appendChild(script);
})();
