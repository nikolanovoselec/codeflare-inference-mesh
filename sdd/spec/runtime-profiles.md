# Runtime Profiles

This domain covers stable aliases, concrete model profiles, profile rollout, managed MeshLLM runtime behavior, private mesh formation, and split serving.

---

### REQ-RUN-001: Stable public model

**Intent:** AI Gateway and clients target one stable public model id per mesh while the router changes which concrete local model actually serves behind it. Each mesh's stable id is the first public alias of every profile assigned to that mesh, and the per-mesh single-active invariant leaves exactly one owner, so switching a mesh's active model never changes the Gateway route or the public model name that mesh's clients call.

**Applies To:** Client

**Acceptance Criteria:**

1. The router exposes one stable public model id per mesh: `codeflare-mesh` for the default mesh and `codeflare-mesh-<mesh>` for every other mesh, carried as the leading alias by that mesh's profiles and pinned as that mesh's AI Gateway route and forwarded model. <!-- @impl: packages/router-worker/src/profiles.ts::STABLE_PUBLIC_MODEL = codeflare-mesh --> <!-- @impl: packages/router-worker/src/meshes.ts::meshAliasFor --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 exposes one stable public model constant carried as a shared alias by every profile) --> <!-- @test: packages/router-worker/src/meshes.test.ts (REQ-RUN-016 meshAliasFor pins default and derives per-mesh aliases) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 gateway sync pins route and model to codeflare-mesh regardless of request body) -->
2. The provider model-listing surface returns the stable public model id `codeflare-mesh`. <!-- @impl: packages/router-worker/src/router.ts::handleModels --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
3. A chat request for a mesh's stable id resolves to that mesh's single active serving model, because that mesh's profiles carry the alias and per-mesh single-active leaves exactly one owner. <!-- @impl: packages/router-worker/src/store.ts::getProfileByPublicModel --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 the stable public model codeflare-mesh resolves to whichever model is active) -->
4. The resolved request is rewritten to the active model's upstream model name before node forwarding. <!-- @impl: packages/router-worker/src/router.ts::handleChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards the rewritten chat request to the selected node and streams the response) -->
5. Switching which model is active in a mesh never changes that mesh's Gateway dynamic route name or stable public model id. <!-- @impl: packages/router-worker/src/profiles.ts::STABLE_PUBLIC_MODEL --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 the stable public model codeflare-mesh resolves to whichever model is active) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 gateway sync pins route and model to codeflare-mesh regardless of request body) -->
6. A request for `codeflare-mesh` while no model is active returns an OpenAI-style model-not-found error. <!-- @impl: packages/router-worker/src/router.ts::handleChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 a chat for codeflare-mesh with no active model returns model-not-found) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-GWY-001](gateway.md#req-gwy-001-gateway-custom-provider)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-002: Default model profiles

**Intent:** A fresh deployment needs one resolved starter model so install and Gateway validation never stall on model selection: a small active smoke-test profile verifies inference end-to-end on a cheap model before an admin onboards the target model. The starter is seeded exactly once and is an ordinary deletable profile afterwards, so the catalog belongs to the operator, not the ship image.

**Applies To:** Admin

**Acceptance Criteria:**

1. The shipped catalog is exactly one profile: `mesh-smoke-qwen25-1.5b`, active with display name `Qwen2.5 Coder 1.5B`, rollout percent `100`, aliases `codeflare-mesh`, `mesh-smoke`, and `smoke-test`, model ref `unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M`, split disabled, mesh bind port `4320`, and default-mesh membership. <!-- @impl: packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-002 ships only the starter profile and seeds it exactly once) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the smoke starter with contract values and leaves stored legacy rows intact) -->
2. The starter is seeded only while the seeding marker is absent; existing rows are never refreshed or retired, and a deleted starter never re-seeds. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-002 ships only the starter profile and seeds it exactly once) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 deletes the switched-off starter like any other model and it never re-seeds) -->
3. When an active non-default profile already owns a starter alias at first seed, the starter arrives inactive so the alias keeps a single active owner. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultActivation --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-002 first seed yields an inactive starter when an active custom already owns its alias) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 preserves active llama.cpp custom profiles during first seeding) -->
4. A profile definition enumerates a display name, public aliases, upstream model name, source mode `meshllm-ref`, context limit (`0` = Auto), runtime `meshllm` settings (model ref, split, mandatory bind port, optional max VRAM, and the runtime tunables), profile version, rollout percent, and active flag. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and meshllm contract values) -->
5. Each default profile's upstream model name is the verbatim `/v1/models` id MeshLLM reports for its model ref. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and meshllm contract values) -->
6. The MeshLLM runtime tunables: parallel lanes, KV cache types, prefill batch, micro-batch, flash attention, max output tokens, reasoning, forced tool-call emulation, staged transport (wire precision, prefill pacing, prefill chunk size), and prefix cache (enable, payload mode, max entries, shared-prefix tuning) — optional, Auto/native when omitted. <!-- @impl: packages/router-worker/src/profiles.ts::MESHLLM_TUNABLE_DEFAULTS --> <!-- @impl: packages/router-worker/src/profiles.ts::meshllmPayloadMode --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 a new model ships with input caching enabled and multi-lane by default) -->
7. A config update can clear a previously set tunable back to Auto. <!-- @impl: packages/router-worker/src/router.ts::resolveMeshllmTunables --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-RUN-001](#req-run-001-stable-public-model)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-009: Profile seeding and activation exclusivity

**Intent:** Seeding happens exactly once so the catalog belongs to the operator afterwards, and activation is single-active per mesh: each mesh serves at most one model at a time while other meshes' active models stay untouched, and no public alias ever has two active owners.

**Applies To:** Admin

**Acceptance Criteria:**

1. Seeding writes the starter only while the seeding marker is absent and never resurrects or refreshes stored rows afterwards. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 seeds the starter exactly once and never resurrects or refreshes rows) -->
2. A first seed against a store that already holds an active alias-owning profile leaves that profile the active owner. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultActivation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 preserves active llama.cpp custom profiles during first seeding) -->
3. `POST /admin/profiles/activate` activates the target profile and atomically deactivates the other active profiles in its mesh, so each mesh serves at most one model. <!-- @impl: packages/router-worker/src/store.ts::singleActiveActivation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 activation is single-active) -->
4. Activation also deactivates any alias-overlapping active profile in another mesh, so a public alias never has two active owners. <!-- @impl: packages/router-worker/src/store.ts::singleActiveActivation --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-016 activation deactivates only same-mesh and alias-overlapping actives) -->
5. Activating a model in one mesh leaves another mesh's alias-disjoint active model active. <!-- @impl: packages/router-worker/src/store.ts::singleActiveActivation --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-016 activation deactivates only same-mesh and alias-overlapping actives) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-003: Managed MeshLLM runtime

