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
5. For automation-key management only, the admin bearer credential remains accepted after Access is provisioned so operators can clean up machine keys from automation while human console routes still require Access outside break-glass recovery. <!-- @impl: packages/router-worker/src/router.ts::requireKeyAdmin --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 accepts the admin bearer credential for key cleanup after Access is provisioned) -->
6. Minting and revoking an automation key each record an audit event that names the key id and never the secret. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyCreate --> <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyRevoke --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 audits automation key creation and revocation) -->
7. `POST /api/v1/keys/{id}/rotate` requires an admin credential, retires the named key, and issues a replacement whose new secret is returned exactly once, so the previous secret stops authenticating; rotation is audited by key id and returns `404` for an unknown key. <!-- @impl: packages/router-worker/src/router.ts::handleApiKeyRotate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-001 rotates an automation key so the old secret dies and a new one authenticates) -->

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
5. `GET /api/v1/status` returns an authenticated fleet snapshot, and full-detail requests include node/profile/mesh/stage projections without secret values. <!-- @impl: packages/router-worker/src/router.ts::handleApiStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 returns a fleet snapshot to an authenticated automation caller) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 exposes detailed mesh roles, readiness, and stage ownership on request) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 exposes per-node runtime install status to automation callers) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-009 exposes the direct router speed test to automation callers) -->

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
5. `DELETE /api/v1/nodes/{id}` decommissions a node — deleting its record (reaching even a revoked tombstone row so it can be reaped) and revoking its node and mesh tokens so it must re-enroll — records a `node_revoked` audit event, and returns `404` for an unknown node. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeDecommission --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 decommissions a node and revokes its credentials) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 decommission reaps a lingering revoked tombstone row) -->
6. The node endpoints refuse a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::handleApiNodeList --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-004 refuses node access without an automation key) -->
7. `POST /api/v1/nodes/{id}/deactivate` and `POST /api/v1/nodes/{id}/activate` set and clear the node's deactivated taint, record a `node_deactivated` / `node_activated` audit event, return the updated node projection (which carries `deactivated`), and `404` for an unknown node. <!-- @impl: packages/router-worker/src/router.ts::apiSetNodeDeactivated --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-002 REQ-ADM-030 deactivates and reactivates a node over the automation API) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-SEC-002](security.md#req-sec-002-secret-storage-and-rotation-readiness)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-005: Programmatic model management

**Intent:** Fleet managers must list, configure, enable, and disable models programmatically through the same validated model levers the console uses.

**Applies To:** Automation

**Acceptance Criteria:**

