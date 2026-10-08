<?php
// Alias conservado para las instalaciones locales existentes. Ambas etapas
// comparten rutas, permisos, claves y tratamiento de errores en un solo proxy.
// MGPC_API_ENV permite elegir otro perfil sin modificar este archivo.
define('MGPC_PROXY_DEFAULT_ENV', 'local');
require __DIR__ . '/api-proxy.php';
