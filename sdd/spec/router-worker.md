# Router Worker

This domain covers the public Worker that receives provider calls, protects route families, rewrites requests, and forwards inference traffic through Workers VPC.

---

### REQ-RTR-001: Route family separation

**Intent:** The Worker must apply the right authentication policy to each route family. Provider credentials must not block setup, node, installer, or admin routes that use different credentials.

**Applies To:** Client

**Acceptance Criteria:**

1. Health, installer, and Admin UI shell routes are evaluated before provider authentication. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-006 serves a responsive browser admin UI for every admin-facing function) -->
2. Node claim, heartbeat, and unregister routes use setup or node credentials rather than provider credentials. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->
3. Authenticated admin action routes use admin session or admin token credentials rather than provider credentials. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->
4. Provider authentication applies only to provider model-listing and chat-completion route families. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->
5. Unknown routes return a not-found response after all known route families are checked. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-GWY-002](gateway.md#req-gwy-002-provider-token-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RTR-002: Chat completion forwarding

**Intent:** The Worker must accept OpenAI-compatible chat requests, choose a node, rewrite the public model alias, and forward the request to the selected node through the private Mesh path.

**Applies To:** Client

**Acceptance Criteria:**

1. The Worker validates that the chat request body is JSON and within the configured maximum size. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
2. The Worker maps the inbound `model` value to the active model profile before reserving a node. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
3. The Worker asks the Durable Object scheduler for a reservation before forwarding the request. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
4. The forwarded request replaces the public alias with the selected node's upstream runtime model name. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
5. The forwarded request is sent with Worker-to-Mesh transport to the selected Mesh IP and port. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->
6. The Worker releases the reservation when the response body finishes, fails, or is absent. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards rewritten chat requests through Mesh and releases reservations) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P0

**Dependencies:** [REQ-RTR-001](#req-rtr-001-route-family-separation), [REQ-SCH-002](state-scheduling.md#req-sch-002-node-reservations), [REQ-RUN-001](runtime-profiles.md#req-run-001-stable-public-model)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RTR-003: Streaming pass-through

**Intent:** Streaming responses must preserve OpenAI-compatible Server-Sent Events so coding agents can receive tokens as soon as the local runtime emits them.

**Applies To:** Client

**Acceptance Criteria:**

1. When the upstream node returns a stream, the Worker returns the same response body stream to AI Gateway. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-003 streams upstream bodies without buffering them first) -->
2. The Worker does not buffer a full streaming response before returning it. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-003 streams upstream bodies without buffering them first) -->
3. Stream completion releases the scheduler reservation exactly once. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-003 streams upstream bodies without buffering them first) -->
4. Stream failure releases the scheduler reservation. <!-- @impl: packages/router-worker/src/router.ts::releaseOnCompletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-003 releases and penalizes stream failures) -->
5. Stream failure records the node failure signal. <!-- @impl: packages/router-worker/src/scheduler.ts::recordFailure --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-003 releases and penalizes stream failures) -->
6. The Worker does not retry after upstream generation has started. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-003 streams upstream bodies without buffering them first) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P0

**Dependencies:** [REQ-RTR-002](#req-rtr-002-chat-completion-forwarding)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RTR-004: Mesh destination safety

**Intent:** Nodes must be reachable by private Mesh address without letting a compromised node register arbitrary URLs or force the Worker to fetch public endpoints.

**Applies To:** Admin

**Acceptance Criteria:**

1. Node records store Mesh IP and port as separate fields. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs) -->
2. The router accepts Mesh IPs only when they match configured private CIDR rules. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs) -->
3. The router accepts node ports only when they match the allowed port set. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs) -->
4. The Worker constructs target URLs itself from validated Mesh IP and port fields. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs) -->
5. The Worker rejects node records that contain a full upstream URL. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-004 accepts only private Mesh IP destinations and rejects full upstream URLs) -->

**Constraints:** [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RTR-005: Malformed request body handling

**Intent:** A client that sends a body that is not valid JSON is making a client error, so every endpoint that reads a JSON body must answer with a clear `400`, never an ambiguous `500`. The guard is a typed request-body parse error, so a server-side parse fault (a stored record or a decrypted payload) is never mistaken for client error and still surfaces as an audited `500`.

**Applies To:** Node Operator, Admin, Automation

**Acceptance Criteria:**

1. A request whose body fails to parse as JSON is rejected with `400` `invalid_json` on every endpoint that reads a JSON body — across the `/api/v1`, `/admin`, and `/node` surfaces. <!-- @impl: packages/router-worker/src/router.ts::createRouter --> <!-- @impl: packages/router-worker/src/errors.ts::InvalidJsonBodyError --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on an api endpoint) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on a node endpoint) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-005 rejects a malformed JSON body with 400 invalid_json on an admin endpoint) -->

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P2

**Dependencies:** [REQ-RTR-002](#req-rtr-002-chat-completion-forwarding)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/observability.md](../../documentation/lanes/observability.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
