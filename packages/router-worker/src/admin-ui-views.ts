import {
  ADMIN_UI_ACTIONS,
  ADMIN_UI_AGENT_VERSION,
  ADMIN_UI_DRAWER,
  ADMIN_UI_MESH_HEALTH,
  ADMIN_UI_NAV,
  ADMIN_UI_NODES_TABLE,
  ADMIN_UI_PLAYGROUND,
  ADMIN_UI_TOKS_TRACE,
  ADMIN_UI_TOPOLOGY,
  ADMIN_UI_WIZARD
} from './admin-ui-contract'
import { button, escapeHtml, field, navItem, output, sectionPanel, stepper, tabItem, textInput, wizardStep } from './admin-ui-components'

/**
 * The three entry views. Pure composition: structure comes from
 * admin-ui-components, ids and orders from admin-ui-contract, and all
 * dynamic content is rendered client-side from authenticated responses.
 */

function platformSelect(prefix: string): string {
  return `<select id="${prefix}installer-platform" name="platform" data-installer-platform="true" data-prefix="${prefix}"><option value="linux">Linux</option><option value="macos">macOS</option><option value="windows">Windows</option></select>`
}

function emptySlotSelect(slotId: string, selectId: string, name: string, marker: string): string {
  return `<span class="slot" id="${slotId}"><select id="${selectId}" name="${name}" ${marker} disabled></select></span>`
}

function enrollControls(prefix: string): string {
  return `<div class="form-actions">${button({ action: 'setup-token-create', label: 'Create setup token', out: `${prefix}setup-token-output`, prefix })}</div>
${output({ id: `${prefix}setup-token-output`, kind: 'setup-token', extraClass: 'token-grid' })}
<div class="form-grid">${field({ id: `${prefix}installer-platform`, label: 'Platform', control: platformSelect(prefix) })}</div>
<p class="field-hint">Create a token and your install command appears below. Click it to copy, then run it on the machine.</p>
${output({ id: `${prefix}installer-output`, kind: 'installer-command', pre: true, extraClass: 'copyable' })}`
}

