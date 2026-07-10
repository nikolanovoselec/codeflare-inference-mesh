# Security

This domain covers credential separation, route-level auth, header filtering, token storage, mesh token lifecycle, runtime secret boundaries, and abuse/rate-limiting controls.

---

### REQ-SEC-001: Credential boundaries

**Intent:** Each trust boundary must use its own credential class so a compromised node, copied installer, or leaked provider key cannot impersonate another role.

**Applies To:** Admin

**Acceptance Criteria:**

1. Client-to-Gateway, Gateway-to-Worker, setup, node-to-Worker, dashboard, Worker-to-node, mesh invite, admin, deploy, and runtime Cloudflare credentials are separate classes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
2. Provider tokens cannot claim nodes or access admin routes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
3. Node tokens cannot call provider endpoints or admin routes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
4. Setup tokens cannot heartbeat, proxy inference, or access admin routes after claim. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
5. Upstream tokens are accepted only by node-agent Mesh-facing inference routes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC004RuntimeExposureUsesLocalDashboardAndUpstreamToken) -->
6. Mesh invite tokens never cross the provider, node, or admin credential families. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
7. Mesh invite tokens are delivered only in post-claim, node-token-authenticated responses, never on the enrollment or installer path, so the single-use setup token carries no mesh material. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-001 delivers mesh bootstrap only in node-token-authenticated heartbeat responses) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-002: Secret storage and rotation readiness

**Intent:** Durable storage must avoid plaintext secrets while still allowing operators to rotate compromised credentials.

**Applies To:** Admin

**Acceptance Criteria:**

1. Setup, provider, admin, node, and upstream tokens are generated with enough entropy for bearer-token use. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
2. Durable token records store hashes or encrypted values. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
3. Router config keeps the generated Worker-to-node upstream token recoverable so the Worker can present it during node forwarding. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SEC-001 reuses generated upstream token when no env secret exists) -->
4. Token verification uses constant-time comparison for hash matches. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
5. Admin can revoke a node: its node and mesh tokens are revoked and the node record is deleted, so the node disappears from the console at once and a still-running agent cannot re-authenticate or re-register. <!-- @impl: packages/router-worker/src/router.ts::handleNodeRevoke --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-002 lets an admin revoke a node token and audit the action) -->
6. Admin can stage a replacement setup credential as a new verifier without exposing the stored verifier or disabling existing setup credentials. <!-- @impl: packages/router-worker/src/router.ts::handleSetupToken --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
7. A revoked node never appears in any fleet listing — neither the console status view nor the automation node list — even when a mid-revoke failure leaves its credential-stripped row behind. <!-- @impl: packages/router-worker/src/store.ts::listNodes --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-002 hides a revoked tombstone node from every fleet listing) --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SEC-002 listNodes excludes revoked tombstone rows that getNode can still reach) -->

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-SEC-001](#req-sec-001-credential-boundaries)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-003: Header filtering

**Intent:** The Worker and node agent must not forward credentials across the wrong trust boundary while proxying OpenAI-compatible requests.

**Applies To:** Client

**Acceptance Criteria:**

1. The Worker sends only the node upstream token and approved inference metadata to the selected node. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding) -->
2. The Worker strips client authorization, Cloudflare API tokens, admin credentials, node credentials, and setup credentials before node forwarding. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding) -->
3. The node agent strips upstream token headers before forwarding to the local runtime unless the runtime is explicitly configured to require them. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
4. Observability logs record credential-bearing header names only when values are redacted. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding) -->
5. Header filtering applies to streaming and non-streaming requests. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-003 strips client authorization and Cloudflare headers before Worker-to-node forwarding) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P0

**Dependencies:** [REQ-RTR-002](router-worker.md#req-rtr-002-chat-completion-forwarding), [REQ-NODE-003](node-agent.md#req-node-003-upstream-proxy)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-004: Runtime API exposure

**Intent:** Local runtimes are powerful processes on private machines, so the product must avoid exposing runtime admin surfaces beyond what inference requires; the MeshLLM console API exposes the mesh invite token, so only the inference API may ever be proxied to the Mesh.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The node agent proxies only the configured inference and health endpoints to the runtime. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
2. The MeshLLM console API binds localhost-only and is never proxied to the Mesh. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMRenderAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQSEC004ArgvListForbidsPublicExposureFlags) --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
3. Managed MeshLLM processes always run in headless mode, keeping runtime web UI features disabled. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMRenderAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQSEC004RendererEnforcesHeadlessMode) -->
4. The rendered MeshLLM argv list never contains `--publish`, `--listen-all`, `--auto`, or `--discover`. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMRenderAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQSEC004ArgvListForbidsPublicExposureFlags) -->
5. Discovery runs over `nostr`, carrying rendezvous metadata only, never inference. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMRenderAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQSEC004ArgvListForbidsPublicExposureFlags) --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQSEC004NostrRelaysAppendWhenConfiguredOnly) -->
6. iroh's inference data transport is pinned to the WARP overlay via `--bind-ip` + `--disable-iroh-relays`, with no public relay/STUN fallback. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMRenderAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQSEC004ArgvListForbidsPublicExposureFlags) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-NODE-003](node-agent.md#req-node-003-upstream-proxy), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-meshllm-runtime)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-008: Dashboard access control and log redaction

