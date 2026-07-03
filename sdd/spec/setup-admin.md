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
4. Claim creates and reveals only the one-time bootstrap access token; machine tokens surface at the steps that use them. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
5. After setup completes, setup routes require admin authentication rather than remaining open. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](state-scheduling.md#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-002: Admin authentication

**Intent:** Human admin access is bearer-protected only while the deployment is being bootstrapped; once the custom domain and Cloudflare Access exist, Access is the only human entrance and bearer credentials remain for machines and recovery.

**Applies To:** Admin

**Acceptance Criteria:**

1. Until Access provisioning completes, admin routes accept the bootstrap admin token or an admin session derived from it. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
2. Once Access configuration is stored, admin routes require a valid Access JWT and refuse bearer-only requests outside break-glass recovery. <!-- @impl: packages/router-worker/src/router.ts::requireAdmin --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 requires a valid Access JWT on admin routes once access config is stored) -->
3. Admin token verification uses a stored verifier rather than plaintext token storage. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
4. Admin authentication is never accepted for provider route-family requests or node heartbeat identity. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
5. Failed admin authentication does not reveal whether setup has completed. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
6. A lost admin token can be replaced only through the configured recovery secret. <!-- @impl: packages/router-worker/src/router.ts::handleAdminRecovery --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 recovers a lost admin token only with the recovery secret) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-SEC-009](security.md#req-sec-009-cloudflare-access-admin-authentication)

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

**Dependencies:** [REQ-ADM-002](#req-adm-002-admin-authentication), [REQ-RUN-002](runtime-profiles.md#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-004: One-line installers

**Intent:** Node operators should enroll machines with one command that carries no permanent secret and works on the target operating system.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The Admin UI generates Linux/macOS and Windows install commands that pass only the router base URL — the custom domain once recorded — setup token, and optional node name. <!-- @impl: packages/router-worker/src/router.ts::handleInstaller --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 installer commands use the custom domain once recorded) -->
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
2. On the custom domain the UI operates entirely under the Access session, with no token entry, token storage, or sign-in view. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 auto-loads installer command for saved tokens and platform changes) -->
3. The UI displays the bootstrap, provider, and setup tokens only from their creation responses and never surfaces the upstream token. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 reveals only the one-time bootstrap token at claim) -->
4. The UI shows mesh invite tokens only as presence, status, and age, and never reads plaintext credential values back from status. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 shows mesh invite tokens as presence, status, and age only) -->
5. The UI remains usable on desktop and mobile viewports. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_RESPONSIVE --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
6. Admin UI HTML responses prevent browser framing. <!-- @impl: packages/router-worker/src/router.ts::html --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
7. During bootstrap and break-glass recovery only, the UI stores the session credential after successful verification and offers a sign-out control that clears it. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 verifies the admin token before storing it) --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 signs out and clears the stored admin token) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-ADM-002](#req-adm-002-admin-authentication), [REQ-ADM-003](#req-adm-003-setup-token-lifecycle), [REQ-ADM-004](#req-adm-004-one-line-installers), [REQ-ADM-005](#req-adm-005-custom-domain-handoff), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-RUN-004](runtime-profiles.md#req-run-004-profile-rollout), [REQ-OBS-002](observability.md#req-obs-002-admin-status-surface)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-009: Admin mesh operation controls

**Intent:** Mesh lifecycle operations — health visibility, one-click rotation, and profile activation — must be operable from the Admin UI so operators never reproduce them with raw API calls.

**Applies To:** Admin

**Acceptance Criteria:**

1. The UI exposes initial setup, status refresh, setup-token creation, Linux/macOS/Windows install-command copy, Gateway configuration, custom-domain provisioning, node revocation, the mesh health panel, mesh-profile readiness, profile activation, mesh-secret rotation, and profile rollout controls. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 exposes mesh health, rotation, and activation controls) -->
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

