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

export const ADMIN_UI_RESPONSIVE = {
  mobileBreakpointPx: 760,
  desktopMinColumns: 1,
  minTouchTargetPx: 44
} as const

export const ADMIN_UI_OPERATOR_FLOW = {
  stages: ['setup/authentication', 'enrollment/installers', 'Gateway/domain routing', 'status/node/profile operations'],
  panelOrder: ['setup', 'login', 'setup-token', 'installer', 'gateway', 'domain', 'status', 'node', 'profile']
} as const

export const ADMIN_UI_COMMAND_CENTER = {
  layout: 'command-center',
  statusStrip: ['setup', 'auth', 'nodes', 'profiles', 'audit'],
  railOrder: ['setup', 'auth', 'enroll', 'route', 'operate'],
  rowOrder: ['first-run-setup', 'admin-login', 'setup-token-create', 'installer-generate', 'gateway-sync', 'custom-domain-validate', 'status-refresh', 'node-revoke', 'profile-rollout']
} as const

export const ADMIN_UI_ACTION_ROW_ANCHOR = {
  className: 'action-row',
  slots: ['copy', 'controls', 'feedback']
} as const

export const ADMIN_UI_SETUP_LOCKED_FEEDBACK = {
  status: 401,
  variant: 'setup-locked'
} as const