**Intent:** Node-local control surfaces need their own authentication boundaries: the Mesh-facing listener verifies upstream tokens, dashboard controls require the local dashboard token and a matching browser origin, and runtime logs never leak credentials.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The Mesh-facing listener requires upstream token verification before any inference proxy call. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC004RuntimeExposureUsesLocalDashboardAndUpstreamToken) -->
2. Local dashboard endpoints bind to localhost and do not accept Worker upstream tokens as dashboard auth. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC004RuntimeExposureUsesLocalDashboardAndUpstreamToken) -->
3. Runtime-control dashboard POSTs require the local dashboard token. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
4. Runtime-control dashboard POSTs reject browser Origin headers that do not match the dashboard origin. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC004RuntimeExposureUsesLocalDashboardAndUpstreamToken) -->
5. Runtime process logs are redacted before display or heartbeat transmission when they contain credentials. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC008DashboardRedactsCredentials) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-NODE-003](node-agent.md#req-node-003-upstream-proxy), [REQ-NODE-004](node-agent.md#req-node-004-local-dashboard)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-005: Dashboard token lifecycle

**Intent:** Local runtime controls need a stable node-local dashboard token even when operators upgrade from earlier configs that did not include one.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. Newly generated node-agent configs include a non-empty local dashboard token. <!-- @impl: packages/node-agent/internal/agent/config.go::DefaultConfig --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC005LegacyConfigBackfillsDashboardToken) -->
2. Legacy node-agent configs without a local dashboard token generate one during config load. <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC005LegacyConfigBackfillsDashboardToken) -->
3. A generated legacy backfill token is persisted so the dashboard token remains stable across reloads. <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQSEC005LegacyConfigBackfillsDashboardToken) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-NODE-004](node-agent.md#req-node-004-local-dashboard)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-006: Mesh token lifecycle

**Intent:** Mesh invite tokens admit nodes to the private inference mesh, so the router must own their encrypted storage, distribution, and rotation without exposing token values. Rotation evicts stale-token holders by forcing a new mesh identity, with `--trust-policy allowlist` plus `--owner-key` as the backstop.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. The Worker stores per-profile mesh state AES-GCM envelope-encrypted under the `MESH_STATE_KEY` Worker secret, and the D1 record holds only `{iv, ciphertext}`. <!-- @impl: packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS --> <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-006 stores mesh state as round-tripping ciphertext and never plaintext tokens) -->
2. When `MESH_STATE_KEY` is absent, the mesh rotation endpoint and mesh bootstrap computation fail closed with a `mesh_state_key_missing` error while claim, heartbeat persistence, and scheduling of already-ready nodes continue. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-006 fails closed on missing MESH_STATE_KEY for mesh endpoints only) -->
3. The `mesh_state_key_missing` condition surfaces as an admin status banner. <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/admin-ui-mesh.test.ts (REQ-SEC-006 surfaces mesh_state_key_missing as an admin status banner) -->
4. Mesh invite tokens are distributed only in heartbeat responses to live, non-revoked nodes assigned to the mesh profile. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-006 distributes join tokens only to live non-revoked nodes) -->
5. `POST /admin/mesh/rotate` increments the profile's rotation counter, clears stored mesh state, and appends a `mesh_token_rotated` audit event. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-006 rotate increments the counter, clears state, and audits) -->
6. Heartbeat responses issued after a rotation carry the incremented rotation counter and freshly computed mesh bootstrap. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-006 post-rotation heartbeats carry the new rotation and bootstrap) -->
7. `POST /api/v1/mesh/rotate` authenticates by automation key, rotates the named profile, returns the rotation, audits the caller, and enforces `404`/`401` failures. <!-- @impl: packages/router-worker/src/router.ts::handleApiMeshRotate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-006 REQ-API-002 rotates the mesh secret over the automation API) -->

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets), [CON-SEC-003](constraints.md#con-sec-003-mesh-secret-custody-and-rotation)

**Priority:** P0

**Dependencies:** [REQ-SEC-001](#req-sec-001-credential-boundaries), [REQ-SEC-002](#req-sec-002-secret-storage-and-rotation-readiness), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-007: Mesh token revocation

**Intent:** Revoking a node must remove it from mesh token distribution immediately and make re-enrollment the only path back, while admin surfaces expose token presence without ever exposing values.

**Applies To:** Admin

**Acceptance Criteria:**

1. Revoking a node removes its invite-token entry from stored mesh state and appends a `mesh_token_removed` audit event. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-007 revoke removes the node token entry and audits) -->
2. A revoked node regains mesh access only through re-enrollment with a fresh single-use setup token; node tokens have no in-place rotation. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SEC-007 readmits a revoked node only after re-enrollment) -->
3. Admin surfaces show mesh token presence, age, and count, never token values. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-007 admin status reports token presence, age, and count without values) -->

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets), [CON-SEC-003](constraints.md#con-sec-003-mesh-secret-custody-and-rotation)

**Priority:** P0

**Dependencies:** [REQ-SEC-006](#req-sec-006-mesh-token-lifecycle), [REQ-SEC-002](#req-sec-002-secret-storage-and-rotation-readiness)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-009: Cloudflare Access admin authentication

**Intent:** Once the custom domain exists, human admin identity comes from Cloudflare Access, so the Worker must verify Access JWTs itself and stop trusting bearer tokens for humans outside bootstrap and recovery.

**Applies To:** Admin

**Acceptance Criteria:**

1. Admin requests present an Access JWT via the assertion header or the Access cookie. <!-- @impl: packages/router-worker/src/access.ts::extractAccessJwt --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-009 accepts the Access JWT from the CF_Authorization cookie when the header is absent) -->
2. JWT verification checks the signature against the team's published keys plus audience, issuer, and validity window. <!-- @impl: packages/router-worker/src/access.ts::verifyAccessRequest --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-009 verifies a valid Access JWT from the assertion header and reports the email) --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-009 rejects expired and not-yet-valid JWTs) -->
3. A present-but-invalid JWT is rejected without falling back to bearer authentication. <!-- @impl: packages/router-worker/src/router.ts::requireAdmin --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-009 distinguishes a present-but-invalid JWT from an absent one) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 requires a valid Access JWT on admin routes once access config is stored) -->
4. Verification keys are cached between requests and refreshed without a per-request fetch. <!-- @impl: packages/router-worker/src/access.ts::JWKS_CACHE_TTL_MS = 60 * 60 * 1000 --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-009 caches the published keys between verifications instead of fetching per request) --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-009 refetches the published keys on an unknown key id once the cache is stale enough) -->
5. Successful Access authentication records the authenticated email as the audit actor. <!-- @impl: packages/router-worker/src/router.ts::requireAdmin --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 records the Access email as the audit actor for admin actions) -->
6. Human admin routes accept bearer admin authentication only before Access provisioning completes or while break-glass recovery is active; the machine key-management exception is limited to [REQ-API-001](control-plane-api.md#req-api-001-automation-credentials). <!-- @impl: packages/router-worker/src/router.ts::requireAdmin --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-013 reopens the bootstrap origin while the reopen secret is unconsumed and audits entry once) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 requires a valid Access JWT on admin routes once access config is stored) -->
7. Access-backed mutating admin and playground routes are accepted only with same-origin browser evidence; cross-site Access header/cookie requests are rejected. <!-- @impl: packages/router-worker/src/router.ts::hasSameOriginSignal --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 rejects Access-backed admin mutations without same-origin evidence) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-009 rejects Access-backed user mutations without same-origin evidence) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-SEC-001](#req-sec-001-credential-boundaries)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-010: Role-based console access

**Intent:** Access admits more than one kind of person, so the mesh must map each verified identity to an admin or a read-only user by comparing the caller's Access groups and email against the operator-configured sets — granting the higher privilege on overlap and refusing anyone who matches neither when a user set exists.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. A verified identity whose email (matched case-insensitively) or Access group is in the admin set resolves to the admin role. <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 resolves the admin role from an admin group and lets admins write config) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 matches configured emails case-insensitively against the JWT claim) -->
2. A caller matching both the admin and user sets resolves to admin because the higher privilege wins. <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 grants admin when a caller matches both admin and user groups) -->
3. A verified identity matching only the user set resolves to the read-only user role. <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 resolves the read-only user role from a user group and refuses config writes) -->
4. When no user set is configured, any verified non-admin identity resolves to the read-only user role. <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 grants read-only user to any verified identity when no user set is configured) -->
5. When a user set is configured, a verified identity matching neither set is refused. <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-010 refuses a verified identity that matches neither set when a user set is configured) -->
6. Caller Access groups come from a live get-identity lookup restricted to the team's `cloudflareaccess.com` domain. <!-- @impl: packages/router-worker/src/access.ts::fetchIdentityGroups --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-010 returns the caller Access groups from get-identity using the request JWT) --> <!-- @test: packages/router-worker/src/access.test.ts (REQ-SEC-010 refuses to call a team domain outside cloudflareaccess.com) -->
7. Setup opens the Access allow policy to everyone when no user set is configured. <!-- @impl: packages/router-worker/src/access-provisioning.ts::provisionAccess --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-SEC-010 opens the console policy to everyone when no user set is configured) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-SEC-009](#req-sec-009-cloudflare-access-admin-authentication)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-011: Public endpoint rate limiting

**Intent:** Publicly reachable router endpoints must resist floods and credential brute-force so a single caller cannot exhaust inference capacity, spam heartbeats, or grind setup tokens and admin credentials, while the credentialed AI Gateway inference path stays generously provisioned for production traffic.

**Applies To:** Admin

**Acceptance Criteria:**

1. A request that exceeds its endpoint's rate limit receives a 429 response with a Retry-After header before its route handler runs. <!-- @impl: packages/router-worker/src/rate-limit.ts::isRateLimited --> <!-- @impl: packages/router-worker/src/router.ts::createRouter --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-011 rate-limits a public endpoint before reaching its handler) -->
2. Requests are grouped into rate-limit buckets by route: inference for credentialed `/v1` traffic, heartbeat, enrollment, admin authentication, and a public bucket for token-less `/v1` and all other public routes. <!-- @impl: packages/router-worker/src/rate-limit.ts::classifyRoute --> <!-- @test: packages/router-worker/src/rate-limit.test.ts (REQ-SEC-011 maps each public endpoint to its bucket, defaulting unlisted routes to public) --> <!-- @test: packages/router-worker/src/rate-limit.test.ts (REQ-SEC-011 sends the AI Gateway to the high inference bucket and anonymous inference to the low public bucket) -->
3. Token-keyed buckets key their rate limit to a hash of the caller's bearer credential. <!-- @impl: packages/router-worker/src/rate-limit.ts::rateKey --> <!-- @test: packages/router-worker/src/rate-limit.test.ts (REQ-SEC-011 keys authenticated buckets by a hashed token and unauthenticated buckets by IP) -->
4. Unauthenticated buckets key their rate limit to the client IP. <!-- @impl: packages/router-worker/src/rate-limit.ts::rateKey --> <!-- @test: packages/router-worker/src/rate-limit.test.ts (REQ-SEC-011 keys authenticated buckets by a hashed token and unauthenticated buckets by IP) -->
5. Rate limiting fails open when its binding is unavailable or the limiter faults, so it cannot take the router offline. <!-- @impl: packages/router-worker/src/rate-limit.ts::isRateLimited --> <!-- @test: packages/router-worker/src/rate-limit.test.ts (REQ-SEC-011 allows under the limit and fails open on a limiter fault) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane)

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SEC-012: Authenticated AI Gateway

