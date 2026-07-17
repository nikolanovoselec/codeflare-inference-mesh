# State And Scheduling

This domain covers durable records, hot scheduler state, node eligibility, and scheduler miss behavior.

---

### REQ-SCH-001: Durable router state

**Intent:** Router configuration must survive Worker and Durable Object restarts. D1 is the durable source for setup state, resources, nodes, models, sessions, mesh state, agent-version selection, and audit records.

**Applies To:** Admin

**Acceptance Criteria:**

1. D1 stores setup state, admin token verifier, provider token verifier, the default public model alias, setup token verifiers, claim state, expiration, and claimed node identity. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) -->
2. D1 stores Cloudflare resource identifiers created or selected during setup, the agent and runtime release-tag caches, and the selected agent and runtime versions as router configuration records. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @impl: packages/router-worker/src/runtime-versions.ts::RUNTIME_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-SCH-001 persists the release-tag cache and desired agent version) --> <!-- @test: packages/router-worker/src/runtime-versions.test.ts (REQ-ADM-033 stores selected runtime versions and audits the operator action) -->
3. D1 stores the mesh registry and the starter-seeding marker as router configuration records. <!-- @impl: packages/router-worker/src/meshes.ts::MESHES_ANCHORS --> <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/meshes.test.ts (REQ-SCH-006 lists the implicit Default mesh first and persists created meshes) --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-002 ships only the starter profile and seeds it exactly once) -->
4. D1 stores node records, model profiles, public aliases, and audit events; node and model records carry the mesh membership field, and records stored before machine groups existed read back as members of the default mesh. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @impl: packages/router-worker/src/profiles.ts::normalizeModelProfile --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-016 coerces stored profiles and nodes without meshId to the default mesh) -->
5. D1 stores one mesh state record per MeshLLM profile under the `mesh_state:<profileId>` router configuration key as AES-GCM ciphertext, never as plaintext token material. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SCH-001 stores mesh state as AES-GCM ciphertext and round-trips it from D1) -->
6. Profile seeding is seed-once: the starter catalog is written only while the `default_profiles_seeded` marker is absent, existing rows are never refreshed or retired, and a deleted starter profile never re-seeds. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-002 ships only the starter profile and seeds it exactly once) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 seeds the starter exactly once and never resurrects or refreshes rows) -->
7. Router startup can rebuild scheduler hot state from D1 without requiring manual repair. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-002: Stateless entry-node forwarding

**Intent:** The router holds no live reservation or session-to-node mapping. It selects an eligible node for the requested public model and forwards the request; mesh-llm owns dispatch, per-node concurrency, and KV-aware cache-warm routing across the peered mesh through its AffinityRouter. Selection never mutates node state, so a client can never be wedged behind a leaked reservation.

**Applies To:** Client

**Acceptance Criteria:**

1. Node selection returns an eligible node for a routable public model and never reads or writes an in-flight reservation count or a session-to-node mapping. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode --> <!-- @test: packages/router-worker/src/scheduler.test.ts (REQ-SCH-002 selectEntryNode selects a node regardless of load and never wedges) -->
2. Selection applies no capacity or in-flight gate, so back-to-back requests against a busy node both resolve to that node. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode --> <!-- @test: packages/router-worker/src/scheduler.test.ts (REQ-SCH-002 selectEntryNode selects a node regardless of load and never wedges) -->
3. Among eligible nodes the router picks the least busy by node-reported active-request count. <!-- @impl: packages/router-worker/src/scheduler.ts::selectNode --> <!-- @test: packages/router-worker/src/scheduler.test.ts (REQ-SCH-002 selectNode picks the least-loaded ready node by active requests) -->
4. The request forwards to the selected node with the profile's upstream model and the node's response streams straight back. <!-- @impl: packages/router-worker/src/router.ts::runInference --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards the rewritten chat request to the selected node and streams the response) -->
5. A fresh scheduler over the same D1 reselects the persisted eligible node with no reservation state to rebuild. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-003: Node eligibility and scheduler miss responses

**Intent:** The router must select only nodes whose MeshLLM runtime can serve the requested model, so eligibility is a conjunction of lease freshness, runtime identity, API readiness, model routability, runtime state, profile assignment, operator activation, and connection safety. Per-node concurrency is mesh-llm's responsibility, so eligibility applies no capacity or failure-penalty gate.

**Applies To:** Client

**Acceptance Criteria:**

