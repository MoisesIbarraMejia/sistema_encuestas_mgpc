<?php

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Requested-With');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}


/*
|--------------------------------------------------------------------------
| CONFIGURACIÓN
|--------------------------------------------------------------------------
*/

define(
    'API_BASE_URL',
    'https://145.0.50.112/api/index.php'
);

define(
    'API_KEY',
    'a1b2c3d4e5f6g7h8i9j0'
);


/*
|--------------------------------------------------------------------------
| ENDPOINT
|--------------------------------------------------------------------------
*/

$endpoint = $_GET['endpoint'] ?? '';

if ($endpoint === '') {

    http_response_code(400);

    echo json_encode([
        'error' => 'Endpoint no especificado'
    ]);

    exit();
}


/*
|--------------------------------------------------------------------------
| CONSTRUIR URL
|--------------------------------------------------------------------------
*/

$apiUrl =
    API_BASE_URL .
    '/' .
    ltrim($endpoint, '/');


/*
|--------------------------------------------------------------------------
| QUERY PARAMETERS
|--------------------------------------------------------------------------
*/

$queryParams = $_GET;

unset($queryParams['endpoint']);

$queryParams['api_key'] = API_KEY;

if (!empty($queryParams)) {

    $apiUrl .= '?' .
        http_build_query($queryParams);
}


/*
|--------------------------------------------------------------------------
| CURL
|--------------------------------------------------------------------------
*/

$ch = curl_init();

curl_setopt_array($ch, [

    CURLOPT_URL => $apiUrl,

    CURLOPT_RETURNTRANSFER => true,

    CURLOPT_FOLLOWLOCATION => false,

    CURLOPT_SSL_VERIFYPEER => false,

    CURLOPT_SSL_VERIFYHOST => false,

    CURLOPT_TIMEOUT => 60,

]);


/*
|--------------------------------------------------------------------------
| HEADERS
|--------------------------------------------------------------------------
*/

$headers = [
    'Accept: application/json'
];


/*
|--------------------------------------------------------------------------
| MÉTODO HTTP
|--------------------------------------------------------------------------
*/

$method =
    $_SERVER['REQUEST_METHOD'];


/*
|--------------------------------------------------------------------------
| POST
|--------------------------------------------------------------------------
*/

if ($method === 'POST') {

    $body =
        file_get_contents('php://input');

    $headers[] =
        'Content-Type: application/json';

    curl_setopt(
        $ch,
        CURLOPT_CUSTOMREQUEST,
        'POST'
    );

    curl_setopt(
        $ch,
        CURLOPT_POSTFIELDS,
        $body
    );
}


/*
|--------------------------------------------------------------------------
| HEADERS CURL
|--------------------------------------------------------------------------
*/

curl_setopt(
    $ch,
    CURLOPT_HTTPHEADER,
    $headers
);


/*
|--------------------------------------------------------------------------
| EJECUTAR
|--------------------------------------------------------------------------
*/

$response =
    curl_exec($ch);

$httpCode =
    curl_getinfo(
        $ch,
        CURLINFO_HTTP_CODE
    );

$error =
    curl_error($ch);

curl_close($ch);


/*
|--------------------------------------------------------------------------
| ERROR CURL
|--------------------------------------------------------------------------
*/

if ($response === false) {

    http_response_code(500);

    echo json_encode([
        'error' => 'Error de conexión con la Spatial API',
        'detalle' => $error
    ]);

    exit();
}


/*
|--------------------------------------------------------------------------
| VALIDAR RESPUESTA
|--------------------------------------------------------------------------
*/

$contentType =
    '';

if (
    stripos(
        $response,
        '<!doctype'
    ) !== false
    ||
    stripos(
        $response,
        '<html'
    ) !== false
) {

    http_response_code(502);

    echo json_encode([
        'error' =>
            'La Spatial API devolvió HTML en lugar de JSON'
    ]);

    exit();
}


/*
|--------------------------------------------------------------------------
| DEVOLVER RESPUESTA
|--------------------------------------------------------------------------
*/

http_response_code(
    $httpCode ?: 200
);

echo $response;