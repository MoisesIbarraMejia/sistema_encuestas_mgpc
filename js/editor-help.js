/* Guía de entrada para los casos que se preparan moviendo puntos. */
(function () {
  'use strict';
  const context = MGPCWorkflow.getContext();
  if (!context || !['division','inc_exc_manzanas'].includes(context.caseType)) return;

  const dialog = document.getElementById('editor-help-dialog');
  const trigger = document.getElementById('btn-editor-help');
  const title = document.getElementById('editor-help-title');
  function openHelp() {
    if (dialog.open) return;
    dialog.showModal();
    dialog.scrollTop = 0;
    title.focus();
  }
  trigger.hidden = false;
  trigger.addEventListener('click', openHelp);
  ['btn-editor-help-close','btn-editor-help-start'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => dialog.close());
  });
  // Native dialog handles Escape, modal focus and the inert page underneath.
  dialog.addEventListener('close', () => trigger.focus());
  openHelp();
})();
