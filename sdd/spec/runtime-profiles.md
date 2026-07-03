# Runtime Profiles

This domain covers stable aliases, concrete model profiles, profile rollout, managed MeshLLM runtime behavior, private mesh formation, and split serving.

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

**Intent:** The first implementation needs resolved model defaults so implementation does not stall on model selection. The defaults are MeshLLM private-mesh profiles: an active single-node Qwen3.6 35B A3B profile, an inactive split layer-package variant sharing the same aliases (UD-Q4_K_XL quantization, the published layer package), and a small smoke-test profile that keeps install and Gateway validation practical.

**Applies To:** Admin

**Acceptance Criteria:**

1. `mesh-default-qwen36-35b` ships active with rollout percent `100`, aliases `mesh-default`, `qwen3.6:35b-a3b`, and `qwen3.6-coder`, model ref `unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S`, split disabled, and mesh bind port `4300`. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the MeshLLM default profile set with contract values) -->
2. `mesh-split-qwen36-35b` ships inactive with the same alias set, layer-package model ref `hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@<pinned-rev>`, split enabled, and mesh bind port `4310`. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the MeshLLM default profile set with contract values) -->
3. `mesh-smoke-qwen25-1.5b` ships active with rollout percent `100`, aliases `mesh-smoke` and `smoke-test`, model ref `unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M`, split disabled, and mesh bind port `4320`. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the MeshLLM default profile set with contract values) -->
4. Profile definitions include public aliases, upstream model name, source mode `meshllm-ref`, context limit, runtime `meshllm`, MeshLLM settings (model ref, split flag, mandatory mesh bind port, optional max VRAM), profile version, rollout percent, and active flag. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and meshllm contract values) -->
5. Each default profile's upstream model name is the verbatim `/v1/models` id MeshLLM reports for its model ref. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and meshllm contract values) -->
**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-RUN-001](#req-run-001-public-model-aliases)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-009: Profile seeding and retirement

**Intent:** Deployed profile rows must converge to the shipped default definitions on every deploy: changed defaults refresh in place, stale alias owners retire, non-MeshLLM rows deactivate, and activation is alias-exclusive so no public alias ever has two active owners.

**Applies To:** Admin

**Acceptance Criteria:**

1. Default seeding refreshes an existing managed default row when the shipped profile definition changes. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 migrates changed default profile rows without keeping retired alias owners active) -->
2. Default seeding retires stale active managed defaults that still own a public alias now owned by a shipped default profile. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 migrates changed default profile rows without keeping retired alias owners active) -->
3. Default seeding deactivates every profile row whose runtime is not `meshllm`, regardless of profile version. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 deactivates non-meshllm profile rows regardless of version) -->
4. `POST /admin/profiles/activate` activates the target profile and atomically deactivates any active profile sharing one of its public aliases, so no alias has two active owners. <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 activation deactivates alias-overlapping active profiles) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-003: Managed MeshLLM runtime

**Intent:** The node agent renders one deterministic `mesh-llm serve` command from the selected profile so nodes are prepared consistently. MeshLLM owns model acquisition and embeds its inference runtime, so the rendered argv passes model references verbatim and the agent never manages model files itself.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent renders `mesh-llm serve` as an exact argument list with `--model <model ref>`, `--split` only for split profiles, `--headless`, `--mesh-discovery-mode mdns`, `--mesh-name codeflare-<profileId>-r<rotation>`, and `--log-format json`. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
2. The rendered argv sets `--bind-ip` to the node's Mesh IP, `--bind-port` to the profile's mandatory mesh bind port, and `--port`/`--console` to node-local agent config values (defaults `9337`/`3131`). <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
3. `--max-vram` is rendered only when the profile sets a VRAM cap, and `--llama-flavor` only from hardware detection or an agent config override. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
4. Rendered argv never contains `--publish`, `--listen-all`, `--auto`, `--discover`, or `--mesh-discovery-mode nostr`. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererForbidsPublicDiscoveryFlags) -->
5. Profiles carry the single source mode `meshllm-ref`; the agent passes the model ref to MeshLLM verbatim and never downloads or checksums model files itself. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
6. When a supported MeshLLM configuration key expresses the profile context limit, the agent renders a per-profile config file passed as `--config <data dir>/meshllm-<profileId>.toml`; otherwise the context limit is client-facing metadata only. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003ContextLimitConfigRendering) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-010: MeshLLM process lifecycle

