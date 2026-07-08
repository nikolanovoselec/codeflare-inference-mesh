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
  { id: 'setup-domain', method: 'POST', path: '/admin/setup/domain', auth: 'admin' },
  { id: 'setup-access', method: 'POST', path: '/admin/setup/access', auth: 'admin' },
  { id: 'setup-complete', method: 'POST', path: '/admin/setup/complete', auth: 'admin' },
  { id: 'zones-refresh', method: 'GET', path: '/admin/cloudflare/zones', auth: 'admin' },
  { id: 'gateway-options', method: 'GET', path: '/admin/cloudflare/gateway/options', auth: 'admin' },
  { id: 'gateway-provision-status', method: 'GET', path: '/admin/cloudflare/gateway/provision-status', auth: 'admin' },
  { id: 'status-refresh', method: 'GET', path: '/admin/status', auth: 'admin' },
  { id: 'setup-token-create', method: 'POST', path: '/admin/setup-tokens', auth: 'admin' },
  { id: 'installer-linux', method: 'GET', path: '/admin/installers/linux', auth: 'admin' },
  { id: 'installer-macos', method: 'GET', path: '/admin/installers/macos', auth: 'admin' },
  { id: 'installer-windows', method: 'GET', path: '/admin/installers/windows', auth: 'admin' },
  { id: 'gateway-sync', method: 'POST', path: '/admin/cloudflare/gateway/sync', auth: 'admin' },
  { id: 'custom-domain-validate', method: 'POST', path: '/admin/custom-domain/validate', auth: 'admin' },
  { id: 'node-revoke', method: 'POST', path: '/admin/nodes/{nodeId}/revoke', auth: 'admin' },
  { id: 'node-deactivate', method: 'POST', path: '/admin/nodes/{nodeId}/deactivate', auth: 'admin' },
  { id: 'node-activate', method: 'POST', path: '/admin/nodes/{nodeId}/activate', auth: 'admin' },
  { id: 'profile-rollout', method: 'POST', path: '/admin/profiles/rollout', auth: 'admin' },
  { id: 'profile-activate', method: 'POST', path: '/admin/profiles/activate', auth: 'admin' },
  { id: 'profile-config', method: 'POST', path: '/admin/profiles/config', auth: 'admin' },
  { id: 'agent-versions-refresh', method: 'GET', path: '/admin/agent-versions', auth: 'admin' },
  { id: 'agent-version-set', method: 'POST', path: '/admin/agent-version', auth: 'admin' },
  { id: 'runtime-versions-refresh', method: 'GET', path: '/admin/runtime-versions', auth: 'admin' },
  { id: 'runtime-versions-set', method: 'POST', path: '/admin/runtime-versions', auth: 'admin' },
  { id: 'settings-save', method: 'POST', path: '/admin/settings', auth: 'admin' },
  { id: 'mesh-rotate', method: 'POST', path: '/admin/mesh/rotate', auth: 'admin' },
  { id: 'playground-chat', method: 'POST', path: '/admin/playground/chat', auth: 'admin' },
  { id: 'playground-direct', method: 'POST', path: '/admin/playground/direct-chat', auth: 'admin' }
] as const

export const ADMIN_UI_RESPONSIVE = {
  mobileBreakpointPx: 760,
  desktopMinColumns: 1,
  minTouchTargetPx: 44
} as const

/** Entry views are pre-rendered server-side from host and setup phase. */
export const ADMIN_UI_VIEWS = {
  modes: ['setup', 'dashboard'],
  attribute: 'data-view'
} as const

/** Wire shape of the server-rendered state inside the admin-ui-config blob. */
export interface AdminUiStateView {
  readonly view: 'setup' | 'dashboard'
  readonly phase: 'unclaimed' | 'claimed' | 'domain_ready' | 'access_ready' | 'complete'
  readonly customDomain?: string
  readonly recovery?: boolean
}

/** Dashboard IA: six noun sections; mobile reaches them through four tabs. Model
 * sharing is not its own section — a sharded model is just a model, so its mesh
 * detail lives in that model's Manage drawer alongside every other model. */
