export interface AdminUiAction {
  readonly id: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly auth: 'open' | 'admin'
}

export const ADMIN_UI_ACTIONS: readonly AdminUiAction[] = [
  { id: 'first-run-setup', method: 'POST', path: '/admin/setup', auth: 'open' },
  { id: 'admin-login', method: 'POST', path: '/admin/login', auth: 'admin' },
  { id: 'status-refresh', method: 'GET', path: '/admin/status', auth: 'admin' },
  { id: 'setup-token-create', method: 'POST', path: '/admin/setup-tokens', auth: 'admin' },
  { id: 'installer-linux', method: 'GET', path: '/admin/installers/linux', auth: 'admin' },
  { id: 'installer-macos', method: 'GET', path: '/admin/installers/macos', auth: 'admin' },
  { id: 'installer-windows', method: 'GET', path: '/admin/installers/windows', auth: 'admin' },
  { id: 'gateway-sync', method: 'POST', path: '/admin/cloudflare/gateway/sync', auth: 'admin' },
  { id: 'custom-domain-validate', method: 'POST', path: '/admin/custom-domain/validate', auth: 'admin' },
  { id: 'node-revoke', method: 'POST', path: '/admin/nodes/{nodeId}/revoke', auth: 'admin' },
  { id: 'profile-rollout', method: 'POST', path: '/admin/profiles/rollout', auth: 'admin' }
] as const

const ADMIN_FORMS = [
  { id: 'setup', action: 'first-run-setup', title: 'First-run setup', description: 'Create admin, provider, setup, and upstream credentials for this Worker.' },
  { id: 'login', action: 'admin-login', title: 'Admin token', description: 'Store an admin token in this browser and verify access before running protected actions.' },
  { id: 'status', action: 'status-refresh', title: 'Status', description: 'Refresh redacted router state, nodes, profiles, and recent audit events.' },
  { id: 'setup-token', action: 'setup-token-create', title: 'Setup token', description: 'Create a short-lived token for enrolling one node.' },
  { id: 'installer', action: 'installer-linux', title: 'Installers', description: 'Generate Linux, macOS, or Windows install commands backed by release artifacts.' },
  { id: 'gateway', action: 'gateway-sync', title: 'AI Gateway', description: 'Sync the custom provider, dynamic route, version, and deployment metadata.' },
  { id: 'domain', action: 'custom-domain-validate', title: 'Custom domain', description: 'Validate a hostname before switching Gateway traffic to a custom origin.' },
  { id: 'node', action: 'node-revoke', title: 'Node controls', description: 'Revoke a node from scheduling when it should no longer receive traffic.' },
  { id: 'profile', action: 'profile-rollout', title: 'Profile rollout', description: 'Adjust an active profile rollout percentage with a versioned config update.' }
] as const

export const ADMIN_UI_RESPONSIVE = {
  mobileBreakpointPx: 760,
  desktopMinColumns: 2,
  minTouchTargetPx: 44
} as const

