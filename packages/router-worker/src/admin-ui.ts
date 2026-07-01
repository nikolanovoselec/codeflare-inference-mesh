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
  desktopMinColumns: 1,
  minTouchTargetPx: 44
} as const

export function adminUiHtml(workerOrigin: string): string {
  const config = scriptJson({ workerOrigin, actions: ADMIN_UI_ACTIONS, responsive: ADMIN_UI_RESPONSIVE })
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
        <span><strong>codeflare</strong><small>Inference Mesh admin</small></span>
      </a>
      <nav class="nav" aria-label="Admin sections">
        <a href="#setup">Setup</a>
        <a href="#setup-token">Enroll</a>
        <a href="#gateway">Route</a>
        <a href="#status">Operate</a>
      </nav>
    </header>

    <main class="main">
      <section class="hero" aria-labelledby="admin-title">
        <div>
          <p class="hero-kicker">THE CODEFLARE <span>INFERENCE MESH</span></p>
          <h1 id="admin-title">Operate the <span class="flare">private inference router.</span></h1>
          <p class="lede">Start with setup, verify admin access, enroll nodes, then keep Gateway, profiles, and audit state in one governed run.</p>
        </div>
        <aside class="health-panel" aria-label="Router health">
          <span class="status-dot" aria-hidden="true"></span>
          <span>Worker shell loaded</span>
          <code id="origin-label"></code>
        </aside>
      </section>

      <section class="runway" aria-label="Operator workflow" data-flow="setup-enroll-route-operate">
        <div><strong>~/setup</strong><span>Create credentials once</span></div>
        <div><strong>~/enroll</strong><span>Generate installer + node token</span></div>
        <div><strong>~/route</strong><span>Sync Gateway + custom domain</span></div>
        <div><strong>~/operate</strong><span>Watch status, profiles, and revocation</span></div>
      </section>

      <section class="workspace" aria-label="Admin configuration workspace" data-layout="operator-sequence" data-density="wide">
        <div class="panel command-panel" id="setup" data-form="setup" data-state="idle" data-step="1">
          ${panelHeader('First-run setup', 'Create credentials once, copy them immediately, then store the admin token locally if this is your browser.', 'first-run-setup')}
          <button class="primary" type="button" data-action="first-run-setup">Run first-run setup</button>
          <div class="token-grid result surface" id="setup-output" data-output="setup-tokens" data-empty="Generated credentials will appear here once." aria-live="polite"></div>
        </div>

        <div class="panel" id="login" data-form="login" data-state="idle" data-step="2">
          ${panelHeader('Admin token', 'Paste the admin token generated during setup. It stays in browser storage, not D1 plaintext.', 'admin-login')}
          <label>Admin token<input name="adminToken" id="admin-token" autocomplete="off" type="password"></label>
          <label class="check"><input name="rememberToken" id="remember-token" type="checkbox"> Remember on this device</label>
          <div class="button-row">
            <button type="button" data-action="admin-login">Verify token</button>
            <button class="secondary" type="button" data-action="forget-token">Forget token</button>
          </div>
        </div>

        <div class="panel wide" id="status" data-form="status" data-state="idle" data-step="3">
          ${panelHeader('Status', 'Redacted operational state from /admin/status. Plaintext credentials are never read back.', 'status-refresh')}
          <button type="button" data-action="status-refresh">Refresh status</button>
          <div class="status-grid result surface" id="status-output" data-output="status" data-empty="Refresh status to load redacted nodes, profiles, and audit events." aria-live="polite"></div>
        </div>

        <div class="panel" id="setup-token" data-form="setup-token" data-state="idle" data-step="4">
          ${panelHeader('Setup token', 'Generate a one-time node enrollment token, then use an installer command before it expires.', 'setup-token-create')}
          <button type="button" data-action="setup-token-create">Create setup token</button>
          <div class="token-grid result surface" id="setup-token-output" data-output="setup-token" data-empty="A short-lived setup token will appear here." aria-live="polite"></div>
        </div>

        <div class="panel" id="installer" data-form="installer" data-state="idle" data-step="5">
          ${panelHeader('Installers', 'Generate Linux, macOS, or Windows install commands backed by release artifacts.', 'installer-linux')}
          <label>Platform<select name="platform" id="installer-platform"><option value="linux">Linux</option><option value="macos">macOS</option><option value="windows">Windows</option></select></label>
          <button type="button" data-action="installer-generate">Generate installer command</button>
          <pre class="result command" id="installer-output" data-output="installer-command" data-empty="Installer command output will appear here." tabindex="0"></pre>
        </div>

        <div class="panel" id="gateway" data-form="gateway" data-state="idle" data-step="6">
          ${panelHeader('AI Gateway', 'Sync the custom provider, dynamic route, version, and deployment metadata when runtime Cloudflare credentials are configured.', 'gateway-sync')}
          <button type="button" data-action="gateway-sync">Sync Gateway route</button>
          <pre class="result" id="gateway-output" data-output="gateway-sync" data-empty="Gateway sync response will appear here. Configuration errors stay visible." tabindex="0"></pre>
        </div>

        <div class="panel" id="domain" data-form="custom-domain" data-state="idle" data-step="7">
          ${panelHeader('Custom domain', 'Validate a hostname before switching Gateway traffic to a custom origin.', 'custom-domain-validate')}
          <label>Hostname<input name="hostname" id="custom-domain" placeholder="ai.example.com" inputmode="url"></label>
          <label>Zone ID<input name="zoneId" id="custom-domain-zone" placeholder="0123456789abcdef0123456789abcdef"></label>
          <button type="button" data-action="custom-domain-validate">Validate hostname</button>
          <pre class="result" id="domain-output" data-output="custom-domain" data-empty="Hostname validation response will appear here." tabindex="0"></pre>
        </div>

        <div class="panel" id="node" data-form="node-revoke" data-state="idle" data-step="8">
          ${panelHeader('Node controls', 'Revoke a node from scheduling when it should no longer receive traffic.', 'node-revoke')}
          <label>Node ID<input name="nodeId" id="node-id" autocomplete="off"></label>
          <button class="danger" type="button" data-action="node-revoke">Revoke node</button>
          <pre class="result" id="node-output" data-output="node-revoke" data-empty="Revocation result will appear here." tabindex="0"></pre>
        </div>

        <div class="panel" id="profile" data-form="profile-rollout" data-state="idle" data-step="9">
          ${panelHeader('Profile rollout', 'Set rollout percentage for an existing model profile.', 'profile-rollout')}
          <label>Profile ID<input name="profileId" id="profile-id" autocomplete="off" placeholder="gemma4-26b-a4b-256k-3090"></label>
          <label>Rollout percent<input name="rolloutPercent" id="rollout-percent" type="number" min="0" max="100" step="1" value="100"></label>
          <button type="button" data-action="profile-rollout">Update rollout</button>
          <pre class="result" id="profile-output" data-output="profile-rollout" data-empty="Profile rollout result will appear here." tabindex="0"></pre>
        </div>
      </section>
    </main>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
  <script type="application/json" id="admin-ui-config">${config}</script>
  <script>${adminUiScript()}</script>
</body>
</html>`
}

function panelHeader(title: string, description: string, actionId: string): string {
  const action = ADMIN_UI_ACTIONS.find((item) => item.id === actionId)
  const meta = action ? `<span>${action.method}</span><code>${escapeHtml(action.path)}</code><span>${action.auth}</span>` : ''
  return `<div class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><div class="panel-state" aria-hidden="true"></div></div><div class="meta-row" aria-label="Route contract">${meta}</div>`
}

function adminUiCss(): string {
  return `:root{
  color-scheme:dark;
  --font-sans:'Inter Variable',Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:'JetBrains Mono Variable','JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --bg-base:#0a0a0c;
  --bg-base-rgb:10 10 12;
  --bg-surface:#101015;
  --bg-surface-rgb:16 16 21;
  --bg-elevated:#16161d;
  --bg-terminal:#0c0c11;
  --border-subtle:#1c1c22;
  --border-default:#2a2a33;
  --border-strong:#3a3a45;
  --text-primary:#f6f6f7;
  --text-secondary:#adadb6;
  --text-muted:#8a8a94;
  --text-dimmed:#565660;
  --accent:#ff5c3c;
  --accent-rgb:255 92 60;
  --accent-hover:#ff734f;
  --accent-soft:rgb(var(--accent-rgb)/.12);
  --accent-line:rgb(var(--accent-rgb)/.32);
  --flare-gradient:linear-gradient(96deg,#ff8a3d 0%,#ff5c3c 52%,#ff3f7c 100%);
  --term-green:#4ade80;
  --term-cyan:#67e8f9;
  --term-warn:#fbbf24;
  --danger:#ff5c3c;
  --radius:14px;
  --radius-sm:10px;
  --nav-height:4rem;
  --shadow:0 30px 60px -30px rgb(0 0 0/.72);
  --focus:0 0 0 3px rgb(var(--accent-rgb)/.28);
}
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--nav-height) + 1rem)}
body{min-height:100vh;background:var(--bg-base);isolation:isolate;color:var(--text-secondary);font:15px/1.62 var(--font-sans);font-synthesis:none;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow-x:clip}
body::before{content:'';position:fixed;z-index:-2;inset:0;background:radial-gradient(ellipse max(32rem,120vw) clamp(16rem,38svh,30rem) at 50% -4rem,rgb(var(--accent-rgb)/.14) 0%,rgb(var(--accent-rgb)/.07) 34%,transparent 72%)}
body::after{content:'';position:fixed;z-index:-1;inset:0;background:linear-gradient(180deg,transparent 0%,var(--bg-base) 62%),radial-gradient(circle at 12% 18%,rgb(255 63 124/.08),transparent 26%);pointer-events:none}
::selection{background:rgb(var(--accent-rgb)/.28);color:var(--text-primary)}
a{color:var(--accent);text-decoration:none;transition:color .18s ease}
a:hover{color:var(--accent-hover)}
button,input,select{font:inherit}
button{display:inline-flex;align-items:center;justify-content:center;gap:.38rem;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:transparent;color:var(--text-primary);font-size:.95rem;font-weight:650;line-height:1;padding:.78rem 1.1rem;white-space:nowrap;cursor:pointer;transition:transform .12s ease,background .18s ease,border-color .18s ease,color .18s ease,opacity .18s ease}
button:not(.primary):not(.danger):not(.secondary)::before{content:'[';color:var(--text-dimmed)}
button:not(.primary):not(.danger):not(.secondary)::after{content:']';color:var(--text-dimmed)}
button:hover{border-color:var(--text-muted);color:var(--text-primary)}
button:active{transform:translateY(1px)}
button:disabled{cursor:not-allowed;opacity:.62}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,pre:focus-visible{outline:none;box-shadow:var(--focus)}
button.primary{background:var(--accent);border-color:transparent;color:#160a06}
button.primary:hover{background:var(--accent-hover);color:#160a06}
button.secondary{background:transparent;border-color:var(--border-default);color:var(--text-secondary)}
button.danger{background:rgb(var(--accent-rgb)/.12);border-color:var(--accent-line);color:var(--accent-hover)}
button.danger:hover{border-color:var(--accent);color:var(--text-primary)}
code,pre{font-family:var(--font-mono)}
.shell{min-height:100vh}
.topbar{position:sticky;top:0;z-index:50;min-height:var(--nav-height);display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border-subtle);background:rgb(var(--bg-base-rgb)/.72);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);padding:.75rem clamp(1.25rem,5vw,2.25rem)}
.brand{display:inline-flex;align-items:center;gap:.55rem;color:var(--text-primary);font-size:1.02rem;font-weight:700;letter-spacing:-.01em;text-decoration:none}
.brand:hover{color:var(--text-primary)}
.brand span:last-child{display:grid;gap:.08rem}
.brand small{color:var(--text-muted);font-size:.72rem;font-weight:500;letter-spacing:0}
.brand-mark{width:.7rem;height:.7rem;border-radius:3px;background:var(--flare-gradient);box-shadow:0 0 14px rgb(var(--accent-rgb)/.55)}
.nav{display:flex;align-items:center;gap:1.2rem;flex-wrap:wrap;justify-content:flex-end}
.nav a{color:var(--text-muted);font-size:.9rem;font-weight:500;text-decoration:none}
.nav a:hover{color:var(--text-primary)}
.main{width:100%;max-width:72rem;margin:0 auto;padding:clamp(1.25rem,5vw,2.25rem)}
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(16rem,24rem);gap:clamp(2rem,5vw,4rem);align-items:end;padding:clamp(3.5rem,4rem + 4vw,6rem) 0 clamp(2.5rem,5vw,4rem)}
.hero-kicker{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:.34em;position:relative;z-index:2;margin:0 0 1rem;color:var(--accent);font-size:.75rem;font-weight:600;letter-spacing:.16em;line-height:1;text-transform:uppercase}
.hero-kicker span{color:var(--text-primary)}
.hero h1{max-width:15ch;color:var(--text-primary);font-size:clamp(2.5rem,1.6rem + 4.4vw,4.5rem);font-weight:680;line-height:1.05;letter-spacing:-.03em;text-wrap:balance}
.hero h1 .flare{background:var(--flare-gradient);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{max-width:48ch;margin-top:1.4rem;color:var(--text-primary);font-size:clamp(1.05rem,.98rem + .4vw,1.2rem);line-height:1.5;text-wrap:pretty}
.health-panel,.panel{border:1px solid var(--border-default);border-radius:var(--radius);background:rgb(var(--bg-surface-rgb)/.92);box-shadow:var(--shadow)}
.health-panel{display:grid;gap:.5rem;align-self:end;overflow:hidden;padding:1rem;font-family:var(--font-mono);font-size:.8125rem}
.health-panel::before{content:'';display:block;height:.7rem;width:.7rem;border-radius:50%;background:var(--border-strong);box-shadow:1.1rem 0 0 var(--border-strong),2.2rem 0 0 var(--accent);margin-bottom:.2rem}
.health-panel span:not(.status-dot){color:var(--text-primary)}
.status-dot{display:none}
#origin-label{display:block;overflow:auto;color:var(--text-muted);white-space:nowrap}
.runway{display:flex;align-items:center;flex-wrap:wrap;gap:.55rem;margin:0 auto 1.5rem;max-width:68rem;padding:.25rem 0 .75rem;color:var(--text-muted);font-family:var(--font-mono);font-size:.72rem}
.runway div{display:flex;align-items:center;gap:.45rem;min-width:0}
.runway div+div::before{content:'→';color:var(--text-dimmed);margin-right:.2rem}
.runway strong{color:var(--accent);font-weight:500;text-transform:lowercase}
.runway span{color:var(--text-muted);font-family:var(--font-sans);font-size:.875rem}
.workspace{counter-reset:admin-step;display:flex;flex-direction:column;gap:1.25rem;max-width:68rem;margin:0 auto}
.panel{counter-increment:admin-step;display:flex;flex-direction:column;min-width:0;overflow:hidden;padding:0;width:100%}
.panel.wide,.command-panel{width:100%}
.panel[data-state=loading]{border-color:var(--term-cyan)}
.panel[data-state=ready]{border-color:rgb(74 222 128/.58)}
.panel[data-state=error]{border-color:var(--accent-line)}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border-subtle);background:rgb(255 255 255/.015);padding:.9rem 1rem .75rem}
.panel-head::before{content:counter(admin-step,decimal-leading-zero);flex:0 0 auto;width:2.35rem;color:var(--accent);font-family:var(--font-mono);font-size:.72rem;font-weight:500;line-height:1.35;margin-top:.08rem}
.panel h2{color:var(--text-primary);font-size:1.05rem;font-weight:650;line-height:1.15;letter-spacing:-.01em;margin:0 0 .25rem}
.panel p{max-width:68ch;color:var(--text-secondary);margin:0;text-wrap:pretty}
.panel-state{flex:0 0 auto;border:1px solid var(--border-default);border-radius:999px;color:var(--text-muted);font-family:var(--font-mono);font-size:.65rem;font-weight:500;line-height:1;padding:.32rem .5rem;white-space:nowrap;text-transform:uppercase}
.panel[data-state=idle] .panel-state::before{content:'READY'}
.panel[data-state=loading] .panel-state::before{content:'RUNNING'}
.panel[data-state=ready] .panel-state::before{content:'PASSED';color:var(--term-green)}
.panel[data-state=error] .panel-state::before{content:'BLOCKED';color:var(--accent-hover)}
.meta-row{align-items:center;display:flex;flex-wrap:wrap;gap:.4rem;border-bottom:1px solid var(--border-subtle);padding:.75rem 1rem;color:var(--text-muted);font-family:var(--font-mono);font-size:.72rem}
.meta-row span,.meta-row code{border:1px solid var(--border-default);border-radius:999px;background:rgb(255 255 255/.018);color:var(--text-muted);font-size:.72rem;font-weight:500;padding:.24rem .5rem}
.meta-row span:first-child{color:var(--accent)}
.meta-row code{max-width:100%;overflow:auto}
.panel > button,.panel > label,.panel > .button-row,.panel > .result{margin-left:1.25rem;margin-right:1.25rem}
.panel > button,.panel > .button-row{margin-bottom:1.25rem}
.panel > button{align-self:flex-start}
.panel > label:first-of-type{margin-top:1.25rem}
.panel > label{max-width:42rem}
label{display:grid;gap:.35rem;color:var(--text-muted);font-size:.875rem;font-weight:600;margin:.8rem 0}
input,select{min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;width:100%;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-terminal);color:var(--text-primary);padding:.68rem .8rem}
input::placeholder{color:var(--text-dimmed);opacity:1}
.check{align-items:center;display:flex;font-weight:600}
.check input{min-height:auto;width:auto;accent-color:var(--accent)}
.button-row{display:flex;gap:.6rem;flex-wrap:wrap}
.token-grid,.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem;margin-top:0}
.token,.metric{min-width:0;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:rgb(255 255 255/.018);padding:.8rem}
.token strong,.metric strong{display:block;color:var(--text-muted);font-family:var(--font-mono);font-size:.65rem;font-weight:500;letter-spacing:.06em;margin-bottom:.35rem;text-transform:uppercase}
.token code,.metric code{display:block;overflow:auto;color:var(--text-primary);white-space:nowrap}
.token button{margin-top:.65rem;min-height:2.15rem;padding:.45rem .75rem}
.result{min-height:3.6rem;overflow:auto;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-terminal);color:var(--text-secondary);font-family:var(--font-mono);font-size:.8125rem;line-height:1.75;padding:1rem;white-space:pre-wrap}
.result:empty::before{content:attr(data-empty);color:var(--text-dimmed)}
.result.is-error{border-color:var(--accent-line);background:rgb(var(--accent-rgb)/.08);color:var(--accent-hover)}
.command:not(:empty){color:var(--text-primary)}
.toast{position:fixed;right:1rem;bottom:1rem;z-index:60;max-width:min(28rem,calc(100vw - 2rem));border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--text-primary);box-shadow:var(--shadow);opacity:0;pointer-events:none;padding:.85rem 1rem;transform:translateY(.5rem);transition:opacity .18s ease,transform .18s ease}
.toast.show{opacity:1;transform:translateY(0)}
@media (min-width:900px){.panel > .button-row{max-width:42rem}.result{min-height:4.25rem}}
@media (max-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx}px){.topbar{position:static;align-items:flex-start;flex-direction:column}.nav{justify-content:flex-start;gap:.85rem;overflow-x:auto;width:100%;padding-bottom:.2rem}.hero{display:flex;flex-direction:column;padding-top:2.5rem}.hero h1{font-size:clamp(2.2rem,12vw,3.2rem);max-width:12ch}.health-panel{width:100%}.runway{display:grid;gap:.4rem;margin-bottom:1rem}.runway div+div::before{content:'';display:none}.panel-head{display:grid}.panel-head::before{width:auto}.button-row,button{width:100%}.panel > button{align-self:stretch}.panel-state{justify-self:start}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}`
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
  const panelFor = (target) => target.closest('.panel');
  const setPanelState = (panel, state) => { if (!panel) return; panel.dataset.state = state; panel.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false'); };
  const primaryOutput = (panel) => panel?.querySelector('[data-output]');
  const setOutput = (id, value, isError = false) => { const el = byId(id); el.classList.toggle('is-error', isError); el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  const showJson = (id, value) => setOutput(id, value);
  const esc = (value) => String(value).replace(/[&<>\"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[char]));
  const copyButton = (value) => '<button type="button" data-copy="' + encodeURIComponent(value) + '">Copy</button>';
  function renderTokens(target, values) {
    byId(target).classList.remove('is-error');
    byId(target).innerHTML = Object.entries(values).filter(([, value]) => typeof value === 'string').map(([key, value]) => '<div class="token"><strong>' + esc(key) + '</strong><code>' + esc(value) + '</code>' + copyButton(value) + '</div>').join('');
  }
  function renderStatus(value) {
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];
    byId('status-output').classList.remove('is-error');
    byId('status-output').innerHTML = [
      '<div class="metric"><strong>Nodes</strong><code>' + nodes.length + '</code></div>',
      '<div class="metric"><strong>Profiles</strong><code>' + profiles.length + '</code></div>',
      '<div class="metric"><strong>Generated</strong><code>' + (value.generatedAt || 'unknown') + '</code></div>',
      '<div class="metric"><strong>Node state</strong><code>' + esc(nodes.map((node) => node.id + ':' + node.status).join('\\n')) + '</code></div>',
      '<div class="metric"><strong>Profiles</strong><code>' + esc(profiles.map((profile) => profile.id + ' ' + profile.rolloutPercent + '%').join('\\n')) + '</code></div>'
    ].join('');
  }
  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard.writeText(decodeURIComponent(copy.dataset.copy)); toast('Copied'); return; }
    const button = event.target.closest('[data-action]');
    const action = button?.dataset.action;
    if (!action) return;
    const panel = panelFor(button);
    try {
      setPanelState(panel, 'loading'); button.disabled = true;
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
        const platform = byId('installer-platform').value; setOutput('installer-output', await request('/admin/installers/' + platform, { headers: headers(true) }));
      } else if (action === 'gateway-sync') {
        showJson('gateway-output', await request('/admin/cloudflare/gateway/sync', { method: 'POST', headers: headers(true) }));
      } else if (action === 'custom-domain-validate') {
        showJson('domain-output', await request('/admin/custom-domain/validate', { method: 'POST', headers: headers(true, true), body: JSON.stringify({ hostname: byId('custom-domain').value.trim(), zoneId: byId('custom-domain-zone').value.trim() }) }));
      } else if (action === 'node-revoke') {
        const nodeId = encodeURIComponent(byId('node-id').value.trim()); showJson('node-output', await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(true) }));
      } else if (action === 'profile-rollout') {
        showJson('profile-output', await request('/admin/profiles/rollout', { method: 'POST', headers: headers(true, true), body: JSON.stringify({ profileId: byId('profile-id').value.trim(), rolloutPercent: Number(byId('rollout-percent').value) }) }));
      }
      setPanelState(panel, 'ready');
    } catch (error) {
      const message = error.body?.error || error.message;
      const output = primaryOutput(panel);
      if (output) { output.classList.add('is-error'); output.textContent = JSON.stringify({ error: message, status: error.status || null }, null, 2); }
      setPanelState(panel, 'error');
      toast('Error: ' + message);
    } finally {
      button.disabled = false;
    }
  });
  const saved = token(); if (saved) byId('admin-token').value = saved;
})();`
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
}

export const ADMIN_UI_ANCHORS = {
  REQ_ADM_006: 'REQ-ADM-006'
} as const
