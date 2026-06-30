# Security

This domain covers credential separation, route-level auth, header filtering, token storage, and runtime secret boundaries.

---

### REQ-SEC-001: Credential boundaries

**Intent:** Each trust boundary must use its own credential class so a compromised node, copied installer, or leaked provider key cannot impersonate another role.

**Applies To:** Admin

**Acceptance Criteria:**

1. Client-to-Gateway, Gateway-to-Worker, setup, node-to-Worker, Worker-to-node, admin, deploy, and runtime Cloudflare credentials are separate classes.
2. Provider tokens cannot claim nodes or access admin routes.
3. Node tokens cannot call provider endpoints or admin routes.
4. Setup tokens cannot heartbeat, proxy inference, or access admin routes after claim.
5. Upstream tokens are accepted only by node-agent Mesh-facing inference routes.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Planned

---

### REQ-SEC-002: Secret storage and rotation readiness

**Intent:** Durable storage must avoid plaintext secrets while still allowing operators to rotate compromised credentials.

**Applies To:** Admin

**Acceptance Criteria:**

1. Setup, provider, admin, node, and upstream tokens are generated with enough entropy for bearer-token use.
2. Durable storage stores token hashes or encrypted values, never plaintext by default.
3. Token verification uses constant-time comparison for hash matches.
4. Admin can revoke a node token and remove the node from eligible scheduling.
5. Credential rotation creates a new verifier before disabling the old credential where the flow requires continuity.

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-SEC-001](#req-sec-001-credential-boundaries)

**Verification:** Automated test

**Status:** Planned

---

### REQ-SEC-003: Header filtering

**Intent:** The Worker and node agent must not forward credentials across the wrong trust boundary while proxying OpenAI-compatible requests.

**Applies To:** Client

**Acceptance Criteria:**

1. The Worker sends only the node upstream token and approved inference metadata to the selected node.
2. The Worker strips client authorization, Cloudflare API tokens, admin credentials, node credentials, and setup credentials before node forwarding.
3. The node agent strips upstream token headers before forwarding to the local runtime unless the runtime is explicitly configured to require them.
4. Observability logs record credential-bearing header names only when values are redacted.
5. Header filtering applies to streaming and non-streaming requests.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-CF-002](constraints.md#con-cf-002-worker-runtime-compatibility)

**Priority:** P0

**Dependencies:** [REQ-RTR-002](router-worker.md#req-rtr-002-chat-completion-forwarding), [REQ-NODE-003](node-agent.md#req-node-003-upstream-proxy)

**Verification:** Automated test

**Status:** Planned

---

### REQ-SEC-004: Runtime API exposure

**Intent:** Local runtimes are powerful processes on private machines, so the product must avoid exposing runtime admin surfaces beyond what inference requires.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The node agent proxies only the configured inference and health endpoints to the runtime.
2. Local runtime built-in tools, file access, and unauthenticated web UI features are disabled for managed profiles unless explicitly allowed by an Admin profile.
3. The Mesh-facing listener requires upstream token verification before any inference proxy call.
4. Local dashboard endpoints bind to localhost and do not accept Worker upstream tokens as dashboard auth.
5. Runtime process logs are redacted before display or heartbeat transmission when they contain credentials.

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-llamacpp-first-runtime), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-NODE-003](node-agent.md#req-node-003-upstream-proxy), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-llamacpp-runtime)

**Verification:** Automated test

**Status:** Planned

---