export function adminUiHtml(workerOrigin: string): string {
  const config = JSON.stringify({ workerOrigin, actions: ADMIN_UI_ACTIONS, responsive: ADMIN_UI_RESPONSIVE })
  return `<!doctype html>
<html lang="en" data-admin-ui="codeflare-inference-mesh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codeflare Inference Mesh Admin</title>
  <style>${adminUiCss()}</style>
</head>
<body>
  <div class="shell" data-layout="admin-shell" data-responsive="desktop mobile">
    <header class="topbar">
      <a class="brand" href="/admin" aria-label="Codeflare Inference Mesh admin home">
        <span class="brand-mark" aria-hidden="true"></span>
        <span><strong>Inference Mesh</strong><small>Admin configuration</small></span>
      </a>
      <nav class="nav" aria-label="Admin sections">
        ${ADMIN_FORMS.map((form) => `<a href="#${form.id}">${form.title}</a>`).join('')}
      </nav>
    </header>

    <main class="main">
      <section class="hero" aria-labelledby="admin-title">
        <div>
          <p class="kicker">Private inference control plane</p>
          <h1 id="admin-title">Configure the router from the browser.</h1>
          <p class="lede">Use this screen for first-run setup, admin access, Gateway sync, node enrollment, node controls, profile rollout, and status checks.</p>
        </div>
        <aside class="health-panel" aria-label="Router health">
          <span class="status-dot" aria-hidden="true"></span>
          <span>Worker shell loaded</span>
          <code id="origin-label"></code>
        </aside>
      </section>

      <section class="workspace" aria-label="Admin configuration workspace">
        <div class="panel command-panel" id="setup" data-form="setup">
          ${panelHeader('First-run setup', 'Create credentials once, copy them immediately, then store the admin token locally if this is your browser.')}
          <button class="primary" type="button" data-action="first-run-setup">Run first-run setup</button>
          <div class="token-grid" id="setup-output" data-output="setup-tokens" aria-live="polite"></div>
        </div>

        <div class="panel" id="login" data-form="login">
          ${panelHeader('Admin token', 'Paste the admin token generated during setup. It stays in browser storage, not D1 plaintext.')}
          <label>Admin token<input name="adminToken" id="admin-token" autocomplete="off" type="password"></label>
          <label class="check"><input name="rememberToken" id="remember-token" type="checkbox"> Remember on this device</label>
          <div class="button-row">
            <button type="button" data-action="admin-login">Verify token</button>
            <button class="secondary" type="button" data-action="forget-token">Forget token</button>
          </div>
        </div>

        <div class="panel wide" id="status" data-form="status">
          ${panelHeader('Status', 'Redacted operational state from /admin/status. Plaintext credentials are never read back.')}
          <button type="button" data-action="status-refresh">Refresh status</button>
          <div class="status-grid" id="status-output" data-output="status" aria-live="polite"></div>
        </div>

        <div class="panel" id="setup-token" data-form="setup-token">
          ${panelHeader('Setup token', 'Generate a one-time node enrollment token, then use an installer command before it expires.')}
          <button type="button" data-action="setup-token-create">Create setup token</button>
          <div id="setup-token-output" data-output="setup-token" aria-live="polite"></div>
        </div>

        <div class="panel" id="installer" data-form="installer">
          ${panelHeader('Installers', 'Generate an install command for the target operating system.')}
          <label>Platform<select name="platform" id="installer-platform"><option value="linux">Linux</option><option value="macos">macOS</option><option value="windows">Windows</option></select></label>
          <button type="button" data-action="installer-generate">Generate installer command</button>
          <pre class="command" id="installer-output" data-output="installer-command" tabindex="0"></pre>
        </div>

        <div class="panel" id="gateway" data-form="gateway">
          ${panelHeader('AI Gateway', 'Create or update the custom provider and dynamic route using runtime Cloudflare credentials.')}
          <button type="button" data-action="gateway-sync">Sync Gateway route</button>
          <pre id="gateway-output" data-output="gateway-sync" tabindex="0"></pre>
        </div>

        <div class="panel" id="domain" data-form="custom-domain">
          ${panelHeader('Custom domain', 'Validate a hostname before wiring it into Gateway or DNS automation.')}
          <label>Hostname<input name="hostname" id="custom-domain" placeholder="ai.example.com" inputmode="url"></label>
          <button type="button" data-action="custom-domain-validate">Validate hostname</button>
          <pre id="domain-output" data-output="custom-domain" tabindex="0"></pre>
        </div>

        <div class="panel" id="node" data-form="node-revoke">
          ${panelHeader('Node controls', 'Revoke a node so it stops receiving scheduled inference traffic.')}
          <label>Node ID<input name="nodeId" id="node-id" autocomplete="off"></label>
          <button class="danger" type="button" data-action="node-revoke">Revoke node</button>
          <pre id="node-output" data-output="node-revoke" tabindex="0"></pre>
        </div>

        <div class="panel" id="profile" data-form="profile-rollout">
          ${panelHeader('Profile rollout', 'Set rollout percentage for an existing model profile.')}
          <label>Profile ID<input name="profileId" id="profile-id" autocomplete="off" placeholder="gemma4-26b-a4b-256k-3090"></label>
          <label>Rollout percent<input name="rolloutPercent" id="rollout-percent" type="number" min="0" max="100" step="1" value="100"></label>
          <button type="button" data-action="profile-rollout">Update rollout</button>
          <pre id="profile-output" data-output="profile-rollout" tabindex="0"></pre>
        </div>
      </section>
    </main>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
  <script type="application/json" id="admin-ui-config">${escapeHtml(config)}</script>
  <script>${adminUiScript()}</script>
</body>
</html>`
}

function panelHeader(title: string, description: string): string {
  return `<div class="panel-head"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`
}

