<?php
// api-proxy.php - AUTO-DETECCIÓN DE AMBIENTE (Desarrollo, Producción y Local)
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Requested-With');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// DETECTAR AMBIENTE AUTOMÁTICAMENTE
$currentHost = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
$serverAddr = isset($_SERVER['SERVER_ADDR']) ? $_SERVER['SERVER_ADDR'] : '';

// Configuración por ambiente
if (strpos($currentHost, '145.0.50.112') !== false || 
    strpos($serverAddr, '145.0.50.112') !== false || 
    strpos($currentHost, 'localhost') !== false ||
    strpos($currentHost, '127.0.0.1') !== false) {
    
    // AMBIENTE LOCAL (tu máquina de desarrollo)
    define('API_KEY', 'a1b2c3d4e5f6g7h8i9j0');
    define('API_BASE_URL', 'https://145.0.50.112/api/index.php'); // API DEV
    define('API_HOST', 'localhost');
    define('AMBIENTE', 'LOCAL');
    
} elseif (strpos($currentHost, 'devgeoutcdmx') !== false || 
          strpos($currentHost, 'dev_geoutcdmx') !== false) {
    
    // AMBIENTE DE DESARROLLO (servidor dev)
    define('API_KEY', 'a1b2c3d4e5f6g7h8i9j0');
    define('API_BASE_URL', 'https://145.0.90.250/index.php'); // API DEV
    define('API_HOST', 'devsiga.iecm.mx');
    define('AMBIENTE', 'DESARROLLO');
    
} else {
    
    // AMBIENTE DE PRODUCCIÓN
    define('API_KEY', 'a1b2c3d4e5f6g7h8i9j0'); // Cambiar si es diferente en prod
    define('API_BASE_URL', 'https://145.0.90.241/index.php'); // API PROD
    define('API_HOST', 'siga.iecm.mx');
    define('AMBIENTE', 'PRODUCCION');
}

// Obtener endpoint
$endpoint = isset($_GET['endpoint']) ? $_GET['endpoint'] : '';

if (empty($endpoint)) {
    http_response_code(400);
    echo json_encode(array('error' => 'Endpoint no especificado'));
    exit();
}

// Construir URL
$apiUrl = API_BASE_URL . '/' . ltrim($endpoint, '/');

// Construir parámetros
$queryParams = $_GET;
unset($queryParams['endpoint']);
$queryParams['api_key'] = API_KEY;

if (!empty($queryParams)) {
    $apiUrl .= '?' . http_build_query($queryParams);
}

// Inicializar cURL
$ch = curl_init();

curl_setopt($ch, CURLOPT_URL, $apiUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);

$headers = array(
    'Accept: application/json',
    'Host: ' . API_HOST
);
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

// Ejecutar petición
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);

curl_close($ch);

// Verificar error
if ($response === false) {
    http_response_code(500);
    echo json_encode(array(
        'error' => 'Error de conexion',
        'detalle' => $error,
        'ambiente' => AMBIENTE,
        'api_url' => API_BASE_URL // Para debug
    ));
    exit();
}

// Verificar que no sea HTML
if (strpos($response, '<!doctype') !== false || strpos($response, '<html') !== false) {
    http_response_code(401);
    echo json_encode(array(
        'error' => 'Respuesta invalida de la API',
        'ambiente' => AMBIENTE
    ));
    exit();
}

// Devolver respuesta
http_response_code($httpCode);
echo $response;
?>