# Setup And Admin

This domain covers first-run setup, admin access, node setup tokens, Cloudflare resource setup, install-script delivery, and fleet agent-version management.

---

### REQ-ADM-001: First-run setup

**Intent:** A freshly deployed router should become usable through its `workers.dev` URL before any custom domain or Cloudflare Access policy exists.

**Applies To:** Admin

**Acceptance Criteria:**

1. The setup UI is available on the Worker origin until setup is completed. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function) -->
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

1. Until Access provisioning completes, admin routes accept the bootstrap admin token or an admin session derived from it. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status and REQ-RUN-004 reports profile readiness in admin status) -->
2. Once Access configuration is stored, admin routes require a valid Access JWT and refuse bearer-only requests outside break-glass recovery. <!-- @impl: packages/router-worker/src/router.ts::requireAdmin --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 requires a valid Access JWT on admin routes once access config is stored) -->
3. Admin token verification uses a stored verifier rather than plaintext token storage. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
4. Admin authentication is never accepted for provider route-family requests or node heartbeat identity. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
5. Failed admin authentication does not reveal whether setup has completed. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 failed admin authentication returns an identical unauthorized response before and after setup completes) -->
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
6. Fetching an install command returns a token placeholder in place of a setup token instead of minting one. <!-- @impl: packages/router-worker/src/router.ts::handleInstaller --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-003 does not mint a setup token when an install command is fetched) -->
7. Creating a setup token fills it into the displayed install command so one token backs each enrollment. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-003 fills the minted setup token into the install command) -->

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
6. The Admin UI fetches and displays the selected platform install command for saved tokens and platform changes, and the displayed command copies to the clipboard when the operator clicks it — there is no separate copy button. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 auto-loads installer command for saved tokens and platform changes) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-004 copies the install command when the command block is clicked) -->
7. The Unix service wrapper launches the agent with an explicit `--config` path and a fixed working directory under a system state directory, using only a static binary, systemd, and coreutils so enrollment runs across Arch, Debian, Ubuntu, and RHEL with no distribution package manager. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 unix install wrapper runs the agent from an explicit config path and system state dir) -->

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

1. The Worker origin and Admin entry point serve the Admin configuration UI as HTML with no bearer token required to load the shell. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function) -->
2. On the custom domain the UI operates entirely under the Access session, with no token entry, token storage, or sign-in view. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 auto-loads installer command for saved tokens and platform changes) -->
3. The UI displays the bootstrap, provider, and setup tokens only from their creation responses and never surfaces the upstream token. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 reveals only the one-time bootstrap token at claim) -->
4. The UI shows mesh invite tokens only as presence, status, and age, and never reads plaintext credential values back from status. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 keeps mesh invite token state out of visible operator rows) -->
5. The UI presents no horizontal overflow at any desktop or mobile breakpoint, reflowing wide multi-column content into a stacked, labelled layout so no content truncates. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_RESPONSIVE --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function) -->
6. Admin UI HTML responses prevent browser framing. <!-- @impl: packages/router-worker/src/router.ts::html --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function) -->
7. During bootstrap and break-glass recovery only, the UI stores the session credential after successful verification and offers a sign-out control that clears it. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 verifies the admin token before storing it) --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-006 signs out and clears the stored admin token) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-ADM-002](#req-adm-002-admin-authentication), [REQ-ADM-003](#req-adm-003-setup-token-lifecycle), [REQ-ADM-004](#req-adm-004-one-line-installers), [REQ-ADM-005](#req-adm-005-custom-domain-handoff), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-RUN-004](runtime-profiles.md#req-run-004-profile-rollout), [REQ-OBS-002](observability.md#req-obs-002-admin-status-surface)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-035: Settings API reference listing

**Intent:** Admins need the Settings page to expose the operational Admin API surface without leaving the console.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Settings page API reference lists every Admin UI action endpoint and links each row to the Admin API reference. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::settingsSection --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane)

**Priority:** P1