function adminUiCss(): string {
  return `:root{color-scheme:light;--bg:oklch(1 0 0);--surface:oklch(.973 .003 260);--surface-2:oklch(.94 .008 260);--ink:oklch(.19 .025 260);--muted:oklch(.43 .02 260);--line:oklch(.87 .01 260);--primary:oklch(.4 .13 260);--primary-ink:oklch(1 0 0);--accent:oklch(.62 .15 170);--danger:oklch(.55 .17 25);--success:oklch(.55 .13 150);--shadow:0 20px 60px oklch(.19 .025 260/.12);--r:18px;--focus:0 0 0 3px oklch(.72 .12 260/.35)}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,var(--surface),var(--bg) 32rem);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}button{min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);font-weight:700;padding:.72rem 1rem;cursor:pointer;transition:background .18s ease,border-color .18s ease,transform .18s ease}button:hover{border-color:oklch(.74 .03 260);background:var(--surface)}button:active{transform:translateY(1px)}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,pre:focus-visible{outline:none;box-shadow:var(--focus)}button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-ink)}button.danger{background:var(--danger);border-color:var(--danger);color:var(--primary-ink)}button.secondary{background:var(--surface)}a{color:inherit}.shell{min-height:100vh}.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--line);background:oklch(1 0 0/.86);backdrop-filter:blur(16px);padding:1rem clamp(1rem,4vw,3rem)}.brand{display:flex;align-items:center;gap:.72rem;text-decoration:none}.brand span:last-child{display:grid}.brand small{color:var(--muted);font-size:.8rem}.brand-mark{width:2rem;height:2rem;border-radius:10px;background:radial-gradient(circle at 35% 25%,oklch(.78 .12 205),var(--primary) 58%,oklch(.25 .1 260));box-shadow:0 8px 24px oklch(.4 .13 260/.28)}.nav{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}.nav a{border-radius:999px;color:var(--muted);font-size:.86rem;padding:.42rem .7rem;text-decoration:none}.nav a:hover{background:var(--surface-2);color:var(--ink)}.main{max-width:1180px;margin:0 auto;padding:clamp(1rem,4vw,3rem)}.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(16rem,24rem);gap:1.5rem;align-items:end;margin:1.5rem 0 2rem}.kicker{color:var(--primary);font-weight:800;letter-spacing:.04em;margin:0 0 .45rem;text-transform:uppercase;font-size:.78rem}.hero h1{font-size:2.35rem;line-height:1.05;letter-spacing:-.03em;margin:0;text-wrap:balance}.lede{max-width:68ch;color:var(--muted);font-size:1.02rem}.health-panel,.panel{border:1px solid var(--line);border-radius:var(--r);background:oklch(1 0 0/.82);box-shadow:var(--shadow)}.health-panel{display:grid;gap:.4rem;padding:1rem}.status-dot{width:.7rem;height:.7rem;border-radius:999px;background:var(--success);box-shadow:0 0 0 5px oklch(.55 .13 150/.15)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.workspace{display:grid;grid-template-columns:repeat(${ADMIN_UI_RESPONSIVE.desktopMinColumns},minmax(0,1fr));gap:1rem}.panel{padding:1rem}.panel.wide,.command-panel{grid-column:1/-1}.panel-head{margin-bottom:1rem}.panel h2{font-size:1rem;margin:0 0 .2rem}.panel p{color:var(--muted);margin:.15rem 0 0}label{display:grid;gap:.35rem;color:var(--muted);font-weight:700;margin:.8rem 0}input,select{min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;width:100%;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);padding:.65rem .75rem}.check{align-items:center;display:flex;font-weight:600}.check input{min-height:auto;width:auto}.button-row{display:flex;gap:.6rem;flex-wrap:wrap}.token-grid,.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem;margin-top:1rem}.token,.metric{border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:.8rem;min-width:0}.token strong,.metric strong{display:block;font-size:.78rem;color:var(--muted);margin-bottom:.35rem}.token code,.metric code{display:block;overflow:auto;white-space:nowrap}.command,pre{min-height:3.5rem;overflow:auto;border:1px solid var(--line);border-radius:14px;background:oklch(.18 .02 260);color:oklch(.96 .01 260);padding:.8rem;white-space:pre-wrap}.toast{position:fixed;right:1rem;bottom:1rem;max-width:min(28rem,calc(100vw - 2rem));border-radius:14px;background:var(--ink);color:var(--bg);box-shadow:var(--shadow);opacity:0;pointer-events:none;padding:.8rem 1rem;transform:translateY(.5rem);transition:opacity .18s ease,transform .18s ease}.toast.show{opacity:1;transform:translateY(0)}@media (max-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx}px){.topbar{align-items:flex-start;position:static}.nav{justify-content:flex-start;overflow-x:auto;width:100%;padding-bottom:.2rem}.topbar,.hero{display:flex;flex-direction:column}.hero h1{font-size:1.85rem}.workspace{grid-template-columns:1fr}.panel{padding:.9rem}.button-row,button{width:100%}.health-panel{width:100%}}@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}`
}

