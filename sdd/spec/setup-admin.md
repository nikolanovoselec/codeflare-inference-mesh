# Setup And Admin

This domain covers first-run setup, admin access, node setup tokens, Cloudflare resource setup, install-script delivery, and fleet agent-version management.

---

### REQ-ADM-001: First-run setup

**Intent:** A freshly deployed router should become usable through its `workers.dev` URL before any custom domain or Cloudflare Access policy exists.

**Applies To:** Admin

**Acceptance Criteria:**

1. The setup UI is available on the Worker origin until setup is completed. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
2. First-run setup remains open until the first admin configuration completes. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->
3. Successful first-run setup stores setup-complete state in D1. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->
4. The setup flow creates and displays the provider token exactly once. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
5. After setup completes, setup routes require admin authentication rather than remaining open. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](state-scheduling.md#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-002: MVP admin auth

**Intent:** Admin UI access must be protected in the first implementation without requiring Cloudflare Access service-token wiring for Gateway or node traffic.

**Applies To:** Admin

**Acceptance Criteria:**

1. Admin routes accept a configured admin token or an admin session derived from it. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
2. Admin token verification uses a stored verifier rather than plaintext token storage. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
3. Cloudflare Access is documented as an optional hardening step after the custom domain exists. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
4. Admin authentication is never accepted for provider route-family requests or node heartbeat identity. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
5. Failed admin authentication does not reveal whether setup has completed. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
6. A lost admin token can be replaced only through the configured recovery secret. <!-- @impl: packages/router-worker/src/router.ts::handleAdminRecovery --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 recovers a lost admin token only with the recovery secret) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-003: Setup token lifecycle

**Intent:** Node enrollment must use short-lived single-use setup tokens so copied install commands cannot enroll unlimited machines.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Admin can create a short-lived setup token with a 24h expiration for node enrollment. <!-- @impl: packages/router-worker/src/router.ts::SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-003 creates setup tokens with a 24h expiration) -->
2. The router stores only the setup token verifier and claim metadata in D1. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->
3. A setup token can be claimed at most once. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->
4. Expired, claimed, or invalid setup tokens are rejected. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->
5. Successful claim returns permanent node credentials and the initial desired profile state. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-ADM-002](#req-adm-002-mvp-admin-auth), [REQ-RUN-002](runtime-profiles.md#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-004: One-line installers

**Intent:** Node operators should enroll machines with one command that carries no permanent secret and works on the target operating system.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The Admin UI generates Linux/macOS and Windows install commands that pass only router URL, setup token, and optional node name. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
2. The Unix installer route installs the matching agent artifact and service wrapper. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
3. The Windows installer route installs the matching agent artifact and registers startup supervision without requiring the foreground CLI to implement the Windows service-control protocol. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
4. Install scripts verify downloaded artifact checksums before installation. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
5. Install scripts do not embed provider, admin, node, upstream, deploy, or Cloudflare API credentials. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
6. The Admin UI fetches and displays the selected platform install command for saved tokens and platform changes. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 auto-loads installer command for saved tokens and platform changes) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-ADM-003](#req-adm-003-setup-token-lifecycle), [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-006: Admin configuration UI

**Intent:** Admins must be able to configure and operate the deployed router from a responsive browser interface instead of using raw API calls for normal setup and operations.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Worker origin and Admin entry point serve the Admin configuration UI as HTML with no bearer token required to load the shell. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
2. The UI stores admin tokens in browser-controlled session/local storage only after a successful login verification and sends them as bearer credentials only when an admin action requires authentication. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 verifies the admin token before storing it) -->
3. The UI displays generated admin/provider/setup/upstream tokens only from creation responses, surfaces mesh invite tokens only as presence, status, and age, and never reads plaintext credential values back from status. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 shows mesh invite tokens as presence, status, and age only) -->
4. The UI remains usable on desktop and mobile viewports. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_RESPONSIVE --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
5. Admin UI HTML responses prevent browser framing. <!-- @impl: packages/router-worker/src/router.ts::html --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
6. The UI provides a sign-out control that removes the stored admin token from browser storage and returns to the entry view. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 signs out and clears the stored admin token) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-ADM-002](#req-adm-002-mvp-admin-auth), [REQ-ADM-003](#req-adm-003-setup-token-lifecycle), [REQ-ADM-004](#req-adm-004-one-line-installers), [REQ-ADM-005](#req-adm-005-optional-custom-domain), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-RUN-004](runtime-profiles.md#req-run-004-profile-rollout), [REQ-OBS-002](observability.md#req-obs-002-admin-status-surface)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-009: Admin mesh operation controls

**Intent:** Mesh lifecycle operations — health visibility, one-click rotation, and profile activation — must be operable from the Admin UI so operators never reproduce them with raw API calls.

**Applies To:** Admin

**Acceptance Criteria:**

1. The UI exposes initial setup, admin login, status refresh, setup-token creation, Linux/macOS/Windows install-command copy, Gateway configuration, custom-domain validation, node revocation, the mesh health panel, mesh-profile readiness, profile activation, mesh-secret rotation, and profile rollout controls. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 exposes mesh health, rotation, and activation controls) -->
2. The UI provides a one-click "Rotate mesh secret" action that submits `POST /admin/mesh/rotate` for the selected mesh profile. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 wires the one-click rotate action to the mesh rotate endpoint) -->
3. The UI presents the single-node and split serving profiles as one activation selection control that submits `POST /admin/profiles/activate`. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 renders the profile activation selection control) -->
4. Activating a profile records a `profile_activated` audit event. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-009 activates profiles alias-exclusively and records the audit event) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-006](#req-adm-006-admin-configuration-ui), [REQ-SEC-006](security.md#req-sec-006-mesh-token-lifecycle), [REQ-RUN-009](runtime-profiles.md#req-run-009-profile-seeding-and-retirement)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-007: Operator dashboard

**Intent:** Admins need the browser surface to behave like an operator console: entry views driven by real deployment state, day-two operations separated into navigable sections, and consistent, safe control feedback.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Worker serves the admin shell pre-rendered into the entry view matching stored setup state: the setup wizard while setup is open, and the sign-in view once setup is locked. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_VIEWS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 pre-renders the entry view from stored setup state) -->
2. The authenticated dashboard separates operations into Overview, Nodes, Models, Routing, Mesh, and Settings sections behind persistent navigation that marks the active section. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_NAV --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation) -->
3. Each navigation entry resolves to a rendered dashboard section, and mobile viewports reach every section through a bottom tab bar. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation) -->
4. Every text, number, and select control carries a visible label, with inline hints and per-action feedback in predictable placement. <!-- @impl: packages/router-worker/src/admin-ui-components.ts::ADMIN_UI_FIELD_ANCHOR --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 labels every dashboard control visibly) -->
5. Destructive actions arm into an explicit same-control confirm step that auto-disarms before submitting. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-007 arms destructive controls and auto-disarms before submitting) -->
6. Locked setup errors show inline guidance instead of raw JSON. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 renders setup-locked recovery affordances instead of raw JSON) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-011: Guided first-run setup

