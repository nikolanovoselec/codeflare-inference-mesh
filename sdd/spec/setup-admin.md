# Setup And Admin

This domain covers first-run setup, admin access, node setup tokens, Cloudflare resource setup, and install-script delivery.

---

### REQ-ADM-001: First-run setup

**Intent:** A freshly deployed router should become usable through its `workers.dev` URL before any custom domain or Cloudflare Access policy exists.

**Applies To:** Admin

**Acceptance Criteria:**

1. The setup UI is available on the Worker origin until setup is completed.
2. First-run setup requires the configured initial setup token.
3. Successful first-run setup stores setup-complete state in D1.
4. The setup flow creates and displays the provider token exactly once.
5. After setup completes, setup routes require admin authentication rather than the initial setup token.

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-SCH-001](state-scheduling.md#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Planned

---

### REQ-ADM-002: MVP admin auth

**Intent:** Admin UI access must be protected in the first implementation without requiring Cloudflare Access service-token wiring for Gateway or node traffic.

**Applies To:** Admin

**Acceptance Criteria:**

1. Admin routes accept a configured admin token or an admin session derived from it.
2. Admin token verification uses a stored verifier rather than plaintext token storage.
3. Cloudflare Access is documented as an optional hardening step after the custom domain exists.
4. Admin authentication is never accepted for provider `/v1/*` requests or node heartbeat identity.
5. Failed admin authentication does not reveal whether setup has completed.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup)

**Verification:** Automated test

**Status:** Planned

---

### REQ-ADM-003: Setup token lifecycle

**Intent:** Node enrollment must use short-lived single-use setup tokens so copied install commands cannot enroll unlimited machines.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Admin can create a setup token with expiration, optional node name, and allowed profile list.
2. The router stores only the setup token verifier and claim metadata in D1.
3. A setup token can be claimed at most once.
4. Expired, claimed, or invalid setup tokens are rejected.
5. Successful claim returns permanent node credentials and the initial desired profile state.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-ADM-002](#req-adm-002-mvp-admin-auth), [REQ-RUN-002](runtime-profiles.md#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Planned

---

### REQ-ADM-004: One-line installers

**Intent:** Node operators should enroll machines with one command that carries no permanent secret and works on the target operating system.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The Admin UI generates Linux/macOS and Windows install commands that pass only router URL, setup token, and optional node name.
2. `/install.sh` installs the matching Unix agent artifact and service wrapper.
3. `/install.ps1` installs the matching Windows agent artifact and service wrapper.
4. Install scripts verify downloaded artifact checksums before installation.
5. Install scripts do not embed provider, admin, node, upstream, deploy, or Cloudflare API credentials.

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P1

**Dependencies:** [REQ-ADM-003](#req-adm-003-setup-token-lifecycle), [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts)

**Verification:** Automated test

**Status:** Planned

---

### REQ-ADM-005: Optional custom domain

**Intent:** The router should work on `workers.dev` first and support a custom domain later without blocking the private Mesh proof path.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Admin can keep using the `workers.dev` origin after setup.
2. The Admin can select a zone and hostname for a Worker custom domain when runtime Cloudflare permissions allow it.
3. Custom domain setup failure leaves the existing Worker origin usable.
4. AI Gateway provider configuration can be updated to the custom domain after it is attached.
5. The setup UI records the selected custom domain and Cloudflare zone resource identifiers in D1.

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-ADM-001](#req-adm-001-first-run-setup), [REQ-GWY-001](gateway.md#req-gwy-001-gateway-custom-provider)

**Verification:** Automated test

**Status:** Planned

---