export function setupWizardView(active: boolean): string {
  const steps = [
    { step: 'connect', label: 'Connect' },
    { step: 'domain', label: 'Domain' },
    { step: 'access', label: 'Access' },
    { step: 'gateway', label: 'Gateway' },
    { step: 'node', label: 'First node' },
    { step: 'review', label: 'Review' }
  ]
  const connect = wizardStep({
    step: 'connect',
    title: 'Claim this deployment',
    description: 'Claims this router and issues one setup access token. Save it to return to setup until Access is live. Gateway and node credentials appear later, at the steps that use them.',
    active: true,
    body: `<div class="wizard-actions">${button({ action: 'first-run-setup', label: 'Claim deployment', variant: 'primary', out: 'setup-output' })}</div>
${output({ id: 'setup-output', kind: 'setup-tokens', extraClass: 'token-grid' })}
<div class="wizard-actions"><button class="btn" type="button" data-wizard-next id="wizard-continue-connect" hidden>Continue</button></div>
<details class="gate-alt" id="connect-signin"><summary>Already claimed? Sign in</summary>
<form class="signin-form" id="login-form" data-login-form="true">
${field({ id: 'admin-token', label: 'Admin token', control: textInput({ id: 'admin-token', name: 'adminToken', type: 'password', autocomplete: 'current-password' }) })}
<label class="check"><input name="rememberToken" id="remember-token" type="checkbox"> Remember on this device</label>
<button class="btn" type="submit">Sign in</button>
${output({ id: 'login-output', kind: 'login-feedback' })}
</form></details>`
  })
  const domain = wizardStep({
    step: 'domain',
    title: 'Set the custom domain',
    description: 'The console and all mesh traffic move to this hostname permanently. Pick a zone from your account and choose a hostname inside it.',
    body: `<div class="form-grid">
${field({ id: 'wizard-domain-zone', label: 'Zone', control: '<span class="slot" id="wizard-zone-slot"><select id="wizard-domain-zone" name="zoneId" data-zone-select="true" disabled></select></span>', hint: 'Zones load from your Cloudflare account.' })}
${field({ id: 'wizard-domain-hostname', label: 'Hostname', control: textInput({ id: 'wizard-domain-hostname', name: 'hostname', inputmode: 'url', placeholder: 'e.g. mesh.example.com' }) })}
</div>
<div class="wizard-actions"><button class="btn btn-ghost" type="button" data-wizard-back>Back</button>${button({ action: 'setup-domain', label: 'Provision domain', variant: 'primary', out: 'wizard-domain-output' })}</div>
${output({ id: 'wizard-domain-output', kind: 'setup-domain', pre: true })}`
  })
  const access = wizardStep({
    step: 'access',
    title: 'Gate access with roles',
    description: 'Cloudflare Access protects the custom domain. Add admin and, optionally, user identities: an email or an existing Access group name for each. Admins reconfigure everything; users get a read-only console with the playground. Each person signs in with a one-time PIN.',
    body: `<div class="form-grid">
${field({ id: 'wizard-admin-ident', label: 'Admin email or Access group', control: textInput({ id: 'wizard-admin-ident', name: 'adminIdent', placeholder: 'you@example.com or an Access group name' }), hint: 'Admins see and reconfigure everything. At least one is required.' })}
</div>
<div class="wizard-actions"><button class="btn" type="button" data-action="access-ident-add" data-ident-input="wizard-admin-ident" data-ident-list="admin">Add admin</button></div>
<ul class="email-chips" id="wizard-admin-idents" data-ident-chips="admin"></ul>
<div class="form-grid">
${field({ id: 'wizard-user-ident', label: 'User email or Access group (optional)', control: textInput({ id: 'wizard-user-ident', name: 'userIdent', placeholder: 'read-only: dashboard, stats, playground' }), hint: 'Leave empty to let anyone who can pass Access read the console.' })}
</div>
<div class="wizard-actions"><button class="btn" type="button" data-action="access-ident-add" data-ident-input="wizard-user-ident" data-ident-list="user">Add user</button></div>
<ul class="email-chips" id="wizard-user-idents" data-ident-chips="user"></ul>
<div class="wizard-actions"><button class="btn btn-ghost" type="button" data-wizard-back>Back</button>${button({ action: 'setup-access', label: 'Enable Access', variant: 'primary', out: 'wizard-access-output' })}</div>
${output({ id: 'wizard-access-output', kind: 'setup-access', pre: true })}
<div class="handoff-panel" id="wizard-handoff" hidden>
<p>Access is live. Continue setup on the custom domain. This bootstrap page locks when setup finishes.</p>
<a class="btn btn-primary" id="wizard-handoff-link" href="#">Continue on custom domain</a>
</div>`
  })
  const gateway = wizardStep({
    step: 'gateway',
    title: 'Connect AI Gateway',
    description: 'Choose your AI Gateway (or create one) and name the provider. The dynamic route your clients call is created for you. You can also do this later under Routing.',
    body: `<div class="wizard-actions" id="wizard-gateway-empty" hidden>${button({ action: 'gateway-provision-default', label: 'Create gateway + route', variant: 'primary', out: 'wiz-gateway-output' })}</div>
<div class="form-grid" id="wizard-gateway-selects">
${field({ id: 'wiz-gateway-select', label: 'Gateway', control: '<span class="slot" id="wiz-gateway-slot"><select id="wiz-gateway-select" name="gatewayId" data-gateway-select="true" disabled></select></span>' })}
${field({ id: 'wiz-gateway-provider-name', label: 'Provider name', control: textInput({ id: 'wiz-gateway-provider-name', name: 'providerName', value: 'Codeflare Inference Mesh' }), hint: 'The name of the provider created on your AI Gateway.' })}
</div>
<div class="form-grid"><div id="wiz-gateway-new-wrap" hidden>${field({ id: 'wiz-gateway-new', label: 'New gateway name', control: textInput({ id: 'wiz-gateway-new', name: 'newGatewayId', placeholder: 'e.g. inference-mesh' }) })}</div></div>
<p class="field-hint">The dynamic route <code>codeflare-mesh</code> is created for you; you never choose a route or model.</p>
<div class="wizard-actions">${button({ action: 'gateway-sync', label: 'Connect AI Gateway', variant: 'primary', out: 'wiz-gateway-output', prefix: 'wiz-' })}</div>
${output({ id: 'wiz-gateway-output', kind: 'gateway-sync', pre: true })}
<div class="wizard-actions"><button class="btn btn-ghost" type="button" data-wizard-back>Back</button><button class="btn" type="button" data-wizard-next>Continue</button></div>`
  })
  const node = wizardStep({
    step: 'node',
    title: 'Enroll your first node',
    description: 'Create a short-lived setup token, then run the install command on the machine that will serve inference. You can also do this later under Nodes.',
    body: `${enrollControls('wiz-')}
<div class="wizard-actions"><button class="btn btn-ghost" type="button" data-wizard-back>Back</button><button class="btn" type="button" data-wizard-next>Continue</button></div>`
  })
  const review = wizardStep({
    step: 'review',
    title: 'Review and finish',
    description: 'What this router knows so far. Finishing locks the bootstrap origin; everything stays adjustable from the dashboard.',
    body: `<div class="tile-grid" id="review-summary"></div>
<div class="wizard-actions"><button class="btn btn-ghost" type="button" data-wizard-back>Back</button>${button({ action: 'setup-complete', label: 'Finish setup', variant: 'primary', out: 'wizard-complete-output' })}</div>
${output({ id: 'wizard-complete-output', kind: 'setup-complete', pre: true })}`
  })
  return `<section class="view view-gate" id="view-setup" data-wizard="${escapeHtml(ADMIN_UI_WIZARD.steps.join(' '))}"${active ? '' : ' hidden'} aria-label="Guided setup">
<div class="gate-flow">${stepper(steps, 'connect')}${connect}${domain}${access}${gateway}${node}${review}</div>
</section>`
}

