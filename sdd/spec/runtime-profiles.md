# Runtime Profiles

This domain covers stable aliases, concrete model profiles, profile rollout, managed MeshLLM runtime behavior, private mesh formation, and split serving.

---

### REQ-RUN-001: Stable public model

**Intent:** AI Gateway and clients target one stable public model id while the router changes which concrete local model actually serves behind it. The stable id is a shared public alias carried by every model profile, and the single-active invariant leaves exactly one owner, so switching the active model never changes the Gateway route or the public model name clients call.

**Applies To:** Client

**Acceptance Criteria:**

1. The router exposes one stable public model id `codeflare-mesh`, carried as a shared alias by every model profile and pinned as the AI Gateway route and forwarded model. <!-- @impl: packages/router-worker/src/profiles.ts::STABLE_PUBLIC_MODEL = codeflare-mesh --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 exposes one stable public model constant carried as a shared alias by every profile) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 gateway sync pins route and model to codeflare-mesh regardless of request body) -->
2. The provider model-listing surface returns the stable public model id `codeflare-mesh`. <!-- @impl: packages/router-worker/src/router.ts::handleModels --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 REQ-RUN-002 exposes seeded public model aliases through the provider API) -->
3. A chat request for `codeflare-mesh` resolves to the single active serving model, because every profile carries `codeflare-mesh` and the single-active invariant leaves exactly one owner. <!-- @impl: packages/router-worker/src/store.ts::getProfileByPublicModel --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 the stable public model codeflare-mesh resolves to whichever model is active) -->
4. The resolved request is rewritten to the active model's upstream model name before node forwarding. <!-- @impl: packages/router-worker/src/router.ts::handleChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RTR-002 REQ-SCH-002 REQ-OBS-001 forwards the rewritten chat request to the selected node and streams the response) -->
5. Switching which model is active never changes the Gateway dynamic route name or the stable public model id. <!-- @impl: packages/router-worker/src/profiles.ts::STABLE_PUBLIC_MODEL --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 the stable public model codeflare-mesh resolves to whichever model is active) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 gateway sync pins route and model to codeflare-mesh regardless of request body) -->
6. A request for `codeflare-mesh` while no model is active returns an OpenAI-style model-not-found error. <!-- @impl: packages/router-worker/src/router.ts::handleChat --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-001 a chat for codeflare-mesh with no active model returns model-not-found) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P0

