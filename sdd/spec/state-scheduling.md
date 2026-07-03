# State And Scheduling

This domain covers durable records, hot scheduler state, reservations, leases, session affinity, and scheduler miss behavior.

---

### REQ-SCH-001: Durable router state

**Intent:** Router configuration must survive Worker and Durable Object restarts. D1 is the durable source for setup state, resources, nodes, models, sessions, mesh state, agent-version selection, and audit records.

**Applies To:** Admin

**Acceptance Criteria:**

1. D1 stores setup state, admin token verifier, provider token verifier, the default public model alias, setup token verifiers, claim state, expiration, and claimed node identity. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 persists durable router state and reloads scheduler state from D1) -->
2. D1 stores Cloudflare resource identifiers created or selected during setup, the agent release-tag cache (`agent_versions_cache`), and the selected fleet agent version (`desired_agent_version`) as router configuration records. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 persists durable router state and reloads scheduler state from D1) --> <!-- @test: packages/router-worker/src/agent-versions.test.ts (REQ-SCH-001 persists the release-tag cache and desired agent version) -->
3. D1 stores node records, model profiles, public aliases, session mappings, reservation records, and audit events. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 persists durable router state and reloads scheduler state from D1) -->
4. D1 stores one mesh state record per MeshLLM profile under the `mesh_state:<profileId>` router configuration key as AES-GCM ciphertext, never as plaintext token material. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-SCH-001 stores mesh state as AES-GCM ciphertext and round-trips it from D1) -->
5. Profile seeding deactivates every stored profile row whose runtime is not `meshllm`, regardless of row version. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-001 deactivates non-meshllm profile rows during seeding) -->
6. Router startup can rebuild scheduler hot state from D1 without requiring manual repair. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-SCH-001 persists durable router state and reloads scheduler state from D1) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-002: Node reservations

**Intent:** The scheduler must serialize live reservation decisions so two Worker isolates do not overbook a single local GPU.

**Applies To:** Client

**Acceptance Criteria:**

1. The Durable Object is the only component that increments or decrements live in-flight reservation counts. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
2. A reservation is granted only when the selected node is eligible for the requested public model. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
3. A reservation records node ID, public model, internal profile, optional session ID, creation time, and expiration time. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
4. Reservation release decrements in-flight count at most once. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
5. Expired reservations are removed from live state before new scheduling decisions. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->

**Constraints:** [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-003: Node eligibility and scheduler miss responses

**Intent:** The router must schedule only nodes whose MeshLLM runtime can serve the requested model, so eligibility is a conjunction of lease freshness, runtime identity, API readiness, model routability, runtime state, profile assignment, and capacity, failure, and connection safety.

**Applies To:** Client

**Acceptance Criteria:**

1. A node is eligible only while its lease is unexpired and status is online. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from scheduling) -->
2. A node is eligible only when its reported runtime is `meshllm`. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 excludes nodes whose runtime is not meshllm from scheduling) -->
3. A node is eligible only when its metrics report the MeshLLM inference API as ready. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 excludes nodes whose MeshLLM API is not ready from scheduling) -->
4. A node is eligible for a profile only when the profile's upstream model appears in the node's reported ready-model list. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 excludes nodes whose ready models omit the requested upstream model) -->
5. A node whose reported runtime state is not ready or running stays ineligible even when its ready-model list includes the requested model. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 keeps standby nodes unschedulable even when ready models list the requested model) -->
6. A node is ineligible when the requested profile is not among its active profiles or the profile's public aliases do not intersect the node's advertised models. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from scheduling) -->
7. A node is ineligible while it is over capacity, under an active failure penalty, or its Mesh connection data fails validation. <!-- @impl: packages/router-worker/src/scheduler.ts::isEligible --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from scheduling) -->

**Constraints:** [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations), [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation)

**Priority:** P0

**Dependencies:** [REQ-SCH-002](#req-sch-002-node-reservations), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-005: Scheduler miss responses

**Intent:** Model-configuration misses and normal capacity exhaustion must be distinguishable from server failure: missing profiles return not-found, unavailable eligible capacity returns no-node instead of an internal error, and advertised aliases never point at profiles that cannot resolve.

**Applies To:** Client

**Acceptance Criteria:**

1. The public model listing includes only aliases of active profiles. <!-- @impl: packages/router-worker/src/router.ts::handleModels --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 lists only active profile aliases in the public model listing) -->
2. The scheduler returns `no-profile` when no profile is configured for the requested public alias. <!-- @impl: packages/router-worker/src/scheduler.ts::reserve --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 returns no-profile when the public model has no configured profile) -->
3. The scheduler returns `no-node` when no node is eligible for the requested profile. <!-- @impl: packages/router-worker/src/scheduler.ts::reserve --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-003 REQ-OBS-004 excludes expired unhealthy and unsafe nodes from scheduling) -->
4. The Worker translates `no-profile` into `404` with a request ID and scheduler reason. <!-- @impl: packages/router-worker/src/router.ts::handleChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 returns no-profile when the public model has no configured profile) -->
5. The Worker translates `no-node` into `429` with a request ID and scheduler reason. <!-- @impl: packages/router-worker/src/router.ts::handleChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-005 returns no-node when no eligible node has capacity) -->

**Constraints:** [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations), [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation)

**Priority:** P0

**Dependencies:** [REQ-SCH-003](#req-sch-003-node-eligibility-and-scheduler-miss-responses)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-004: Session affinity

**Intent:** Coding sessions should stay on the same node when practical so long-context prompts can reuse local runtime cache and avoid unnecessary prefill work.

**Applies To:** Client

**Acceptance Criteria:**

1. The scheduler extracts explicit session IDs before using metadata or weak fallback heuristics. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 preserves session affinity when the sticky node remains eligible) -->
2. A valid session mapping gives the mapped node a dominant scheduling bonus when that node remains eligible. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 preserves session affinity when the sticky node remains eligible) -->
3. An ineligible sticky node does not block routing to another eligible node. <!-- @impl: packages/router-worker/src/scheduler.ts::reserve --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 uses another eligible node when the sticky node is ineligible) -->
4. Session mappings expire after the configured inactivity window. <!-- @impl: packages/router-worker/src/scheduler.ts::reserve --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-SCH-004 ignores expired session mappings when choosing an eligible node) -->

**Constraints:** [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P1

**Dependencies:** [REQ-SCH-002](#req-sch-002-node-reservations)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference-admin.md](../../documentation/lanes/api-reference-admin.md)
- [documentation/lanes/observability.md](../../documentation/lanes/observability.md)
- [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md)