function overviewSection(): string {
  return sectionPanel({
    id: 'overview',
    title: 'Overview',
    description: 'Live state of the router, mesh, and recent activity.',
    actions: button({ action: 'status-refresh', label: 'Refresh' }),
    active: true,
    body: `<div class="tile-grid" id="overview-tiles" data-output="status"><p class="empty-note">Status loads automatically.</p></div>
<div class="topology" id="${ADMIN_UI_TOPOLOGY.containerId}">
<p class="topo-caption" id="${ADMIN_UI_TOPOLOGY.captionId}" data-output="topology-caption"></p>
<div class="toks-trace" id="${ADMIN_UI_TOKS_TRACE.containerId}" data-output="toks-trace" role="img" aria-label="Tokens per second, rolling window"></div>
<div class="topo-canvas" id="${ADMIN_UI_TOPOLOGY.canvasId}" data-output="topology" role="group" aria-label="Mesh topology"></div>
<div class="topo-list" id="${ADMIN_UI_TOPOLOGY.listId}" data-output="topology-list"></div>
</div>
<div class="subpanel"><h3>Model sharing</h3><div class="form-actions" id="overview-mesh"></div></div>
<div class="subpanel"><h3>Recent activity</h3><div class="feed" id="overview-audit" data-output="audit"></div></div>`
  })
}