1. A node is eligible only while its lease is unexpired and status is online. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from selection) -->
2. A node is eligible only when its reported runtime is `meshllm`. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 excludes nodes whose runtime is not meshllm from scheduling) -->
3. A node is eligible only when its metrics report the MeshLLM inference API as ready. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 excludes nodes whose MeshLLM API is not ready from scheduling) -->
4. A node is eligible for a profile only when the profile's upstream model appears in the node's reported ready-model list. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 excludes nodes whose ready models omit the requested upstream model) -->
5. A node whose reported runtime state is not ready or running stays ineligible even when its ready-model list includes the requested model. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 keeps standby nodes unschedulable even when ready models list the requested model) -->
6. A node is ineligible when the requested profile is not among its active profiles or the profile's public aliases do not intersect the node's advertised models. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from selection) -->
7. A node is ineligible when its Mesh connection data fails validation; per-node concurrency and failure back-off are mesh-llm's responsibility, so the router applies no capacity or failure-penalty gate. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from selection) -->

8. A node is eligible for a profile only when both belong to the same mesh, for direct llama.cpp selection as well, whatever profile ids the node self-reports. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @impl: packages/router-worker/src/scheduler.ts::isDirectEligible --> <!-- @test: packages/router-worker/src/scheduler.test.ts (REQ-SCH-003 rejects nodes outside the profile mesh even when they self-report the profile id) -->

**Constraints:** [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation)

**Priority:** P0

**Dependencies:** [REQ-SCH-002](#req-sch-002-stateless-entry-node-forwarding), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-004: Direct session affinity

**Intent:** Direct llama.cpp profiles need cache-local routing for coding sessions without reintroducing live reservations to the MeshLLM path. A direct request identifies its operator/session through the OpenAI-compatible `body.user` field, metadata that reaches the router, or a provider-scoped fallback for AI Gateway dynamic-route calls whose log metadata is not forwarded. The router stores only HMAC-derived keys, and a Durable Object coordinates a reusable node pin with D1 fallback so repeated direct prompts stay on the same node until that node stops being eligible.

**Applies To:** Client

**Acceptance Criteria:**

1. Direct llama.cpp chat requests use `body.user` in the exact grammar `user:<id>|session:<id>` when present, else metadata with a `user` value when that metadata reaches the router, else a provider-scoped fallback session for authenticated provider-token calls. <!-- @impl: packages/router-worker/src/router.ts::parseDirectSession --> <!-- @impl: packages/router-worker/src/router.ts::gatewayMetadataDirectSession --> <!-- @impl: packages/router-worker/src/router.ts::providerDefaultDirectSession --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 uses a provider-scoped fallback session when Gateway metadata is not forwarded) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 derives direct llama.cpp session affinity from AI Gateway metadata) -->
2. The router hashes the user and session ids with HMAC-SHA-256 using `SESSION_AFFINITY_KEY` (or local/test fallback) and never stores raw user or session ids. <!-- @impl: packages/router-worker/src/router.ts::directAffinitySecret --> <!-- @impl: packages/router-worker/src/router.ts::hmacHex --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 reuses the pinned direct node and stores only hashed affinity keys) -->
3. Direct affinity pins a session to an eligible llama.cpp node and reuses that node on later requests while it remains eligible. <!-- @impl: packages/router-worker/src/direct-affinity.ts::decideDirectSession --> <!-- @impl: packages/router-worker/src/store.ts::putDirectSession --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 reuses the pinned direct node and stores only hashed affinity keys) -->
4. If the pinned node is offline, deactivated, or no longer eligible for the direct profile, the router fails over to another eligible llama.cpp node and updates the direct session record. <!-- @impl: packages/router-worker/src/direct-affinity.ts::decideDirectSession --> <!-- @impl: packages/router-worker/src/scheduler.ts::eligibleDirectNodes --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 fails over a direct session when the pinned node is no longer eligible) -->
5. Direct affinity state lives in the `direct_sessions` D1 table and the `SessionAffinityDO` Durable Object binding; MeshLLM scheduling continues to use stateless entry-node selection and never requires `body.user`. <!-- @impl: packages/router-worker/migrations/0003_direct_sessions.sql::direct_sessions --> <!-- @impl: packages/router-worker/src/durable.ts::SessionAffinityDO --> <!-- @impl: packages/router-worker/wrangler.toml::SESSION_AFFINITY --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards the rewritten chat request to the selected node and streams the response) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 direct llama.cpp heartbeats never receive mesh bootstrap or write mesh state) -->
6. The Admin playground direct target sends a stable `body.user` value for the browser session so manual prompts exercise the same affinity contract as API callers. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::playgroundSessionUser --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-029 REQ-RUN-013 direct playground sends a stable session user for affinity) -->
7. When forwarded metadata supplies `user` and optional `session`, the router derives direct affinity from it; otherwise provider-authenticated calls use the provider fallback session. <!-- @impl: packages/router-worker/src/router.ts::directSessionBody --> <!-- @impl: packages/router-worker/src/router.ts::gatewayMetadataDirectSession --> <!-- @impl: packages/router-worker/src/router.ts::providerDefaultDirectSession --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 derives direct llama.cpp session affinity from AI Gateway metadata) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 uses a provider-scoped fallback session when Gateway metadata is not forwarded) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](#req-sch-001-durable-router-state), [REQ-SCH-003](#req-sch-003-node-eligibility-and-scheduler-miss-responses), [REQ-RUN-011](runtime-profiles.md#req-run-011-custom-model-onboarding)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-005: Scheduler miss responses

**Intent:** Model-configuration misses, absence of a ready node, and node transport failures must each be distinguishable from a router fault: a missing profile returns 404, no ready node returns 503, an unreachable node returns 502, and advertised aliases never point at profiles that cannot resolve.

**Applies To:** Client

**Acceptance Criteria:**

1. The public model listing includes only aliases of active profiles. <!-- @impl: packages/router-worker/src/router.ts::handleModels --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 lists only active profile aliases in the public model listing) -->
2. The scheduler returns `no-profile` when no profile is configured for the requested public alias. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 returns no-profile when the public model has no configured profile) -->
3. The scheduler returns `no-node` when no node is eligible for the requested profile. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from selection) -->
4. The Worker translates `no-profile` into `404` with a request ID. <!-- @impl: packages/router-worker/src/router.ts::runInference --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 returns no-profile when the public model has no configured profile) -->
5. The Worker translates the absence of a ready node into `503 no_healthy_node` with a request ID. <!-- @impl: packages/router-worker/src/router.ts::runInference --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 returns 503 no_healthy_node when no eligible node is ready) -->
6. A Mesh transport failure reaching the selected node surfaces as `502 node_unreachable` with a request ID. <!-- @impl: packages/router-worker/src/router.ts::runInference --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-005 returns 502 node_unreachable when the mesh fetch throws) -->

