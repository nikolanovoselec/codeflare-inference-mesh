# State And Scheduling

This domain covers durable records, hot scheduler state, reservations, leases, session affinity, and busy behavior.

---

### REQ-SCH-001: Durable router state

**Intent:** Router configuration must survive Worker and Durable Object restarts. D1 is the durable source for setup state, resources, nodes, models, sessions, and audit records.

**Applies To:** Admin

**Acceptance Criteria:**

1. D1 stores setup state, admin token verifier, provider token verifier, and the default public model alias. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS -->
2. D1 stores Cloudflare resource identifiers created or selected during setup. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS -->
3. D1 stores setup token verifiers, claim state, expiration, and claimed node identity. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS -->
4. D1 stores node records, model profiles, public aliases, session mappings, reservation records, and audit events. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS -->
5. Router startup can rebuild scheduler hot state from D1 without requiring manual repair. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS -->

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

1. The Durable Object is the only component that increments or decrements live in-flight reservation counts. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
2. A reservation is granted only when the selected node is eligible for the requested public model. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
3. A reservation records node ID, public model, internal profile, optional session ID, creation time, and expiration time. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
4. Reservation release decrements in-flight count at most once. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
5. Expired reservations are removed from live state before new scheduling decisions. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->

**Constraints:** [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-003: Node eligibility and busy response

**Intent:** The router must distinguish normal capacity exhaustion from server failure. When no eligible node exists, clients receive a retryable busy response instead of an internal error.

**Applies To:** Client

**Acceptance Criteria:**

1. A node is eligible only while its lease is unexpired and status is ready. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
2. A node is ineligible when the requested profile is unsupported, unloaded, over capacity, under failure penalty, or has invalid Mesh connection data. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
3. The scheduler returns a busy result when no eligible node is available. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
4. The Worker translates busy results into a `429` response with a `Retry-After` header. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
5. Busy responses use an OpenAI-style error envelope with type `inference_mesh_busy`. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->

**Constraints:** [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations), [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation)

**Priority:** P0

**Dependencies:** [REQ-SCH-002](#req-sch-002-node-reservations), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SCH-004: Session affinity

**Intent:** Coding sessions should stay on the same node when practical so long-context prompts can reuse local runtime cache and avoid unnecessary prefill work.

**Applies To:** Client

**Acceptance Criteria:**

1. The scheduler extracts explicit session IDs before using metadata or weak fallback heuristics. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
2. A valid session mapping gives the mapped node a dominant scheduling bonus when that node remains eligible. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
3. A hot sticky session prefers a busy response over moving to another node when moving would violate the session policy. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
4. Session mappings expire after the configured inactivity window. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->
5. The Admin status surface reports active session-to-node mappings. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->

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