function nodesSection(): string {
  return sectionPanel({
    id: 'nodes',
    title: 'Nodes',
    description: 'The machines running your models. Ready = serving a model. Active = online, still loading. Offline = has not checked in.',
    actions: button({ action: 'status-refresh', label: 'Refresh' }),
    body: `<div class="node-filters form-actions" role="group" aria-label="Filter machines">
<button class="btn btn-ghost" type="button" id="node-filter-all" data-action="nodes-filter" data-filter="all" aria-current="page">All</button>
<button class="btn btn-ghost" type="button" id="node-filter-ready" data-action="nodes-filter" data-filter="ready">Ready</button>
<button class="btn btn-ghost" type="button" id="node-filter-active" data-action="nodes-filter" data-filter="active">Active</button>
<button class="btn btn-ghost" type="button" id="node-filter-offline" data-action="nodes-filter" data-filter="offline">Offline</button>
<label for="node-search">Search</label>
<input class="node-search" id="node-search" type="search" name="nodeSearch" placeholder="Search machines…" data-node-search="true">
</div>
<div class="table-wrap"><table class="nodes-table" data-output="nodes-table">
<thead><tr>${ADMIN_UI_NODES_TABLE.columns.map((column) => `<th scope="col"><button class="sort-btn" type="button" data-action="nodes-sort" data-sort="${column}">${column === 'toks' ? 'tok/s' : column === 'vram' ? 'VRAM' : column}</button></th>`).join('')}</tr></thead>
<tbody id="${ADMIN_UI_NODES_TABLE.bodyId}"><tr><td class="empty-note" colspan="${ADMIN_UI_NODES_TABLE.columns.length}">Nodes appear here once enrolled.</td></tr></tbody>
</table></div>
${output({ id: 'node-output', kind: 'node-revoke', pre: true })}
<div class="subpanel"><h3>Enroll a node</h3>${enrollControls('')}</div>`
  })
}

function addModelCard(): string {
  return `<div class="subpanel"><h3>Add a model</h3>
<p class="field-hint">Add any mesh-llm-compatible model. Single machine runs a full GGUF model on one machine; split runs a layer package across several.</p>
<div class="form-grid">
${field({ id: 'model-add-mode', label: 'Serving', control: '<span class="slot"><select id="model-add-mode" name="mode" data-model-add-mode="true"><option value="single">Single machine</option><option value="split">Split (multi-machine)</option></select></span>' })}
${field({ id: 'model-add-ref', label: 'Model reference', control: textInput({ id: 'model-add-ref', name: 'modelRef', placeholder: 'e.g. unsloth/Qwen3-14B-GGUF:Q4_K_M' }), hint: 'Paste a model reference, or find one below.' })}
</div>
<p class="field-hint">Find a model: <a id="model-add-search-single" href="https://huggingface.co/unsloth?search_models=GGUF" target="_blank" rel="noopener">Unsloth GGUF (single machine)</a> · <a id="model-add-search-split" href="https://huggingface.co/meshllm" target="_blank" rel="noopener">mesh-llm layer packages (split)</a> · <a id="model-add-split-guide" href="https://github.com/Mesh-LLM/hf-mesh-skippy-splitter" target="_blank" rel="noopener">prepare your own split model</a></p>
<div class="form-actions">${button({ action: 'model-add', label: 'Add model', variant: 'primary', out: 'model-add-output' })}</div>
${output({ id: 'model-add-output', kind: 'model-add', pre: true })}</div>`
}

function modelsSection(): string {
  return sectionPanel({
    id: 'models',
    title: 'Models',
    description: 'The AI models your machines can run. Turn one on to start serving it; open Manage to rename what callers ask for or change its settings.',
    body: `<div class="row-list" id="profile-list" data-output="profiles"><p class="empty-note">Your models appear here after you sign in. Turn one on to start serving it.</p></div>
${output({ id: 'models-output', kind: 'models', pre: true })}
${addModelCard()}`
  })
}