**Intent:** The node agent renders one deterministic `mesh-llm serve` command from the selected profile so nodes are prepared consistently. MeshLLM owns model acquisition and embeds its inference runtime, so the rendered argv passes model references verbatim and the agent never manages model files itself.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent renders `mesh-llm serve` as an exact argument list with `--model <model ref>`, `--split` only for split profiles, `--headless`, `--mesh-discovery-mode nostr`, `--disable-iroh-relays`, `--mesh-name codeflare-<profileId>-r<rotation>`, `--bind-ip <MeshIP>`, `--log-format json`, and one `--nostr-relay <url>` per operator-configured relay. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
2. The rendered argv sets `--bind-ip` to the node's Mesh IP, `--bind-port` to the profile's mandatory mesh bind port, and `--port`/`--console` to node-local agent config values (defaults `9337`/`3131`). <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
3. `--max-vram` is rendered only when the profile sets a VRAM cap, and `--llama-flavor` only from hardware detection or an agent config override. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
4. Rendered argv never contains `--publish`, `--listen-all`, `--auto`, or `--discover`. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererForbidsPublicDiscoveryFlags) -->
5. Profiles carry the single source mode `meshllm-ref`; the agent passes the model ref to MeshLLM verbatim and never downloads or checksums model files itself. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-014: MeshLLM runtime configuration and versioning