export function adminUiHtml(workerOrigin: string): string {
  const config = scriptJson({
    workerOrigin,
    actions: ADMIN_UI_ACTIONS,
    responsive: ADMIN_UI_RESPONSIVE,
    operatorFlow: ADMIN_UI_OPERATOR_FLOW,
    commandCenter: ADMIN_UI_COMMAND_CENTER,
    setupLockedFeedback: ADMIN_UI_SETUP_LOCKED_FEEDBACK
  })
  return `<!doctype html>
<html lang="en" data-admin-ui="codeflare-inference-mesh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Codeflare Inference Mesh Admin</title>
  <style>${adminUiCss()}</style>
</head>
<body>
  <div class="shell" data-layout="admin-shell" data-responsive="desktop mobile">
    <header class="topbar">
      <a class="brand" href="/admin" aria-label="Codeflare Inference Mesh admin home">
        <span class="brand-mark" aria-hidden="true"></span>
        <span><strong>codeflare</strong></span>
      </a>
      <div class="origin-pill" aria-label="Router health">
        <span class="live-badge"><span class="status-dot" aria-hidden="true"></span>LIVE</span>
        <code id="origin-label"></code>
      </div>
    </header>

    <main class="console" data-layout="command-center" data-density="operator" data-command-center="true">
      <section class="overview" aria-labelledby="admin-title">
        <div>
          <h1 class="codeflare-headline" id="admin-title" data-brand-title="codeflare-inference-mesh"><span>Codeflare</span> <span class="flare-word">Inference Mesh</span></h1>
          <p>Set up credentials, enroll nodes, route traffic, and inspect state from one control surface.</p>
        </div>
        <div class="status-strip" aria-label="Admin status summary" data-status-strip="${ADMIN_UI_COMMAND_CENTER.statusStrip.join(' ')}">
          ${statusItem('Setup', 'locked', 'setup-status')}
          ${statusItem('Auth', 'required', 'auth-status')}
          ${statusItem('Nodes', '—', 'node-status')}
          ${statusItem('Profiles', '—', 'profile-status')}
          ${statusItem('Audit', '—', 'audit-status')}
        </div>
      </section>

      <div class="setup-banner" data-setup-banner hidden>
        <p>Setup is already complete. <a href="#login" data-banner-action="go-to-auth">Go to Auth</a></p>
      </div>

      <div class="command-grid">
        <aside class="workflow-rail" aria-label="Operator workflow" data-rail-order="${ADMIN_UI_COMMAND_CENTER.railOrder.join(' ')}">
          ${railItem('setup', 'setup', 'Setup', 'Locked')}
          ${railItem('auth', 'login', 'Auth', 'Required')}
          ${railItem('enroll', 'setup-token', 'Enroll', 'Setup token')}
          ${railItem('route', 'gateway', 'Route', 'Gateway + domain')}
          ${railItem('operate', 'status', 'Operate', 'Status + controls')}
        </aside>

        <section class="work-area" aria-label="Admin work area" data-layout="command-center-work-area" data-panel-order="${ADMIN_UI_OPERATOR_FLOW.panelOrder.join(' ')}">
          <section class="work-section" id="setup" data-flow-stage="setup">
            ${sectionHeader('Setup')}
            ${actionRow({ id: 'first-run-setup', actionId: 'first-run-setup', title: 'First-run setup', description: 'Only works before setup is locked. Once locked, use the existing admin token.', controls: '<button class="primary" type="button" data-action="first-run-setup">Create first credentials</button>', outputId: 'setup-output', outputKind: 'setup-tokens', empty: 'Generated credentials appear here once.' })}
          </section>

          <section class="work-section" id="login" data-flow-stage="auth">
            ${sectionHeader('Auth')}
            ${actionRow({ id: 'admin-login', actionId: 'admin-login', title: 'Admin token', description: 'Paste the token generated during setup. It stays in browser storage, not D1 plaintext.', controls: '<div class="control-line"><input class="control-input" name="adminToken" id="admin-token" autocomplete="off" type="password" aria-label="Admin token"><button type="button" data-action="admin-login">Verify token</button><button class="secondary" type="button" data-action="forget-token">Forget</button></div><label class="check"><input name="rememberToken" id="remember-token" type="checkbox"> Remember on this device</label>', outputId: 'login-output', outputKind: 'login-feedback', empty: 'Token verification feedback appears here.' })}
          </section>

          <section class="work-section" id="setup-token" data-flow-stage="enroll">
            ${sectionHeader('Enroll')}
            ${actionRow({ id: 'setup-token-create', actionId: 'setup-token-create', title: 'Setup token', description: 'Create a short-lived node enrollment token.', controls: '<button type="button" data-action="setup-token-create">Create setup token</button>', outputId: 'setup-token-output', outputKind: 'setup-token', empty: 'A short-lived setup token appears here.' })}
            ${actionRow({ id: 'installer-generate', actionId: 'installer-linux', title: 'Installer command', description: 'Generate a release-backed install command for the node platform.', controls: '<div class="control-line compact"><select name="platform" id="installer-platform" aria-label="Installer platform"><option value="linux">Linux</option><option value="macos">macOS</option><option value="windows">Windows</option></select><button type="button" data-action="installer-generate">Generate installer</button></div>', outputId: 'installer-output', outputKind: 'installer-command', empty: 'Installer command output appears here.', tag: 'pre' })}
          </section>

          <section class="work-section" id="gateway" data-flow-stage="route">
            ${sectionHeader('Route')}
            ${actionRow({ id: 'gateway-sync', actionId: 'gateway-sync', title: 'AI Gateway', description: 'Sync custom provider, dynamic route, version, and deployment metadata.', controls: '<button type="button" data-action="gateway-sync">Sync Gateway route</button>', outputId: 'gateway-output', outputKind: 'gateway-sync', empty: 'Gateway sync response appears here.', tag: 'pre' })}
            ${actionRow({ id: 'custom-domain-validate', actionId: 'custom-domain-validate', title: 'Custom domain', description: 'Validate a hostname before switching Gateway traffic to a custom origin.', controls: '<div class="control-stack"><input class="control-input" name="hostname" id="custom-domain" placeholder="ai.example.com" inputmode="url" aria-label="Hostname"><input class="control-input" name="zoneId" id="custom-domain-zone" placeholder="Zone ID" aria-label="Zone ID"><button type="button" data-action="custom-domain-validate">Validate hostname</button></div>', outputId: 'domain-output', outputKind: 'custom-domain', empty: 'Hostname validation response appears here.', help: 'Use the Cloudflare zone ID for the hostname you want to validate.', tag: 'pre' })}
          </section>

          <section class="work-section" id="status" data-flow-stage="operate">
            ${sectionHeader('Operate')}
            ${actionRow({ id: 'status-refresh', actionId: 'status-refresh', title: 'Status', description: 'Load redacted nodes, profiles, audit events, and freshness metadata.', controls: '<button type="button" data-action="status-refresh">Refresh status</button>', outputId: 'status-output', outputKind: 'status', empty: 'Refresh status to load redacted state.', surfaceClass: 'status-grid' })}
            ${actionRow({ id: 'node-revoke', actionId: 'node-revoke', title: 'Node controls', description: 'Revoke a node when it should no longer receive traffic.', controls: '<div class="control-line"><input class="control-input" name="nodeId" id="node-id" autocomplete="off" aria-label="Node ID" placeholder="node id"><button class="danger" type="button" data-action="node-revoke">Revoke node</button></div>', outputId: 'node-output', outputKind: 'node-revoke', empty: 'Revocation result appears here.', tag: 'pre' })}
            ${actionRow({ id: 'profile-rollout', actionId: 'profile-rollout', title: 'Profile rollout', description: 'Set rollout percentage for an existing model profile.', controls: '<div class="control-stack"><input class="control-input" name="profileId" id="profile-id" autocomplete="off" placeholder="gemma4-26b-a4b-256k-3090" aria-label="Profile ID"><div class="control-line compact"><input class="control-input short" name="rolloutPercent" id="rollout-percent" type="number" min="0" max="100" step="1" value="100" aria-label="Rollout percent"><button type="button" data-action="profile-rollout">Update rollout</button></div></div>', outputId: 'profile-output', outputKind: 'profile-rollout', empty: 'Profile rollout result appears here.', help: 'Set how much traffic can use this model profile, from 0 to 100 percent.', tag: 'pre' })}
          </section>
        </section>
      </div>
    </main>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </div>
  <script type="application/json" id="admin-ui-config">${config}</script>
  <script>${adminUiScript()}</script>
</body>
</html>`
}

