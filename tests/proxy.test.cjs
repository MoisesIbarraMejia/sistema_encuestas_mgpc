'use strict';

// Run: node --test tests/proxy.test.cjs
// Only uses loopback HTTP fixtures; never connects to the real Spatial API.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

test('shared PHP proxy forwards methods/bodies and rejects invalid operations', { timeout: 20000 }, async () => {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, endpoint: url.pathname.replace('/index.php/', ''), body, url, key: req.headers['x-api-key'] });
    const fixture = url.searchParams.get('cve_ut');
    if (fixture === '99-001') { res.end('<html>invalid</html>'); return; }
    if (fixture === '99-003') { res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (fixture === '99-002') { res.writeHead(422); res.end(JSON.stringify({ error: 'Fixture rejected' })); return; }
    res.end(JSON.stringify({ ok: true }));
  });
  let php;
  try {
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const reserve = http.createServer();
    reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const proxyPort = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const phpBinary = process.env.PHP_BINARY || (process.platform === 'win32' ? 'C:/xampp/php/php.exe' : 'php');
    php = spawn(phpBinary, ['-S', '127.0.0.1:' + proxyPort, '-t', path.resolve(__dirname, '..')], {
      env: {
        ...process.env,
        MGPC_API_ENV: 'local',
        MGPC_API_BASE_URL: 'http://127.0.0.1:' + backend.address().port + '/index.php',
        MGPC_API_HOST: '', MGPC_API_KEY: 'test-read', MGPC_API_WRITE_KEY: 'test-write'
      },
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    });
    let launchError;
    php.on('error', error => { launchError = error; });
    php.stderr.resume();
    const filters = {
      'filter_2/uts_mgpc': 'cve_ut=05-030',
      'filter/secciones': 'clave=05-030', 'filter_2/secciones': 'clave=05-030'
    };
    const call = (file, endpoint, method = 'GET', body, extra = '', query = filters[endpoint]) => fetch(
      'http://127.0.0.1:' + proxyPort + '/' + file + '?endpoint=' + encodeURIComponent(endpoint) +
        (query ? '&' + query : '') + extra,
      { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) }
    );
    let ready = false;
    for (let retry = 0; retry < 50; retry++) {
      if (launchError) throw launchError;
      try { await call('api-proxy.php', '', 'OPTIONS'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'PHP fixture server could not start.');
    const routes = {
      'filter_2/uts_mgpc': 'GET',
      'filter/secciones': 'GET', 'filter_2/secciones': 'GET',
      'intersect/uts_mgpc': 'POST', 'intersect/secciones': 'POST', 'intersect/manzana': 'POST',
      'intersect/localidad': 'POST', 'cache/store': 'POST',
      'create/historial_ajustes_ut': 'POST'
    };
    for (const file of ['api-proxy.php', 'api-proxy_local.php']) {
      const options = await call(file, '', 'OPTIONS');
      assert.equal(options.status, 204);
      assert.equal(options.headers.get('Allow'), 'GET, POST, OPTIONS');
      for (const [endpoint, method] of Object.entries(routes)) {
        const payload = method === 'GET' ? undefined : JSON.stringify({
          where: [{ column: 'cve_ut', value: '05-030' }], data: { nombre: 'Fixture' }
        });
        const response = await call(file, endpoint, method, payload, '&modo=escritura&api_key=ignored');
        assert.equal(response.status, 200, endpoint + ': ' + await response.text());
        const forwarded = calls.at(-1);
        assert.equal(forwarded.method, method); assert.equal(forwarded.endpoint, endpoint);
        assert.equal(forwarded.body, payload || '');
        assert.equal(forwarded.key, endpoint === 'create/historial_ajustes_ut' ? 'test-write' : 'test-read');
        assert.equal(forwarded.url.searchParams.has('api_key'), false, 'Keys must not enter URL/query logs.');
        assert.equal(forwarded.url.searchParams.has('modo'), false);
        if (filters[endpoint]) {
          const [filter, value] = filters[endpoint].split('=');
          assert.equal(forwarded.url.searchParams.get(filter), value);
        }
      }
      const districtCatalog = await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '', 'dtto_loc=26&limit=1000&offset=0');
      assert.equal(districtCatalog.status, 200);
      assert.equal(calls.at(-1).endpoint, 'filter_2/uts_mgpc');
      assert.equal(calls.at(-1).url.searchParams.get('dtto_loc'), '26');
      assert.equal(calls.at(-1).url.searchParams.has('cve_ut'), false);
      assert.equal(calls.at(-1).key, 'test-read');
      const before = calls.length;
      assert.equal((await call(file, '../filter_2/uts_mgpc')).status, 404);
      for (const endpoint of ['filter_2/mesas_2396', 'patch/secciones_mro_2396_c', 'update/mesas_2396', 'create/historial_mesas']) {
        assert.equal((await call(file, endpoint)).status, 404, endpoint + ' must no longer be exposed.');
      }
      assert.equal((await call(file, 'create/historial_mesas', 'POST', '{}')).status, 404);
      for (const [endpoint, method] of [['patch/secciones_mro_2396_c', 'PATCH'], ['update/mesas_2396', 'PUT'], ['update/uts_mgpc', 'PUT']]) {
        const response = await call(file, endpoint, method, '{}');
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('Allow'), 'GET, POST, OPTIONS');
      }
      assert.equal((await call(file, 'create/historial_ajustes_ut')).status, 405);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'DELETE')).status, 405);
      assert.equal((await call(file, 'intersect/manzana', 'POST', 'invalid')).status, 400);
      assert.equal((await call(file, 'intersect/manzana', 'POST', '')).status, 400);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&arbitrary_column=1')).status, 400);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&x%60%3D1%23=1')).status, 400);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&cve_ut%5B%5D=05-030')).status, 400);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&limit=-1')).status, 400);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&limit=10001')).status, 400);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&cve_ut=')).status, 400);
      assert.equal((await call(file, 'filter_2/secciones_mro_2396_c', 'GET', undefined, '&dttol=26')).status, 404);
      for (const query of ['', 'dtto_loc=', 'dtto_loc=0', 'dtto_loc=34', 'dtto_loc=2.5', 'dtto_loc=abc', 'dtto_loc%5B%5D=26', 'dtto_loc=26&cve_ut=05-030', 'dttol=26', 'cve_ut=invalid']) {
        assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '', query)).status, 400, 'Invalid catalog/UT filter: ' + query);
      }
      assert.equal(calls.length, before, 'Rejected requests must not reach the API.');
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&cve_ut=99-001')).status, 502);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&cve_ut=99-002')).status, 422);
      assert.equal((await call(file, 'filter_2/uts_mgpc', 'GET', undefined, '&cve_ut=99-003')).status, 204);
    }
  } finally {
    if (php?.pid) php.kill();
    if (backend.listening) await new Promise(resolve => backend.close(resolve));
  }
});