function routingSection(): string {
  return sectionPanel({
    id: 'routing',
    title: 'Routing',
    description: 'The address people use to reach your models, and how requests find this router. Everything here is discovered from your connected Cloudflare account, so you never type an ID by hand.',
    body: `<h3>AI Gateway</h3>
<p class="empty-note" id="gateway-current">No gateway connected yet.</p>
<p class="field-hint">Pick one of your existing gateways, or create a new one. The dynamic route <code>codeflare-mesh</code> is created for you.</p>
<div class="wizard-actions" id="rt-gateway-empty" hidden>${button({ action: 'gateway-provision-default', label: 'Create gateway + route', variant: 'primary', out: 'gateway-output' })}</div>
<div class="form-grid" id="rt-gateway-selects">
${field({ id: 'rt-gateway-select', label: 'Gateway', control: '<span class="slot" id="rt-gateway-slot"><select id="rt-gateway-select" name="gatewayId" data-gateway-select="true" disabled></select></span>' })}
${field({ id: 'rt-gateway-provider-name', label: 'Provider name', control: textInput({ id: 'rt-gateway-provider-name', name: 'providerName', value: 'Codeflare Inference Mesh' }), hint: 'The provider created on your AI Gateway. Copy its API key below into the provider API Key field.' })}
</div>
<div class="form-grid"><div id="rt-gateway-new-wrap" hidden>${field({ id: 'rt-gateway-new', label: 'New gateway name', control: textInput({ id: 'rt-gateway-new', name: 'newGatewayId', placeholder: 'e.g. inference-mesh' }) })}</div></div>
<div class="form-actions">${button({ action: 'gateway-sync', label: 'Connect gateway', variant: 'primary', out: 'gateway-output', prefix: 'rt-' })}</div>
${output({ id: 'gateway-output', kind: 'gateway-sync', pre: true })}
<p class="route-status"><span class="route-chip" id="rt-route-chip"><span class="route-dot"></span>dynamic route <code>codeflare-mesh</code> · <span id="rt-route-state">not connected</span></span></p>
<div class="subpanel"><h3>Custom domain</h3>
<p class="empty-note" id="custom-domain-current">No custom domain yet.</p>
<div class="form-grid">
${field({ id: 'custom-domain', label: 'Address people will use', control: textInput({ id: 'custom-domain', name: 'hostname', inputmode: 'url', placeholder: 'e.g. mesh.example.com' }), hint: 'Just the address. We match it to your Cloudflare domain automatically.' })}
</div>
<div class="form-actions">${button({ action: 'custom-domain-validate', label: 'Set up custom domain', out: 'domain-output' })}</div>
${output({ id: 'domain-output', kind: 'custom-domain', pre: true })}</div>`
  })
}

function meshSection(): string {
  return sectionPanel({
    id: 'mesh',
    title: 'Model sharing',
    description: 'When a model is too big for one machine, several machines team up to run it together. This shows those groups; with a single machine it stays empty.',
    actions: button({ action: 'status-refresh', label: 'Refresh' }),
    body: `<p class="banner" id="${ADMIN_UI_MESH_HEALTH.bannerId}" data-mesh-key-banner="true" hidden>A required Worker secret (<code>MESH_STATE_KEY</code>) is missing, so machines cannot form a sharing group. Set it in the deployment and redeploy.</p>
<div class="tile-grid" id="${ADMIN_UI_MESH_HEALTH.panelId}" data-output="mesh-health"><p class="empty-note">Model sharing appears here only when several machines run one model together.</p></div>
<div class="subpanel"><h3>Reset the sharing key</h3>
${field({ id: ADMIN_UI_MESH_HEALTH.rotateSelectId, label: 'Shared model', control: emptySlotSelect('mesh-rotate-slot', ADMIN_UI_MESH_HEALTH.rotateSelectId, 'meshProfileId', 'data-mesh-profile-select="true"'), hint: 'Resetting briefly disconnects and reconnects the machines, about two minutes.' })}
<div class="form-actions">${button({ action: 'mesh-rotate', label: 'Reset sharing key', variant: 'danger', confirm: 'Reset the sharing key?', out: 'mesh-rotate-output' })}</div>
${output({ id: 'mesh-rotate-output', kind: 'mesh-rotate', pre: true })}</div>`
  })
}

