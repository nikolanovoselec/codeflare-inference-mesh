# Control-Plane API

This domain covers the enterprise `/api/v1` control plane: a scoped, revocable, audited machine credential and the endpoints that let fleet managers and MDM systems orchestrate the mesh programmatically without a Cloudflare Access session.

---

### REQ-API-001: Automation credentials

**Intent:** Enterprise fleet managers and MDM systems need a scoped, revocable, audited machine credential to drive the mesh programmatically, kept separate from the human admin's Access-gated session and from the provider, node, and setup token classes.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. `POST /api/v1/keys` requires an admin credential and mints a new `automation` key, returning the secret exactly once in the response body. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyCreate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 mints an automation key for an admin and returns the secret once) -->
2. `GET /api/v1/keys` requires an admin credential and lists the active automation keys by id and creation time, never the secret or its stored verifier. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyList --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 lists active automation keys without the secret or verifier) -->
3. `DELETE /api/v1/keys/{id}` requires an admin credential and revokes the named automation key so it no longer authenticates, returning `404` for an unknown key. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyRevoke --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 revokes an automation key so it stops authenticating) -->
4. The automation-key management endpoints refuse a request that carries no admin credential. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyCreate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 refuses automation-key management without an admin credential) -->
5. Minting and revoking an automation key each record an audit event that names the key id and never the secret. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyCreate --> <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyRevoke --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 audits automation key creation and revocation) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-SEC-002](security.md#req-sec-002-secret-storage-and-rotation-readiness)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-002: Control-plane access and status

**Intent:** The `/api/v1` control plane must authenticate machine callers by automation key without a Cloudflare Access session, be metered independently of the human and inference surfaces, and expose a fleet status snapshot, so automation can reach it from anywhere while credential classes stay separated.

**Applies To:** Automation

**Acceptance Criteria:**

1. A request to an `/api/v1` endpoint authenticates when it carries a valid automation key as a bearer token. <!-- @impl: packages/router-worker/src/router.ts::requireAutomation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 returns a fleet snapshot to an authenticated automation caller) -->
2. A request to an `/api/v1` endpoint is rejected with `401` when it carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::requireAutomation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 rejects an api request without a valid automation key) -->
3. Every `/api/v1` request is classified into a dedicated `api` rate-limit bucket, keyed by a hash of the automation key so one caller's burst cannot spend another's budget. <!-- @impl: packages/router-worker/src/rate-limit.ts::classifyRoute --> <!-- @test: packages/router-worker/src/rate-limit.test.ts (REQ-SEC-011 maps each public endpoint to its bucket, defaulting unlisted routes to public) -->
4. The `/api/v1/*` paths are covered by the machine Access-bypass so automation reaches them without an Access session. <!-- @impl: packages/router-worker/src/access-provisioning.ts::MACHINE_BYPASS_SUFFIXES --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-ADM-012 creates the admin app and bypass coverage for machine paths with an everyone bypass policy) -->
5. `GET /api/v1/status` returns a fleet snapshot — node totals and online count, model totals and active count, and the desired agent version when one is set — to an authenticated automation caller. <!-- @impl: packages/router-worker/src/router.ts::handleApiStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 returns a fleet snapshot to an authenticated automation caller) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P1

**Dependencies:** [REQ-API-001](#req-api-001-automation-credentials), [REQ-ADM-012](setup-admin.md#req-adm-012-domain-and-access-provisioning), [REQ-SEC-011](security.md#req-sec-011-public-endpoint-rate-limiting)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-003: Programmatic enrollment

**Intent:** Fleet managers and MDM systems must mint node enrollment (setup) tokens programmatically and at scale, from anywhere, without a human console session, so thousands of machines can be provisioned automatically.

**Applies To:** Automation, Admin

**Acceptance Criteria:**

1. `POST /api/v1/enrollment-tokens` authenticated by an automation key mints a setup token with the standard 24-hour expiry and returns it once with its expiry. <!-- @impl: packages/router-worker/src/router.ts::handleApiEnrollmentToken --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-003 mints an enrollment token from an automation key) -->
2. `POST /api/v1/enrollment-tokens` also accepts an admin credential, so operators can mint from either surface. <!-- @impl: packages/router-worker/src/router.ts::handleApiEnrollmentToken --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-003 also mints an enrollment token from an admin credential) -->
3. Minting an enrollment token records a `setup_token_created` audit event naming the caller. <!-- @impl: packages/router-worker/src/router.ts::handleApiEnrollmentToken --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-003 audits enrollment-token minting with the automation caller) -->
4. `POST /api/v1/enrollment-tokens` refuses a request that carries neither an automation key nor an admin credential. <!-- @impl: packages/router-worker/src/router.ts::handleApiEnrollmentToken --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-003 refuses enrollment-token minting without a credential) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-ADM-003](setup-admin.md#req-adm-003-setup-token-lifecycle)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-004: Programmatic node management

**Intent:** Fleet managers must enumerate, inspect, and decommission nodes programmatically — filtering and paginating a large fleet — without ever exposing node token verifiers or internal topology.

**Applies To:** Automation

**Acceptance Criteria:**

1. `GET /api/v1/nodes` returns the fleet as machine-facing node projections that never include token verifiers or internal ports. <!-- @impl: packages/router-worker/src/router.ts::toApiNode --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 lists nodes as projections without token verifiers) -->
2. `GET /api/v1/nodes` filters by a `status` query parameter and by a case-insensitive `q` search over node id and display name. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeList --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 filters the node list by status and search) -->
3. `GET /api/v1/nodes` paginates by an id cursor, returning at most `limit` nodes ordered by id and a `nextCursor` when more remain. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeList --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 paginates the node list by id cursor) -->
4. `GET /api/v1/nodes/{id}` returns one node projection, or `404` when the node is unknown. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeGet --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 returns a single node and 404 for an unknown node) -->
5. `DELETE /api/v1/nodes/{id}` decommissions a node — revoking it and its node and mesh tokens so it must re-enroll — records a `node_revoked` audit event, and returns `404` for an unknown node. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeDecommission --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 decommissions a node and revokes its credentials) -->
6. The node endpoints refuse a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeList --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 refuses node access without an automation key) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-SEC-002](security.md#req-sec-002-secret-storage-and-rotation-readiness)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