**Intent:** First-run operators must be led through credentials, routing, and first-node enrollment as one sequenced flow instead of discovering parallel controls unaided.

**Applies To:** Admin

**Acceptance Criteria:**

1. While setup is open, the Worker origin renders the setup wizard as the entry view with a visible step indicator. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->
2. The wizard sequences credential creation, AI Gateway connection, and first-node enrollment before a finishing review step, in that order. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->
3. Generated credentials render only from the creation response as one-time reveal cards with copy affordances and an explicit shown-once warning. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard) -->
4. Completing credential creation establishes the admin session for the remaining steps without token re-entry. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard) -->
5. The Gateway connection and node enrollment steps are individually skippable, and every wizard capability remains available from the dashboard afterward. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P1

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-ADM-002](#req-adm-002-mvp-admin-auth), [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-008: Agent version management

**Intent:** Operators should select one fleet-wide node-agent version from published releases in the Admin UI and have nodes converge on it through heartbeats, with no channels or per-node targeting.

**Applies To:** Admin

**Acceptance Criteria:**

1. `GET /admin/agent-versions` returns node-agent release tags fetched from the repository's GitHub releases API and cached in `router_config` with an approximately 10-minute TTL. <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 lists release tags from the cached GitHub releases response) -->
2. When the releases fetch fails, the endpoint serves the last cached tag list marked stale. <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 serves the stale cached tag list when the releases fetch fails) -->
3. `POST /admin/agent-version` rejects tags absent from the cached release list. <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 rejects agent-version selections absent from the cached release list) -->
4. Accepting a version selection stores it as the single fleet-wide `desired_agent_version` and records an `agent_version_selected` audit event. <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 stores the fleet-wide desired version and audits the selection) -->
5. Every heartbeat response carries `desiredAgentVersion` while a desired version is set. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 heartbeat responses carry the desired agent version when set) -->
6. The Admin UI offers a release-tag dropdown with the current selection and shows each node's reported agent version against the desired version. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-008 renders the agent-version dropdown and per-node reported-versus-desired view) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-NODE-005](node-agent.md#req-node-005-agent-update-staging), [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-005: Optional custom domain

**Intent:** The router should work on `workers.dev` first and support a custom domain later without blocking the private Mesh proof path.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Admin can keep using the `workers.dev` origin after setup. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
2. The Admin can enter a custom-domain hostname and optional zone ID in the setup UI. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
3. Custom domain setup provisions DNS and a Worker route from the configured Worker origin when the deploy URL is usable. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::provisionCustomDomain --> <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 provisions custom domains from the configured Worker origin when deploy URL is usable) -->
4. Custom domain setup falls back to the bootstrap request origin when the deploy URL is absent or still a placeholder. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 provisions custom domains from the bootstrap request origin when deploy URL is a placeholder) -->
5. Custom domain setup refuses conflicting DNS records instead of overwriting unrelated hostname records. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::provisionCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 refuses to overwrite conflicting custom-domain DNS records) -->
6. Custom domain setup failure leaves the existing Worker origin usable. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 leaves the existing Worker origin usable when custom-domain provisioning fails) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-GWY-001](gateway.md#req-gwy-001-gateway-custom-provider)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-010: Provisioning downstream effects

**Intent:** Custom-domain provisioning must gate its downstream consumers: Gateway sync never targets an unprovisioned hostname, and successful provisioning is durably recorded so later flows reuse it.

**Applies To:** Admin

**Acceptance Criteria:**

1. AI Gateway sync refuses to use a stored custom-domain hostname until provisioning has succeeded. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-010 refuses to sync Gateway to an unprovisioned custom domain) -->
2. The setup UI records the provisioned custom domain in D1. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 provisions custom domains from the configured Worker origin when deploy URL is usable) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-ADM-005](#req-adm-005-optional-custom-domain), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