function playgroundSection(): string {
  return sectionPanel({
    id: 'playground',
    title: 'Playground',
    description: 'Send a test prompt to your models and watch the answer stream back.',
    body: `<div class="form-grid">
${field({ id: ADMIN_UI_PLAYGROUND.selectId, label: 'Model', control: emptySlotSelect(ADMIN_UI_PLAYGROUND.slotId, ADMIN_UI_PLAYGROUND.selectId, 'playgroundModel', 'data-playground-model-select="true"'), hint: 'Only models that are switched on appear here. Your prompt takes the same path your apps use.' })}
</div>
${field({ id: ADMIN_UI_PLAYGROUND.promptId, label: 'Prompt', control: `<textarea class="prompt-input" id="${ADMIN_UI_PLAYGROUND.promptId}" name="prompt" rows="4" placeholder="Ask the mesh something to verify the full path."></textarea>` })}
<div class="form-actions">${button({ action: ADMIN_UI_PLAYGROUND.sendAction, label: 'Send prompt', variant: 'primary', out: ADMIN_UI_PLAYGROUND.outputId })}</div>
${output({ id: ADMIN_UI_PLAYGROUND.outputId, kind: 'playground', pre: true })}`
  })
}

function settingsSection(): string {
  const apiRows = ADMIN_UI_ACTIONS
    .map((action) => `<code>${action.method} ${escapeHtml(action.path)}${action.auth === 'admin' ? ' · admin' : ''}</code>`)
    .join('')
  return sectionPanel({
    id: 'settings',
    title: 'Settings',
    description: 'Machine software version, activity log, session, and recovery.',
    body: `<h3>Machine software version</h3>
<div class="form-actions">${button({ action: 'agent-versions-refresh', label: 'Load available versions' })}</div>
${field({ id: ADMIN_UI_AGENT_VERSION.selectId, label: 'Version to run on every machine', control: emptySlotSelect(ADMIN_UI_AGENT_VERSION.slotId, ADMIN_UI_AGENT_VERSION.selectId, 'agentVersion', 'data-agent-version-select="true" data-stale="false"'), hint: 'Each machine updates to this version the next time it checks in.' })}
<div class="form-actions">${button({ action: 'agent-version-set', label: 'Apply to all machines', out: 'agent-version-output' })}</div>
${output({ id: 'agent-version-output', kind: 'agent-version', pre: true })}
<div class="subpanel"><h3>API keys</h3>
<p class="field-hint">Create a key to operate the mesh over the <code>/api/v1</code> API. The secret is shown once, so copy it immediately. Rotate issues a fresh secret and retires the old one; revoke disables a key immediately.</p>
<div class="form-actions">${button({ action: 'api-key-create', label: 'Create API key', out: 'api-key-output' })}</div>
${output({ id: 'api-key-output', kind: 'api-key', pre: true, extraClass: 'copyable' })}
<div class="key-list" id="api-key-list"><p class="empty-note">API keys appear here after you create one.</p></div></div>
<div class="subpanel"><h3>Offline machines</h3>
${field({ id: 'prune-seconds', label: 'Remove a machine after it is offline for (seconds)', control: textInput({ id: 'prune-seconds', name: 'offlinePruneSeconds', type: 'number', min: 0 }), hint: 'A removed machine must re-enroll. 0 keeps offline machines forever. Example: 3600 = one hour, 2592000 = 30 days.' })}
<div class="form-actions">${button({ action: 'settings-save', label: 'Save', out: 'settings-output' })}</div>
${output({ id: 'settings-output', kind: 'settings', pre: true })}</div>
<div class="subpanel"><h3>Activity log</h3><div class="feed" id="audit-log"><p class="empty-note">Activity appears here after you sign in.</p></div></div>
<div class="subpanel"><h3>Session</h3><p class="empty-note">The admin token lives only in this browser's storage.</p><div class="form-actions">${button({ action: 'sign-out', label: 'Sign out and forget token', variant: 'ghost' })}</div></div>
<div class="subpanel"><h3>Recovery</h3><p class="empty-note">Lost the admin token? <code>POST /admin/recovery/reset</code> with the <code>ADMIN_RECOVERY_TOKEN</code> Worker secret mints a replacement.</p></div>
<div class="subpanel"><details><summary>API reference</summary><div class="api-list">${apiRows}</div></details></div>`
  })
}