**Intent:** The mesh AI Gateway forwards requests to the router using the stored BYOK provider key, so an unauthenticated gateway would let any caller who knows the gateway URL reach the router with valid credentials attached; the gateway must therefore require a valid AI Gateway token on every request.

**Applies To:** Admin

**Acceptance Criteria:**

1. The mesh provisions its AI Gateway with authentication enabled, so provider-native requests require a valid AI Gateway token. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::ensureGateway --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-012 provisions an Authenticated Gateway and reconciles an existing open gateway) -->
2. A gateway created before authentication was enforced is reconciled to authenticated on the next sync, preserving its existing cache and rate-limit settings. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::ensureGateway --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-012 provisions an Authenticated Gateway and reconciles an existing open gateway) -->
3. An already-authenticated gateway is left unchanged on sync. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::ensureGateway --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-012 provisions an Authenticated Gateway and reconciles an existing open gateway) -->
4. The operator playground authenticates to the gateway with an AI Gateway Run token in the `cf-aig-authorization` header. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-012 playground authenticates to the gateway with cf-aig-authorization) -->
5. The playground fails fast with an actionable error when that AI Gateway token is absent. <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SEC-012 fails fast when the gateway auth token is missing instead of an opaque upstream 401) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-GWY-005](gateway.md#req-gwy-005-gateway-selection-and-provisioning), [REQ-ADM-016](setup-admin.md#req-adm-016-operator-playground)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/security.md](../../documentation/lanes/security.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
