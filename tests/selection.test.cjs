const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  return { value: '', disabled: false, hidden: false, textContent: '', children: [], events: {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    addEventListener(name, callback) { this.events[name] = callback; } };
}
function harness() {
  const ids = [...fs.readFileSync('index.html', 'utf8').matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, element()]));
  const requests = [], contexts = [];
  const window = { location: { assign(url) { this.target = url; } } }; window.self = window; window.top = window;
  const sandbox = { window, document: { getElementById: id => elements.get(id) || null, createElement: element },
    MGPCWorkflow: { renderHeader() {}, getContext() { return null; }, setContext(context) { contexts.push(context); }, nextPath() { return contexts.at(-1)?.caseType === 'nomenclatura' ? 'encuestas.html' : 'editor-territorial.html'; }, paths: { survey: 'encuestas.html' } },
    Api: { getDistrictUTs(district) { return new Promise((resolve, reject) => requests.push({ district, resolve, reject })); } } };
  vm.runInNewContext(fs.readFileSync('js/config.js', 'utf8') + '\n' + fs.readFileSync('js/selection.js', 'utf8'), sandbox);
  return { elements, requests, contexts, window, async chooseDistrict(id) { const select = elements.get('district-select'); select.value = id; return select.events.change(); } };
}
const feature = (key, district, name = 'Unidad ' + key, section = 1) => ({ type: 'Feature', properties: { cve_ut: key, dtto_loc: district, nombre: name, secciones: String(section) } });
const collection = (...features) => ({ type: 'FeatureCollection', features });

test('catalogo uts_mgpc conserva propiedades y cuenta secciones completas y parciales sin duplicados', async () => {
  const h = harness();
  const loading = h.chooseDistrict('26');
  const properties = { cve_ut: '05-002', dtto_loc: '26', nombre: 'Unidad de prueba', dem_territ: 'Coyoacan', cve_demarc: '05', secciones: null, secciones1: '412, 413', ln_30_abr: 285, pobtot: 285 };
  h.requests[0].resolve(collection(
    { type: 'Feature', properties },
    { type: 'Feature', properties: { ...properties, cve_ut: '05-003', secciones: '0412, 413; 414', secciones1: ['413', '415', '', 'invalid'] } },
    { type: 'Feature', properties: { cve_ut: '05-004', dttol: '26', nombreut: 'Catalogo retirado', seccion: 412 } }
  ));
  await loading;
  const rows = h.elements.get('ut-list').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].children[3].textContent, '2 secc.');
  assert.equal(rows[1].children[0].children[3].textContent, '4 secc.');
  rows[0].children[0].children[0].events.change();
  h.elements.get('case-select').value = 'division';
  h.elements.get('case-select').events.change();
  h.elements.get('start-survey').events.click();
  const selected = h.contexts[0].ut;
  assert.equal(selected.name, properties.nombre);
  for (const [key, value] of Object.entries(properties)) assert.equal(selected.properties[key], value, key);
  assert.equal(selected.properties.demarcacion, properties.dem_territ);
  assert.equal(selected.properties.nombreut, properties.nombre);
});

test('el catálogo descarta respuestas de distritos anteriores y UT fuera del distrito', async () => {
  const h = harness();
  const first = h.chooseDistrict('1'); const latest = h.chooseDistrict('5');
  h.requests[1].resolve(collection(feature('02-001', '05'), feature('02-001', 5), feature('01-001', 1)));
  await latest;
  h.requests[0].resolve(collection(feature('01-002', 1))); await first;
  const list = h.elements.get('ut-list');
  assert.equal(list.children.length, 1);
  const radio = list.children[0].children[0].children[0]; assert.equal(radio.value, '02-001');
  radio.events.change();
  assert.equal(h.elements.get('start-survey').disabled, true);
  h.elements.get('case-select').value = 'division'; h.elements.get('case-select').events.change();
  h.elements.get('start-survey').events.click();
  assert.equal(h.contexts[0].district, '5'); assert.equal(h.contexts[0].ut.key, '02-001');
  assert.equal(h.contexts[0].caseType, 'division');
  assert.equal(h.window.location.target, 'editor-territorial.html');
});
test('búsqueda sin acentos y estado sin coincidencias', async () => {
  const h = harness(); const loading = h.chooseDistrict('5');
  h.requests[0].resolve(collection(feature('02-001', 5, 'Álamos Norte'))); await loading;
  const filter = h.elements.get('ut-filter'); filter.value = 'alamos'; filter.events.input();
  assert.equal(h.elements.get('ut-list').children.length, 1);
  filter.value = 'inexistente'; filter.events.input();
  assert.equal(h.elements.get('ut-list').hidden, true);
  assert.equal(h.elements.get('catalog-status-title').textContent, 'No hay coincidencias');
});
test('un fallo de API permite reintentar sin habilitar continuación', async () => {
  const h = harness(); const loading = h.chooseDistrict('5');
  h.requests[0].reject(new Error('API no disponible')); await loading;
  assert.equal(h.elements.get('retry-catalog').hidden, false);
  assert.equal(h.elements.get('start-survey').disabled, true);
  assert.equal(h.elements.get('catalog-status-description').textContent, 'API no disponible');
  const retry = h.elements.get('retry-catalog').events.click();
  h.requests[1].resolve(collection(feature('02-001', 5))); await retry;
  assert.equal(h.elements.get('ut-list').hidden, false);
});

test('nomenclatura pasa al cálculo y conserva el nombre; los casos pendientes no avanzan', async () => {
  const h=harness(); const loading=h.chooseDistrict('5');
  h.requests[0].resolve(collection(feature('02-001',5))); await loading;
  h.elements.get('ut-list').children[0].children[0].children[0].events.change();
  const select=h.elements.get('case-select'); select.value='combinacion'; select.events.change();
  assert.equal(h.elements.get('start-survey').disabled,true);
  h.elements.get('start-survey').events.click(); assert.equal(h.contexts.length,0);
  select.value='nomenclatura';select.events.change();h.elements.get('new-name').value='Nuevo nombre';
  assert.equal(h.elements.get('new-name-field').hidden,false);
  h.elements.get('start-survey').events.click();
  assert.equal(h.window.location.target,'encuestas.html');
  assert.equal(h.contexts[0].newName,'Nuevo nombre');
});