**Dependencies:** [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-009: Admin mesh operation controls

**Intent:** Mesh lifecycle operations — health visibility, one-click rotation, and profile activation — must be operable from the Admin UI so operators never reproduce them with raw API calls.

**Applies To:** Admin

**Acceptance Criteria:**

1. The UI exposes initial setup, status refresh, setup-token creation, Linux/macOS/Windows install-command copy, Gateway configuration, custom-domain provisioning, node revocation, the mesh-secret-missing banner, a unified per-model on/off and settings list, and the agent-version control. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 REQ-ADM-035 serves a responsive browser admin UI for every admin-facing function) --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 exposes the mesh-key banner, the model list, and the agent-version control) -->
2. A model's mesh health detail lives in that model's Manage drawer rather than a standalone section. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-OBS-007 renders the mesh health panel from admin status data) -->
3. The UI provides a one-click "Reset sharing key" action in a model's Manage drawer that submits `POST /admin/mesh/rotate` for the model it belongs to. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 wires the one-click rotate action to the mesh rotate endpoint) -->
4. The Models section shows each model as one card with on/off controls backed by profile activation and zero-percent rollout endpoints. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-009 turns a model on from the unified model list) -->
5. Activating a profile records a `profile_activated` audit event. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-009 activates profiles alias-exclusively and records the audit event) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-006](#req-adm-006-admin-configuration-ui), [REQ-SEC-006](security.md#req-sec-006-mesh-token-lifecycle), [REQ-RUN-009](runtime-profiles.md#req-run-009-profile-seeding-and-retirement), [REQ-OBS-007](observability.md#req-obs-007-mesh-health-surface)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-007: Operator dashboard

**Intent:** Admins need the browser surface to behave like an operator console: entry views driven by real deployment state, day-two operations separated into navigable sections, and consistent, safe control feedback.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Worker pre-renders the entry view from host and setup phase: the setup wizard while setup is in progress, the locked console page on the bootstrap origin after completion, and the dashboard on the custom domain. <!-- @impl: packages/router-worker/src/router.ts::adminUiState --> <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_VIEWS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 pre-renders the entry view from host and setup phase) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-014 locks non-custom-domain hosts after setup completes) -->
2. The authenticated dashboard separates operations into Overview, Nodes, Models, Routing, Playground, and Settings sections behind persistent navigation. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_NAV --> <!-- @impl: packages/router-worker/src/admin-ui-components.ts::navItem --> <!-- @impl: packages/router-worker/src/admin-ui-views.ts::dashboardView --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-007 renders a Codeflare operator-console hero and nav rail contracts) -->
3. Each navigation entry resolves to a rendered dashboard section, and mobile viewports reach every section through a top-bar menu instead of a bottom tab bar that conflicts with mobile browser chrome. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @impl: packages/router-worker/src/admin-ui-views.ts::dashboardView --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 serves a sectioned operator dashboard with persistent navigation) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-007 toggles mobile navigation from the top-bar menu and closes it after section changes) -->
4. Every text, number, and select control carries a visible label, with inline hints and per-action feedback in predictable placement. <!-- @impl: packages/router-worker/src/admin-ui-components.ts::ADMIN_UI_FIELD_ANCHOR --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-007 labels every dashboard control visibly) -->
5. Destructive actions arm into an explicit same-control confirm step that auto-disarms before submitting. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-007 arms destructive controls and auto-disarms before submitting) -->
6. The Overview stats strip presents only the non-redundant tiles in the Codeflare operator-console hero: it omits the active-model count and connected-gateway stats, labels the node tile as available machines, labels aggregate VRAM as known VRAM, and keeps the desired-agent-version tile. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::dashboardView --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderStatus --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-007 overview tiles omit the redundant Active-models and Gateway stats and keep the version tile) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-036: Operator dashboard visual identity

**Intent:** The operator dashboard must carry the Codeflare visual identity and progressive wordmark behavior without making the UI depend on motion.

**Applies To:** Admin

**Acceptance Criteria:**

1. The dashboard shell uses the Codeflare product design tokens for typography, code/value text, coral hover states, ink colors, and the hero accent. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @impl: packages/router-worker/src/admin-ui-css.ts::adminUiCss --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-036 uses the official Codeflare shell tokens) -->
2. The hero progressively enhances `Codeflare` to the word-scramble effect while `Inference Mesh` remains static. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::dashboardView --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-036 leaves the scramble phrase static under reduced motion) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-036 scrambles the hero phrase and converges back to the target) -->
3. The word-scramble effect reserves width for temporary glyphs, preserves static text without JavaScript, and disables mutation under `prefers-reduced-motion`. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::dashboardView --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-036 leaves the scramble phrase static under reduced motion) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-036 scrambles the hero phrase and converges back to the target) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane)

**Priority:** P1

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-011: Guided first-run setup

**Intent:** First-run operators must be led from the bootstrap origin through domain, Access, routing, and first-node configuration as one sequenced flow that ends on the custom domain.

**Applies To:** Admin

**Acceptance Criteria:**

1. While setup is open, the Worker origin renders the setup wizard as an operator-console entry view with the shared hero treatment, milestone tiles, and a visible step rail. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::setupWizardView --> <!-- @impl: packages/router-worker/src/admin-ui-css.ts::adminUiCss --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->
2. The wizard sequences connectivity check, custom-domain provisioning, and Access provisioning before handoff, then optional Gateway connection, optional first-node enrollment, and review on the custom domain, in that order. <!-- @impl: packages/router-worker/src/admin-ui-contract.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->
3. Completing the connectivity step claims the deployment and reveals the one-time bootstrap access token that authorizes the remaining setup steps. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 reveals only the one-time bootstrap token at claim) -->
4. The Access step requires at least one admin email or admin group before provisioning and accepts optional user emails and user groups. <!-- @impl: packages/router-worker/src/router.ts::handleSetupAccess --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-012 REQ-SEC-010 provisions Access from captured admin and user identities and stores the role config) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 REQ-SEC-010 access step collects admin and user identities and reveals the handoff link) -->
5. After Access provisioning succeeds, the wizard presents the custom-domain console link as the continuation point. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 REQ-SEC-010 access step collects admin and user identities and reveals the handoff link) -->
6. Generated machine credentials render only from creation responses as one-time reveal cards with copy affordances and an explicit shown-once warning. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-011 reveals created credentials once with copy affordances and advances the wizard) -->
7. Every wizard capability remains available from the dashboard after first-run setup completes. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_WIZARD --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->

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
3. `POST /admin/agent-version` validates selections against GitHub release tags, refreshing a warm cache once when the requested tag is absent so a just-published release can be selected without direct storage edits, and still rejects tags absent after refresh. <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 accepts a newly published agent version after refreshing the release list) --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 refreshes a warm cache before rejecting an unknown agent version) -->
4. Accepting a version selection stores it as the single fleet-wide `desired_agent_version` and records an `agent_version_selected` audit event. <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 stores the fleet-wide desired version and audits the selection) -->
5. Every heartbeat response carries `desiredAgentVersion` while a desired version is set. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 heartbeat responses carry the desired agent version when set) -->
6. The Admin UI offers a release-tag dropdown with the current selection and shows each node's reported agent version against the desired version. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-008 renders the agent-version dropdown and per-node reported-versus-desired view) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-NODE-005](node-agent.md#req-node-005-agent-update-staging), [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-033: Runtime binary version and install visibility