**Intent:** The agent must render optional MeshLLM configuration, install the selected MeshLLM binary version, and restart when saved launch inputs change.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. When a profile sets supported tunables, the agent writes a per-profile MeshLLM config file under the model-fit, throughput, and request-defaults tables, and the staged-transport table renders the explicit wire-precision/prefill-pacing/chunk-size tunables, unset values resolving to the WARP-optimized defaults on split profiles (`activation_wire_dtype = "q8"`, `prefill_chunking = "adaptive-ramp"`) — the stage lane rides the WARP overlay, never LAN. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMConfigTOML --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN014ContextLimitConfigRendering) --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN014SplitProfilesRenderWarpTransportDefaults) -->
2. Unset configuration values are omitted so MeshLLM auto-plans them; a single-node profile that sets nothing writes no config file, while a split profile always writes one carrying the staged-transport defaults, whose config-owned model entry replaces the `--model` argv flag. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMConfigTOML --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN014ContextLimitConfigRendering) -->
3. The MeshLLM binary version is selected from router-delivered runtime settings and installed by the agent before launch. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLMVersion --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQRUN014SelectedMeshLLMVersionDownloadsChecksumSidecar) -->
4. Changes to selected-profile launch inputs request a runtime restart even when the profile ID and version are unchanged. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyDesiredProfiles --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::profileKey --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN014DesiredProfileContentChangeRestartsRuntime) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN014ProfileContentChangeRestartsWithUpdatedRenderInput) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P1

**Dependencies:** [REQ-RUN-003](#req-run-003-managed-meshllm-runtime), [REQ-NODE-013](node-agent.md#req-node-013-runtime-binary-bootstrap)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-010: MeshLLM process lifecycle

**Intent:** The node agent supervises one managed `mesh-llm` process end to end: it applies desired profile state from heartbeats, launches only the provisioned binary, keeps the runtime environment controlled, and stops the process gracefully before escalating.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent can fetch desired model profile state from the heartbeat response. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyDesiredProfiles --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003HeartbeatDesiredProfilesUpdateConfig) -->
2. The runtime process inherits the agent service environment, always sets `MESH_LLM_NO_SELF_UPDATE=1`, and adds `MESH_FORCE_TOOL_EMULATION=1` when the profile forces tool-call emulation. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMEnv --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN010RuntimeEnvInheritsServiceEnvAndDisablesSelfUpdate) --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN010MeshLLMEnvAppendsNoSelfUpdate) -->
3. The agent stops the runtime with SIGTERM first and escalates to kill only after a grace period. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN010StopSendsSIGTERMBeforeKill) -->
4. The agent launches the `mesh-llm` binary provisioned per REQ-NODE-013; a missing or failed install surfaces as a dependency-missing error instead of a runtime start. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN010MissingBinaryReportsDependencyMissing) -->
5. When the selected profile changes, the agent preempts an in-flight download or start of a now-deselected profile and switches to the newly selected profile without requiring a manual restart. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::beginRuntimeProfileRestart --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010PreemptsDeselectedInflightDownload) -->

6. Each heartbeat reconciles the running manager's runtime kind against the selected profile's: two disagreeing managed kinds relaunch through the cross-runtime switch path until actual matches desired, while a runtime already loading or serving the selected profile is never restarted. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeKindMismatch --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::beginRuntimeProfileRestart --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010RuntimeKindMismatchSelfHealsEachHeartbeat) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010ReadyRuntimeForSelectedProfileIsNotRestarted) -->
7. A runtime stop/restart attempt is timeout-bounded, releases the restart latch, marks failure on timeout, and allows later heartbeat retry. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::finishProfileRestart --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::restartCtx --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010RestartLatchReleasedWhenRuntimeHangs) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P1

**Dependencies:** [REQ-RUN-003](#req-run-003-managed-meshllm-runtime), [REQ-NODE-002](node-agent.md#req-node-002-node-claim-and-heartbeat), [REQ-NODE-013](node-agent.md#req-node-013-runtime-binary-bootstrap)

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
5. Readiness-deadline failures retry on the next create directive, and stuck split states self-heal once unless serving/stage evidence is already present. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager.NeedsRestart --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::serviceLoop.meshWaitSelfHeal --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN005LoadingStateExtendsReadinessDeadline) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005WaitingForPeersSelfHealsWithOneRestart) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005ModelSizeUnknownSelfHealsOnlyWhenNotServing) -->
6. The agent drains and stops the runtime before shutdown, update, or profile switch. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runService --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN005RuntimeManagerUsesProcessLifetimeContext) -->
7. The agent reports runtime state, loaded model, active profile ID/version, mesh membership state, MeshLLM version, and dependency-missing errors on heartbeat/dashboard status. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeMetrics --> <!-- @impl: packages/node-agent/internal/agent/metrics.go::RuntimeMetricsWithError --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeMetricsMarksLaunchedProfileLoaded) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeMetricsMarksReadySelectedProfileLoaded) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeMetricsReportsActualLoadedProfile) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN005RuntimeRestartMarksPendingProfileNotReady) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

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
4. Nodes report ready profiles with profile ID, version, loaded model, and runtime state. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status and REQ-RUN-004 reports profile readiness in admin status) -->
5. The Admin can see which active profiles have ready, downloading, or failed nodes before changing rollout. <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-002 REQ-OBS-002 returns redacted machine-readable admin status and REQ-RUN-004 reports profile readiness in admin status) -->
6. Desired profile downloads and restarts do not hold the heartbeat config lock. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::heartbeatLoop --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN003HeartbeatDesiredProfilesUpdateConfig) -->
7. The previous profile remains available as a rollback target until the Admin removes it. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-004 updates profile rollout as versioned configuration) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P1