**Intent:** The node agent supervises one managed `mesh-llm` process end to end: it applies desired profile state from heartbeats, launches only the provisioned binary, keeps the runtime environment controlled, and stops the process gracefully before escalating.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent can fetch desired model profile state from the heartbeat response. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyDesiredProfiles --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003HeartbeatDesiredProfilesUpdateConfig) -->
2. The runtime process inherits the agent service environment and always sets `MESH_LLM_NO_SELF_UPDATE=1`. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN010RuntimeEnvInheritsServiceEnvAndDisablesSelfUpdate) -->
3. The agent stops the runtime with SIGTERM first and escalates to kill only after a grace period. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN010StopSendsSIGTERMBeforeKill) -->
4. The agent launches the `mesh-llm` binary provisioned per REQ-NODE-006; a missing or failed install surfaces as a dependency-missing error instead of a runtime start. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN010MissingBinaryReportsDependencyMissing) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime)

**Priority:** P1

**Dependencies:** [REQ-RUN-003](#req-run-003-managed-meshllm-runtime), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-NODE-006](node-agent.md#req-node-006-meshllm-binary-install-and-update)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-005: Runtime readiness and status reporting

**Intent:** Managed runtimes should only look schedulable after MeshLLM is actually serving the requested model, and status surfaces must describe the live runtime state honestly.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent reports a managed profile loaded only when the MeshLLM console `/api/status` responds and the profile's upstream model name appears among the ids parsed from the node's own `/v1/models` response; a 2xx response without the parsed id is not ready. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN005ReadinessRequiresUpstreamModelInOwnModels) -->
2. While the console reports `node_state` `loading`, the readiness deadline extends instead of marking the runtime failed. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN005LoadingStateExtendsReadinessDeadline) -->
3. Dashboard start requests return after launch while readiness continues outside the request deadline. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline) -->
4. Child-process exit before readiness marks the runtime failed. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN005MeshLLMReadinessFailsWhenProcessExits) -->
5. The agent drains and stops the runtime before shutdown, update, or profile switch. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runService --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN005RuntimeManagerUsesProcessLifetimeContext) -->
6. The agent reports runtime state, loaded model, active profile ID/version, mesh membership state, MeshLLM version, and dependency-missing errors on heartbeat/dashboard status. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeMetrics --> <!-- @impl: packages/node-agent/internal/agent/metrics.go::RuntimeMetricsWithError --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeMetricsMarksLaunchedProfileLoaded) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeMetricsMarksReadySelectedProfileLoaded) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeMetricsReportsActualLoadedProfile) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeRestartMarksPendingProfileNotReady) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P1

**Dependencies:** [REQ-RUN-003](#req-run-003-managed-meshllm-runtime)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-004: Profile rollout

**Intent:** Model changes must be staged so nodes prepare a new MeshLLM mesh profile before the public alias switches traffic to it.

**Applies To:** Admin

**Acceptance Criteria:**

1. Profile updates increment the profile version. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
2. Claim responses can ask compatible nodes to prepare desired profiles before first runtime start. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyClaim --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003ClaimAppliesDesiredProfilesBeforeRuntimeStart) -->
3. Heartbeat responses can ask compatible nodes to prepare desired profiles before alias activation. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->
4. Nodes report ready profiles with profile ID, version, loaded model, and runtime state. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 reports profile readiness in admin status) -->
5. The Admin can see which active profiles have ready, downloading, or failed nodes before changing rollout. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 reports profile readiness in admin status) -->
6. Desired profile downloads and restarts do not hold the heartbeat config lock. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::heartbeatLoop --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003HeartbeatDesiredProfilesUpdateConfig) -->
7. The previous profile remains available as a rollback target until the Admin removes it. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P1