**Intent:** Operators should select the MeshLLM and llama.cpp runtime releases independently from the node-agent release, and should see what each node has installed, what it is installing, and any install failure without SSH access.

**Applies To:** Admin

**Acceptance Criteria:**

1. `GET /admin/runtime-versions` returns MeshLLM and llama.cpp release tags fetched from their GitHub releases APIs, cached in `router_config`, and annotated with the current desired selection for each runtime. <!-- @impl: packages/router-worker/src/runtime-versions.ts::RUNTIME_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/runtime-versions.test.ts (REQ-ADM-033 lists MeshLLM and llama.cpp release tags with defaults selected) -->
2. `POST /admin/runtime-versions` validates selected MeshLLM and llama.cpp versions against the release-tag caches, stores them as fleet-wide desired runtime versions, and records a `runtime_versions_selected` audit event. <!-- @impl: packages/router-worker/src/runtime-versions.ts::handleRuntimeVersionsSelect --> <!-- @test: packages/router-worker/src/runtime-versions.test.ts (REQ-ADM-033 stores selected runtime versions and audits the operator action) -->
3. The Settings page renders MeshLLM and llama.cpp version dropdowns backed by the same Admin endpoints, and saving posts both selections through `POST /admin/runtime-versions`. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::settingsSection --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-033 renders and saves MeshLLM and llama.cpp runtime version controls from Settings) -->
4. Admin status and the node detail drawer expose each node's runtime binary status: runtime kind, desired version, installed version when known, `pending`/`installing`/`installed`/`failed` state, and install error when present. <!-- @impl: packages/router-worker/src/router.ts::runtimeBinaryStatus --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openNodeDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-OBS-012 renders runtime install status in the node table and drawer) -->
5. Claim and heartbeat responses carry desired runtime versions so nodes pick up changes automatically on the next check-in. <!-- @impl: packages/router-worker/src/router.ts::handleNodeClaim --> <!-- @impl: packages/router-worker/src/router.ts::handleNodeHeartbeat --> <!-- @test: packages/router-worker/src/runtime-versions.test.ts (REQ-NODE-013 includes selected runtime versions in heartbeat responses) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-ADM-008](#req-adm-008-agent-version-management), [REQ-NODE-013](node-agent.md#req-node-013-runtime-binary-bootstrap)

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

7. The Routing view surfaces the currently provisioned custom domain as a calm status card carrying the host as its value and its status as an ok-toned chip, or an empty-state card when none is recorded. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderStateCard --> <!-- @impl: packages/router-worker/src/admin-ui-css.ts::adminUiCss --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-005 surfaces the currently provisioned custom domain in Routing) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-005 renders an empty-state card when no custom domain is recorded) -->

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

1. The Access step provisions an Access application for the custom domain with an allow policy gating on the admin and user identities captured during setup. <!-- @impl: packages/router-worker/src/access-provisioning.ts::provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-SEC-010 gates the console app on the admin and user Access groups when a user set exists) -->
2. Provisioning creates bypass coverage for the provider, node, health, and installer paths so machine traffic needs no Access session. <!-- @impl: packages/router-worker/src/access-provisioning.ts::MACHINE_BYPASS_SUFFIXES --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 creates the admin app and bypass coverage for machine paths with an everyone bypass policy) -->
3. When the bypass policy cannot be created, provisioning removes the bypass application rather than leaving machine paths blocked. <!-- @impl: packages/router-worker/src/access-provisioning.ts::provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 removes the bypass app when its bypass policy cannot be created) -->
4. Provisioning durably stores the Access team domain, application audience, application identifiers, and captured role sets for verification and re-runs. <!-- @impl: packages/router-worker/src/router.ts::handleSetupAccess --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-012 REQ-SEC-010 provisions Access from captured admin and user identities and stores the role config) --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 returns the team domain, audience, identifiers, and captured role sets for durable storage) -->
5. Re-running provisioning updates the existing managed applications instead of duplicating them. <!-- @impl: packages/router-worker/src/access-provisioning.ts::provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 updates existing managed applications instead of duplicating them) -->

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
3. Selecting a node opens a detail drawer with status, hardware, models, agent version, trusted VRAM, stage ownership, and MeshLLM VRAM budget. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openNodeDrawer --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderNodesTable --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 REQ-ADM-032 the drawer offers Force Reload wired to the reload action) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-OBS-007 surfaces split capacity shortfall instead of marking raw standby green) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-OBS-011 renders a split stage owner as active work, not standby/API client) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-OBS-011 hides model_size_unknown during reload and update transitions) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-OBS-011 keeps stale model_size_unknown from overriding serving split status) -->
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

