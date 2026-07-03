import {
  ADMIN_UI_ACTIONS,
  ADMIN_UI_AGENT_VERSION,
  ADMIN_UI_MESH_HEALTH,
  ADMIN_UI_NAV,
  ADMIN_UI_PROFILE_ACTIVATION,
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

function gatewayFields(prefix: string): string {
  return [
    field({ id: `${prefix}gateway-account-id`, label: 'Cloudflare account ID', control: textInput({ id: `${prefix}gateway-account-id`, name: 'accountId' }) }),
    field({ id: `${prefix}gateway-id`, label: 'Gateway ID', control: textInput({ id: `${prefix}gateway-id`, name: 'gatewayId', placeholder: 'e.g. inference-mesh' }) }),
    field({ id: `${prefix}gateway-route-name`, label: 'Route name', control: textInput({ id: `${prefix}gateway-route-name`, name: 'routeName', placeholder: 'e.g. mesh-default' }) }),
    field({ id: `${prefix}gateway-public-model`, label: 'Public model', control: textInput({ id: `${prefix}gateway-public-model`, name: 'publicModel', placeholder: 'e.g. mesh-default' }) }),
    field({ id: `${prefix}gateway-provider-name`, label: 'Provider name', control: textInput({ id: `${prefix}gateway-provider-name`, name: 'providerName', placeholder: 'e.g. codeflare-inference-mesh' }) }),
    field({ id: `${prefix}gateway-worker-url`, label: 'Worker URL override', control: textInput({ id: `${prefix}gateway-worker-url`, name: 'workerUrl', inputmode: 'url', placeholder: 'e.g. https://router.example.workers.dev' }), hint: 'Blank fields reuse saved settings or Worker environment defaults.' })
  ].join('')
}

function enrollControls(prefix: string): string {
  return `<div class="form-actions">${button({ action: 'setup-token-create', label: 'Create setup token', out: `${prefix}setup-token-output` })}</div>
${output({ id: `${prefix}setup-token-output`, kind: 'setup-token', extraClass: 'token-grid' })}
<div class="form-grid">${field({ id: `${prefix}installer-platform`, label: 'Platform', control: platformSelect(prefix) })}</div>
<div class="form-actions">${button({ action: 'installer-generate', label: 'Copy install command', out: `${prefix}installer-output`, prefix })}</div>
${output({ id: `${prefix}installer-output`, kind: 'installer-command', pre: true })}`
}

export function setupWizardView(active: boolean): string {
  const steps = [
    { step: 'credentials', label: 'Credentials' },
    { step: 'gateway', label: 'Gateway' },
    { step: 'node', label: 'First node' },
    { step: 'review', label: 'Review' }
  ]
  const credentials = wizardStep({
    step: 'credentials',
    title: 'Create credentials',
    description: 'One click creates the admin, provider, setup, and upstream tokens. Setup locks afterwards.',
    active: true,
    body: `<div class="wizard-actions">${button({ action: 'first-run-setup', label: 'Create credentials', variant: 'primary', out: 'setup-output' })}</div>
${output({ id: 'setup-output', kind: 'setup-tokens', extraClass: 'token-grid' })}
<div class="wizard-actions"><button class="btn" type="button" data-wizard-next id="wizard-continue-credentials" hidden>Continue</button></div>
<p class="gate-alt" id="setup-locked-note">Already set up? <a data-goto-login href="#">Sign in</a></p>`
  })
  const gateway = wizardStep({
    step: 'gateway',
    title: 'Connect AI Gateway',
    description: 'Point your Cloudflare AI Gateway route at this router. You can also do this later under Routing.',
    body: `<div class="form-grid">${gatewayFields('wiz-')}</div>
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
    title: 'Review',
    description: 'What this router knows so far. Everything stays adjustable from the dashboard.',
    body: `<div class="tile-grid" id="review-summary"></div>
<div class="wizard-actions"><button class="btn btn-ghost" type="button" data-wizard-back>Back</button>${button({ action: 'wizard-finish', label: 'Open dashboard', variant: 'primary' })}</div>`
  })
  return `<section class="view view-gate" id="view-setup" data-wizard="${escapeHtml(ADMIN_UI_WIZARD.steps.join(' '))}"${active ? '' : ' hidden'} aria-label="Guided setup">
<div class="gate-flow">${stepper(steps, 'credentials')}${credentials}${gateway}${node}${review}</div>
</section>`
}

export function loginView(active: boolean): string {
  return `<section class="view view-gate" id="view-login"${active ? '' : ' hidden'} aria-label="Sign in">
<form class="gate-card" id="login-form" data-login-form="true">
<h1>Sign in</h1>
<p>Paste the admin token created during setup. It is verified against the router before it is stored, and it stays in this browser only.</p>
${field({ id: 'admin-token', label: 'Admin token', control: textInput({ id: 'admin-token', name: 'adminToken', type: 'password', autocomplete: 'current-password' }) })}
<label class="check"><input name="rememberToken" id="remember-token" type="checkbox"> Remember on this device</label>
<button class="btn btn-primary" type="submit">Sign in</button>
${output({ id: 'login-output', kind: 'login-feedback' })}
</form>
</section>`
}

function overviewSection(): string {
  return sectionPanel({
    id: 'overview',
    title: 'Overview',
    description: 'Live state of the router, mesh, and recent activity.',
    actions: button({ action: 'status-refresh', label: 'Refresh' }),
    active: true,
    body: `<div class="tile-grid" id="overview-tiles" data-output="status"><p class="empty-note">Status loads automatically after sign-in.</p></div>
<div class="subpanel"><h3>Mesh</h3><div class="form-actions" id="overview-mesh"></div></div>
<div class="subpanel"><h3>Recent activity</h3><div class="feed" id="overview-audit" data-output="audit"></div></div>`
  })
}

function nodesSection(): string {
  return sectionPanel({
    id: 'nodes',
    title: 'Nodes',
    description: 'Enrolled machines, their runtime state, and agent versions.',
    actions: button({ action: 'status-refresh', label: 'Refresh' }),
    body: `<div class="row-list" id="node-list" data-output="nodes"><p class="empty-note">Nodes appear here after sign-in.</p></div>
${output({ id: 'node-output', kind: 'node-revoke', pre: true })}
<div class="subpanel"><h3>Enroll a node</h3>${enrollControls('')}</div>`
  })
}

function modelsSection(): string {
  return sectionPanel({
    id: 'models',
    title: 'Models',
    description: 'Serving profiles, readiness, activation, and rollout.',
    body: `<div class="row-list" id="profile-list" data-output="profiles"><p class="empty-note">Profiles appear here after sign-in.</p></div>
<div class="subpanel"><h3>Serving profile</h3>
${field({ id: ADMIN_UI_PROFILE_ACTIVATION.selectId, label: 'Serving profile', control: emptySlotSelect(ADMIN_UI_PROFILE_ACTIVATION.slotId, ADMIN_UI_PROFILE_ACTIVATION.selectId, 'activateProfileId', 'data-profile-activate-select="true"'), hint: 'Activation atomically deactivates the alias-sharing pair.' })}
<div class="form-actions">${button({ action: 'profile-activate', label: 'Activate profile', out: 'profile-activate-output' })}</div>
${output({ id: 'profile-activate-output', kind: 'profile-activate', pre: true })}</div>
<div class="subpanel"><h3>Rollout</h3>
<div class="form-grid">
${field({ id: 'rollout-profile-select', label: 'Profile', control: '<span class="slot"><select id="rollout-profile-select" name="profileId" disabled></select></span>' })}
${field({ id: 'rollout-percent', label: 'Rollout percent', control: textInput({ id: 'rollout-percent', name: 'rolloutPercent', type: 'number', value: '100', min: 0, max: 100 }), hint: 'How much traffic can use this profile, from 0 to 100 percent.' })}
</div>
<div class="form-actions">${button({ action: 'profile-rollout', label: 'Update rollout', out: 'profile-output' })}</div>
${output({ id: 'profile-output', kind: 'profile-rollout', pre: true })}</div>`
  })
}

function routingSection(): string {
  return sectionPanel({
    id: 'routing',
    title: 'Routing',
    description: 'How AI Gateway traffic reaches this router.',
    body: `<h3>AI Gateway</h3>
<p class="empty-note" id="gateway-current">No Gateway connected yet.</p>
<div class="form-grid">${gatewayFields('')}</div>
<div class="form-actions">${button({ action: 'gateway-sync', label: 'Connect AI Gateway', variant: 'primary', out: 'gateway-output' })}</div>
${output({ id: 'gateway-output', kind: 'gateway-sync', pre: true })}
<div class="subpanel"><h3>Custom domain</h3>
<div class="form-grid">
${field({ id: 'custom-domain', label: 'Hostname', control: textInput({ id: 'custom-domain', name: 'hostname', inputmode: 'url', placeholder: 'e.g. ai.example.com' }) })}
${field({ id: 'custom-domain-zone', label: 'Zone ID (optional)', control: textInput({ id: 'custom-domain-zone', name: 'zoneId' }), hint: 'Provide a zone ID when multiple zones could match the hostname.' })}
</div>
<div class="form-actions">${button({ action: 'custom-domain-validate', label: 'Provision custom domain', out: 'domain-output' })}</div>
${output({ id: 'domain-output', kind: 'custom-domain', pre: true })}</div>`
  })
}

function meshSection(): string {
  return sectionPanel({
    id: 'mesh',
    title: 'Mesh',
    description: 'Per-profile mesh formation, rotation, and secret presence.',
    actions: button({ action: 'status-refresh', label: 'Refresh' }),
    body: `<p class="banner" id="${ADMIN_UI_MESH_HEALTH.bannerId}" data-mesh-key-banner="true" hidden>Mesh secret key missing: set the <code>MESH_STATE_KEY</code> Worker secret so mesh bootstrap and rotation can run.</p>
<div class="tile-grid" id="${ADMIN_UI_MESH_HEALTH.panelId}" data-output="mesh-health"><p class="empty-note">Mesh health loads with status after sign-in.</p></div>
<div class="subpanel"><h3>Rotate mesh secret</h3>
${field({ id: ADMIN_UI_MESH_HEALTH.rotateSelectId, label: 'Mesh profile', control: emptySlotSelect('mesh-rotate-slot', ADMIN_UI_MESH_HEALTH.rotateSelectId, 'meshProfileId', 'data-mesh-profile-select="true"'), hint: 'Rotation drains and rejoins mesh members within about two minutes.' })}
<div class="form-actions">${button({ action: 'mesh-rotate', label: 'Rotate mesh secret', variant: 'danger', confirm: 'Confirm rotation?', out: 'mesh-rotate-output' })}</div>
${output({ id: 'mesh-rotate-output', kind: 'mesh-rotate', pre: true })}</div>`
  })
}

function settingsSection(): string {
  const apiRows = ADMIN_UI_ACTIONS
    .map((action) => `<code>${action.method} ${escapeHtml(action.path)}${action.auth === 'admin' ? ' · admin' : ''}</code>`)
    .join('')
  return sectionPanel({
    id: 'settings',
    title: 'Settings',
    description: 'Fleet version, audit trail, session, and recovery.',
    body: `<h3>Fleet agent version</h3>
<div class="form-actions">${button({ action: 'agent-versions-refresh', label: 'Load release tags' })}</div>
${field({ id: ADMIN_UI_AGENT_VERSION.selectId, label: 'Fleet version', control: emptySlotSelect(ADMIN_UI_AGENT_VERSION.slotId, ADMIN_UI_AGENT_VERSION.selectId, 'agentVersion', 'data-agent-version-select="true" data-stale="false"'), hint: 'Nodes converge on the selected release through heartbeats.' })}
<div class="form-actions">${button({ action: 'agent-version-set', label: 'Set fleet version', out: 'agent-version-output' })}</div>
${output({ id: 'agent-version-output', kind: 'agent-version', pre: true })}
<div class="subpanel"><h3>Audit log</h3><div class="feed" id="audit-log"><p class="empty-note">Audit events appear after sign-in.</p></div></div>
<div class="subpanel"><h3>Session</h3><p class="empty-note">The admin token lives only in this browser's storage.</p><div class="form-actions">${button({ action: 'sign-out', label: 'Sign out and forget token', variant: 'ghost' })}</div></div>
<div class="subpanel"><h3>Recovery</h3><p class="empty-note">Lost the admin token? <code>POST /admin/recovery/reset</code> with the <code>ADMIN_RECOVERY_TOKEN</code> Worker secret mints a replacement.</p></div>
<div class="subpanel"><details><summary>API reference</summary><div class="api-list">${apiRows}</div></details></div>`
  })
}

export function dashboardView(): string {
  const navItems = [
    navItem({ section: 'overview', label: 'Overview', hint: 'Health + activity', current: true }),
    navItem({ section: 'nodes', label: 'Nodes', hint: 'Machines + enroll' }),
    navItem({ section: 'models', label: 'Models', hint: 'Profiles + rollout' }),
    navItem({ section: 'routing', label: 'Routing', hint: 'Gateway + domain' }),
    navItem({ section: 'mesh', label: 'Mesh', hint: 'Formation + rotation' }),
    navItem({ section: 'settings', label: 'Settings', hint: 'Versions + audit' })
  ].join('')
  const tabs = [
    tabItem({ tab: 'overview', label: 'Overview', glyph: '◎', current: true }),
    tabItem({ tab: 'nodes', label: 'Nodes', glyph: '●' }),
    tabItem({ tab: 'mesh', label: 'Mesh', glyph: '◆' }),
    tabItem({ tab: 'more', label: 'More', glyph: '⋯' })
  ].join('')
  const moreItems = [
    navItem({ section: 'models', label: 'Models', hint: 'Profiles + rollout' }),
    navItem({ section: 'routing', label: 'Routing', hint: 'Gateway + domain' }),
    navItem({ section: 'settings', label: 'Settings', hint: 'Versions + audit' })
  ].join('')
  return `<div class="view dash" id="view-dashboard" hidden>
<nav class="side-nav" aria-label="Console sections" data-nav-sections="${escapeHtml(ADMIN_UI_NAV.sections.join(' '))}">${navItems}</nav>
<div class="sections">${overviewSection()}${nodesSection()}${modelsSection()}${routingSection()}${meshSection()}${settingsSection()}</div>
<nav class="tab-bar" aria-label="Console sections" data-mobile-tabs="${escapeHtml(ADMIN_UI_NAV.mobileTabs.join(' '))}">${tabs}</nav>
<div class="more-sheet" id="more-sheet" data-more-sections="${escapeHtml(ADMIN_UI_NAV.moreSections.join(' '))}" hidden>${moreItems}</div>
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
