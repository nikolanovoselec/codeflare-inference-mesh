/**
 * Pick the opening view and close the IIFE.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_BOOT = `\
  // --- boot -------------------------------------------------------------------
  const bootView = state.view || document.body.dataset.view;
  setView(bootView);
  if (bootView === 'setup') {
    const target = state.recovery || liveToken || onCustomDomain || state.phase === 'unclaimed' ? phaseStep() : 'connect';
    setWizardStep(target);
  }
  if (bootView === 'dashboard') showDashboard();
})();`