**Intent:** Operators need a one-screen way to verify end-to-end inference — either straight through the router or through any accessible AI Gateway — without copying tokens into external tools.

**Applies To:** Admin

**Acceptance Criteria:**

1. Sending a prompt renders the streamed response incrementally as chunks arrive. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 streams the direct-target playground response incrementally as chunks arrive) -->
2. Streamed response chunks append to a single text node so a selection made while the response streams is not wiped. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 appends stream chunks to one text node so a mid-stream selection survives) -->
3. Failed playground requests append a status-specific actionable next step (provider key, Gateway connection, missing node or profile, or re-sync) instead of a bare status code. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 appends a status-specific actionable hint when a playground request fails) -->
4. The playground exposes an optional tools-JSON input and a max-token cap, forwards them to the route, and surfaces returned tool calls, so an operator can reproduce and verify an agentic (tool-calling) request on the real route. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 renders the tools input, max-token cap, and a stop control in the playground) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-029 forwards tools and a max-token cap and surfaces tool calls on the dynamic route) -->
5. A Stop control aborts an in-flight stream so no further response content renders after it is pressed. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 renders the tools input, max-token cap, and a stop control in the playground) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 the stop control aborts an in-flight playground stream) -->
6. The periodic status poll never resets the operator's chosen playground model or route. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-016 the status poll preserves the chosen playground model) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard), [REQ-ADM-017](#req-adm-017-role-based-console-surface), [REQ-GWY-005](gateway.md#req-gwy-005-gateway-selection-and-provisioning), [REQ-ADM-029](#req-adm-029-playground-inference-endpoints), [REQ-ADM-031](#req-adm-031-operator-playground-target-selection)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-029: Playground inference endpoints

**Intent:** The Playground's two send paths are server endpoints with distinct guarantees: the gateway path proxies a chosen route through the selected gateway without leaking secrets and never lets a non-admin reach an arbitrary gateway, while the direct path drives the router's own scheduler.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. The gateway playground endpoint forwards the chosen route as `dynamic/<route>` and the stable playground session user to the selected gateway's compat endpoint. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-031 a gateway target lists that gateway routes and sends the selected route to the gateway endpoint) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 playground gateway target forwards dynamic/<route> to the selected gateway compat endpoint) -->
2. The gateway playground endpoint does not leak upstream gateway secrets to the caller. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 forwards playground prompts through the configured gateway route and strips upstream secrets) -->
3. The gateway playground endpoint reports `gateway_not_configured` when no account or gateway resolves. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 returns gateway_not_configured until a gateway is connected) -->
4. A non-admin console user is scoped to the default gateway and route on the gateway path, so a read-only viewer cannot proxy inference through an arbitrary account gateway. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 scopes a non-admin playground gateway target to the default gateway) -->
5. The direct playground endpoint forwards the internal model and direct-session user through the router's direct scheduling path, bypassing the gateway and honoring the direct-session affinity contract. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundDirect --> <!-- @impl: packages/router-worker/src/router.ts::runInference --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 playground direct target selects a node and forwards the internal model straight to it) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 direct playground forwards the session user required by llama.cpp profiles) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 REQ-RUN-013 direct playground sends a stable session user for affinity) -->
6. Both playground endpoints require a valid console role (admin or read-only user) before any upstream work. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundDirect --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 rejects unauthenticated playground requests) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 REQ-ADM-017 lets the read-only user role reach the playground endpoint) -->
7. Both playground endpoints forward an optional OpenAI-format `tools` array and a `max_tokens` cap only when the request supplies them, so an agentic request reaches the model verbatim and a runaway response is bounded. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundDirect --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 forwards playground tools and a max-token cap to the upstream route when supplied) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-SCH-002](state-scheduling.md#req-sch-002-stateless-entry-node-forwarding), [REQ-ADM-017](#req-adm-017-role-based-console-surface)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-018: Models section ordering

**Intent:** Operators scanning the Models section need the serving set surfaced first, so the models actually answering traffic are visible without scrolling past ones that are off, and every model must be shown by one clear name.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Models section lists models that are on before models that are off, preserving source order within each group. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderProfiles --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-018 orders profile rows active-first regardless of source order) -->
2. Each model renders as one card labeled by its canonical display name (not its wiring id) with an on/off toggle whose state and label reflect whether the model is on. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderProfiles --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-018 shows each model as one card with its canonical name and an on/off toggle) -->
3. Each model card carries a serving-mode badge — single machine (the whole model on each machine) or split across machines (machines share the model's layers) — as a badge attribute rather than baked into the model name. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderProfiles --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-018 badges each model with its serving mode instead of baking it into the name) -->
4. Each model card carries a runtime badge (`meshllm` or `llamacpp`) and direct llama.cpp cards indicate the `body.user` affinity requirement without changing the model name. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->

**Constraints:** None.

**Priority:** P3

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard), [REQ-RUN-004](runtime-profiles.md#req-run-004-profile-rollout)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-019: Console error affordances

**Intent:** When an operator action fails, the console must return an actionable next step instead of raw internals or an opaque generic error, so the operator can recover without reading logs.

**Applies To:** Admin

**Acceptance Criteria:**

1. Locked setup errors show inline guidance instead of raw JSON. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-019 renders setup-locked recovery affordances instead of raw JSON) -->
2. On a server error (5xx) response, the client renders a humane retry message that omits the raw error token but preserves any request id for support. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-ADM-019 renders a humane retry message for a 5xx failure without leaking the raw server error token) -->
3. A failed Gateway sync returns an actionable next step in the response body instead of a generic server error, so the operator can correct the cause and re-sync. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-019 surfaces an actionable message when Gateway sync fails) -->
4. Successful routine mutating actions render concise completion messages instead of raw JSON blobs; one-time secrets and Speed Test results may still use structured outputs because the operator must copy or inspect their values. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::runAction --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 connects a gateway from Routing using the discovered gateway and provider name only) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-019 REQ-ADM-030 renders concise completion messages for routine mutating actions) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-020: Node status clarity and filtering

