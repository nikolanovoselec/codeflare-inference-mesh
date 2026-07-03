import {
  ADMIN_UI_ACTIONS,
  ADMIN_UI_AGENT_VERSION,
  ADMIN_UI_CONFIRM,
  ADMIN_UI_MESH_HEALTH,
  ADMIN_UI_NAV,
  ADMIN_UI_PROFILE_ACTIVATION,
  ADMIN_UI_RESPONSIVE,
  ADMIN_UI_SETUP_LOCKED_FEEDBACK,
  ADMIN_UI_VIEWS,
  ADMIN_UI_WIZARD
} from './admin-ui-contract'
import { ADMIN_UI_CLIENT_SCRIPT } from './admin-ui-client'
import { adminUiCss } from './admin-ui-css'
import { dashboardView, setupWizardView } from './admin-ui-views'
import type { AdminUiStateView } from './admin-ui-contract'

export {
  ADMIN_UI_ACTIONS,
  ADMIN_UI_AGENT_VERSION,
  ADMIN_UI_CONFIRM,
  ADMIN_UI_MESH_HEALTH,
  ADMIN_UI_NAV,
  ADMIN_UI_PROFILE_ACTIVATION,
  ADMIN_UI_RESPONSIVE,
  ADMIN_UI_SETUP_LOCKED_FEEDBACK,
  ADMIN_UI_VIEWS,
  ADMIN_UI_WIZARD
} from './admin-ui-contract'
export type { ActivationProfileView, AdminUiAction, AdminUiStateView, AgentVersionsView, MeshHealthEntry, MeshUiStatusNode } from './admin-ui-contract'

/** Server-computed entry state: which view to pre-render and where setup stands. */
export type AdminUiState = AdminUiStateView

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4.5' fill='%2309090b'/%3E%3Crect x='6' y='6' width='12' height='12' rx='2.5' fill='%23ff5c3c'/%3E%3C/svg%3E"

/**
 * Server-rendered admin console shell. The entry view is pre-rendered from
 * host and setup phase (wizard until setup completes, dashboard afterwards);
 * on the custom domain the Cloudflare Access session is the authentication.
 */
export function adminUiHtml(workerOrigin: string, state: AdminUiState): string {
  const config = scriptJson({
    workerOrigin,
    state,
    actions: ADMIN_UI_ACTIONS,
    responsive: ADMIN_UI_RESPONSIVE,
    views: ADMIN_UI_VIEWS,
    nav: ADMIN_UI_NAV,
    wizard: ADMIN_UI_WIZARD,
    confirm: ADMIN_UI_CONFIRM,
    setupLockedFeedback: ADMIN_UI_SETUP_LOCKED_FEEDBACK,
    meshHealth: ADMIN_UI_MESH_HEALTH,
    agentVersion: ADMIN_UI_AGENT_VERSION,
    profileActivation: ADMIN_UI_PROFILE_ACTIVATION
  })
  const entryView = state.view
  return `<!doctype html>
<html lang="en" data-admin-ui="codeflare-inference-mesh" style="background:#09090b">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#09090b">
  <title>Codeflare Inference Mesh</title>
  <link rel="icon" href="${FAVICON}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap">
  <style>${adminUiCss()}</style>
</head>
<body data-view="${entryView}">
  <header class="topbar">
    <a class="brand" href="/admin" aria-label="Codeflare Inference Mesh admin home">
      <span class="brand-mark" aria-hidden="true"></span>
      <strong>codeflare</strong>
      <span class="brand-path">/ inference-mesh</span>
    </a>
    <div class="topbar-side">
      <span class="health-pill" id="health-pill" data-health="unknown">shell</span>
      <button class="btn btn-ghost" type="button" id="sign-out-btn" data-action="sign-out" hidden>Sign out</button>
    </div>
  </header>
  <noscript><p class="noscript-banner">This console needs JavaScript to talk to the router API.</p></noscript>
  <main>
    ${setupWizardView(state.view === 'setup')}
    ${dashboardView()}
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script type="application/json" id="admin-ui-config">${config}</script>
  <script>${ADMIN_UI_CLIENT_SCRIPT}</script>
</body>
</html>`
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export const ADMIN_UI_ANCHORS = {
  REQ_ADM_006: 'REQ-ADM-006',
  REQ_ADM_007: 'REQ-ADM-007',
  REQ_ADM_008: 'REQ-ADM-008',
  REQ_ADM_011: 'REQ-ADM-011',
  REQ_OBS_007: 'REQ-OBS-007',
  REQ_SEC_006: 'REQ-SEC-006',
  VIEWS: 'ADMIN_UI_VIEWS',
  NAV: 'ADMIN_UI_NAV',
  WIZARD: 'ADMIN_UI_WIZARD',
  CONFIRM: 'ADMIN_UI_CONFIRM',
  SETUP_LOCKED_FEEDBACK: 'ADMIN_UI_SETUP_LOCKED_FEEDBACK',
  MESH_HEALTH: 'ADMIN_UI_MESH_HEALTH',
  AGENT_VERSION: 'ADMIN_UI_AGENT_VERSION',
  PROFILE_ACTIVATION: 'ADMIN_UI_PROFILE_ACTIVATION'
} as const
