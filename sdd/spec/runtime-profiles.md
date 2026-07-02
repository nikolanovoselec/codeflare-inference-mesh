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

**Intent:** The first implementation needs resolved model defaults so implementation does not stall on model selection. The production defaults are locally proven Qwen3.6 35B A3B profiles for RTX 3090-class nodes, and a small smoke-test profile keeps install and Gateway validation practical.

**Applies To:** Admin

**Acceptance Criteria:**

1. `mesh-default` initially targets `qwen36-35b-a3b-262k-mm-3090` for serious coding-agent validation. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
2. `qwen36-35b-a3b-262k-mm-3090` uses the locally proven Qwen3.6 35B A3B `llama-hf` profile, context `262144`, multimodal projector support, reasoning flags, and RTX 3090-oriented cache/batch flags. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and exact runtime flags) -->
3. `qwen36-35b-a3b-262k-text-3090` is available as an explicit text-only variant without the multimodal projector. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and exact runtime flags) -->
4. `small-smoke-test-32k` is available as a public direct-GGUF validation profile before large model downloads. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and exact runtime flags) -->
5. Profile definitions include source mode, source specifier or download URL, upstream model name, context limit, concurrency/runtime flags, profile version, and stable public aliases. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and exact runtime flags) -->
6. Default seeding refreshes an existing managed default row when the shipped profile definition changes. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 migrates changed default profile rows without keeping retired alias owners active) -->
7. Default seeding retires stale active managed defaults that still own a public alias now owned by a shipped default profile. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 migrates changed default profile rows without keeping retired alias owners active) -->

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

1. The agent can fetch desired model profile state from the heartbeat response. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyDesiredProfiles --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003HeartbeatDesiredProfilesUpdateConfig) -->
2. Direct-GGUF profiles download model files into the configured model cache directory, while `llama-hf` profiles delegate model resolution to `llama-server -hf`. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003SourceModesAndChecksum) -->
3. The agent verifies model checksums when a direct-GGUF profile pins a checksum. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003SourceModesAndChecksum) -->
4. The agent starts `llama-server` from the profile's `runtimeCommand`, preserving exact args/env except for safe local substitutions and enabling llama.cpp metrics where profiles need token-throughput reporting. <!-- @impl: packages/node-agent/internal/agent/runtime.go::LlamaCommand --> <!-- @impl: packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003RuntimeCommandUsesProfileTemplate) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and exact runtime flags) -->
5. The agent waits for the runtime readiness endpoint before reporting a managed profile as loaded, while dashboard start requests return after launch and child-process exit before readiness marks the runtime failed. <!-- @impl: packages/node-agent/internal/agent/runtime.go::waitForRuntimeReady --> <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeManager --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003RuntimeReadinessProbeWaitsForModelEndpoint) --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003RuntimeStartDoesNotUseDashboardRequestDeadline) --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003RuntimeReadinessFailsWhenProcessExits) -->
6. The agent drains and stops the runtime before shutdown, update, or profile switch. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runService --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003RuntimeManagerUsesProcessLifetimeContext) -->
7. The agent reports runtime state, loaded model, active profile ID/version, and dependency-missing errors on heartbeat/dashboard status. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeMetrics --> <!-- @impl: packages/node-agent/internal/agent/metrics.go::RuntimeMetricsWithError --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN003RuntimeMetricsMarksReadySelectedProfileLoaded) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN003RuntimeMetricsReportsActualLoadedProfile) -->

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
2. Claim and heartbeat responses can ask compatible nodes to prepare desired profiles before alias activation. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyClaim --> <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003ClaimAppliesDesiredProfilesBeforeRuntimeStart) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
3. Nodes report ready profiles with profile ID, version, loaded model, and runtime state. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 reports profile readiness in admin status) -->
4. The Admin can see which active profiles have ready, downloading, or failed nodes before changing rollout. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 reports profile readiness in admin status) -->
5. Desired profile downloads and restarts do not hold the heartbeat config lock. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::heartbeatLoop --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003HeartbeatDesiredProfilesUpdateConfig) -->
6. The previous profile remains available as a rollback target until the Admin removes it. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->

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