**Intent:** An operator scanning the Nodes section must understand each machine's state at a glance in plain words, never a frozen internal substate, and must be able to narrow a large fleet by state or by name.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. Each machine's status renders in plain words: `Ready` when serving a model, `Active` (with the current step, e.g. downloading) when online but not yet serving, `Failed` on a runtime error, and `Offline` (with a last-seen age when known) when it stops checking in. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 shows a plain node status and never the stale runtime substate when offline) -->
2. An offline machine never shows the stale runtime substate frozen from its last heartbeat. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 shows a plain node status and never the stale runtime substate when offline) -->
3. A metric that is not yet real renders as a placeholder dash rather than a misleading `0`. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 shows a plain node status and never the stale runtime substate when offline) -->
4. The Nodes section filters the table by a status chip (all, ready, active, offline) and by a search box that applies once at least three characters are typed, matching a machine's id or name. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 filters the nodes table by status chip and by search) -->
5. A machine that has been offline longer than a configurable window (`offline_prune_seconds`, default 30 days, `0` disables) is removed from the fleet and must re-enroll, and the removal is recorded as a `node_pruned` audit event. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-020 prunes nodes offline past the configured window and records the removal) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-020 keeps offline nodes when the prune window is zero) -->
6. The Settings section persists the offline-prune window through `POST /admin/settings`, which accepts a non-negative integer number of seconds and rejects anything else. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-020 sets the offline prune window through the settings endpoint) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-020 saves the offline-machine prune window from Settings) -->
7. `GET /api/v1/settings` and `PUT /api/v1/settings` are automation-key settings endpoints that share console validation and audit writes. <!-- @impl: packages/router-worker/src/router.ts::handleApiSettingsGet --> <!-- @impl: packages/router-worker/src/router.ts::handleApiSettingsSet --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-020 REQ-API-002 reads and writes fleet settings over the automation API) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-ADM-015](#req-adm-015-mesh-visualization)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-021: Model serving configuration

**Intent:** An operator must be able to adjust a model's serving settings — its context window, model file, runtime-specific tuning, and (for MeshLLM) how much GPU memory (VRAM) is dedicated to running it — from the Models drawer, without editing seed configuration, so a machine can be tuned for input caching and throughput and still fit a model within a budget.

**Applies To:** Admin

**Acceptance Criteria:**

1. The model detail drawer exposes an editable context window, model file, runtime badge, and an Advanced runtime group. MeshLLM profiles show the Max VRAM field plus REQ-RUN-002 tunables; direct llama.cpp profiles show llama.cpp parallel slots, prompt-cache, and cache-reuse controls while hiding MeshLLM-only fields. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openModelDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-021 loads and saves a per-model VRAM budget from the model drawer) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-RUN-002 loads and saves per-model runtime tunables from the model drawer) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->
2. Saving posts to `POST /admin/profiles/config`, which persists the context window, model reference, runtime-specific tunables, MeshLLM VRAM budget when applicable, and bumps the profile version so a later default re-seed does not overwrite the edit. <!-- @impl: packages/router-worker/src/router.ts::handleProfileConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-021 configures a profile context window, model ref, and VRAM budget through the validated store path) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->
3. `POST /admin/profiles/config` accepts a MeshLLM context window of `0` (Auto), requires direct llama.cpp context windows to be at least `4096`, and rejects a blank model reference, negative VRAM budget, invalid runtime, or out-of-range runtime tunable. <!-- @impl: packages/router-worker/src/router.ts::handleProfileConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-021 configures a profile context window, model ref, and VRAM budget through the validated store path) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-021 configures direct llama.cpp settings through the admin profile config path) -->
4. A tunable value of null, `0`, or empty is not an error; it clears that field back to Auto by removing it, so MeshLLM auto-plans it. <!-- @impl: packages/router-worker/src/router.ts::resolveMeshllmTunables --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P2

**Dependencies:** [REQ-ADM-018](#req-adm-018-models-section-ordering), [REQ-RUN-002](runtime-profiles.md#req-run-002-default-model-profiles), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-meshllm-runtime)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-022: API key management console

**Intent:** An admin operating the Access-gated console must be able to mint, rotate, and revoke the automation keys that drive the mesh over the `/api/v1` API from the browser, without hand-crafting API calls, so the console is the single place a system admin issues machine credentials.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Settings section lists the active API keys by id and creation time (never the secret) and offers a control to create a new key. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderApiKeys --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-022 manages API keys from Settings: list renders, create reveals the secret once, rotate and revoke call the API) -->
2. Creating a key reveals its secret exactly once in a copy-ready output and refreshes the key list. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-022 manages API keys from Settings: list renders, create reveals the secret once, rotate and revoke call the API) -->
3. Each listed key offers a rotate action (issues a fresh secret revealed once) and a revoke action (disables the key immediately), each calling the control-plane API under the admin's Access session. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-022 manages API keys from Settings: list renders, create reveals the secret once, rotate and revoke call the API) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P2

