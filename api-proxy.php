<?php
/**
 * Proxy compartido por encuestas y revisión cartográfica.
 * Configuración opcional del servidor (nunca en JS):
 * MGPC_API_ENV=local|development|production
 * MGPC_API_BASE_URL, MGPC_API_HOST, MGPC_API_KEY, MGPC_API_WRITE_KEY
 * MGPC_API_VERIFY_SSL=true|false, MGPC_API_CAINFO=/ruta/certificado.pem
 * Los valores heredados mantienen la conexión de intranet existente.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function mgpcProxyError($status, $message) {
    http_response_code($status);
    echo json_encode(array('error' => $message), JSON_UNESCAPED_UNICODE);
    exit;
}

function mgpcEnv($name, $fallback = '') {
    $value = getenv($name);
    return $value === false ? $fallback : trim($value);
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method === 'OPTIONS') {
    header('Allow: GET, POST, OPTIONS');
    http_response_code(204);
    exit;
}
if (!in_array($method, array('GET', 'POST'), true)) {
    header('Allow: GET, POST, OPTIONS');
    mgpcProxyError(405, 'Método HTTP no permitido.');
}

// Lista cerrada de operaciones utilizadas por las dos etapas.
$routes = array(
    'filter_2/uts_mgpc' => array('GET'),
    'filter/secciones' => array('GET'),
    'filter_2/secciones' => array('GET'),
    'intersect/uts_mgpc' => array('POST'),
    'intersect/secciones' => array('POST'),
    'intersect/manzana' => array('POST'),
    'intersect/localidad' => array('POST'),
    'cache/store' => array('POST'),
    'create/historial_ajustes_ut' => array('POST')
);
$endpoint = $_GET['endpoint'] ?? '';
if (!is_string($endpoint) || $endpoint === '') {
    mgpcProxyError(400, 'Endpoint no especificado.');
}
$endpoint = ltrim($endpoint, '/');
if (!isset($routes[$endpoint])) {
    mgpcProxyError(404, 'Endpoint no permitido por la integración MGPC.');
}
if (!in_array($method, $routes[$endpoint], true)) {
    header('Allow: ' . implode(', ', $routes[$endpoint]));
    mgpcProxyError(405, 'El método HTTP no corresponde a este endpoint.');
}

// filter_2 utiliza las claves de query como identificadores SQL. No reenviar
// columnas arbitrarias ni arreglos proporcionados desde el navegador.
$routeFilters = array(
    'filter_2/uts_mgpc' => array('dtto_loc', 'cve_ut'),
    'filter/secciones' => array('clave'),
    'filter_2/secciones' => array('clave')
);
$allowedQuery = array('endpoint', 'modo', 'api_key', 'debug');
$filters = $routeFilters[$endpoint] ?? array();
if ($filters) $allowedQuery = array_merge($allowedQuery, $filters, array('limit', 'offset'));
foreach ($_GET as $name => $value) {
    if (!in_array($name, $allowedQuery, true) || !is_string($value)) {
        mgpcProxyError(400, 'Parámetro de consulta no permitido o con formato inválido.');
    }
}
if ($filters) {
    $providedFilters = array_values(array_filter($filters, function ($name) { return isset($_GET[$name]); }));
    if (count($providedFilters) !== 1) {
        mgpcProxyError(400, 'Se requiere exactamente un filtro para consultar esta tabla.');
    }
    $filter = $providedFilters[0];
    $filterValue = trim($_GET[$filter] ?? '');
    if ($filterValue === '' || strlen($filterValue) > 64) {
        mgpcProxyError(400, 'Se requiere un filtro válido para consultar esta tabla.');
    }
    if ($filter === 'dtto_loc' && (!ctype_digit($filterValue) || (int)$filterValue < 1 || (int)$filterValue > 33)) {
        mgpcProxyError(400, 'El distrito debe estar entre 1 y 33.');
    }
    if ($filter === 'cve_ut' && !preg_match('/^\d{2}-\d{3}$/D', $filterValue)) {
        mgpcProxyError(400, 'La clave de UT debe tener el formato 00-000.');
    }
    $_GET[$filter] = $filterValue;
    foreach (array('limit', 'offset') as $pagination) {
        if (!isset($_GET[$pagination])) continue;
        $value = $_GET[$pagination];
        $maximum = $pagination === 'limit' ? 10000 : 1000000;
        $minimum = $pagination === 'limit' ? 1 : 0;
        if (!ctype_digit($value) || strlen($value) > 7 || (int)$value < $minimum || (int)$value > $maximum) {
            mgpcProxyError(400, 'Los parámetros de paginación no son válidos.');
        }
    }
}

$host = strtolower(parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? 'localhost'), PHP_URL_HOST) ?? '');
$defaultEnvironment = defined('MGPC_PROXY_DEFAULT_ENV') ? MGPC_PROXY_DEFAULT_ENV : 'production';
if (in_array($host, array('localhost', '127.0.0.1', '[::1]'), true)) {
    $defaultEnvironment = 'local';
} elseif (strpos($host, 'devgeoutcdmx') !== false || strpos($host, 'dev_geoutcdmx') !== false) {
    $defaultEnvironment = 'development';
}
$environment = mgpcEnv('MGPC_API_ENV', $defaultEnvironment);
$profiles = array(
    'local' => array('https://145.0.50.112/api/index.php', ''),
    'development' => array('https://145.0.90.250/index.php', 'devsiga.iecm.mx'),
    'production' => array('https://145.0.90.241/index.php', 'siga.iecm.mx')
);
if (!isset($profiles[$environment])) {
    mgpcProxyError(500, 'MGPC_API_ENV debe ser local, development o production.');
}
list($defaultUrl, $defaultHost) = $profiles[$environment];
$baseUrl = rtrim(mgpcEnv('MGPC_API_BASE_URL', $defaultUrl), '/');
// Al configurar otra URL no heredar el Host de la intranet anterior.
$apiHost = mgpcEnv('MGPC_API_HOST', $baseUrl === $defaultUrl ? $defaultHost : '');
$urlParts = parse_url($baseUrl);
if (!$urlParts || !in_array($urlParts['scheme'] ?? '', array('https', 'http'), true)
    || empty($urlParts['host']) || isset($urlParts['query']) || isset($urlParts['fragment'])
    || isset($urlParts['user']) || isset($urlParts['pass']) || preg_match('/[\r\n]/', $apiHost)) {
    mgpcProxyError(500, 'La configuración de conexión de la API no es válida.');
}

// El permiso de escritura depende de la ruta, no de un parámetro del navegador.
$isWrite = $endpoint === 'create/historial_ajustes_ut';
$readKey = mgpcEnv('MGPC_API_KEY', 'a1b2c3d4e5f6g7h8i9j0');
$writeKey = mgpcEnv('MGPC_API_WRITE_KEY', 'xyz123456789');
$key = $isWrite ? $writeKey : $readKey;
if ($key === '' || preg_match('/[\r\n]/', $key)) {
    mgpcProxyError(503, 'No se configuró la clave de acceso requerida para la API.');
}
$queryParams = $_GET;
unset($queryParams['endpoint'], $queryParams['modo'], $queryParams['api_key'], $queryParams['debug']);
$apiUrl = $baseUrl . '/' . $endpoint . '?' . http_build_query($queryParams);

$body = null;
if ($method !== 'GET') {
    $body = file_get_contents('php://input');
    if ($body === false || $body === '') {
        mgpcProxyError(400, 'Se requiere un cuerpo JSON para esta operación.');
    }
    json_decode($body);
    if (json_last_error() !== JSON_ERROR_NONE) {
        mgpcProxyError(400, 'El cuerpo de la solicitud no es JSON válido.');
    }
}
if (!extension_loaded('curl')) {
    mgpcProxyError(503, 'La extensión cURL de PHP no está habilitada.');
}

// Conservar certificados de intranet heredados. Activar verificación al
// instalar el certificado de confianza o indicar MGPC_API_CAINFO.
$caInfo = mgpcEnv('MGPC_API_CAINFO');
$verifySsl = filter_var(mgpcEnv('MGPC_API_VERIFY_SSL', $caInfo !== '' || $baseUrl !== $defaultUrl ? 'true' : 'false'), FILTER_VALIDATE_BOOLEAN);
$headers = array('Accept: application/json', 'X-API-Key: ' . $key);
if ($apiHost !== '') $headers[] = 'Host: ' . $apiHost;
if ($body !== null) $headers[] = 'Content-Type: application/json';
$ch = curl_init($apiUrl);
curl_setopt_array($ch, array(
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_SSL_VERIFYPEER => $verifySsl,
    CURLOPT_SSL_VERIFYHOST => $verifySsl ? 2 : 0,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT => 60,
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => $headers
));
if ($caInfo !== '') curl_setopt($ch, CURLOPT_CAINFO, $caInfo);
if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
$response = curl_exec($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_errno($ch);
curl_close($ch);
if ($response === false || $httpCode === 0) {
    mgpcProxyError($curlError === CURLE_OPERATION_TIMEDOUT ? 504 : 502,
        'No se pudo conectar con la API. Revisa la conexión de intranet y la configuración del servidor.');
}
if ($httpCode === 204) {
    http_response_code(204);
    exit;
}
json_decode($response);
if (json_last_error() !== JSON_ERROR_NONE) {
    mgpcProxyError(502, 'La API devolvió una respuesta que no es JSON válido.');
}
http_response_code($httpCode);
echo $response;