1. `GET /api/v1/models` returns each model projection with identity, callable names, activation state, rollout, runtime, model reference, split state, context, VRAM budget, and tunables. <!-- @impl: packages/router-worker/src/router.ts::toApiModel --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-005 lists models as projections with callable names) -->
2. `POST /api/v1/models/{id}` updates a model's runtime-specific context window, model reference, VRAM budget, and/or tunables; MeshLLM accepts context `0` (Auto), direct llama.cpp requires context `>= 4096`, and invalid runtime/tunable values or unknown model ids are rejected. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelConfigure --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-005 configures a model context window and rejects invalid input) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-005 configures direct llama.cpp settings over the automation API) -->
3. `POST /api/v1/models/{id}/enable` switches a model on and switches off any other model that answers to the same callable name. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelEnable --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-005 enables a model and switches off another with the same callable name) -->
4. `POST /api/v1/models/{id}/disable` drops a model's traffic to zero. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelDisable --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-005 disables a model by dropping its traffic to zero) -->
5. The model endpoints refuse a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::requireAutomation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-010 refuses model and version endpoints without an automation key) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-RUN-002](runtime-profiles.md#req-run-002-default-model-profiles), [REQ-RUN-004](runtime-profiles.md#req-run-004-profile-rollout)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-010: Programmatic version and Gateway management

**Intent:** Fleet managers must select node-agent/runtime versions and run Cloudflare AI Gateway sync programmatically without diverging from console validation.

**Applies To:** Automation

**Acceptance Criteria:**

1. `GET /api/v1/agent-versions` lists the available node-agent versions to an automation caller. <!-- @impl: packages/router-worker/src/router.ts::handleApiAgentVersions --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-010 lists available agent versions to an automation caller) -->
2. `PUT /api/v1/agent-version` sets the desired node-agent version and rejects a tag that is still absent after release-list refresh. <!-- @impl: packages/router-worker/src/router.ts::handleApiAgentVersionSet --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-010 sets the fleet agent version and rejects an unknown version) --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-ADM-008 accepts a newly published agent version after refreshing the release list) -->
3. `GET /api/v1/runtime-versions` lists available MeshLLM and llama.cpp runtime versions with current desired selections. <!-- @impl: packages/router-worker/src/router.ts::handleApiRuntimeVersions --> <!-- @test: packages/router-worker/src/runtime-versions.test.ts (REQ-API-010 lets automation list and select runtime versions) -->
4. `PUT /api/v1/runtime-versions` sets both desired runtime versions through the same validation core as the console. <!-- @impl: packages/router-worker/src/router.ts::handleApiRuntimeVersionSet --> <!-- @test: packages/router-worker/src/runtime-versions.test.ts (REQ-API-010 lets automation list and select runtime versions) -->
5. `POST /api/v1/gateway/sync` runs the same Gateway sync/provider-token rotation as the console and reveals the new provider token once. <!-- @impl: packages/router-worker/src/router.ts::handleApiGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-010 syncs the Gateway over the automation API and returns the provider token once) -->
6. The version and Gateway endpoints refuse a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::requireAutomation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-010 refuses model and version endpoints without an automation key) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P1

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-ADM-008](setup-admin.md#req-adm-008-agent-version-management), [REQ-ADM-033](setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility), [REQ-GWY-003](gateway.md#req-gwy-003-dynamic-route-automation)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-006: Operational events polling

**Intent:** Fleet managers must poll the mesh's operational events programmatically to feed monitoring and alerting, advancing through the log by cursor and narrowing by type, without the internal per-heartbeat bookkeeping that would drown the signal.

**Applies To:** Automation

**Acceptance Criteria:**

1. `GET /api/v1/events` returns operational audit events oldest-first and excludes internal per-heartbeat bookkeeping (mesh state stored/cleared, mesh token rotated/removed). <!-- @impl: packages/router-worker/src/store.ts::OPERATIONAL_EVENT_CHURN_TYPES --> <!-- @impl: packages/router-worker/src/router.ts::handleApiEvents --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-006 lists operational events oldest-first and hides internal bookkeeping) -->
2. `GET /api/v1/events?since={ms}` returns only events recorded strictly after the given timestamp. <!-- @impl: packages/router-worker/src/router.ts::handleApiEvents --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-006 returns only events after the since timestamp) -->
3. `GET /api/v1/events?type={t}` returns only events of the requested comma-separated type(s). <!-- @impl: packages/router-worker/src/router.ts::handleApiEvents --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-006 filters events by type) -->
4. `GET /api/v1/events?limit={n}` caps the page and returns a `nextCursor` (the opaque `"<at>:<id>"` keyset cursor of the last event) when the page is full, or `null` when the log is drained. <!-- @impl: packages/router-worker/src/router.ts::handleApiEvents --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-006 paginates events by cursor) -->
5. The events endpoint refuses a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::handleApiEvents --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-006 refuses events access without an automation key) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-OBS-006](observability.md#req-obs-006-audit-history)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-007: Programmatic model onboarding

**Intent:** Fleet managers must add a model to the catalog programmatically, wrapping the same profile-construction lever the console uses, so automation can onboard a model without an Access session or a Worker redeploy and the API and console never diverge.

**Applies To:** Automation

**Acceptance Criteria:**

1. `POST /api/v1/models` with a non-empty model reference, serving mode `single`, and runtime `meshllm` creates a new inactive MeshLLM model carrying the stable `codeflare-mesh` callable name and returns its machine projection. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelAdd --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 adds a single-machine model as an inactive projection) -->
2. Serving mode `split` creates the model with MeshLLM split serving enabled. <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 adds a split model with split serving enabled) -->
3. A missing or blank model reference is rejected with status 400 and creates no model. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 rejects a blank model reference) -->
4. A reference whose derived id already exists is rejected with status 409 without overwriting the existing model. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 refuses a duplicate model without overwriting) -->
5. Creating a model refuses a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 refuses model creation without an automation key) -->
6. `POST /api/v1/models` with runtime `llamacpp` and serving mode `single` creates an inactive direct profile with llama.cpp settings; runtime `llamacpp` plus serving mode `split` is rejected. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelAdd --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 adds a direct llama.cpp single model as an inactive projection) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-007 rejects direct llama.cpp split model onboarding) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-API-005](#req-api-005-programmatic-model-management), [REQ-RUN-011](runtime-profiles.md#req-run-011-custom-model-onboarding)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-008: Programmatic model deletion

**Intent:** Fleet managers must remove a custom model programmatically, wrapping the same deletion rules the console uses, so automation can prune onboarded models without an Access session and the API and console never diverge.

**Applies To:** Automation

**Acceptance Criteria:**

1. `DELETE /api/v1/models/{id}` with an automation key removes a custom, switched-off model and returns `{ ok, id }`. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelDelete --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 deletes a custom inactive model over the API) -->
2. Deleting the active model is rejected with status 409 without removing it. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 refuses deleting the active model) -->
3. Deleting a built-in model is rejected with status 409 without removing it. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 refuses deleting a built-in model) -->
4. Deleting an unknown model returns status 404. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelDelete --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 returns 404 deleting an unknown model) -->
5. Deleting a model refuses a request that carries no valid automation key. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelDelete --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 refuses model deletion without an automation key) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-API-007](#req-api-007-programmatic-model-onboarding), [REQ-RUN-012](runtime-profiles.md#req-run-012-model-removal)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-API-009: Programmatic speed test

**Intent:** Automation can measure direct inference-router throughput without Cloudflare Access or AI Gateway, so fleet tooling can compare prompt ingestion and generation speed for the selected model on the Worker → node-agent → runtime path.

**Applies To:** Automation

**Acceptance Criteria:**

1. `POST /api/v1/speed-test` requires an automation key, rejects unauthenticated callers, and accepts an optional callable model plus bounded prompt and generation sizes; the synthetic prompt carries a per-request prefix nonce so raw ingestion is not hidden by prompt-cache reuse. <!-- @impl: packages/router-worker/src/router.ts::handleApiSpeedTest --> <!-- @impl: packages/router-worker/src/router.ts::runSpeedTest --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-009 exposes the direct router speed test to automation callers) -->
2. The response reports prompt-token ingestion timing and generation timing separately, preferring llama.cpp upstream timing fields when present and marking token-count fields estimated only when the upstream stream lacks usage/timing metadata. <!-- @impl: packages/router-worker/src/router.ts::measureSpeedStream --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-034 playground speed test measures direct router token ingestion and generation) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-009 exposes the direct router speed test to automation callers) -->
3. A successful run stores one latest Speed Test summary that includes the split throughput values and is returned by `GET /api/v1/status`. <!-- @impl: packages/router-worker/src/router.ts::runSpeedTest --> <!-- @impl: packages/router-worker/src/router.ts::speedTestSummary --> <!-- @impl: packages/router-worker/src/router.ts::handleApiStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-009 exposes the direct router speed test to automation callers) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P2

**Dependencies:** [REQ-API-002](#req-api-002-control-plane-access-and-status), [REQ-ADM-034](setup-admin.md#req-adm-034-direct-router-speed-test)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