**Dependencies:** [REQ-API-001](control-plane-api.md#req-api-001-automation-credentials), [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-023: Per-node settings

**Intent:** Operators need stable human names for machines and may need to cap a specific node's inference VRAM below a model's global budget, so the console and API must persist both settings after the node has registered.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. The node detail drawer exposes editable Machine name and "Max VRAM override (GB)" fields populated from the node; saving posts to `POST /admin/nodes/{id}/config`, where a non-blank name renames the node and a blank VRAM override clears the override. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openNodeDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-023 loads and saves node name and VRAM settings from the node drawer) -->
2. `POST /admin/nodes/{id}/config` persists a non-blank display name in the D1 node JSON, sets or clears a node's VRAM override, rejects a blank name or negative VRAM value, and returns `404` for an unknown or revoked node. <!-- @impl: packages/router-worker/src/router.ts::handleNodeConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-023 persists node name and VRAM override across heartbeat) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-023 refuses reconfigure and admin config for a revoked node) -->
3. Stored display names survive future heartbeats, and node VRAM overrides replace each model budget in heartbeat desired profiles. <!-- @impl: packages/router-worker/src/router.ts::handleNodeHeartbeat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-023 persists node name and VRAM override across heartbeat) -->
4. `POST /api/v1/nodes/{id}/reconfigure` persists the same display name and VRAM override for an automation caller, returns the node projection including them, and returns `404` for an unknown or revoked node. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeReconfigure --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-023 reconfigures node name and VRAM override through the automation API) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-023 refuses reconfigure and admin config for a revoked node) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P2

**Dependencies:** [REQ-ADM-021](#req-adm-021-model-serving-configuration), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-meshllm-runtime), [REQ-API-004](control-plane-api.md#req-api-004-programmatic-node-management)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-024: Routing operational status

**Intent:** The Routing screen live-verifies the selected gateway and shows the stable `codeflare-mesh` dynamic route inside the AI Gateway status card, while making the minted provider API key trivially copyable, so an operator sees the true wiring state and completes the one manual BYOK paste step.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Routing screen renders the selected gateway and its `codeflare-mesh` route in the AI Gateway status card, not as a separate dangling chip above the provision button. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::routingSection --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::refreshProvisionChip --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 keeps route status inside the Gateway card and labels the action clearly) -->
2. The card reads connected only when a live check confirms the selected gateway's mesh route and canonical provider exist — provisioning state, not node or serving health. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::refreshProvisionChip --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 shows the selected gateway route inside the AI Gateway card) -->
3. When the selected gateway is not provisioned, the card says it needs provisioning instead of showing stale connected state. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::refreshProvisionChip --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 marks the AI Gateway card as needing provisioning when the selected route is missing) -->
4. After Connect, the minted provider API key is revealed with a one-click copy control. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 the Routing screen exposes a copy control for the minted provider key) -->
5. A clear instruction tells the operator to paste the key into the AI Gateway provider's API Key field. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::routingSection --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 renders the AI Gateway paste instruction with the minted key) -->
6. The provision action is labeled `Provision Gateway`, matching the outcome rather than the implementation detail of syncing a route. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::routingSection --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 keeps route status inside the Gateway card and labels the action clearly) -->
7. The connected gateway reads as a calm status card carrying the gateway id, route line, and ok-toned connected chip; confirmed provisioned/connected state never uses danger/red treatment. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderStateCard --> <!-- @impl: packages/router-worker/src/admin-ui-css.ts::adminUiCss --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-024 reads the connected gateway as a state card) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P1

**Dependencies:** [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-GWY-005](gateway.md#req-gwy-005-gateway-selection-and-provisioning), [REQ-GWY-008](gateway.md#req-gwy-008-live-gateway-provision-verification)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-025: Add-a-model console control

**Intent:** An admin must be able to add a model from the console without redeploying the Worker: pick a serving mode, follow a mode-specific link to find a compatible model, enter its reference, and add it so it appears in the model list for deployment and activation.

**Applies To:** Admin

**Acceptance Criteria:**

1. The dashboard models area renders an add-model form with a serving-mode selector offering single-machine and split, a runtime selector offering MeshLLM and direct llama.cpp, and a model-reference input; split mode forces the runtime selector back to MeshLLM. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::addModelCard --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-025 renders an add-model form with a mode selector defaulting to single machine) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->

2. The form links to the Unsloth GGUF catalog for single-machine models, to the mesh-llm layer-package organization for split models, and to the layer-package preparation guide for models not already offered. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::addModelCard --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-025 links to the Unsloth GGUF catalog, the meshllm layer-package org, and the split-your-own guide) -->

3. Submitting the form posts the entered model reference, selected mode, and selected runtime to the profile-add endpoint and refreshes the model list on success so the new model appears without a redeploy. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-025 posts the model ref and mode and refreshes the model list) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-OBS-012 REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->