1. The Worker pre-renders the entry view from host and setup phase: the setup wizard while setup is in progress, the locked console page on the bootstrap origin after completion, and the dashboard on the custom domain. <!-- @impl: packages/router-worker/src/router.ts::adminUiState --> <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_VIEWS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 pre-renders the entry view from host and setup phase) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-014 locks non-custom-domain hosts after setup completes) -->
2. The authenticated dashboard separates operations into Overview, Nodes, Models, Routing, Mesh, Playground, and Settings sections behind persistent navigation that marks the active section. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_NAV --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation) -->
3. Each navigation entry resolves to a rendered dashboard section, and mobile viewports reach every section through a bottom tab bar. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation) -->
4. Every text, number, and select control carries a visible label, with inline hints and per-action feedback in predictable placement. <!-- @impl: packages/router-worker/src/admin-ui-components.ts::ADMIN_UI_FIELD_ANCHOR --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 labels every dashboard control visibly) -->
5. Destructive actions arm into an explicit same-control confirm step that auto-disarms before submitting. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-007 arms destructive controls and auto-disarms before submitting) -->
6. Locked setup errors show inline guidance instead of raw JSON. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 renders setup-locked recovery affordances instead of raw JSON) -->
7. On a server error (5xx) response, the client renders a humane retry message that omits the raw error token but preserves any request id for support. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (renders a humane retry message for a 5xx failure without leaking the raw server error token) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-011: Guided first-run setup

**Intent:** First-run operators must be led from the bootstrap origin through domain, Access, routing, and first-node configuration as one sequenced flow that ends on the custom domain.

**Applies To:** Admin

**Acceptance Criteria:**

1. While setup is open, the Worker origin renders the setup wizard as the entry view with a visible step indicator. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->
2. The wizard sequences connectivity check, custom-domain provisioning, and Access provisioning before handoff, then Gateway connection, first-node enrollment, and review on the custom domain, in that order. <!-- @impl: packages/router-worker/src/admin-ui-contract.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->
3. Completing the connectivity step claims the deployment and reveals the one-time bootstrap access token that authorizes the remaining setup steps. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 reveals only the one-time bootstrap token at claim) -->
4. The Access step requires at least one admin email or admin group before provisioning and accepts optional user emails and user groups. <!-- @impl: packages/router-worker/src/router.ts::handleSetupAccess --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-012 REQ-SEC-010 provisions Access from captured admin and user identities and stores the role config) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 REQ-SEC-010 access step collects admin and user identities and reveals the handoff link) -->
5. After Access provisioning succeeds, the wizard presents the custom-domain console link as the continuation point. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 REQ-SEC-010 access step collects admin and user identities and reveals the handoff link) -->
6. Generated machine credentials render only from creation responses as one-time reveal cards with copy affordances and an explicit shown-once warning. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard) -->
7. The Gateway connection and node enrollment steps are individually skippable, and every wizard capability remains available from the dashboard afterward. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P1

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-ADM-002](#req-adm-002-admin-authentication), [REQ-ADM-005](#req-adm-005-custom-domain-handoff), [REQ-ADM-006](#req-adm-006-admin-configuration-ui), [REQ-ADM-012](#req-adm-012-domain-and-access-provisioning)

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

### REQ-ADM-005: Custom domain handoff

**Intent:** The custom domain is the permanent home of the console and all machine traffic; the `workers.dev` origin exists only to bootstrap it during first-run setup.

**Applies To:** Admin

**Acceptance Criteria:**

1. The domain step lists the account's zones for selection and provisions DNS and a Worker route for the entered hostname. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::provisionCustomDomain --> <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CloudflareGatewayClient.listZones --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 lists account zones for the domain step) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 REQ-ADM-011 provisions the domain step and advances the setup phase) -->
2. Custom domain setup falls back to the bootstrap request origin when the deploy URL is absent or still a placeholder. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 provisions custom domains from the bootstrap request origin when deploy URL is a placeholder) -->
3. Custom domain setup refuses conflicting DNS records instead of overwriting unrelated hostname records. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::provisionCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 refuses to overwrite conflicting custom-domain DNS records) -->
4. Custom domain provisioning failure leaves the current origin usable and the domain step retryable. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 leaves the existing Worker origin usable when custom-domain provisioning fails) -->
5. Successful provisioning durably records the custom domain and advances setup to the Access step. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 REQ-ADM-011 provisions the domain step and advances the setup phase) -->
6. After Access provisioning succeeds, setup continues on the custom-domain console. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 finishing setup on the custom domain opens the dashboard) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

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