function adminUiScript(): string {
  return `(() => {
  const config = JSON.parse(document.getElementById('admin-ui-config').textContent);
  const byId = (id) => document.getElementById(id);
  const tokenKey = 'codeflareInferenceMeshAdminToken';
  byId('origin-label').textContent = config.workerOrigin;
  const token = () => sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || byId('admin-token').value.trim();
  const setToken = (value, remember) => {
    sessionStorage.removeItem(tokenKey); localStorage.removeItem(tokenKey);
    if (value) (remember ? localStorage : sessionStorage).setItem(tokenKey, value);
    byId('admin-token').value = value;
  };
  const toast = (message) => { const el = byId('toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3600); };
  const headers = (auth, json = false) => ({ ...(json ? {'content-type':'application/json'} : {}), ...(auth ? {authorization: 'Bearer ' + token()} : {}) });
  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw Object.assign(new Error(typeof body === 'string' ? body : body.error || 'request failed'), { body, status: response.status });
    return body;
  }
  const showJson = (id, value) => { byId(id).textContent = JSON.stringify(value, null, 2); };
  const copyButton = (value) => '<button type="button" data-copy="' + encodeURIComponent(value) + '">Copy</button>';
  function renderTokens(target, values) {
    byId(target).innerHTML = Object.entries(values).filter(([, value]) => typeof value === 'string').map(([key, value]) => '<div class="token"><strong>' + key + '</strong><code>' + value + '</code>' + copyButton(value) + '</div>').join('');
  }
  function renderStatus(value) {
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];
    byId('status-output').innerHTML = [
      '<div class="metric"><strong>Nodes</strong><code>' + nodes.length + '</code></div>',
      '<div class="metric"><strong>Profiles</strong><code>' + profiles.length + '</code></div>',
      '<div class="metric"><strong>Generated</strong><code>' + (value.generatedAt || 'unknown') + '</code></div>',
      '<div class="metric"><strong>Node state</strong><code>' + nodes.map((node) => node.id + ':' + node.status).join('\\n') + '</code></div>',
      '<div class="metric"><strong>Profiles</strong><code>' + profiles.map((profile) => profile.id + ' ' + profile.rolloutPercent + '%').join('\\n') + '</code></div>'
    ].join('');
  }
  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard.writeText(decodeURIComponent(copy.dataset.copy)); toast('Copied'); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    try {
      if (action === 'first-run-setup') {
        const body = await request('/admin/setup', { method: 'POST' });
        renderTokens('setup-output', body); setToken(body.adminToken || '', byId('remember-token').checked); toast('Setup complete');
      } else if (action === 'admin-login') {
        setToken(byId('admin-token').value.trim(), byId('remember-token').checked); await request('/admin/login', { method: 'POST', headers: headers(true) }); toast('Admin token verified');
      } else if (action === 'forget-token') {
        setToken('', false); toast('Token removed');
      } else if (action === 'status-refresh') {
        renderStatus(await request('/admin/status', { headers: headers(true) }));
      } else if (action === 'setup-token-create') {
        renderTokens('setup-token-output', await request('/admin/setup-tokens', { method: 'POST', headers: headers(true) }));
      } else if (action === 'installer-generate') {
        const platform = byId('installer-platform').value; byId('installer-output').textContent = await request('/admin/installers/' + platform, { headers: headers(true) });
      } else if (action === 'gateway-sync') {
        showJson('gateway-output', await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true) }));
      } else if (action === 'custom-domain-validate') {
        showJson('domain-output', await request('/admin/custom-domain/validate', { method: 'POST', headers: headers(true, true), body: JSON.stringify({ hostname: byId('custom-domain').value.trim() }) }));
      } else if (action === 'node-revoke') {
        const nodeId = encodeURIComponent(byId('node-id').value.trim()); showJson('node-output', await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(true) }));
      } else if (action === 'profile-rollout') {
        showJson('profile-output', await request('/admin/profiles/rollout', { method: 'POST', headers: headers(true, true), body: JSON.stringify({ profileId: byId('profile-id').value.trim(), rolloutPercent: Number(byId('rollout-percent').value) }) }));
      }
    } catch (error) {
      toast('Error: ' + (error.body?.error || error.message));
    }
  });
  const saved = token(); if (saved) byId('admin-token').value = saved;
})();`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
}

export const ADMIN_UI_ANCHORS = {
  REQ_ADM_006: 'REQ-ADM-006'
} as const