**Dependencies:** [REQ-RUN-001](#req-run-001-stable-public-model), [REQ-RUN-003](#req-run-003-managed-meshllm-runtime), [REQ-RUN-005](#req-run-005-runtime-readiness-and-status-reporting)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-006: Private mesh formation

**Intent:** Nodes serving the same MeshLLM profile must form one private mesh with no public discovery, relay, or STUN egress, over WARP unicast where multicast discovery cannot work. The agent acts only on router directives: it defers launch until told to create or join, reports its own invite token, and reforms the mesh when the router's directive changes.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. On `wait` the agent reports the runtime starting without launching `mesh-llm`; on `join` it renders one `--join <token>` argument per distributed token. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006WaitDefersLaunchAndJoinRendersTokens) -->
2. The agent includes its current invite token and mesh id, read from the console status, in every heartbeat request. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManagerAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQRUN006HeartbeatCarriesMeshTokenAndMeshId) --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006PollStatusCapturesTokenAndMeshID) -->
3. The agent drains and restarts when rotation, mesh id, late join-token, or create-vs-join directive changes require a fresh mesh process. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006RestartTriggersDrainAndRelaunch) --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006TokenlessStartupRestartsWhenJoinArrivesBeforeMeshID) -->
4. Rendered mesh transport always binds `--bind-ip` to the node's Mesh IP so peers dial each other over the WARP overlay, and `--disable-iroh-relays` removes any public relay/STUN fallback so iroh data stays private; `nostr` discovery carries rendezvous metadata only, never inference. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses) -->
5. The agent runs at most one `mesh-llm` process; when several active MeshLLM profiles apply to a node, the first active profile is selected. <!-- @impl: packages/node-agent/internal/agent/runtime.go::SelectedProfile --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006SingleProcessSelectsFirstActiveProfile) -->
6. Draining waits for local proxy and MeshLLM console in-flight counters until the drain timeout, then proceeds with operator-driven restarts. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::waitForDrain --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::restartRuntimeForSelectedProfile --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN006DrainWaitsForMeshLLMConsoleInflight) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010ProfileRestartContinuesAfterStaleDrainCounter) -->
7. The tracked mesh id mirrors only the current process and resets with invite token and readiness on each new launch. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006PollStatusClearsStaleMeshIDWhenConsoleReportsNone) --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006StartClearsStaleMeshIdentity) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

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
2. The elected seed's heartbeat response always carries mesh bootstrap action `create` with the current rotation counter, even after its own invite token lands; other nodes receive `wait` until live tokens exist, then `join` with the mesh id and every live join token. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 returns create to the seed and wait then join with live tokens to peers) -->
3. The router upserts changed invite-token and mesh-id values reported in heartbeat requests into the profile's token set. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 upserts reported invite tokens into the profile token set) -->
4. An elected seed that reports no invite token within four heartbeat intervals expires, clearing the whole rotation's mesh state (seed, mesh id, and tokens) before election reruns. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 clears a seed that reports no token within four heartbeat intervals and re-elects) --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 seed expiry clears the whole rotation including stale mesh id and foreign tokens) -->
5. Token entries are removed when their node is revoked or offline more than 24 hours; an empty token set with no live seed clears mesh state, preserves the rotation counter, and re-elects on the next heartbeat. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 prunes revoked and stale tokens and re-elects when the set empties) -->
6. A node is never handed its own invite token as a join target; it joins only on invite tokens reported by other nodes. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 re-elects a node holding only its own token instead of joining it to itself) -->
7. When a node's own token is the only entry left with no live seed, the router re-elects that node and drops the stale mesh id and token so it creates a fresh mesh. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @test: packages/router-worker/src/mesh-state.test.ts (REQ-RUN-008 re-elects a node holding only its own token instead of joining it to itself) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

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
2. The agent derives mesh role `coordinator` when the node owns stage 0 in console status, `serving-peer` when it owns any other stage even if MeshLLM's raw node state is standby, else `serving-peer` or `api-client` from the node state. <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus --> <!-- @test: packages/node-agent/internal/agent/meshllm_status_test.go (TestREQRUN007DerivesCoordinatorFromStageZeroOwnership) -->
3. A split profile reports loaded only when the full model id appears in the node's `/v1/models`, which MeshLLM populates only after every stage is ready. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN007SplitReadinessGatedOnFullModelId) -->
4. A profile version bump on an active split profile drains and restarts every serving node, interrupting the whole mesh until all stages reload; split rollout is a mesh-wide outage, not a rolling update. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN007VersionBumpRestartsEverySplitServingNode) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P1

