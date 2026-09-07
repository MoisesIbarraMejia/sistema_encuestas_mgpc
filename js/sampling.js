// ============================================================
// sampling.js — fórmula de Cochran + regla de censo mínimo
//
// Implementa la "Propuesta nueva" de Analisis_Muestreo_MGPC2025.xlsx
// (hoja "3. Propuesta nueva"), NO el reparto proporcional en cascada
// del Documento Rector (Ciudad → Demarcación → UT → manzanas), que ese
// mismo análisis identifica como defectuoso: al heredar una fracción
// de la muestra de 398,045 calculada para los 9,209,944 habitantes de
// la CDMX, una modificación real que afecta a un puñado de manzanas
// termina arrojando 1-2 encuestas, un tamaño no representativo.
//
// Aquí, en cambio, la fórmula de Cochran (mismos Z=2.58, p=q=0.5,
// d=0.002 que ya usa el Documento Rector) se aplica DIRECTAMENTE sobre
// la población realmente afectada (N = manzanas + localidades que
// intersectan la zona afectada), con una regla de censo mínimo: si
// N ≤ umbral (100 por defecto), se encuesta al 100%.
//
// Validado celda por celda contra la hoja "4. Comparativo" del Excel
// (N=5,10,20,40,50,100,180,200,500,1000,2000,5000,10000 → coincide
// exactamente, incluyendo el redondeo).
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
