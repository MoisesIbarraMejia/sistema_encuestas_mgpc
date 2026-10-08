(function () {
  'use strict';
  MGPCWorkflow.renderHeader('home');
  const district = document.getElementById('district-select');
  const filter = document.getElementById('ut-filter');
  const list = document.getElementById('ut-list');
  const start = document.getElementById('start-survey');
  const error = document.getElementById('selection-error');
  const caseSelect = document.getElementById('case-select');
  const newName = document.getElementById('new-name');
  Object.entries(CONFIG.CASES).forEach(([id, details]) => {
    const option = document.createElement('option'); option.value = id;
    option.textContent = details.label + (details.pending ? ' · No disponible por ahora' : '');
    option.disabled = !!details.pending; caseSelect.append(option);
  });
  let units = [], selected = null, revision = 0;
  for (let number = 1; number <= 33; number++) {
    const option = document.createElement('option'); option.value = number; option.textContent = 'Distrito ' + String(number).padStart(2, '0'); district.append(option);
  }
  const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function status(title, description, retry = false) {
    document.getElementById('catalog-status').hidden = false;
    document.getElementById('catalog-status-title').textContent = title;
    document.getElementById('catalog-status-description').textContent = description;
    document.getElementById('retry-catalog').hidden = !retry;
    list.hidden = true;
  }
  function aggregate(data, districtId) {
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('El catálogo de UT no devolvió una colección válida.');
    const map = new Map();
    data.features.forEach(feature => {
      const p = feature.properties || {};
      // Se filtra también aquí para no mezclar territorios si el servidor ignora el filtro.
      if (Number(p.dtto_loc) !== Number(districtId) || !/^\d{2}-\d{3}$/.test(String(p.cve_ut || ''))) return;
      const key = String(p.cve_ut);
      const name = String(p.nombre || p.nombreut || key);
      if (!map.has(key)) map.set(key, { key, name, properties: { ...p, cve_ut: key, nombreut: name, dtto_loc: String(districtId), demarcacion: p.dem_territ || p.demarcacion || p.dem || '' }, sections: new Set() });
      // Conservar completas/parciales en sus campos originales; el contador
      // incluye ambas listas y evita repetir una misma seccion.
      [p.secciones, p.secciones1].forEach(value => {
        String(value ?? '').split(/[,;\s]+/).forEach(section => {
          if (/^\d+$/.test(section) && Number(section) > 0) map.get(key).sections.add(String(Number(section)));
        });
      });
    });
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
  function summary() {
    const caseInfo = CONFIG.CASES[caseSelect.value];
    start.disabled = !selected || !caseInfo || caseInfo.pending;
    start.textContent = caseSelect.value === 'nomenclatura' ? 'Calcular muestra →' : 'Preparar propuesta →';
    document.getElementById('selection-summary').textContent = selected ? 'Distrito ' + district.value + ' · ' + selected.key + ' · ' + selected.name + (caseInfo ? ' · ' + caseInfo.label : ' · Elige el tipo de caso.') : 'Selecciona una UT y un tipo de caso para continuar.';
  }
  function updateCaseHelp() {
    const details = CONFIG.CASES[caseSelect.value];
    document.getElementById('case-help').textContent = details?.instruction || 'Selecciona el cambio que deseas proponer.';
    document.getElementById('new-name-field').hidden = caseSelect.value !== 'nomenclatura';
    summary();
  }
  function render() {
    const query = normalize(filter.value);
    const visible = units.filter(ut => normalize(ut.key + ' ' + ut.name).includes(query));
    list.replaceChildren();
    document.getElementById('ut-count').textContent = visible.length + ' de ' + units.length + ' UT';
    if (!visible.length) { status('No hay coincidencias', 'Prueba con otra clave o nombre dentro de este distrito.'); return; }
    list.hidden = false; document.getElementById('catalog-status').hidden = true;
    visible.forEach((ut, index) => {
      const item = document.createElement('li'); item.className = 'ut-option';
      const label = document.createElement('label');
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'territorial-unit'; radio.value = ut.key; radio.checked = selected?.key === ut.key;
      radio.id = 'ut-option-' + index;
      radio.addEventListener('change', () => { selected = ut; error.hidden = true; summary(); });
      const key = document.createElement('span'); key.className = 'ut-key'; key.textContent = ut.key;
      const name = document.createElement('span'); name.className = 'ut-name'; name.textContent = ut.name;
      const count = document.createElement('span'); count.className = 'ut-count'; count.textContent = ut.sections.size + ' secc.';
      label.append(radio, key, name, count); item.append(label); list.append(item);
    });
  }
  async function load() {
    const request = ++revision, id = district.value;
    units = []; selected = null; filter.value = ''; filter.disabled = true; error.hidden = true; summary();
    document.getElementById('ut-count').textContent = id ? 'Cargando…' : 'Sin distrito';
    if (!id) { status('Primero, elige tu distrito', 'Aquí aparecerán sus unidades territoriales para iniciar el expediente.'); return; }
    status('Consultando unidades territoriales…', 'Buscando las UT del distrito ' + id + '.');
    try {
      const data = await Api.getDistrictUTs(id);
      if (revision !== request) return;
      units = aggregate(data, id);
      if (!units.length) { document.getElementById('ut-count').textContent = '0 UT'; status('Sin unidades territoriales', 'La API no devolvió UT para este distrito. Puedes volver a consultar o seleccionar otro.', true); return; }
      const context = MGPCWorkflow.getContext();
      if (context?.district === id) selected = units.find(ut => ut.key === context.ut.key) || null;
      filter.disabled = false; render(); summary();
    } catch (e) {
      if (revision !== request) return;
      document.getElementById('ut-count').textContent = 'Sin conexión';
      status('No se pudo cargar el catálogo', e.message || 'Revisa la conexión e inténtalo de nuevo.', true);
    }
  }
  district.addEventListener('change', load);
  caseSelect.addEventListener('change', updateCaseHelp);
  filter.addEventListener('input', render);
  document.getElementById('retry-catalog').addEventListener('click', load);
  start.addEventListener('click', () => {
    if (!selected || !CONFIG.CASES[caseSelect.value] || CONFIG.CASES[caseSelect.value].pending) return;
    try {
      MGPCWorkflow.setContext({ district: district.value, ut: { key: selected.key, name: selected.name, properties: selected.properties }, caseType: caseSelect.value, newName: caseSelect.value === 'nomenclatura' ? newName.value.trim() : '' });
      window.location.assign(MGPCWorkflow.nextPath());
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  });
  const context = MGPCWorkflow.getContext();
  if (context) {
    document.getElementById('resume-strip').hidden = false;
    document.getElementById('resume-text').textContent = 'Expediente activo · Distrito ' + context.district + ' · ' + context.ut.key + ' · ' + context.ut.name;
    document.getElementById('resume-link').href = MGPCWorkflow.nextPath();
    caseSelect.value = CONFIG.CASES[context.caseType]?.pending ? '' : context.caseType;
    newName.value = context.newName || '';
    updateCaseHelp();
    district.value = context.district; load();
  }
})();