**Dependencies:** [REQ-GWY-001](gateway.md#req-gwy-001-gateway-custom-provider)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-002: Default model profiles

**Intent:** The first implementation needs resolved model defaults so implementation does not stall on model selection. The defaults are MeshLLM private-mesh profiles: an inactive single-node Qwen3.6 35B A3B profile, an inactive split layer-package variant (UD-Q4_K_XL quantization, the published layer package), and a small active smoke-test profile that keeps install and Gateway validation practical. The single-active invariant means only the smoke default ships active, so a fresh mesh verifies functionality on a cheap model before an admin flips to the target model.

**Applies To:** Admin

**Acceptance Criteria:**

1. `mesh-default-qwen36-35b` ships inactive with display name `Qwen3.6 35B`, rollout percent `0`, aliases `codeflare-mesh`, `qwen3.6:35b-a3b`, and `qwen3.6-coder`, model ref `unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S`, split disabled, and mesh bind port `4300`. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the MeshLLM default profile set with contract values) -->
2. `mesh-split-qwen36-35b` ships inactive with display name `Qwen3.6 35B (multi-machine)`, aliases `codeflare-mesh`, `qwen3.6:35b-a3b`, and `qwen3.6-coder`, layer-package model ref `hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@<pinned-rev>`, split enabled, and mesh bind port `4310`. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the MeshLLM default profile set with contract values) -->
3. `mesh-smoke-qwen25-1.5b` ships active with display name `Qwen2.5 Coder 1.5B`, rollout percent `100`, aliases `codeflare-mesh`, `mesh-smoke`, and `smoke-test`, model ref `unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M`, split disabled, and mesh bind port `4320`. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 seeds the MeshLLM default profile set with contract values) -->
4. A profile definition enumerates a display name, public aliases, upstream model name, source mode `meshllm-ref`, context limit (`0` = Auto), runtime `meshllm` settings (model ref, split, mandatory bind port, optional max VRAM, and the runtime tunables), profile version, rollout percent, and active flag. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and meshllm contract values) -->
5. Each default profile's upstream model name is the verbatim `/v1/models` id MeshLLM reports for its model ref. <!-- @impl: packages/router-worker/src/profiles.ts::PROFILE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 exposes profile source modes and meshllm contract values) -->
6. The MeshLLM runtime tunables are parallel lanes, KV cache types, prefill batch, micro-batch, flash attention, max output tokens, reasoning, and the prefix cache (enable, payload mode, max entries, shared-prefix tuning); each is optional and an omitted value means Auto and is not rendered. <!-- @impl: packages/router-worker/src/profiles.ts::MESHLLM_TUNABLE_DEFAULTS --> <!-- @impl: packages/router-worker/src/profiles.ts::meshllmPayloadMode --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 a new model ships with input caching enabled and multi-lane by default) -->
7. A config update can clear a previously set tunable back to Auto. <!-- @impl: packages/router-worker/src/router.ts::resolveMeshllmTunables --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-002 persists per-model runtime tunables and clears them back to Auto) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-RUN-001](#req-run-001-stable-public-model)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-RUN-009: Profile seeding and retirement

**Intent:** Deployed profile rows must converge to the shipped default definitions on every deploy: changed defaults refresh in place, stale alias owners retire, non-MeshLLM rows deactivate, and activation is single-active so at most one model is active at a time.

**Applies To:** Admin

**Acceptance Criteria:**

1. Default seeding refreshes an existing managed default row when the shipped profile definition changes. <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 migrates changed default profile rows without keeping retired alias owners active) -->
2. Default seeding retires stale active managed defaults that still own a public alias now owned by a shipped default profile. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 migrates changed default profile rows without keeping retired alias owners active) -->
3. Default seeding deactivates every profile row whose runtime is not `meshllm`, regardless of profile version. <!-- @impl: packages/router-worker/src/store.ts::retiredDefaultProfiles --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 deactivates non-meshllm profile rows regardless of version) -->
4. `POST /admin/profiles/activate` activates the target profile and atomically deactivates every other active profile, so at most one model is ever active (one mesh, one active model). <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-RUN-009 activation is single-active) -->

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

