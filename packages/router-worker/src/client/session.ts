/**
 * Sign-in, sign-out, and arming a destructive button before it fires.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_SESSION = `\
  // --- login ----------------------------------------------------------------
  async function signIn(rawToken, remember) {
    const candidate = rawToken.trim();
    liveToken = candidate;
    try {
      await request('/admin/login', { method: 'POST', headers: headers(false) });
    } catch (error) {
      liveToken = savedToken();
      throw error;
    }
    storeToken(candidate, remember);
    setOutput('login-output', 'Signed in');
    if (state.phase === 'complete') showDashboard(); else { setView('setup'); setWizardStep(phaseStep()); }
  }
  const signOut = () => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
    storeToken('', false);
    liveToken = '';
    setView('setup');
    setWizardStep('connect');
    setOutput('login-output', 'Signed out. The token was removed from this browser.');
    toast('Signed out');
  };

  // --- destructive-action arming ---------------------------------------------
  const disarm = (button) => {
    if (!button || button.dataset.armed !== 'true') return;
    delete button.dataset.armed;
    button.classList.remove('is-armed');
    if (button.dataset.label) button.textContent = button.dataset.label;
    if (armedButton === button) armedButton = undefined;
  };
  const armOrProceed = (button) => {
    if (!button.dataset.confirm) return true;
    if (button.dataset.armed === 'true') { disarm(button); return true; }
    if (armedButton && armedButton !== button) disarm(armedButton);
    button.dataset.label = button.textContent;
    button.dataset.armed = 'true';
    button.classList.add('is-armed');
    button.textContent = button.dataset.confirm;
    armedButton = button;
    if (disarmTimer) clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => disarm(button), config.confirm.disarmMs);
    return false;
  };

`
