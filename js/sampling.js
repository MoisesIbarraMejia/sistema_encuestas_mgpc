// ============================================================
// sampling.js — fórmula de Cochran + regla de censo mínimo
// Misma lógica que la hoja "3. Propuesta nueva" del análisis en Excel.
// ============================================================
const Sampling = (() => {

  // n = (N·Z²·p·q) / (d²·(N-1) + Z²·p·q)
  function cochran(N, { Z, p, q, d } = CONFIG.SAMPLING) {
    if (N <= 0) return 0;
    return (N * Z ** 2 * p * q) / (d ** 2 * (N - 1) + Z ** 2 * p * q);
  }

  // Aplica la regla de censo mínimo: si N <= umbral, se censa al 100%.
  function computeSampleSize(N, params = CONFIG.SAMPLING) {
    N = Math.round(N);
    if (N <= 0) {
      return { N, n: 0, method: 'sin_poblacion' };
    }
    if (N <= params.censusThreshold) {
      return { N, n: N, method: 'censo' };
    }
    const raw = cochran(N, params);
    return { N, n: Math.round(raw), method: 'muestreo' };
  }

  return { cochran, computeSampleSize };
})();