1. The agent renders `mesh-llm serve` as an exact argument list with `--model <model ref>`, `--split` only for split profiles, `--headless`, `--mesh-discovery-mode nostr`, `--disable-iroh-relays`, `--mesh-name codeflare-<profileId>-r<rotation>`, `--bind-ip <MeshIP>`, `--log-format json`, and one `--nostr-relay <url>` per operator-configured relay. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
2. The rendered argv sets `--bind-ip` to the node's Mesh IP, `--bind-port` to the profile's mandatory mesh bind port, and `--port`/`--console` to node-local agent config values (defaults `9337`/`3131`). <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
3. `--max-vram` is rendered only when the profile sets a VRAM cap, and `--llama-flavor` only from hardware detection or an agent config override. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
4. Rendered argv never contains `--publish`, `--listen-all`, `--auto`, or `--discover`. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererForbidsPublicDiscoveryFlags) -->
5. Profiles carry the single source mode `meshllm-ref`; the agent passes the model ref to MeshLLM verbatim and never downloads or checksums model files itself. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003RendererContract) -->
6. When a profile sets any supported value, the agent renders a per-profile config file (`--config <data dir>/meshllm-<profileId>.toml`) placing each under its MeshLLM subtable: `[models.model_fit]` (context, batch, micro-batch, KV cache types, flash attention, and a `prefix_cache` child table), `[models.throughput]` (parallel), and `[models.request_defaults]` (max output tokens, reasoning). <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMConfigTOML --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003ContextLimitConfigRendering) -->
7. A configuration value left unset (`0`/empty/absent, including a non-positive context limit) is omitted so MeshLLM auto-plans it; when a profile sets nothing, no config file is written. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMConfigTOML --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN003ContextLimitConfigRendering) -->

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
5. When the selected profile changes, the agent preempts an in-flight download or start of a now-deselected profile and switches to the newly selected profile without requiring a manual restart. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::beginRuntimeProfileRestart --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010PreemptsDeselectedInflightDownload) -->
6. The agent does not restart a runtime that is already loading or serving the currently selected profile, so a healthy ready runtime is left running instead of being torn down on each heartbeat tick. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::beginRuntimeProfileRestart --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010ReadyRuntimeForSelectedProfileIsNotRestarted) -->
7. A restart attempt is bounded by a timeout so a Stop hung on a runtime ignoring SIGTERM cannot block the restart goroutine and strand the restart-pending latch; the bounded attempt releases the latch and marks the runtime failed, so a later heartbeat retries instead of the node wedging in a transient state until a manual relaunch. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::finishProfileRestart --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::restartCtx --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN010RestartLatchReleasedWhenRuntimeHangs) -->

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

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime)

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
3. The agent drains and restarts the runtime when the response rotation differs from the running rotation, when the response mesh id differs from the running mesh id and join tokens are present, or when a `create` directive promotes a running joiner to seed. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006RestartTriggersDrainAndRelaunch) -->
4. Rendered mesh transport always binds `--bind-ip` to the node's Mesh IP so peers dial each other over the WARP overlay, and `--disable-iroh-relays` removes any public relay/STUN fallback so iroh data stays private; `nostr` discovery carries rendezvous metadata only, never inference. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @test: packages/node-agent/internal/agent/meshllm_render_test.go (TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses) -->
5. The agent runs at most one `mesh-llm` process; when several active MeshLLM profiles apply to a node, the first active profile is selected. <!-- @impl: packages/node-agent/internal/agent/runtime.go::SelectedProfile --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006SingleProcessSelectsFirstActiveProfile) -->
6. Draining waits until both the local proxy in-flight counter and the MeshLLM console `inflight_requests` reach zero, bounded by the drain timeout, so a restart never lands while MeshLLM is still generating a response. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::waitForDrain --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQRUN006DrainWaitsForMeshLLMConsoleInflight) -->
7. The agent's tracked mesh id reflects only the current process: it mirrors the console mesh id (clearing it when the console reports none) and resets the mesh id, invite token, and readiness on each new process launch, so no stale identity is reported or triggers a restart. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006PollStatusClearsStaleMeshIDWhenConsoleReportsNone) --> <!-- @test: packages/node-agent/internal/agent/meshllm_manager_test.go (TestREQRUN006StartClearsStaleMeshIdentity) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

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

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-meshllm-only-runtime), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

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

### REQ-RUN-011: Custom model onboarding

**Intent:** Operators must be able to add a model beyond the seeded profiles by supplying a mesh-llm-compatible model reference and a serving mode, so the router creates a new inactive profile that joins the model catalog and becomes available for rollout and activation without redeploying the Worker.

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

### REQ-RUN-012: Custom model removal

**Intent:** Operators must be able to remove a custom model they onboarded so the catalog does not accumulate abandoned entries, while the router protects the models that must not disappear: the shipped defaults that re-seed on boot and the one model currently answering the stable route.

**Applies To:** Admin, Automation

**Acceptance Criteria:**

1. A custom (non-default), switched-off model is permanently removed from the catalog. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @impl: packages/router-worker/src/store.ts::deleteProfile --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 deletes a custom inactive model over the API) -->

2. Removing the active model is refused with status 409 so the stable `codeflare-mesh` route is never left without a target. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 refuses deleting the active model) -->

3. Removing a default (shipped) model is refused with status 409 because it re-seeds on the next boot. <!-- @impl: packages/router-worker/src/profiles.ts::isDefaultModelId --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 refuses deleting a built-in model) -->

4. Removing an unknown model returns status 404 and changes nothing. <!-- @impl: packages/router-worker/src/router.ts::classifyModelDeletion --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-API-008 REQ-RUN-012 returns 404 deleting an unknown model) -->

**Constraints:** [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases), [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth)

**Priority:** P2

**Dependencies:** [REQ-RUN-011](#req-run-011-custom-model-onboarding), [REQ-RUN-001](#req-run-001-stable-public-model), [REQ-RUN-002](#req-run-002-default-model-profiles)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