export function dashboardView(active: boolean): string {
  const navItems = [
    navItem({ section: 'overview', label: 'Overview', hint: 'Health and activity', current: true }),
    navItem({ section: 'nodes', label: 'Nodes', hint: 'Your machines' }),
    navItem({ section: 'models', label: 'Models', hint: 'Your AI models' }),
    navItem({ section: 'routing', label: 'Routing', hint: 'Address and gateway' }),
    navItem({ section: 'mesh', label: 'Model sharing', hint: 'Machines sharing a model' }),
    navItem({ section: 'playground', label: 'Playground', hint: 'Try a prompt' }),
    navItem({ section: 'settings', label: 'Settings', hint: 'Version and activity' })
  ].join('')
  const tabs = [
    tabItem({ tab: 'overview', label: 'Overview', glyph: '◎', current: true }),
    tabItem({ tab: 'nodes', label: 'Nodes', glyph: '●' }),
    tabItem({ tab: 'mesh', label: 'Sharing', glyph: '◆' }),
    tabItem({ tab: 'more', label: 'More', glyph: '⋯' })
  ].join('')
  const moreItems = [
    navItem({ section: 'models', label: 'Models', hint: 'Your AI models' }),
    navItem({ section: 'routing', label: 'Routing', hint: 'Address and gateway' }),
    navItem({ section: 'playground', label: 'Playground', hint: 'Try a prompt' }),
    navItem({ section: 'settings', label: 'Settings', hint: 'Version and activity' })
  ].join('')
  return `<div class="view dash" id="view-dashboard"${active ? '' : ' hidden'}>
<nav class="side-nav" aria-label="Console sections" data-nav-sections="${escapeHtml(ADMIN_UI_NAV.sections.join(' '))}">${navItems}</nav>
<div class="sections">${overviewSection()}${nodesSection()}${modelsSection()}${routingSection()}${meshSection()}${playgroundSection()}${settingsSection()}</div>
<nav class="tab-bar" aria-label="Console sections" data-mobile-tabs="${escapeHtml(ADMIN_UI_NAV.mobileTabs.join(' '))}">${tabs}</nav>
<div class="more-sheet" id="more-sheet" data-more-sections="${escapeHtml(ADMIN_UI_NAV.moreSections.join(' '))}" hidden>${moreItems}</div>
<aside class="drawer" id="${ADMIN_UI_DRAWER.containerId}" role="dialog" aria-labelledby="${ADMIN_UI_DRAWER.titleId}" hidden>
<div class="drawer-head"><h2 id="${ADMIN_UI_DRAWER.titleId}"></h2><button class="btn btn-ghost" type="button" data-action="${ADMIN_UI_DRAWER.closeAction}">Close</button></div>
<div class="drawer-body" id="${ADMIN_UI_DRAWER.bodyId}"></div>
</aside>
</div>`
}

/**
 * Standalone page served on non-custom-domain hostnames after setup
 * completes (REQ-ADM-014). Deliberately free of the admin-ui-config
 * script: the bootstrap origin stops being a console entirely.
 */
export function consoleMovedHtml(hostname: string): string {
  const consoleUrl = `https://${escapeHtml(hostname)}/admin`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>codeflare / inference-mesh</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#09090b;color:#e4e4e7;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.125rem;font-weight:600;margin:0 0 .75rem}p{font-size:.875rem;line-height:1.6;color:#a1a1aa;margin:0 0 1rem}a{color:#ff5c3c;text-decoration:none;word-break:break-all}a:hover{text-decoration:underline}</style>
</head>
<body>
<main data-view="moved">
<h1>Console has moved</h1>
<p>This origin is bootstrap-only. The operator console and all mesh traffic live on the custom domain.</p>
<p><a href="${consoleUrl}">${consoleUrl}</a></p>
</main>
</body>
</html>`
}