export const ADMIN_UI_NAV = {
  sections: ['overview', 'nodes', 'models', 'routing', 'playground', 'settings'],
  mobileTabs: ['overview', 'nodes', 'models', 'more'],
  moreSections: ['routing', 'playground', 'settings']
} as const

/**
 * Guided first-run flow across two hosts: connect/domain/access run on the
 * bootstrap origin, then setup hands off to the custom domain for the rest.
 * Gateway and node steps are skippable.
 */
export const ADMIN_UI_WIZARD = {
  steps: ['connect', 'domain', 'access', 'gateway', 'node', 'review'],
  skippable: ['gateway', 'node'],
  phaseSteps: {
    unclaimed: 'connect',
    claimed: 'domain',
    domain_ready: 'access',
    access_ready: 'gateway',
    complete: 'review'
  }
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

/** Overview topology: hub-and-spoke, every node selectable, list fallback on mobile. */
export const ADMIN_UI_TOPOLOGY = {
  containerId: 'overview-topology',
  canvasId: 'topo-canvas',
  listId: 'topo-list',
  captionId: 'topo-caption'
} as const

/** Slide-over detail drawer shared by node and model selections. */
export const ADMIN_UI_DRAWER = {
  containerId: 'detail-drawer',
  titleId: 'drawer-title',
  bodyId: 'drawer-body',
  closeAction: 'drawer-close'
} as const

/** Dashboard status polling: visibility-aware, live badge reflects freshness. */
export const ADMIN_UI_POLLING = {
  intervalMs: 5000
} as const

/** Sortable nodes table; sort keys are data-driven, never copy. */
export const ADMIN_UI_NODES_TABLE = {
  bodyId: 'nodes-table-body',
  sortAttribute: 'data-sort',
  columns: ['id', 'status', 'toks', 'vram', 'models', 'version']
} as const

/**
 * Operator playground: a Target select (the direct router or an accessible AI Gateway) drives a
 * dependent Model/Route select, streamed into the response pane. Direct sends hit `directPath`
 * with an internal model; gateway sends hit `gatewayPath` with the selected route.
 */
export const ADMIN_UI_PLAYGROUND = {
  targetSelectId: 'playground-target',
  targetSlotId: 'playground-target-slot',
  selectId: 'playground-model',
  slotId: 'playground-model-slot',
  promptId: 'playground-prompt',
  toolsId: 'playground-tools',
  maxTokensId: 'playground-max-tokens',
  outputId: 'playground-output',
  sendAction: 'playground-send',
  stopAction: 'playground-stop',
  directValue: 'direct',
  directPath: '/admin/playground/direct-chat',
  gatewayPath: '/admin/playground/chat'
} as const

/** Client-smoothed throughput sparkline over a rolling window of poll samples. */
export const ADMIN_UI_TOKS_TRACE = {
  containerId: 'toks-trace',
  window: 40,
  smoothing: 3
} as const

export const ADMIN_UI_MESH_HEALTH = {
  bannerId: 'mesh-key-banner',
  keyMissingError: 'mesh_state_key_missing',
  fields: ['coordinator', 'peers', 'ready-models', 'failed-nodes', 'last-error', 'rotation', 'secret']
} as const

export const ADMIN_UI_AGENT_VERSION = {
  selectId: 'agent-version-select',
  slotId: 'agent-version-slot',
  staleAttribute: 'data-stale'
} as const

export const ADMIN_UI_RUNTIME_VERSION = {
  meshllmSelectId: 'runtime-meshllm-version-select',
  llamacppSelectId: 'runtime-llamacpp-version-select',
  slotId: 'runtime-version-slot',
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
  readonly deactivatedNodeIds?: readonly string[]
  readonly active?: boolean
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

export interface RuntimeVersionOptionView {
  readonly tags: readonly string[]
  readonly fetchedAt?: number
  readonly stale: boolean
  readonly desired: string
  readonly error?: string
}

/** Mirrors the GET /admin/runtime-versions response contract. */
export interface RuntimeVersionsView {
  readonly meshllm: RuntimeVersionOptionView
  readonly llamacpp: RuntimeVersionOptionView
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
