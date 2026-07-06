# State And Scheduling

This domain covers durable records, hot scheduler state, reservations, leases, session affinity, and scheduler miss behavior.

---

### REQ-SCH-001: Durable router state

**Intent:** Router configuration must survive Worker and Durable Object restarts. D1 is the durable source for setup state, resources, nodes, models, sessions, mesh state, agent-version selection, and audit records.

**Applies To:** Admin

**Acceptance Criteria:**

1. D1 stores setup state, admin token verifier, provider token verifier, the default public model alias, setup token verifiers, claim state, expiration, and claimed node identity. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) -->
2. D1 stores Cloudflare resource identifiers created or selected during setup, the agent release-tag cache (`agent_versions_cache`), and the selected fleet agent version (`desired_agent_version`) as router configuration records. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-SCH-001 persists the release-tag cache and desired agent version) -->
3. D1 stores node records, model profiles, public aliases, and audit events. (The legacy `sessions` and `reservations` tables remain as dead schema after the move to stateless forwarding; a later migration drops them.) <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) -->
4. D1 stores one mesh state record per MeshLLM profile under the `mesh_state:<profileId>` router configuration key as AES-GCM ciphertext, never as plaintext token material. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SCH-001 stores mesh state as AES-GCM ciphertext and round-trips it from D1) -->
5. Profile seeding deactivates every stored profile row whose runtime is not `meshllm`, regardless of row version. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-001 deactivates non-meshllm profile rows during seeding) -->
6. Router startup can rebuild scheduler hot state from D1 without requiring manual repair. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 REQ-SCH-002 persists durable router state and reselects the eligible node from D1) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-002: Stateless entry-node forwarding

**Intent:** The router holds no live reservation state. It selects an eligible node for the requested public model and forwards the request; mesh-llm owns dispatch, per-node concurrency, and KV-aware routing across the peered mesh. Selection never mutates node state, so a client can never be wedged behind a leaked reservation.

**Applies To:** Client

**Acceptance Criteria:**

1. Node selection returns an eligible node for a routable public model and never reads or writes an in-flight reservation count. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode --> <!-- @test: packages/router-worker/src/scheduler.test.ts (REQ-SCH-002 selectEntryNode selects a node regardless of load and never wedges) -->
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

**Constraints:** [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation)

**Priority:** P0

**Dependencies:** [REQ-SCH-002](#req-sch-002-stateless-entry-node-forwarding), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

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

### REQ-SCH-004: Session affinity (superseded)

**Intent:** Session affinity was a router-side stickiness bonus that pinned a coding session to one node to reuse local KV cache. It is superseded by REQ-SCH-002: mesh-llm's AffinityRouter now owns KV-aware, prefix-hash, cache-warm routing across the peered mesh, so the router forwards statelessly and keeps no session-to-node mapping.

**Applies To:** Client

**Acceptance Criteria:**

1. The router keeps no session-to-node mapping; KV-aware, cache-warm routing is delegated to mesh-llm's AffinityRouter across the mesh. <!-- @impl: packages/router-worker/src/scheduler.ts::selectEntryNode -->

**Priority:** P1

**Dependencies:** [REQ-SCH-002](#req-sch-002-stateless-entry-node-forwarding)

**Verification:** Superseded

**Status:** Superseded

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/observability.md](../../documentation/lanes/observability.md)
- [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md)