4. The form does not submit an empty model reference. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-025 does not submit an empty model ref) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-RUN-011](runtime-profiles.md#req-run-011-custom-model-onboarding), [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-026: Delete-a-model console control

**Intent:** An admin must be able to remove a custom model from the console once it is no longer needed, with a delete control that appears only where deletion is allowed and a confirm that cannot be lost to a background refresh before the operator commits.

**Applies To:** Admin

**Acceptance Criteria:**

1. The model Manage drawer shows a Delete control only for a custom, switched-off model, and hides it for a built-in model or the active model. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-026 shows a Delete control only for a custom, switched-off model) -->

2. Deleting from the drawer posts to the profile-delete endpoint and closes the drawer, so the removed model leaves the list on the next refresh. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-026 deletes a model from the drawer through the profiles delete endpoint and closes the drawer) -->

3. `POST /admin/profiles/delete` under admin authentication removes the named custom model. <!-- @impl: packages/router-worker/src/router.ts::handleProfileDelete --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-026 deletes a custom model from the console) -->

4. The console delete refuses a built-in model with status 409. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-026 refuses console deletion of a built-in model) -->

5. The console delete refuses a request that carries no admin credential. <!-- @impl: packages/router-worker/src/router.ts::handleProfileDelete --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-026 refuses console model deletion without an admin credential) -->

6. While a destructive confirm is armed, the dashboard holds its status poll so a refresh cannot rebuild the control and drop the confirm before the operator commits. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-026 holds the status poll while a destructive confirm is armed so it is not clobbered) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-RUN-012](runtime-profiles.md#req-run-012-custom-model-removal), [REQ-ADM-025](#req-adm-025-add-a-model-console-control), [REQ-ADM-006](#req-adm-006-admin-configuration-ui)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-027: Model naming and rename

**Intent:** An operator must be able to name a model when adding it and rename it afterwards — both the human display name and the model's own callable name — so a model is never stuck with a machine-derived label or an alias nobody chose, without ever colliding with the shared `codeflare-mesh` route or another model's alias.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. The add-model form carries a Name field; a supplied name becomes the model's display name, and a blank name defaults to the model-file segment. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::addModelCard --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-027 names a model on creation and defaults the name to the model file) -->

2. The Manage drawer exposes editable Name and Alias fields prefilled with the current display name and the model's own callable name (its non-shared alias). <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openModelDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 opens a model drawer listing the nodes serving each alias) -->

3. Saving a changed name sets the display name, and a changed call name replaces that callable alias while keeping the shared `codeflare-mesh` alias. <!-- @impl: packages/router-worker/src/router.ts::handleProfileConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-027 renames a model display name and call name with collision and reserved-alias guards) -->

4. A call name must slugify to a non-empty token, cannot be the reserved shared alias `codeflare-mesh` (409), and cannot collide with another model's alias (409); a blank display name is rejected (400). <!-- @impl: packages/router-worker/src/router.ts::handleProfileConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-027 renames a model display name and call name with collision and reserved-alias guards) -->

5. An unrelated setting save leaves the model's name and aliases untouched. <!-- @impl: packages/router-worker/src/router.ts::handleProfileConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-027 renames a model display name and call name with collision and reserved-alias guards) -->

6. The same naming is available to automation: `POST /api/v1/models` accepts an optional name, and `POST /api/v1/models/{id}` renames the display name and call name under the identical guards. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelAdd --> <!-- @impl: packages/router-worker/src/router.ts::handleApiModelConfigure --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-027 renames a model over the automation API with the same guards) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-ADM-025](#req-adm-025-add-a-model-console-control), [REQ-ADM-021](#req-adm-021-model-serving-configuration), [REQ-RUN-011](runtime-profiles.md#req-run-011-custom-model-onboarding)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-028: Topology connector bounds

**Intent:** Topology connectors must stay inside the canvas so the diagram never draws a line outside its frame, regardless of how many nodes are placed or at what angle.

**Applies To:** Admin

**Acceptance Criteria:**

1. Each node connector is sized to its node's position so no spoke renders outside the 2:1 topology canvas. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderTopology --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-028 sizes each topology spoke to stay within the 2:1 canvas (no vertical overflow)) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P2

**Dependencies:** [REQ-ADM-015](#req-adm-015-mesh-visualization)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-030: Node deactivation and activation

**Intent:** An operator can deactivate a node from the console (and via the admin API) to keep it enrolled and heartbeating while it runs no model and is never selected for inference, then reactivate it. Deactivation is a reversible taint, distinct from the one-way revoke decommission, and a deactivated node reads as tainted (orange) rather than healthy.

**Applies To:** Admin

**Acceptance Criteria:**

1. `POST /admin/nodes/{nodeId}/deactivate` and `POST /admin/nodes/{nodeId}/activate` require an admin credential, set and clear the node's `deactivated` flag, and record a `node_deactivated` / `node_activated` audit event. <!-- @impl: packages/router-worker/src/router.ts::setNodeDeactivated --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-030 deactivates and reactivates a node from the admin console with audit) -->
2. A deactivated node stays enrolled and heartbeating but is excluded from inference selection, and its heartbeat is answered with an empty desired-profile set and the deactivated signal. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @impl: packages/router-worker/src/router.ts::handleNodeHeartbeat --> <!-- @test: packages/router-worker/src/scheduler.test.ts (REQ-ADM-030 isEligible excludes a deactivated node even when it is otherwise ready) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-030 REQ-NODE-011 a deactivated node heartbeat gets no desired profiles and the flag survives) -->
3. The Nodes table renders a right-aligned Manage button opening a node drawer that offers Revoke plus Deactivate when active or Activate when deactivated; a deactivated node reads with a warn (orange) status and never turns the intentional stopped runtime into an install failure. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openNodeDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-030 a deactivated node reads as tainted (warn tone) and its drawer offers Activate) -->
4. The deactivated taint survives heartbeats that do not carry it, and clearing it re-admits the node to selection. <!-- @impl: packages/router-worker/src/router.ts::handleNodeHeartbeat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-030 REQ-NODE-011 a deactivated node heartbeat gets no desired profiles and the flag survives) -->
5. The drawer's Deactivate/Activate control posts to the corresponding `POST /admin/nodes/{id}/deactivate` or `/activate` endpoint and refreshes the status. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::runAction --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-019 REQ-ADM-030 renders concise completion messages for routine mutating actions) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-SCH-002](state-scheduling.md#req-sch-002-stateless-entry-node-forwarding), [REQ-NODE-011](node-agent.md#req-node-011-deactivated-nodes-run-no-model)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-031: Operator playground target selection

