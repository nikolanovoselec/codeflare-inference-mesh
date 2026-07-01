# Runtime Profiles

This domain covers stable aliases, concrete model profiles, profile rollout, and managed runtime behavior.

---

### REQ-RUN-001: Public model aliases

**Intent:** Clients and AI Gateway should use stable names while the router changes concrete local models behind those names. This keeps client configuration stable during model rollout and rollback.

**Applies To:** Client

**Acceptance Criteria:**

1. The router stores public model aliases with active profile and fallback profile lists. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
2. The provider model-listing surface returns public aliases rather than every node runtime model name. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
3. Chat requests using a public alias are rewritten to the selected profile's upstream model name before node forwarding. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
4. Changing an alias active profile does not require changing the AI Gateway dynamic route name. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
5. A missing public alias returns an OpenAI-style model-not-found error. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-GWY-001](gateway.md#req-gwy-001-gateway-custom-provider)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-002: Default model profiles

**Intent:** The first implementation needs resolved model defaults so implementation does not stall on model selection. Qwen is the primary coding profile, Gemma is the fallback benchmark profile, and a small smoke-test profile keeps CI and demos practical.

**Applies To:** Admin

**Acceptance Criteria:**

1. `mesh-default` initially targets `qwen36-27b-256k-3090` for serious coding-agent validation. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
2. `qwen36-27b-256k-3090` uses Qwen3.6 27B, context `262144`, and coding-oriented sampling defaults. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
3. `gemma4-26b-a4b-256k-3090` is configured as a fallback and benchmark candidate for the same public aliases. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
4. `small-smoke-test-32k` is available for fast validation when a full 27B profile is unavailable. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
5. Profile definitions include source specifier, upstream model name, context limit, concurrency, runtime args, and profile version. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-llamacpp-first-runtime), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-RUN-001](#req-run-001-public-model-aliases)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-003: Managed llama.cpp runtime

**Intent:** After the Mesh path works with a manually started runtime, the node agent should manage `llama-server` and model files so nodes can be prepared consistently.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent can fetch desired model profile state from the heartbeat response. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003LlamaRuntimeCommandAndChecksum) -->
2. The agent downloads model files into the configured model cache directory. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003LlamaRuntimeCommandAndChecksum) -->
3. The agent verifies model checksums when a profile pins a checksum. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003LlamaRuntimeCommandAndChecksum) -->
4. The agent starts `llama-server` with the profile's runtime args and upstream model alias. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003LlamaRuntimeCommandAndChecksum) -->
5. The agent drains and stops the runtime before shutdown, update, or profile switch. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003LlamaRuntimeCommandAndChecksum) -->
6. The agent reports runtime state and active profile version on heartbeat. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003LlamaRuntimeCommandAndChecksum) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-llamacpp-first-runtime), [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-004: Profile rollout

**Intent:** Model changes must be staged so nodes prepare a new profile before the public alias switches traffic to it.

**Applies To:** Admin

**Acceptance Criteria:**

1. Profile updates increment the profile version. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
2. Heartbeat responses can ask compatible nodes to prepare desired profiles before alias activation. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
3. Nodes report ready profiles with profile ID, version, and loaded state. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
4. The Admin can switch an alias only to a profile that at least one eligible node reports ready. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
5. The previous profile remains available as a rollback target until the Admin removes it. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P1

**Dependencies:** [REQ-RUN-001](#req-run-001-public-model-aliases), [REQ-RUN-003](#req-run-003-managed-llamacpp-runtime)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