interface ActionRowOptions {
  readonly id: string
  readonly actionId: string
  readonly title: string
  readonly description: string
  readonly controls: string
  readonly outputId: string
  readonly outputKind: string
  readonly empty: string
  readonly help?: string
  readonly tag?: 'div' | 'pre'
  readonly surfaceClass?: string
}

function sectionHeader(title: string): string {
  return `<h2>${escapeHtml(title)}</h2>`
}

function actionRow(options: ActionRowOptions): string {
  const action = ADMIN_UI_ACTIONS.find((item) => item.id === options.actionId)
  const outputTag = options.tag ?? 'div'
  const surfaceClass = options.surfaceClass ? `result ${options.surfaceClass}` : 'result'
  const authLabel = action?.id === 'first-run-setup' ? 'first run only' : action?.auth
  const meta = action ? `<div class="row-meta"><span>${action.method}</span><code>${escapeHtml(action.path)}</code><span>${escapeHtml(authLabel ?? '')}</span></div>` : ''
  const help = options.help ? `<div class="field-help">${escapeHtml(options.help)}</div>` : ''
  return `<div class="action-row" id="row-${escapeHtml(options.id)}" data-action-scope="${escapeHtml(options.id)}" data-row="${escapeHtml(options.id)}" data-state="idle" data-action-row="${ADMIN_UI_ACTION_ROW_ANCHOR.slots.join(' ')}">
    <div class="row-copy"><h3>${escapeHtml(options.title)}</h3><p>${escapeHtml(options.description)}</p>${meta}<span class="row-state" aria-hidden="true"></span></div>
    <div class="row-controls">${options.controls}${help}<${outputTag} class="${surfaceClass}" id="${escapeHtml(options.outputId)}" data-output="${escapeHtml(options.outputKind)}" data-empty="${escapeHtml(options.empty)}" role="log"${outputTag === 'pre' ? ' tabindex="0"' : ''} aria-live="polite"></${outputTag}></div>
  </div>`
}

function railItem(stage: string, targetId: string, label: string, state: string): string {
  return `<a class="rail-item" href="#${escapeHtml(targetId)}" data-rail-item="${escapeHtml(stage)}"><span>${escapeHtml(label)}</span><small>${escapeHtml(state)}</small></a>`
}

function statusItem(label: string, value: string, id: string): string {
  return `<div class="status-item"><span>${escapeHtml(label)}</span><strong id="${escapeHtml(id)}">${escapeHtml(value)}</strong></div>`
}

