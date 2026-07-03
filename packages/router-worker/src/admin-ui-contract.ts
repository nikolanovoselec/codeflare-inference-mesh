/**
 * Shared admin-UI contract: the constants and wire-shape interfaces that the
 * views, stylesheet, client config, and tests all agree on. Leaf module with
 * no imports so every admin-ui file can depend on it without cycles.
 * Re-exported from admin-ui.ts, which remains the anchor surface for specs.
 */

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
  { id: 'profile-rollout', method: 'POST', path: '/admin/profiles/rollout', auth: 'admin' },
  { id: 'profile-activate', method: 'POST', path: '/admin/profiles/activate', auth: 'admin' },
  { id: 'agent-versions-refresh', method: 'GET', path: '/admin/agent-versions', auth: 'admin' },
  { id: 'agent-version-set', method: 'POST', path: '/admin/agent-version', auth: 'admin' },
  { id: 'mesh-rotate', method: 'POST', path: '/admin/mesh/rotate', auth: 'admin' }
] as const

export const ADMIN_UI_RESPONSIVE = {
  mobileBreakpointPx: 760,
  desktopMinColumns: 1,
  minTouchTargetPx: 44
} as const

/** Entry views are pre-rendered server-side from stored setup state. */
export const ADMIN_UI_VIEWS = {
  modes: ['setup', 'login', 'dashboard'],
  attribute: 'data-view'
} as const

/** Dashboard IA: six noun sections; mobile reaches them through four tabs. */
export const ADMIN_UI_NAV = {
  sections: ['overview', 'nodes', 'models', 'routing', 'mesh', 'settings'],
  mobileTabs: ['overview', 'nodes', 'mesh', 'more'],
  moreSections: ['models', 'routing', 'settings']
} as const

/** Guided first-run flow; gateway and node steps are skippable. */
export const ADMIN_UI_WIZARD = {
  steps: ['credentials', 'gateway', 'node', 'review'],
  skippable: ['gateway', 'node']
} as const

/** Destructive controls arm into a same-button confirm that auto-disarms. */
export const ADMIN_UI_CONFIRM = {
  attribute: 'data-confirm',
  disarmMs: 5000
} as const

export const ADMIN_UI_SETUP_LOCKED_FEEDBACK = {
  status: 401,
  variant: 'setup-locked'
} as const

export const ADMIN_UI_MESH_HEALTH = {
  panelId: 'mesh-health-output',
  rotateSelectId: 'mesh-rotate-profile',
  bannerId: 'mesh-key-banner',
  keyMissingError: 'mesh_state_key_missing',
  fields: ['coordinator', 'peers', 'ready-models', 'failed-nodes', 'last-error', 'rotation', 'secret']
} as const

export const ADMIN_UI_AGENT_VERSION = {
  selectId: 'agent-version-select',
  slotId: 'agent-version-slot',
  staleAttribute: 'data-stale'
} as const

export const ADMIN_UI_PROFILE_ACTIVATION = {
  selectId: 'profile-activate-select',
  slotId: 'profile-activate-slot'
} as const

/** Mirrors the admin-status meshHealth contract from router.ts; carries no secret values by shape. */
export interface MeshHealthEntry {
  readonly profileId: string
  readonly meshId?: string
  readonly rotation: number
  readonly seedNodeId?: string
  readonly coordinatorNodeId?: string
  readonly peerNodeIds: readonly string[]
  readonly readyModels?: readonly string[]
  readonly failedNodeIds?: readonly string[]
  readonly tokenCount: number
  readonly secretAgeMs?: number
  readonly lastError?: string
}

/** Mirrors the GET /admin/agent-versions response contract. */
export interface AgentVersionsView {
  readonly tags: readonly string[]
  readonly fetchedAt?: number
  readonly stale: boolean
  readonly desired?: string
}

/** Structural subset of an admin-status node used by the client renderers. */
export interface MeshUiStatusNode {
  readonly id: string
  readonly status?: string
  readonly agentVersion?: string
  readonly metrics?: {
    readonly runtimeState?: string
    readonly readyModels?: readonly string[]
  }
}

/** Structural subset of a ModelProfile used by the activation and rotation selects. */
export interface ActivationProfileView {
  readonly id: string
  readonly publicAliases: readonly string[]
  readonly active: boolean
  readonly meshllm: { readonly split: boolean }
}