**Dependencies:** [REQ-RUN-002](#req-run-002-default-model-profiles), [REQ-RUN-005](#req-run-005-runtime-readiness-and-status-reporting), [REQ-RUN-006](#req-run-006-private-mesh-formation)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-011: Custom model onboarding

**Intent:** Operators must be able to add a model beyond the seeded profiles by supplying a model reference, serving mode, and runtime. MeshLLM models can be single-node or split; llama.cpp models are direct single-node profiles for cache-local coding sessions. The router creates a new inactive profile that joins the model catalog and becomes available for rollout and activation without redeploying the Worker.

**Applies To:** Admin

**Acceptance Criteria:**

1. `POST /admin/profiles/add` with a non-empty model reference and serving mode `single` creates a new profile carrying the `codeflare-mesh` shared alias with `split` false, `active` false, and `rolloutPercent` zero. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 adds a single-machine model as an inactive profile carrying the stable alias) -->

2. Serving mode `split` creates the profile with `split` true and is otherwise the same inactive shape. <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 adds a split model as a profile with split enabled) -->

3. The new profile identifier is derived from the model reference and mode and must be unique; a reference that would collide with an existing profile is rejected without overwriting it. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 derives a unique profile id and refuses a duplicate model) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 single and split of the same model create distinct profiles) -->

4. A missing or blank model reference is rejected with status 400 and creates no profile. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 rejects a blank model reference) -->

5. An added profile serves only after the existing activation path makes it active, which deactivates any previously active profile so the single-active invariant holds. <!-- @impl: packages/router-worker/src/store.ts::singleActiveActivation --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 activating an added model deactivates the previously active profile) -->

6. Adding a model requires admin authentication. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 requires admin authentication to add a model) -->

7. A successful add records a profile-added audit event. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-011 records a profile-added audit event on a successful add) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-RUN-001](#req-run-001-stable-public-model), [REQ-RUN-002](#req-run-002-default-model-profiles), [REQ-RUN-007](#req-run-007-split-serving-via-layer-packages)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-013: Direct llama.cpp custom profiles

**Intent:** Operators must be able to add and tune direct llama.cpp profiles for single-node cache-local coding sessions while split serving remains MeshLLM-only.

**Applies To:** Admin

**Acceptance Criteria:**

1. `POST /admin/profiles/add` with runtime `llamacpp` and serving mode `single` creates an inactive direct profile with source mode `llamacpp-hf` and no MeshLLM split state. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-013 adds a direct llama.cpp single model as an inactive profile) -->

2. New direct profiles apply the proven direct default tunables — catalogued on the profile-config API reference — and profiles stored before the unified-KV field normalize to unified KV on. <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @impl: packages/router-worker/src/profiles.ts::normalizeModelProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-013 adds a direct llama.cpp single model as an inactive profile) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-021 configures direct llama.cpp settings through the admin profile config path) -->

3. Runtime `llamacpp` with serving mode `split` is rejected with status 400 and creates no direct profile. <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-013 rejects direct llama.cpp for split models) -->

4. The Admin UI model-add runtime selector posts the authenticated `runtime` field accepted by the Admin API, and split mode forces the selector back to `meshllm`. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::addModelCard --> <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->

