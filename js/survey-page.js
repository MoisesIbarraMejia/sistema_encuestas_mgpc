(function () {
  'use strict';
  const context = MGPCWorkflow.requireContext('survey');
  MGPCWorkflow.renderHeader('survey');
  if (!context) return;
  document.getElementById('survey-ut-name').textContent = context.ut.name;
  document.getElementById('survey-ut-key').textContent = 'Distrito ' + context.district + ' · UT ' + context.ut.key;
  document.getElementById('survey-case-label').textContent = CONFIG.CASES[context.caseType].label;
  const scopes = {
    division: 'Se considera toda la UT original, aunque hayas preparado nuevos límites. La propuesta de división ya quedó registrada para esta sesión.',
    fusion: 'Se considera la unión de la UT principal y las UT vecinas que elegiste para fusionar.',
    nomenclatura: 'Se considera toda la UT original. El cambio de nombre no modifica sus límites.',
    inc_exc_secciones: 'Se considera la zona que cambia al incluir o quitar las secciones que elegiste.',
    inc_exc_manzanas: 'Se considera la zona que cambia entre el límite original y el que preparaste.'
  };
  document.getElementById('survey-scope').textContent = scopes[context.caseType];
  const editLink = document.getElementById('survey-edit-link');
  if (context.caseType === 'nomenclatura') {editLink.href = MGPCWorkflow.paths.home; editLink.textContent = '← Volver a los datos del caso';}
  const button = document.getElementById('btn-continuar-etapa2');
  button.disabled = !MGPCWorkflow.hasSurvey();
  button.addEventListener('click', () => { if (MGPCWorkflow.hasSurvey()) window.location.assign(MGPCWorkflow.paths.review); });
})();