**Dependencies:** [REQ-RUN-001](#req-run-001-public-model-aliases), [REQ-RUN-003](#req-run-003-managed-meshllm-runtime), [REQ-RUN-005](#req-run-005-runtime-readiness-and-status-reporting)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-006: Private mesh formation

**Intent:** Nodes serving the same MeshLLM profile must form one private mesh with no public discovery, relay, or STUN egress, over WARP unicast where multicast discovery cannot work. The agent acts only on router directives: it defers launch until told to create or join, reports its own invite token, and reforms the mesh when the router's directive changes.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. On `wait` the agent reports the runtime starting without launching `mesh-llm`; on `join` it renders one `--join <token>` argument per distributed token. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006WaitDefersLaunchAndJoinRendersTokens) -->
2. The agent includes its current invite token and mesh id, read from the console status, in every heartbeat request. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManagerAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN006HeartbeatCarriesMeshTokenAndMeshId) --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006PollStatusCapturesTokenAndMeshID) -->
3. The agent drains and restarts the runtime when the response rotation differs from the running rotation, when the response mesh id differs from the running mesh id and join tokens are present, or when `create` arrives while a mesh is running. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006RestartTriggersDrainAndRelaunch) -->
4. Rendered mesh transport always binds `--bind-ip` to the node's Mesh IP so invite tokens embed dialable addresses; the `mdns` discovery mode only suppresses public relay, STUN, and Nostr egress and is never a formation mechanism. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses) -->
5. The agent runs at most one `mesh-llm` process; when several active MeshLLM profiles apply to a node, the first active profile is selected. <!-- @impl: packages/node-agent/internal/agent/runtime.go::SelectedProfile --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006SingleProcessSelectsFirstActiveProfile) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P1

**Dependencies:** [REQ-RUN-003](#req-run-003-managed-meshllm-runtime), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-RUN-008](#req-run-008-router-mesh-membership-authority)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-008: Router mesh membership authority

**Intent:** The router is the mesh membership authority: it elects the seed node, captures every node's invite token, and distributes the live token set so mesh membership always converges toward router state.

**Applies To:** Admin

**Acceptance Criteria:**

1. When an active MeshLLM profile has no recorded seed, the router records the first seed-eligible heartbeating node with a store-if-absent write serialized through the registry Durable Object; eligibility requires a fresh heartbeat, runtime `meshllm`, and an active profile, not API readiness. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 elects the first seed-eligible heartbeater with a store-if-absent write) -->
2. The elected seed's heartbeat response carries mesh bootstrap action `create` with the current rotation counter; other nodes receive `wait` until live tokens exist, then `join` with the mesh id and every live join token. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 returns create to the seed and wait then join with live tokens to peers) -->
3. The router upserts changed invite-token and mesh-id values reported in heartbeat requests into the profile's token set. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 upserts reported invite tokens into the profile token set) -->
4. An elected seed that reports no invite token within four heartbeat intervals is cleared and election reruns. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 clears a seed that reports no token within four heartbeat intervals and re-elects) -->
5. Token entries are removed when their node is revoked or offline more than 24 hours; an empty token set with no live seed clears mesh state, preserves the rotation counter, and re-elects on the next heartbeat. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 prunes revoked and stale tokens and re-elects when the set empties) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SCHED-001](constraints.md#con-sched-001-serialized-live-reservations)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-SEC-006](security.md#req-sec-006-mesh-token-lifecycle)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-007: Split serving via layer packages

**Intent:** Models larger than one node's VRAM are served across nodes through MeshLLM layer packages. MeshLLM owns layer placement and stage readiness; the router treats a split profile like any other profile and stays fail-closed until the whole pipeline is ready.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. Every serving node of a split profile renders `--model <layer-package ref>` and `--split`; joining nodes add `--join` tokens and never render a bare join without the model and split flags. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN007SplitProfilesRenderModelAndSplitOnEveryNode) -->
2. The agent derives mesh role `coordinator` when the node owns stage 0 in console status, else `serving-peer` or `api-client` from the node state. <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus --> <!-- @test: packages/node-agent/internal/agent/meshllm_status_test.go (TestREQRUN007DerivesCoordinatorFromStageZeroOwnership) -->
3. A split profile reports loaded only when the full model id appears in the node's `/v1/models`, which MeshLLM populates only after every stage is ready. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN007SplitReadinessGatedOnFullModelId) -->
4. A profile version bump on an active split profile drains and restarts every serving node, interrupting the whole mesh until all stages reload; split rollout is a mesh-wide outage, not a rolling update. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN007VersionBumpRestartsEverySplitServingNode) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P1

**Dependencies:** [REQ-RUN-002](#req-run-002-default-model-profiles), [REQ-RUN-005](#req-run-005-runtime-readiness-and-status-reporting), [REQ-RUN-006](#req-run-006-private-mesh-formation)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