5. A direct profile's Manage drawer exposes parallel slots (blank = Auto), a unified-KV toggle defaulting to on, GPU layers, KV cache, batch, micro-batch, flash attention, generation cap, prompt cache/reuse, and reasoning settings, and hides MeshLLM-only controls. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openModelDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-RUN-013 loads and saves direct llama.cpp runtime tunables from the model drawer) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-013 keeps direct llama.cpp UI controls backed by admin API payloads) -->

6. Saving direct profile settings posts through `POST /admin/profiles/config` with a `llamacpp` settings block whose parallel and context-window fields accept their Auto sentinels or documented fixed ranges. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @impl: packages/router-worker/src/router.ts::resolveLlamaCppSettings --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-RUN-013 loads and saves direct llama.cpp runtime tunables from the model drawer) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-021 configures direct llama.cpp settings through the admin profile config path) -->

7. Disabling unified KV together with Auto parallel is rejected with status 400. <!-- @impl: packages/router-worker/src/router.ts::resolveLlamaCppSettings --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-021 configures direct llama.cpp settings through the admin profile config path) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P2

**Dependencies:** [REQ-RUN-011](#req-run-011-custom-model-onboarding), [REQ-SCH-004](state-scheduling.md#req-sch-004-direct-session-affinity)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-015: Direct llama.cpp launch rendering

**Intent:** Direct llama.cpp profile settings saved by the control plane must become deterministic `llama-server` launch arguments on each node.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The node agent renders saved direct llama.cpp settings into `llama-server` launch arguments. <!-- @impl: packages/node-agent/internal/agent/llamacpp_manager.go::RenderLlamaCppArgs --> <!-- @test: packages/node-agent/internal/agent/llamacpp_manager_test.go (TestREQRUN015LlamaCppRenderArgsIncludesCacheAndAlias) -->

2. Rendered launch arguments enable unified KV (`--kv-unified`) unless the profile explicitly disables it (`--no-kv-unified`); Auto parallel passes through as `--parallel -1` and Auto context as `--ctx-size 0`, so llama-server plans slots itself and loads the model's native training context. <!-- @impl: packages/node-agent/internal/agent/llamacpp_manager.go::RenderLlamaCppArgs --> <!-- @test: packages/node-agent/internal/agent/llamacpp_manager_test.go (TestREQRUN015LlamaCppRenderArgsKVUnifiedAndAutoParallel) --> <!-- @test: packages/node-agent/internal/agent/llamacpp_manager_test.go (TestREQRUN015LlamaCppRenderArgsAutoContext) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P2

**Dependencies:** [REQ-RUN-013](#req-run-013-direct-llamacpp-custom-profiles), [REQ-SCH-004](state-scheduling.md#req-sch-004-direct-session-affinity)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-012: Model removal

**Intent:** Operators must be able to remove any model they no longer serve — including the seed-once starter — so the catalog does not accumulate abandoned entries, while the one model currently answering a mesh's stable route stays protected.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. Any switched-off model, including the starter, is permanently removed from the catalog and never re-seeds. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @impl: packages/router-worker/src/store.ts::deleteProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 deletes a custom inactive model over the API) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 deletes the switched-off starter like any other model and it never re-seeds) -->

2. Removing the active model is refused with status 409 so its mesh's stable route is never left without a target. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 refuses deleting the active model) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-026 refuses console deletion only while the model is active) -->

3. Removing an unknown model returns status 404 and changes nothing. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 returns 404 deleting an unknown model) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-RUN-011](#req-run-011-custom-model-onboarding), [REQ-RUN-001](#req-run-001-stable-public-model), [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-016: Per-mesh model assignment

**Intent:** Every model profile belongs to exactly one mesh (operator-named machine group), and that mesh's stable route name is the profile's leading public alias. Operators onboard a model directly into a mesh or move it later; a moved model arrives switched off in its new group so activation there is always an explicit decision. Serving the same model in two meshes is done by duplicating the profile and reassigning the copy ([REQ-RUN-017](#req-run-017-profile-duplication)).

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. Every model profile carries exactly one mesh membership; stored rows without a mesh field read back as members of the default mesh. <!-- @impl: packages/router-worker/src/profiles.ts::normalizeModelProfile --> <!-- @impl: packages/router-worker/src/profiles.ts::profileMeshId --> <!-- @test: packages/router-worker/src/store.test.ts (REQ-RUN-016 coerces stored profiles and nodes without meshId to the default mesh) -->

2. A profile's leading public alias is its mesh's stable route name: `codeflare-mesh` for the default mesh and `codeflare-mesh-<mesh>` otherwise. <!-- @impl: packages/router-worker/src/meshes.ts::meshAliasFor --> <!-- @impl: packages/router-worker/src/profiles.ts::buildCustomProfile --> <!-- @test: packages/router-worker/src/meshes.test.ts (REQ-RUN-016 meshAliasFor pins default and derives per-mesh aliases) -->

3. Model onboarding accepts an optional target mesh, defaulting to the default mesh; the created profile carries the target mesh's membership and alias, and an unknown mesh is rejected with status 400 creating nothing. <!-- @impl: packages/router-worker/src/router.ts::resolveOnboardingMesh --> <!-- @impl: packages/router-worker/src/router.ts::handleProfileAdd --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-016 onboarding accepts a target mesh and stamps its alias) -->

4. Reassigning a model through the profile-config path swaps its leading alias to the new mesh's route name, keeps its own call name, switches it off (`active` false, rollout `0`), and bumps its version. <!-- @impl: packages/router-worker/src/router.ts::resolveMeshReassignment --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-016 reassigning a model swaps its mesh alias and deactivates it) -->

5. A mesh reassignment records a `model_mesh_assigned` audit event, and an unknown mesh is rejected with status 400 changing nothing. <!-- @impl: packages/router-worker/src/router.ts::resolveMeshReassignment --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-016 mesh reassignment records the audit event and rejects an unknown mesh) -->

6. Call-name edits preserve the profile's mesh alias as the leading alias and reject any reserved stable route name (`codeflare-mesh` or any `codeflare-mesh-` prefix) with status 409. <!-- @impl: packages/router-worker/src/router.ts::resolveCallNameAliases --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-016 call-name edits preserve the mesh alias and reject reserved names) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P1

**Dependencies:** [REQ-SCH-006](state-scheduling.md#req-sch-006-mesh-registry-and-membership), [REQ-RUN-001](#req-run-001-stable-public-model), [REQ-RUN-011](#req-run-011-custom-model-onboarding)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-017: Profile duplication

**Intent:** Operators must be able to clone an existing model profile into an independent copy — identical model reference, runtime, and tunables — so a variant can be tuned or moved to another mesh without touching the profile currently serving. The copy is an ordinary profile afterwards: editable, reassignable, activatable, and deletable like any other.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. `POST /admin/profiles/duplicate` creates a switched-off copy in the source's mesh with the same model reference, runtime, context, and tunables; a `(copy)` display name and derived unique call name; and its own id, bind port, version, and rollout. <!-- @impl: packages/router-worker/src/router.ts::duplicateProfileCore --> <!-- @impl: packages/router-worker/src/profiles.ts::buildDuplicateProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-017 duplicates a profile as an inactive same-mesh copy with a derived call name) -->

2. Duplicating an unknown profile returns status 404; repeated duplicates of the same source coexist under successive derived names. <!-- @impl: packages/router-worker/src/profiles.ts::buildDuplicateProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-017 duplicates a profile as an inactive same-mesh copy with a derived call name) -->

3. The copy is edited independently through the ordinary profile-config path and the source keeps its own settings. <!-- @impl: packages/router-worker/src/router.ts::handleProfileConfig --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-017 duplicates a profile as an inactive same-mesh copy with a derived call name) -->

4. `POST /api/v1/models/{id}/duplicate` is the automation twin: automation-key authenticated, same duplication core, returning the created model projection. <!-- @impl: packages/router-worker/src/router.ts::handleApiModelDuplicate --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-017 the automation duplicate twin mirrors the console behavior) -->

5. The console model drawer offers Duplicate for any model — including the active one — posting through the admin endpoint and closing the drawer so the refreshed catalog shows the copy. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::openModelDrawer --> <!-- @test: packages/router-worker/src/admin-ui-dashboard.test.ts (REQ-RUN-017 model drawer duplicates a model through the duplicate endpoint) -->

6. A successful duplicate records a `model_duplicated` audit event targeting the copy and naming the source. <!-- @impl: packages/router-worker/src/router.ts::duplicateProfileCore --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-017 duplicates a profile as an inactive same-mesh copy with a derived call name) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-RUN-011](#req-run-011-custom-model-onboarding), [REQ-RUN-016](#req-run-016-per-mesh-model-assignment)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
