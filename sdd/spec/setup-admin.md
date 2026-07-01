# Setup And Admin

This domain covers first-run setup, admin access, node setup tokens, Cloudflare resource setup, and install-script delivery.

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
4. Admin authentication is never accepted for provider `/v1/*` requests or node heartbeat identity. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->
5. Failed admin authentication does not reveal whether setup has completed. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status) -->

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

1. The Admin can create a setup token with expiration, optional node name, and allowed profile list. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim) -->
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
2. `/install.sh` installs the matching Unix agent artifact and service wrapper. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
3. `/install.ps1` installs the matching Windows agent artifact and service wrapper. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
4. Install scripts verify downloaded artifact checksums before installation. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->
5. Install scripts do not embed provider, admin, node, upstream, deploy, or Cloudflare API credentials. <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans) -->

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
2. The UI exposes first-run setup, admin login, status refresh, setup-token creation, Linux/macOS/Windows installer generation, Gateway sync, custom-domain validation, node revocation, and profile rollout controls. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
3. The UI stores admin tokens only in browser-controlled session/local storage and sends them as bearer credentials only when an admin action requires authentication. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
4. The UI displays generated admin/provider/setup/upstream tokens only from creation responses and never reads plaintext credentials back from status. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
5. The layout remains usable on desktop and mobile viewports with responsive navigation, forms, status panels, tables, and action controls. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-ADM-002](#req-adm-002-mvp-admin-auth), [REQ-ADM-003](#req-adm-003-setup-token-lifecycle), [REQ-ADM-004](#req-adm-004-one-line-installers), [REQ-ADM-005](#req-adm-005-optional-custom-domain), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation), [REQ-RUN-004](runtime-profiles.md#req-run-004-profile-rollout-controls), [REQ-OBS-002](observability.md#req-obs-002-admin-status)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ADM-005: Optional custom domain

**Intent:** The router should work on `workers.dev` first and support a custom domain later without blocking the private Mesh proof path.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Admin can keep using the `workers.dev` origin after setup. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
2. The Admin can select a zone and hostname for a Worker custom domain when runtime Cloudflare permissions allow it. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 validates and stores optional custom-domain hostnames before accepting them) -->
3. Custom domain setup failure leaves the existing Worker origin usable. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 validates and stores optional custom-domain hostnames before accepting them) -->
4. AI Gateway provider configuration can be updated to the custom domain after it is attached. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 automates provider, route, version, and deployment creation while leaving BYOK manual) -->
5. The setup UI records the selected custom domain and Cloudflare zone resource identifiers in D1. <!-- @impl: packages/router-worker/src/router.ts::handleCustomDomain --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-005 validates and stores optional custom-domain hostnames before accepting them) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-GWY-001](gateway.md#req-gwy-001-gateway-custom-provider)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