**Intent:** Before sending a test prompt, an operator chooses where the playground routes it, the direct router or an accessible AI Gateway, and the model or route selector is populated from that target's live options.

**Applies To:** Admin

**Acceptance Criteria:**

1. The direct target offers one option per model that is on, valued by the model's own callable name and labeled with that callable name paired with the model name, from live status data. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::renderPlaygroundSelect --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-031 lists one playground option per model on, valued by callable name and labeled with the model name) -->
2. A gateway target lists that gateway's dynamic routes in the dependent selector and sends the chosen route to the gateway playground endpoint. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::updatePlaygroundModels --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-031 a gateway target lists that gateway routes and sends the selected route to the gateway endpoint) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-ADM-007](#req-adm-007-operator-dashboard), [REQ-ADM-017](#req-adm-017-role-based-console-surface), [REQ-GWY-005](gateway.md#req-gwy-005-gateway-selection-and-provisioning), [REQ-ADM-029](#req-adm-029-playground-inference-endpoints)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-032: Node Force Reload

**Intent:** An operator can restart a node's mesh-llm runtime on demand from the console or the automation API, so a wedged runtime is recovered without SSHing into the host. It is reversible and never decommissions the node.

**Applies To:** Admin, Control Plane API

**Acceptance Criteria:**

1. `POST /admin/nodes/{id}/reload` (admin) and `POST /api/v1/nodes/{id}/reload` (automation twin) stamp a one-shot reload nonce on the node and audit it; each requires its respective credential and returns 404 for an unknown node. <!-- @impl: packages/router-worker/src/router.ts::requestNodeReload --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-032 REQ-NODE-012 force reload stamps a nonce, delivers it once, and retires it on ack) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-032 force reload requires an admin credential) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-032 REQ-API-004 force reloads a node over the automation API) -->
2. The reload nonce rides the node's heartbeat response until the node echoes it back, when the router retires the directive so it fires exactly once. <!-- @impl: packages/router-worker/src/router.ts::handleNodeHeartbeat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-032 REQ-NODE-012 force reload stamps a nonce, delivers it once, and retires it on ack) -->
3. The node Manage drawer offers a Force Reload control wired to the reload endpoint. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openNodeDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-015 REQ-ADM-032 the drawer offers Force Reload wired to the reload action) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P2

**Dependencies:** [REQ-ADM-030](#req-adm-030-node-deactivation-and-activation), [REQ-NODE-012](node-agent.md#req-node-012-on-demand-runtime-reload), [REQ-API-004](control-plane-api.md#req-api-004-programmatic-node-management)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-034: Direct router speed test

**Intent:** An operator can measure inference-router throughput from the console without involving AI Gateway, so runtime tuning distinguishes prompt ingestion speed from generation speed on the Worker → node-agent → runtime path.

**Applies To:** Admin, Control Plane API

**Acceptance Criteria:**

1. The Playground renders a Speed Test action that posts the currently selected callable model to the direct speed-test endpoint and renders the returned measurement fields. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::playgroundSection --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-034 runs a direct router speed test from the playground) -->
2. `POST /admin/playground/speed-test` requires a console role, runs direct scheduling with a prompt nonce, returns prompt/generation timing, and stores the latest summary. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundSpeedTest --> <!-- @impl: packages/router-worker/src/router.ts::runSpeedTest --> <!-- @impl: packages/router-worker/src/router.ts::measureSpeedStream --> <!-- @impl: packages/router-worker/src/router.ts::speedTestSummary --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-034 playground speed test measures direct router token ingestion and generation) -->
3. The dashboard status strip shows the latest Speed Test split throughput when a summary exists, and the Playground refreshes status after a Speed Test run. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-OBS-010 computes the stats strip aggregates from admin status) --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-034 runs a direct router speed test from the playground) -->
4. The Playground Speed Test control is rendered as an operator command row with endpoint and auth-scope chips, so the direct-router measurement is visually distinguishable from free-form chat. <!-- @impl: packages/router-worker/src/admin-ui-components.ts::commandRow --> <!-- @impl: packages/router-worker/src/admin-ui-views.ts::playgroundSection --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-ADM-034 renders endpoint chips inside command rows for action-heavy controls) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P2

**Dependencies:** [REQ-ADM-016](#req-adm-016-operator-playground), [REQ-ADM-029](#req-adm-029-playground-inference-endpoints)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
