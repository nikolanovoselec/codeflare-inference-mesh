/**
 * Which view and section is showing, the setup wizard step machine, and the one-time token reveal.
 *
 * A fragment of the console script, not a standalone module: it is concatenated
 * verbatim into one IIFE by `../admin-ui-client`. Zero interpolation, by rule.
 */
export const CLIENT_VIEW = `\
  // --- view + section state -------------------------------------------------
  const setMobileMenu = (open) => {
    const sheet = byId('mobile-menu');
    if (sheet) sheet.hidden = !open;
    const button = byId('mobile-menu-toggle');
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const setView = (mode) => {
    document.body.dataset.view = mode;
    ['setup', 'dashboard'].forEach((view) => { const el = byId('view-' + view); if (el) el.hidden = view !== mode; });
    const signOut = byId('sign-out-btn');
    if (signOut) signOut.hidden = mode !== 'dashboard' || !liveToken;
    const menuToggle = byId('mobile-menu-toggle');
    if (menuToggle) menuToggle.hidden = mode !== 'dashboard';
    if (mode !== 'dashboard') setMobileMenu(false);
  };
  const setSection = (name) => {
    config.nav.sections.forEach((section) => {
      const panel = byId(section);
      if (panel) panel.dataset.active = String(section === name);
      document.querySelectorAll('[data-nav="' + section + '"]').forEach((item) => {
        if (section === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      });
    });
    setMobileMenu(false);
    // Opening Routing discovers the operator's gateways from the runtime token.
    if (name === 'routing') loadGatewayOptions('', 'routing').catch(() => undefined);
    // Opening the Playground lists inference targets (the direct router plus any gateways).
    if (name === 'playground') loadPlaygroundTargets().catch(() => undefined);
  };
  let appliedRole;
  const userAllowedSections = ['overview', 'playground'];
  function applyRole(role) {
    if (role === appliedRole) return;
    appliedRole = role;
    const restricted = role === 'user';
    config.nav.sections.forEach((section) => {
      const restrict = restricted && userAllowedSections.indexOf(section) < 0;
      const panel = byId(section);
      if (panel) panel.hidden = restrict;
      document.querySelectorAll('[data-nav="' + section + '"]').forEach((navItem) => { navItem.hidden = restrict; });
    });
    if (restricted) setSection('overview');
  }
  const schedulePoll = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (document.hidden || document.body.dataset.view !== 'dashboard') return;
      // A refresh rebuilds the cards and would drop a pending confirm; hold it while a
      // destructive action is armed, and resume on the next tick after the arm clears.
      if (armedButton && armedButton.dataset.armed === 'true') { schedulePoll(); return; }
      refreshStatus().catch(() => undefined);
      schedulePoll();
    }, config.polling.intervalMs);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.body.dataset.view !== 'dashboard') return;
    if (document.hidden) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      return;
    }
    refreshStatus().catch(() => undefined);
    schedulePoll();
  });
  const showDashboard = () => {
    setView('dashboard');
    setSection(config.nav.sections[0]);
    refreshStatus().catch(() => undefined);
    loadVersions().catch(() => undefined);
    loadRuntimeVersions().catch(() => undefined);
    loadInstaller('').catch(() => undefined);
    loadApiKeys().catch(() => undefined);
    closeDrawer();
    schedulePoll();
  };

  // --- wizard ---------------------------------------------------------------
  const wizardSteps = config.wizard.steps;
  const phaseStep = () => {
    if (state.recovery) return 'domain';
    return config.wizard.phaseSteps[state.phase] || 'connect';
  };
  const setWizardStep = (step) => {
    wizardSteps.forEach((name, index) => {
      const panel = byId('step-' + name);
      if (panel) panel.hidden = name !== step;
      const marker = document.querySelector('[data-step="' + name + '"]');
      if (marker) {
        if (name === step) marker.setAttribute('aria-current', 'step'); else marker.removeAttribute('aria-current');
        marker.dataset.done = String(index < wizardSteps.indexOf(step));
      }
    });
    if (step === 'domain') loadZones().catch(() => undefined);
    if (step === 'gateway') loadGatewayOptions('').catch(() => undefined);
    if (step === 'review') renderReview().catch(() => undefined);
  };
  const wizardMove = (delta) => {
    const current = wizardSteps.find((name) => { const panel = byId('step-' + name); return panel && !panel.hidden; }) || wizardSteps[0];
    const next = wizardSteps[Math.min(wizardSteps.length - 1, Math.max(0, wizardSteps.indexOf(current) + delta))];
    setWizardStep(next);
  };
  async function renderReview() {
    const summary = byId('review-summary');
    if (!summary || (!liveToken && !onCustomDomain)) return;
    const status = await request('/admin/status', { headers: headers(false) });
    summary.textContent = '';
    const nodes = Array.isArray(status.nodes) ? status.nodes : [];
    const gateway = status.gateway || {};
    const domain = status.customDomain || {};
    const lines = [
      ['Custom domain', domain.hostname ? String(domain.hostname) : 'not configured'],
      ['Access', state.phase === 'access_ready' || state.phase === 'complete' ? 'enabled' : 'not enabled'],
      ['AI Gateway', gateway.gatewayId ? String(gateway.gatewayId) : 'not connected (available under Routing)'],
      ['Nodes enrolled', String(nodes.length)]
    ];
    lines.forEach((pair) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const label = document.createElement('strong');
      label.textContent = pair[0];
      const value = document.createElement('code');
      value.textContent = pair[1];
      tile.append(label, value);
      summary.appendChild(tile);
    });
  }

  // --- one-time token reveal ------------------------------------------------
  function renderTokens(targetId, values) {
    const el = byId(targetId);
    if (!el) return;
    el.classList.remove('is-error');
    el.textContent = '';
    const entries = Object.entries(values).filter((pair) => typeof pair[1] === 'string' && pair[0] !== 'byokInstruction' && pair[0] !== 'adminToken');
    const warning = document.createElement('p');
    warning.className = 'token-warning';
    warning.setAttribute('data-token-warning', 'true');
    warning.textContent = 'Save these now. They are shown only once and are stored hashed.';
    el.appendChild(warning);
    entries.forEach((pair) => {
      const card = document.createElement('div');
      card.className = 'token-card';
      card.setAttribute('data-token-card', pair[0]);
      const label = document.createElement('strong');
      label.textContent = pair[0];
      const code = document.createElement('code');
      code.textContent = pair[1];
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn';
      copy.textContent = 'Copy';
      copy.dataset.copy = pair[1];
      card.append(label, code, copy);
      el.appendChild(card);
    });
    if (entries.length > 1) {
      const copyAll = document.createElement('button');
      copyAll.type = 'button';
      copyAll.className = 'btn';
      copyAll.textContent = 'Copy all';
      copyAll.setAttribute('data-copy-all', 'true');
      copyAll.dataset.copy = entries.map((pair) => pair[0] + ': ' + pair[1]).join('\\n');
      el.appendChild(copyAll);
    }
  }
  function revealKey(targetId, label, token, note) {
    const el = byId(targetId);
    if (!el) return;
    el.classList.remove('is-error');
    el.textContent = '';
    if (note) {
      const warning = document.createElement('p');
      warning.className = 'token-warning';
      warning.setAttribute('data-token-warning', 'true');
      warning.textContent = note;
      el.appendChild(warning);
    }
    const card = document.createElement('div');
    card.className = 'token-card';
    card.setAttribute('data-token-card', label);
    const labelEl = document.createElement('strong');
    labelEl.textContent = label;
    const code = document.createElement('code');
    code.textContent = token;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = 'Copy';
    copy.dataset.copy = token;
    card.append(labelEl, code, copy);
    el.appendChild(card);
  }
  const revealGatewayKey = (out, body) => {
    if (body && body.providerToken) revealKey(out, 'AI Gateway provider key', body.providerToken, body.byokInstruction || 'Paste this key into your AI Gateway custom provider.');
    else setOutput(out, 'Gateway provisioned.');
  };

`