**Dependencies:** [REQ-ADM-005](#req-adm-005-custom-domain-handoff), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-012: Domain and Access provisioning

**Intent:** The wizard must create the Cloudflare Access application protecting the custom domain so operators never assemble Zero Trust policies by hand, while machine traffic keeps flowing without Access sessions.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Access step provisions an Access application for the custom domain with an allow policy gating on the admin and user identities captured during setup. <!-- @impl: packages/router-worker/src/access-provisioning.ts::CloudflareAccessClient.provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-SEC-010 gates the console app on the admin and user Access groups when a user set exists) -->
2. Provisioning creates bypass coverage for the provider, node, health, and installer paths so machine traffic needs no Access session. <!-- @impl: packages/router-worker/src/access-provisioning.ts::MACHINE_BYPASS_SUFFIXES --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 creates the admin app and bypass coverage for machine paths with an everyone bypass policy) -->
3. When the bypass policy cannot be created, provisioning removes the bypass application rather than leaving machine paths blocked. <!-- @impl: packages/router-worker/src/access-provisioning.ts::CloudflareAccessClient.provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 removes the bypass app when its bypass policy cannot be created) -->
4. Provisioning durably stores the Access team domain, application audience, application identifiers, and captured role sets for verification and re-runs. <!-- @impl: packages/router-worker/src/router.ts::handleSetupAccess --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-012 REQ-SEC-010 provisions Access from captured admin and user identities and stores the role config) --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 returns the team domain, audience, identifiers, and captured role sets for durable storage) -->
5. Re-running provisioning updates the existing managed applications instead of duplicating them. <!-- @impl: packages/router-worker/src/access-provisioning.ts::CloudflareAccessClient.provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 updates existing managed applications instead of duplicating them) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-ADM-005](#req-adm-005-custom-domain-handoff), [REQ-SEC-009](security.md#req-sec-009-cloudflare-access-admin-authentication), [REQ-SEC-010](security.md#req-sec-010-role-based-console-access)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-017: Role-based console surface

**Intent:** The console must show admins the full control surface and show read-only users only what they may look at, so a user who passes Access can observe the mesh without ever reaching a configuration control.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. `GET /admin/status` reports the caller's resolved console role so the client can tailor the surface. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 resolves the read-only user role from a user group and refuses config writes) -->
2. `GET /admin/whoami` returns the caller's role and actor identity. <!-- @impl: packages/router-worker/src/router.ts::handleWhoami --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 resolves the admin role from an admin group and lets admins write config) -->
3. Under the user role the console hides every configuration section and exposes only the overview and playground. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-017 hides every configuration section and keeps only overview and playground for the user role) -->
4. Configuration-mutating admin endpoints refuse the user role at the server regardless of the client surface. <!-- @impl: packages/router-worker/src/router.ts::requireAdmin --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 resolves the read-only user role from a user group and refuses config writes) -->
5. Under the admin role every console section and capability remains available. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-017 leaves every section visible for the admin role) -->
6. The status response withholds configuration state and the audit log from the read-only user role at the server. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-017 withholds configuration state and the audit log from the read-only user role) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-ADM-012](#req-adm-012-domain-and-access-provisioning), [REQ-SEC-010](security.md#req-sec-010-role-based-console-access)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-013: Break-glass recovery

**Intent:** A locked-out operator — Access misconfigured, domain lapsed, wrong email — must have a documented deliberate path back in that requires control of the Cloudflare account rather than a memorized credential.

**Applies To:** Admin

**Acceptance Criteria:**

1. When the reopen secret is set and its value is unconsumed, the bootstrap origin serves the recovery surface instead of the locked page. <!-- @impl: packages/router-worker/src/setup-state.ts::breakGlassActive --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 reopens the bootstrap origin while the reopen secret is unconsumed and audits entry once) -->
2. Completing recovery records the secret value as consumed so the surface closes until a new value is set. <!-- @impl: packages/router-worker/src/router.ts::handleSetupComplete --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 consuming the reopen secret closes the recovery surface) -->
3. The recovery surface re-runs the domain and Access steps against currently stored state. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 reopens the bootstrap origin while the reopen secret is unconsumed and audits entry once) -->
4. Entering and completing recovery each record an audit event. <!-- @impl: packages/router-worker/src/router.ts::recordBreakGlassEntry --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 reopens the bootstrap origin while the reopen secret is unconsumed and audits entry once) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 consuming the reopen secret closes the recovery surface) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-ADM-012](#req-adm-012-domain-and-access-provisioning)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-014: Host gating and console lock

**Intent:** After setup completes, the bootstrap origin must stop being an admin or machine surface entirely so the custom domain is the single gate for humans and machines alike.

**Applies To:** Admin

**Acceptance Criteria:**

1. After setup completes, admin UI requests on non-custom-domain hostnames receive a console-moved page naming the custom domain. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::consoleMovedHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-014 locks non-custom-domain hosts after setup completes) -->
2. After setup completes, provider and node route families on non-custom-domain hostnames are refused. <!-- @impl: packages/router-worker/src/router.ts::resolveHostGate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-014 locks non-custom-domain hosts after setup completes) -->
3. The custom domain serves the full console and all machine route families. <!-- @impl: packages/router-worker/src/router.ts::resolveHostGate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-014 locks non-custom-domain hosts after setup completes) -->
4. Break-glass recovery reopens only the admin surface on the bootstrap origin, never machine routes. <!-- @impl: packages/router-worker/src/router.ts::resolveHostGate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 reopens the bootstrap origin while the reopen secret is unconsumed and audits entry once) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-ADM-005](#req-adm-005-custom-domain-handoff), [REQ-ADM-012](#req-adm-012-domain-and-access-provisioning), [REQ-ADM-013](#req-adm-013-break-glass-recovery)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-015: Mesh visualization

**Intent:** Operators should see the mesh as a living system — which nodes exist, what they serve, and how they relate to the router — without reading raw status JSON.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Overview section renders a topology visual with the router hub and one selectable element per node, styled by node status. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderTopology --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 renders a hub-and-spoke topology with one selectable element per node) -->
2. The topology caption reports node and serving counts derived from live status data. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderTopology --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 renders a hub-and-spoke topology with one selectable element per node) -->
3. Selecting a node opens a detail drawer showing status, hardware, throughput, models, and reported-versus-desired agent version. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openNodeDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 opens a node drawer with metrics, version drift, and an armed revoke control) -->
4. Selecting a model opens a detail drawer showing its alias, availability, and serving nodes. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openModelDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 opens a model drawer listing the nodes serving each alias) -->
5. The Nodes section renders nodes as a sortable table whose rows open the node drawer. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderNodesTable --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 sorts the nodes table by the clicked column and flips direction on repeat) -->
6. Below the mobile breakpoint the topology falls back to a list presentation. <!-- @impl: packages/router-worker/src/admin-ui-contract.ts::ADMIN_UI_TOPOLOGY --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 renders a hub-and-spoke topology with one selectable element per node) -->
7. When no nodes are enrolled, the topology shows an empty-state message directing the operator to add a node rather than a bare hub-and-spoke frame. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderTopology --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 renders an empty-state topology when no nodes are enrolled) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P1

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard), [REQ-OBS-002](observability.md#req-obs-002-admin-status-surface), [REQ-OBS-010](observability.md#req-obs-010-live-throughput-surface)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-016: Operator playground

**Intent:** Operators need a one-screen way to verify end-to-end inference through the same path real clients use, without copying tokens into external tools.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Playground section offers a model selection populated from live status data. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderPlaygroundSelect --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 populates the playground model select from active profile aliases) -->
2. Sending a prompt submits it through the admin playground endpoint and renders the streamed response incrementally. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 streams the playground response incrementally as chunks arrive) -->
3. The playground endpoint forwards prompts through the configured AI Gateway route and streams the response back. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-016 forwards playground prompts through the configured gateway route and strips upstream secrets) -->
4. The playground endpoint requires a valid console role (admin or read-only user) and never exposes gateway credentials to the browser. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-016 rejects unauthenticated playground requests) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-016 REQ-ADM-017 lets the read-only user role reach the playground endpoint) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-ADM-017](#req-adm-017-role-based-console-surface)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
