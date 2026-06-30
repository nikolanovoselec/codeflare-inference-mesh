# Router Worker

This domain covers the public Worker that receives provider calls, protects route families, rewrites requests, and forwards inference traffic through Workers VPC.

---

### REQ-RTR-001: Route family separation

**Intent:** The Worker must apply the right authentication policy to each route family. Provider credentials must not block setup, node, installer, or admin routes that use different credentials.

**Applies To:** Client

**Acceptance Criteria:**

1. Health and installer routes are evaluated before provider authentication.
2. Node claim and heartbeat routes use node/setup credentials rather than provider credentials.
3. Admin routes use admin session or admin token credentials rather than provider credentials.
4. Provider authentication applies only to `/v1/models` and `/v1/chat/completions`.
5. Unknown routes return a not-found response after all known route families are checked.

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-GWY-002](gateway.md#req-gwy-002-provider-token-contract)

**Verification:** Automated test

**Status:** Planned

---

### REQ-RTR-002: Chat completion forwarding

**Intent:** The Worker must accept OpenAI-compatible chat requests, choose a node, rewrite the public model alias, and forward the request to the selected node through the private Mesh path.

**Applies To:** Client

**Acceptance Criteria:**

1. The Worker validates that the chat request body is JSON and within the configured maximum size.
2. The Worker maps the inbound `model` value to the active model profile before reserving a node.
3. The Worker asks the Durable Object scheduler for a reservation before forwarding the request.
4. The forwarded request replaces the public alias with the selected node's upstream runtime model name.
5. The forwarded request is sent with `env.MESH.fetch` to the selected Mesh IP and port.
6. The Worker releases the reservation when the response body finishes, fails, or is absent.

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P0

**Dependencies:** [REQ-RTR-001](#req-rtr-001-route-family-separation), [REQ-SCH-002](state-scheduling.md#req-sch-002-node-reservations), [REQ-RUN-001](runtime-profiles.md#req-run-001-public-model-aliases)

**Verification:** Automated test

**Status:** Planned

---

### REQ-RTR-003: Streaming pass-through

**Intent:** Streaming responses must preserve OpenAI-compatible Server-Sent Events so coding agents can receive tokens as soon as the local runtime emits them.

**Applies To:** Client

**Acceptance Criteria:**

1. When the upstream node returns a stream, the Worker returns the same response body stream to AI Gateway.
2. The Worker does not buffer a full streaming response before returning it.
3. Stream completion releases the scheduler reservation exactly once.
4. Stream failure releases the scheduler reservation and records the node failure signal.
5. The Worker does not retry after upstream generation has started.

**Constraints:** [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P0

**Dependencies:** [REQ-RTR-002](#req-rtr-002-chat-completion-forwarding)

**Verification:** Automated test

**Status:** Planned

---

### REQ-RTR-004: Mesh destination safety

**Intent:** Nodes must be reachable by private Mesh address without letting a compromised node register arbitrary URLs or force the Worker to fetch public endpoints.

**Applies To:** Admin

**Acceptance Criteria:**

1. Node records store Mesh IP and port as separate fields.
2. The router accepts Mesh IPs only when they match configured private CIDR rules.
3. The router accepts node ports only when they match the allowed port set.
4. The Worker constructs target URLs itself from validated Mesh IP and port fields.
5. The Worker rejects node records that contain a full upstream URL.

**Constraints:** [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Planned

---