**Constraints:** [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation)

**Priority:** P0

**Dependencies:** [REQ-SCH-003](#req-sch-003-node-eligibility-and-scheduler-miss-responses)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-006: Mesh registry and membership

**Intent:** Operators group machines into named meshes so different groups serve different models. The registry is durable router configuration, every node belongs to exactly one mesh, membership is router authority (a node's self-reported profile ids never cross meshes), and profile distribution is scoped so a node only ever receives its own mesh's models.

**Applies To:** Admin, Node Agent

**Acceptance Criteria:**

1. A mesh name is letters-only up to 32 characters, normalized to a capitalized display name and a lowercase id; anything else is rejected. <!-- @impl: packages/router-worker/src/meshes.ts::validateMeshName --> <!-- @test: packages/router-worker/src/meshes.test.ts (REQ-SCH-006 validates and normalizes mesh names) -->

2. The default mesh always exists first in the registry, is never stored, and cannot be deleted; operator-created meshes persist in the `meshes` router configuration record and delete cleanly. <!-- @impl: packages/router-worker/src/meshes.ts::listMeshes --> <!-- @impl: packages/router-worker/src/meshes.ts::deleteMesh --> <!-- @test: packages/router-worker/src/meshes.test.ts (REQ-SCH-006 lists the implicit Default mesh first and persists created meshes) -->

3. Claim and heartbeat responses carry only the profiles of the node's own mesh, and a newly claimed node joins the default mesh. <!-- @impl: packages/router-worker/src/router.ts::meshProfilesFor --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-006 heartbeat and claim send only the node mesh profiles) -->

4. A heartbeat from a node still self-reporting a foreign mesh's profile ids receives no mesh bootstrap for that mesh and cannot re-add its invite token to that mesh's state. <!-- @impl: packages/router-worker/src/router.ts::selectedMeshProfile --> <!-- @impl: packages/router-worker/src/mesh-state.ts::selectedMeshProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-023 reassigning a node drops its mesh tokens and heartbeats do not re-add them) -->

5. Seed election and mesh health consider only nodes in the profile's own mesh. <!-- @impl: packages/router-worker/src/mesh-state.ts::isSeedEligible --> <!-- @impl: packages/router-worker/src/mesh-state.ts::nodeParticipatesInProfile --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SCH-006 seed election and mesh health ignore foreign-mesh nodes) -->

6. Profile readiness counts only nodes in the profile's own mesh. <!-- @impl: packages/router-worker/src/router.ts::profileReadiness --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-006 profile readiness counts only same-mesh nodes) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](#req-sch-001-durable-router-state), [REQ-SCH-003](#req-sch-003-node-eligibility-and-scheduler-miss-responses)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/observability.md](../../documentation/lanes/observability.md)
- [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md)