function adminUiCss(): string {
  return `:root{
  color-scheme:dark;
  --font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --bg:#09090b;
  --surface:#101014;
  --surface-2:#15151b;
  --surface-3:#1b1b22;
  --line:#292932;
  --line-strong:#3a3a46;
  --text:#f4f4f5;
  --muted:#b0b0ba;
  --dim:#747480;
  --accent:#ff6a45;
  --accent-soft:rgb(255 106 69/.12);
  --accent-line:rgb(255 106 69/.36);
  --success:#4ade80;
  --warning:#f59e0b;
  --danger:#ff6a45;
  --radius:12px;
  --radius-sm:9px;
  --focus:0 0 0 3px rgb(255 106 69/.28);
}
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;scroll-padding-top:5rem}
body{min-height:100vh;background:var(--bg);color:var(--muted);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:var(--accent);color:#170b06}
a{color:inherit;text-decoration:none}
button,input,select{font:inherit}
button{display:inline-flex;align-items:center;justify-content:center;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);font-weight:650;padding:.62rem .9rem;white-space:nowrap;cursor:pointer;transition:background .16s ease,border-color .16s ease,transform .1s ease,opacity .16s ease}
button:hover{background:var(--surface-3);border-color:var(--dim)}
button:active{transform:translateY(1px)}
button:disabled{cursor:not-allowed;opacity:.6}
button.primary{background:var(--accent);border-color:transparent;color:#170b06}
button.primary:hover{background:#ff7b58;color:#170b06}
button.secondary{background:transparent;border-color:var(--line);color:var(--muted)}
button.danger{background:rgb(255 106 69/.1);border-color:var(--accent-line);color:#ff9a7f}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,pre:focus-visible{outline:none;box-shadow:var(--focus)}
input,select{min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;border:1px solid var(--line);border-radius:var(--radius-sm);background:#0d0d11;color:var(--text);padding:.6rem .75rem}
input::placeholder{color:#8b8b96;opacity:1}
code,pre{font-family:var(--font-mono)}
.shell{min-height:100vh}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--line);background:rgb(9 9 11/.9);backdrop-filter:blur(12px);padding:.85rem clamp(1rem,3vw,1.5rem)}
.brand{display:inline-flex;align-items:center;gap:.65rem;color:var(--text)}
.brand-mark{width:.7rem;height:.7rem;border-radius:3px;background:var(--accent);box-shadow:0 0 16px rgb(255 106 69/.42)}
.brand span:last-child{display:grid;gap:.05rem}
.brand strong{font-size:.98rem;line-height:1}
.origin-pill{display:flex;align-items:center;justify-content:flex-end;gap:.65rem;min-width:0;max-width:58vw}
.live-badge{display:inline-flex;align-items:center;gap:.35rem;border:1px solid rgb(74 222 128/.34);border-radius:999px;background:rgb(74 222 128/.1);color:var(--success);font-size:.68rem;font-weight:800;letter-spacing:.06em;padding:.28rem .48rem}
.status-dot{display:inline-block;width:.45rem;height:.45rem;border-radius:50%;background:var(--success);box-shadow:0 0 0 .16rem rgb(74 222 128/.12),0 0 12px rgb(74 222 128/.4)}
#origin-label{display:block;min-width:0;max-width:100%;overflow:visible;color:var(--muted);font-size:.78rem;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
.console{width:min(1180px,100%);margin:0 auto;padding:1.25rem clamp(1rem,3vw,1.5rem) 3rem}
.overview{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:1rem}
.overview h1{color:var(--text);font-size:1.55rem;font-weight:720;letter-spacing:-.02em;line-height:1.15;text-wrap:balance}
.codeflare-headline{font-size:clamp(2.2rem,5.4vw,4.25rem)!important;font-weight:760!important;letter-spacing:-.04em!important;line-height:1!important;max-width:100%}
.codeflare-headline .flare-word{color:var(--accent)}
.overview p{max-width:64ch;margin-top:.75rem;color:var(--muted)}
.setup-banner{border:1px solid var(--accent-line);border-radius:var(--radius-sm);background:rgb(255 106 69/.06);color:#ff9a7f;font-size:.85rem;margin-top:1rem;padding:.9rem 1rem}
.setup-banner[hidden]{display:none}
.setup-banner p{margin:0}
.setup-banner a{color:#ff9a7f;font-weight:700;text-decoration:underline}
.status-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));overflow:hidden;border:1px solid var(--line);border-radius:var(--radius-sm)}
.status-item{display:grid;gap:.2rem;border-right:1px solid var(--line);padding:.65rem .75rem;min-width:0}
.status-item:last-child{border-right:0}
.status-item span{color:var(--dim);font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.status-item strong{color:var(--text);font-size:.9rem;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.command-grid{display:grid;grid-template-columns:13.5rem minmax(0,1fr);gap:1rem;margin-top:1rem;align-items:start}
.workflow-rail{position:sticky;top:5rem;display:grid;gap:.35rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:.5rem}
.rail-item{display:grid;gap:.1rem;border-radius:var(--radius-sm);padding:.7rem .75rem;color:var(--muted)}
.rail-item:hover{background:var(--surface-2);color:var(--text)}
.rail-item span{color:var(--text);font-weight:700}
.rail-item small{color:var(--dim);font-size:.76rem}
.work-area{display:grid;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);overflow:hidden}
.work-section{display:grid;gap:0;border-bottom:1px solid var(--line)}
.work-section:last-child{border-bottom:0}
.work-section>h2{border-bottom:1px solid var(--line);background:#0d0d11;color:var(--text);font-size:.78rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:.7rem .9rem}
.action-row{display:grid;grid-template-columns:minmax(12rem,16rem) minmax(0,1fr);gap:1rem;border-bottom:1px solid var(--line);padding:.95rem}
.action-row:last-child{border-bottom:0}
.action-row[data-state=loading]{background:rgb(103 232 249/.04)}
.action-row[data-state=ready]{background:rgb(74 222 128/.04)}
.action-row[data-state=error]{background:rgb(255 106 69/.055)}
.row-copy{display:grid;align-content:start;gap:.45rem;min-width:0}
.row-copy h3{color:var(--text);font-size:1rem;font-weight:700;letter-spacing:-.01em;line-height:1.2}
.row-copy p{max-width:32ch;color:var(--muted)}
.row-meta{display:flex;flex-wrap:wrap;gap:.35rem;color:var(--dim);font-family:var(--font-mono);font-size:.72rem}
.row-meta span,.row-meta code{border:1px solid var(--line);border-radius:999px;background:#0d0d11;padding:.2rem .45rem;max-width:100%;overflow:auto}
.row-meta span:first-child{color:var(--accent)}
.row-state{justify-self:start;border:1px solid var(--line);border-radius:999px;color:var(--dim);font-family:var(--font-mono);font-size:.66rem;font-weight:800;letter-spacing:.04em;padding:.24rem .48rem;text-transform:uppercase}
.action-row[data-state=idle] .row-state::before{content:'ready'}
.action-row[data-state=loading] .row-state::before{content:'running';color:#67e8f9}
.action-row[data-state=ready] .row-state::before{content:'done';color:var(--success)}
.action-row[data-state=error] .row-state::before{content:'blocked';color:#ff9a7f}
.row-controls{display:grid;gap:.6rem;min-width:0;align-content:start}
.field-help{color:var(--dim);font-size:.72rem;margin-top:-.25rem}
.control-line,.control-stack{display:flex;align-items:center;gap:.5rem;min-width:0}
.control-stack{align-items:stretch;flex-wrap:wrap}
.control-line.compact{justify-content:flex-start}
.control-input{flex:1 1 18rem;max-width:30rem;min-width:10rem}
.control-input.short{flex:0 0 8rem;min-width:8rem}
select{flex:0 0 10rem}
.check{display:inline-flex;align-items:center;gap:.45rem;color:var(--muted);font-size:.85rem;font-weight:600}
.check input{min-height:auto;width:auto;accent-color:var(--accent)}
.result{min-height:2.75rem;max-height:16rem;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm);background:#0d0d11;color:var(--muted);font-family:var(--font-mono);font-size:.8rem;line-height:1.6;padding:.7rem;white-space:pre-wrap}
.result:empty::before{content:attr(data-empty);color:var(--dim)}
.result.is-error{border-color:var(--accent-line);background:rgb(255 106 69/.08);color:#ff9a7f}
.token-grid,.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.5rem;font-family:var(--font-sans)}
.token,.metric{min-width:0;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);padding:.65rem}
.token strong,.metric strong{display:block;color:var(--dim);font-size:.68rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;margin-bottom:.25rem}
.token code,.metric code{display:block;overflow:auto;color:var(--text);font-family:var(--font-mono);white-space:nowrap}
.token button{margin-top:.55rem;min-height:2.1rem;padding:.42rem .65rem}
.copy-all{justify-self:start;min-height:2.1rem;padding:.42rem .65rem}
.toast{position:fixed;right:1rem;bottom:1rem;z-index:30;display:flex;align-items:center;gap:.75rem;max-width:min(28rem,calc(100vw - 2rem));border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface-2);color:var(--text);box-shadow:0 20px 60px rgb(0 0 0/.45);opacity:0;pointer-events:none;padding:.8rem .95rem;transform:translateY(.5rem);transition:opacity .16s ease,transform .16s ease}
.toast span{min-width:0}
.toast button{min-height:2rem;padding:.35rem .55rem}
.toast.show{opacity:1;pointer-events:auto;transform:translateY(0)}
.toast.is-error{border-color:var(--accent-line);background:rgb(255 106 69/.1);color:#ff9a7f}
@media (max-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx}px){.topbar{position:static;align-items:flex-start;flex-direction:column}.origin-pill{align-items:flex-start;flex-direction:column;max-width:100%}.console{padding-top:1rem}.status-strip{position:relative;display:flex;overflow-x:auto;-webkit-overflow-scrolling:touch}.status-strip::after{content:'';position:absolute;right:0;top:0;bottom:0;width:2rem;background:linear-gradient(to right,transparent,var(--surface));pointer-events:none}.status-item{min-width:7.5rem}.command-grid{grid-template-columns:1fr}.workflow-rail{position:static;display:grid;gap:.35rem}.rail-item{min-width:0;text-align:center}.action-row{grid-template-columns:1fr}.row-copy p{max-width:65ch}.control-line,.control-stack{align-items:stretch;flex-direction:column}.control-input,.control-input.short,select,button{width:100%;max-width:none;min-width:0;flex-basis:auto}.result{max-height:none}}
@media (max-width:480px){:root{--focus:0 0 0 2px rgb(255 106 69/.28)}button{min-height:48px}.control-input,select{min-height:48px}}
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
  let toastTimer;
  const toast = (message, isError = false) => {
    const el = byId('toast');
    if (toastTimer) clearTimeout(toastTimer);
    el.textContent = '';
    el.classList.remove('show', 'is-error');
    el.classList.toggle('is-error', isError);
    const text = document.createElement('span');
    text.textContent = message;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('data-toast-dismiss', 'true');
    dismiss.addEventListener('click', () => {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = undefined;
      el.classList.remove('show');
    });
    el.append(text, dismiss);
    el.classList.add('show');
    toastTimer = setTimeout(() => { el.classList.remove('show'); toastTimer = undefined; }, isError ? 8000 : 3600);
  };
  const focusAuthSection = () => {
    byId('login')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    byId('admin-token')?.focus({ preventScroll: true });
  };
  const showSetupBanner = () => { const banner = document.querySelector('[data-setup-banner]'); if (banner) banner.hidden = false; focusAuthSection(); };
  const headers = (auth, json = false) => ({ ...(json ? {'content-type':'application/json'} : {}), ...(auth ? {authorization: 'Bearer ' + token()} : {}) });
  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw Object.assign(new Error(typeof body === 'string' ? body : body.error || 'request failed'), { body, status: response.status });
    return body;
  }
  const scopeFor = (target) => target.closest('[data-action-scope]');
  const setScopeState = (scope, state) => { if (!scope) return; scope.dataset.state = state; scope.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false'); };
  const primaryOutput = (scope) => scope?.querySelector('[data-output]');
  const setOutput = (id, value, isError = false) => { const el = byId(id); el.classList.toggle('is-error', isError); el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  const showJson = (id, value) => setOutput(id, value);
  const friendlyError = (action, error) => {
    if (action === 'first-run-setup' && error.status === config.setupLockedFeedback.status) return 'Setup is already complete for this Worker. Paste the existing admin token in the Admin token section, then use the authenticated controls below.';
    if (error.status === 401) return 'Admin token missing or invalid. Paste the admin token, verify it, then try this action again.';
    return error.body?.error || error.message || 'Request failed';
  };
  const esc = (value) => String(value).replace(/[&<>\"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[char]));
  function renderTokens(target, values) {
    const el = byId(target);
    const entries = Object.entries(values).filter(([, value]) => typeof value === 'string');
    el.classList.remove('is-error');
    el.innerHTML = '';
    if (entries.length > 1) {
      const copyAll = document.createElement('button');
      copyAll.type = 'button';
      copyAll.className = 'secondary copy-all';
      copyAll.textContent = 'Copy all';
      copyAll.setAttribute('data-copy-all', 'true');
      copyAll.addEventListener('click', async () => {
        await navigator.clipboard.writeText(entries.map(([key, value]) => key + ': ' + value).join('\n'));
        toast('Copied all');
      });
      el.appendChild(copyAll);
    }
    entries.forEach(([key, value]) => {
      const token = document.createElement('div');
      token.className = 'token';
      const label = document.createElement('strong');
      label.textContent = key;
      token.appendChild(label);
      const code = document.createElement('code');
      code.textContent = value;
      token.appendChild(code);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.dataset.copy = value;
      token.appendChild(copy);
      el.appendChild(token);
    });
  }
  function renderStatus(value) {
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    const profiles = Array.isArray(value.profiles) ? value.profiles : [];
    const audit = Array.isArray(value.audit) ? value.audit : [];
    byId('node-status').textContent = String(nodes.length);
    byId('profile-status').textContent = String(profiles.length);
    byId('audit-status').textContent = String(audit.length);
    byId('status-output').classList.remove('is-error');
    byId('status-output').innerHTML = [
      '<div class="metric"><strong>Nodes</strong><code>' + nodes.length + '</code></div>',
      '<div class="metric"><strong>Profiles</strong><code>' + profiles.length + '</code></div>',
      '<div class="metric"><strong>Audit</strong><code>' + audit.length + '</code></div>',
      '<div class="metric"><strong>Generated</strong><code>' + (value.generatedAt || 'unknown') + '</code></div>',
      '<div class="metric"><strong>Node state</strong><code>' + esc(nodes.map((node) => node.id + ':' + node.status).join('\\n')) + '</code></div>',
      '<div class="metric"><strong>Profiles</strong><code>' + esc(profiles.map((profile) => profile.id + ' ' + profile.rolloutPercent + '%').join('\\n')) + '</code></div>'
    ].join('');
  }
  document.addEventListener('click', async (event) => {
    const bannerAction = event.target.closest('[data-banner-action="go-to-auth"]');
    if (bannerAction) { event.preventDefault(); focusAuthSection(); return; }
    const copy = event.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.copy || ''); toast('Copied'); return; }
    const button = event.target.closest('[data-action]');
    const action = button?.dataset.action;
    if (!action) return;
    const scope = scopeFor(button);
    if (action === 'node-revoke' && button.dataset.confirming !== 'true') {
      button.dataset.confirming = 'true';
      button.textContent = 'Are you sure?';
      setScopeState(scope, 'idle');
      return;
    }
    try {
      setScopeState(scope, 'loading'); button.disabled = true;
      if (action === 'first-run-setup') {
        const body = await request('/admin/setup', { method: 'POST' });
        renderTokens('setup-output', body); setToken(body.adminToken || '', byId('remember-token').checked); byId('setup-status').textContent = 'locked'; byId('auth-status').textContent = 'verified'; toast('Setup complete');
      } else if (action === 'admin-login') {
        setToken(byId('admin-token').value.trim(), byId('remember-token').checked); await request('/admin/login', { method: 'POST', headers: headers(true) }); byId('auth-status').textContent = 'verified'; setOutput('login-output', 'Admin token verified'); toast('Admin token verified');
      } else if (action === 'forget-token') {
        setToken('', false); byId('auth-status').textContent = 'required'; setOutput('login-output', 'Token removed'); toast('Token removed');
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
      setScopeState(scope, 'ready');
    } catch (error) {
      const message = friendlyError(action, error);
      const output = primaryOutput(scope);
      if (output) {
        output.classList.add('is-error');
        if (action === 'first-run-setup' && error.status === config.setupLockedFeedback.status) {
          output.dataset.feedback = config.setupLockedFeedback.variant;
          showSetupBanner();
        }
        output.textContent = message;
      }
      setScopeState(scope, 'error');
      toast(message, true);
    } finally {
      if (action === 'node-revoke') {
        delete button.dataset.confirming;
        button.textContent = 'Revoke node';
      }
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
  REQ_ADM_006: 'REQ-ADM-006',
  COMMAND_CENTER: 'ADMIN_UI_COMMAND_CENTER',
  ACTION_ROW: 'ADMIN_UI_ACTION_ROW_ANCHOR',
  SETUP_LOCKED_FEEDBACK: 'ADMIN_UI_SETUP_LOCKED_FEEDBACK'
} as const
