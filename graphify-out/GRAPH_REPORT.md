# Graph Report - codeflare-inference-mesh  (2026-08-21)

## Corpus Check
- 197 files · ~311,988 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2089 nodes · 6561 edges · 83 communities (74 shown, 9 thin omitted)
- Extraction: 78% EXTRACTED · 22% INFERRED · 0% AMBIGUOUS · INFERRED: 1450 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a925ef05`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Release and CI verification
- llamacpp_install.go
- fakeMeshRuntime
- router.ts
- CloudflareGatewayClient
- LlamaCppManager
- testing.T
- SDD requirements index
- newSelfUpdateFixture
- admin-ui.ts
- models.ts
- scheduler.ts
- admin-ui-views.ts
- mesh-state.ts
- MemoryStore
- MeshLLMManager
- meshllm_manager_test.go
- agent_node_test.go
- Glossary
- meshllm_status.go
- admin-ui-mesh.test.ts
- auth-gates.ts
- router-worker/package.json
- router-setup.test.ts
- runtime-versions.ts
- Store
- MeshLLMRenderInput
- access.ts
- handlers/meshes.ts
- router-test-support.ts
- Config
- MeshLLMStatus
- store.test.ts
- runtimeMetrics
- workflow-safety.mjs
- admin-ui-test-support.ts
- admin-ui-client.ts
- config.go
- llamacpp_manager_test.go
- serviceLoop
- runService
- D1Store
- client.go
- dashboard.go
- profiles.ts
- meshProcess
- package.json
- installers.ts
- rate-limit.ts
- types.ts
- compilerOptions
- context.Context
- meshRuntime
- rasterize-og.mjs
- 0001_initial.sql
- resolve-deploy-settings.mjs
- tsconfig.json
- llamacpp_manager.go
- fuzzAddr
- .ServeHTTP
- runtimeLog
- node-protocol.ts
- runtime.go
- sync.Mutex
- ActiveCounter
- deploy-gate.mjs
- 0003_direct_sessions.sql
- Mesh token lifecycle
- .Review Queue
- Changes
- github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent
- src/inference.ts
- speed-test.ts
- NewMeshLLMManager
- workflows.test.ts
- ignorePatterns
- direct-affinity.ts
- .meshWaitSelfHeal
- migrations.test.ts

## God Nodes (most connected - your core abstractions)
1. `Constraints` - 132 edges
2. `json()` - 77 edges
3. `MeshLLMManager` - 46 edges
4. `Store` - 46 edges
5. `Setup Admin` - 44 edges
6. `vitest` - 42 edges
7. `MemoryStore` - 41 edges
8. `LlamaCppManager` - 39 edges
9. `Runtime Profiles` - 38 edges
10. `fakeMeshRuntime` - 34 edges

## Surprising Connections (you probably didn't know these)
- `TestREQRUN007RestartWithInputRelaunchesWithNewProfileArgs()` --calls--> `argvContains()`  [INFERRED]
  packages/node-agent/internal/agent/agent_runtime_test.go → packages/node-agent/internal/agent/agent_fakes_test.go
- `TestREQOBS009MeshStatusGPUMetrics()` --calls--> `applyMeshStatusMetrics()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/heartbeat_test.go → packages/node-agent/cmd/inference-mesh-agent/runtime_metrics.go
- `runService()` --calls--> `launchInitialRuntime()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/cmd/inference-mesh-agent/runtime_launch.go
- `runService()` --calls--> `provisionMeshPeerFirewall()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/cmd/inference-mesh-agent/runtime_launch.go
- `runService()` --calls--> `heartbeatLoop()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/cmd/inference-mesh-agent/service_loop.go

## Import Cycles
- None detected.

## Communities (83 total, 9 thin omitted)

### Community 0 - "Release and CI verification"
Cohesion: 0.10
Nodes (168): CON-CF-001: Cloudflare-first public control plane, CON-CF-002: Worker runtime compatibility, CON-CI-001: CI is the verification surface, CON-MODEL-001: Stable Gateway aliases, CON-NET-001: Mesh destination validation, CON-REL-001: Release artifacts are verifiable, CON-RUNTIME-001: Runtime boundaries, CON-SDD-001: SDD and TDD stay coupled (+160 more)

### Community 1 - "llamacpp_install.go"
Cohesion: 0.06
Nodes (94): fakeArchiveEntry, LlamaCppAsset, LlamaCppInstallOption, llamaCppInstallOptions, LlamaCppReleaseAsset, llamaCppReleaseResponse, MeshLLMAsset, MeshLLMInstallOption (+86 more)

### Community 3 - "router.ts"
Cohesion: 0.08
Nodes (68): createTokenRecord(), ConsoleRole, generateBearerToken(), gatewaySettings, handleGatewayOptions(), handleGatewayProvisionStatus(), syncGatewayForActor(), handleChat() (+60 more)

### Community 4 - "CloudflareGatewayClient"
Cohesion: 0.07
Nodes (23): ACCESS_PROVISIONING_ANCHORS, AccessAppRecord, AccessGroupRecord, AccessPolicyRecord, AccessProvisionRequest, AccessProvisionResult, ADMIN_APP_NAME, BYPASS_APP_NAME (+15 more)

### Community 5 - "LlamaCppManager"
Cohesion: 0.11
Nodes (4): LlamaCppManager, meshLauncher, MeshBootstrap, NodeMetrics

### Community 6 - "testing.T"
Cohesion: 0.14
Nodes (39): testing.T, TestREQOBS007CollectCarriesSplitReadinessAndLaunchedBudget(), TestREQOBS008DashboardStatusAndControlsTrackCurrentManager(), TestREQOBS009CollectFillsMeshLLMUsedVRAMFromHostTelemetry(), TestREQOBS009MeshStatusGPUMetrics(), TestREQOBS011RuntimeDetailAndNodeStateRideHeartbeat(), TestREQNODE002HeartbeatFailuresSurfaceAndClear(), TestREQNODE002HeartbeatTelemetryProbeIsBounded() (+31 more)

### Community 7 - "SDD requirements index"
Cohesion: 0.05
Nodes (40): Setup and admin API routes, Agent self-update, Authenticated AI Gateway, Behavioral verification, Cloudflare Access admin authentication, Codeflare Inference Mesh, codeflare-mesh public alias, GitHub Actions deployment workflow (+32 more)

### Community 8 - "newSelfUpdateFixture"
Cohesion: 0.10
Nodes (32): fakeSelfUpdateEnv, SelfUpdateOption, SelfUpdater, time.Time, argvContains(), containsEnv(), applyStagedBinary(), atomicSwap() (+24 more)

### Community 9 - "admin-ui.ts"
Cohesion: 0.14
Nodes (26): ADMIN_UI_ANCHORS, AdminUiState, ADMIN_UI_ACTIONS, ADMIN_UI_AGENT_VERSION, ADMIN_UI_CONFIRM, ADMIN_UI_MESH_HEALTH, ADMIN_UI_MESH_ROLE, ADMIN_UI_MESHES (+18 more)

### Community 10 - "models.ts"
Cohesion: 0.13
Nodes (35): duplicateProfileCore(), handleApiModelAdd(), handleApiModelConfigure(), handleApiModelList(), handleProfileAdd(), handleProfileConfig(), handleProfileDuplicate(), resolveOnboardingMesh() (+27 more)

### Community 11 - "scheduler.ts"
Cohesion: 0.16
Nodes (15): validateClaim(), allowedMeshCidrs(), allowedMeshPorts(), cidrContains(), DEFAULT_MESH_CIDRS, DEFAULT_MESH_PORTS, eligibleDirectNodes(), eligibleNodes() (+7 more)

### Community 12 - "admin-ui-views.ts"
Cohesion: 0.15
Nodes (39): ADMIN_UI_FIELD_ANCHOR, button(), ButtonOptions, commandChip(), CommandChipOptions, commandRow(), CommandRowOptions, escapeHtml() (+31 more)

### Community 13 - "mesh-state.ts"
Cohesion: 0.08
Nodes (54): decryptJson(), EncryptedEnvelope, encryptJson(), fromBase64(), importMeshStateKey(), MESH_CRYPTO_ANCHORS, toBase64(), appendMeshAudit() (+46 more)

### Community 14 - "MemoryStore"
Cohesion: 0.07
Nodes (21): DirectSessionDecision, seedAutomationKey(), DEFAULT_PROFILES_SEEDED_KEY, directSessionFromRow(), DirectSessionRow, GATE_CONFIG_KEYS, gateConfigCache, NodeRow (+13 more)

### Community 15 - "MeshLLMManager"
Cohesion: 0.10
Nodes (4): execMeshProcess, os/exec.Cmd, MeshLLMManager, MeshBootstrap

### Community 16 - "meshllm_manager_test.go"
Cohesion: 0.18
Nodes (30): modelsFixture, TestREQRUN005APIReadyFailsClosedWhenModelsUnreachable(), TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline(), TestREQRUN006HeartbeatCarriesMeshTokenAndMeshId(), TestREQRUN007RestartWithInputRelaunchesWithNewProfileArgs(), envContains(), equalStrings(), flagValues() (+22 more)

### Community 17 - "agent_node_test.go"
Cohesion: 0.09
Nodes (34): net/http/httptest.Server, routerFixture, TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(), TestREQNODE004DashboardRendersOperationalStatusUI(), TestREQNODE004DashboardReportsMeshLLMRuntimePanel(), TestREQNODE004DashboardRuntimeControlsReportUnavailableWithoutController(), TestREQNODE004DashboardRuntimeControlsUseController(), TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches() (+26 more)

### Community 18 - "Glossary"
Cohesion: 0.06
Nodes (35): Access Application, Access JWT, Agent Release, AI Gateway, Bootstrap Origin, Break-Glass Recovery, Cloudflare Mesh, Console API (+27 more)

### Community 19 - "meshllm_status.go"
Cohesion: 0.13
Nodes (26): MeshLLMSplitCapacityAdvice, MeshLLMSplitParticipant, MeshLLMSplitReadinessBlocker, MeshLLMStage, runtimeStagePayload, DeriveMeshRole(), firstNonEmpty(), MeshLLMSplitReadiness (+18 more)

### Community 20 - "admin-ui-mesh.test.ts"
Cohesion: 0.09
Nodes (11): adminUiCss(), CHIP_TONES, chipToneCss(), adminUiHarness, dashboardHarness(), meshCard(), meshEntries, meshField() (+3 more)

### Community 21 - "auth-gates.ts"
Cohesion: 0.07
Nodes (54): accessJwtSource, AUTH_ANCHORS, bearerToken(), createTokenId(), AUTH_GATES_ANCHORS, authenticateAnyStoredToken(), authenticateKind(), authenticateTokenByNode() (+46 more)

### Community 22 - "router-worker/package.json"
Cohesion: 0.08
Nodes (24): @cloudflare/workers-types, dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler (+16 more)

### Community 23 - "router-setup.test.ts"
Cohesion: 0.16
Nodes (7): elementStub(), ROUTES, identityGroupsFetcher(), roleRouter(), samplePath(), accessJwksFetcher(), accessTestKey

### Community 24 - "runtime-versions.ts"
Cohesion: 0.06
Nodes (49): AGENT_VERSIONS_ANCHORS, AgentVersionsCache, AgentVersionsEnv, extractReleaseTags(), fetchReleaseTags(), handleAgentVersionSelect(), handleAgentVersionsList(), isCacheFresh() (+41 more)

### Community 25 - "Store"
Cohesion: 0.10
Nodes (4): AuthDeps, InferenceDeps, Scheduler, Store

### Community 26 - "MeshLLMRenderInput"
Cohesion: 0.21
Nodes (24): flashAttentionValue(), MeshLLMRenderInput, MeshLLMConfigTOML(), MeshLLMEnv(), meshLLMNativeRuntimeManifestURL(), RenderMeshLLMArgs(), allRenderForms(), argvValue() (+16 more)

### Community 27 - "access.ts"
Cohesion: 0.11
Nodes (23): ACCESS_ANCHORS, AccessConfig, AccessJwk, AccessVerification, base64UrlToBytes(), claimsValid(), decodeSegment(), extractAccessJwt() (+15 more)

### Community 28 - "handlers/meshes.ts"
Cohesion: 0.26
Nodes (15): meshCreateCore(), meshDeleteCore(), meshListCore(), meshRotateCore(), meshSummary(), createMesh(), DEFAULT_MESH_ID, deleteMesh() (+7 more)

### Community 29 - "router-test-support.ts"
Cohesion: 0.11
Nodes (29): STABLE_PUBLIC_MODEL, mintKey(), required(), addApiModelId(), addModel(), adminUiConfig(), adminUiScript(), apiAddModel() (+21 more)

### Community 30 - "Config"
Cohesion: 0.17
Nodes (16): sync.RWMutex, runtimeLoadState, serviceLoop, launchInitialRuntime(), llamaCppBinaryPath(), llamaCppInput(), managedLlamaCppBackend(), meshFlavorFlag() (+8 more)

### Community 31 - "MeshLLMStatus"
Cohesion: 0.27
Nodes (10): GPUStatus, net/http.Client, fetchLocalBody(), fetchMeshLLMModels(), fetchMeshLLMRuntimeStages(), fetchMeshLLMSplitReadiness(), fetchMeshLLMStatus(), MeshLLMStatus (+2 more)

### Community 32 - "store.test.ts"
Cohesion: 0.18
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 33 - "runtimeMetrics"
Cohesion: 0.29
Nodes (9): runtimeTelemetry, TestREQRUN005RuntimeMetricsMarksLaunchedProfileLoaded(), applyMeshStatusMetrics(), runtimeMetrics(), runtimeVersionOrDefault(), NodeMetrics, MergeRuntimeMetrics(), ParseNvidiaSMI() (+1 more)

### Community 34 - "workflow-safety.mjs"
Cohesion: 0.22
Nodes (18): actionUses(), checkoutSteps(), escapeRegExp(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin() (+10 more)

### Community 35 - "admin-ui-test-support.ts"
Cohesion: 0.17
Nodes (21): adminUiHtml(), ADMIN_UI_DRAWER, ADMIN_UI_NODES_TABLE, descendants(), FetchCall, HarnessOptions, PendingTimer, RecordedEvent (+13 more)

### Community 36 - "admin-ui-client.ts"
Cohesion: 0.09
Nodes (17): ADMIN_UI_CLIENT_FRAGMENTS, ADMIN_UI_CLIENT_SCRIPT, CLIENT_ACTIONS, CLIENT_BOOT, CLIENT_DRAWERS, CLIENT_EVENTS, CLIENT_FORMAT, CLIENT_LOADERS (+9 more)

### Community 37 - "config.go"
Cohesion: 0.25
Nodes (16): NamedInterface, RuntimeBinaryVersions, net.Addr, net.IP, TestREQNODE008DetectsWARPAdapterAndIP(), DetectHostMeshIP(), DetectMeshIP(), detectWARPInterfaceIP() (+8 more)

### Community 38 - "llamacpp_manager_test.go"
Cohesion: 0.21
Nodes (16): fakeLlamaMetrics, mutableTarget, RenderLlamaCppArgs(), containsArgSequence(), hasExactArg(), joinArgs(), portOf(), TestREQOBS009LlamaCppLiveThroughputFromCounterDeltas() (+8 more)

### Community 39 - "serviceLoop"
Cohesion: 0.16
Nodes (9): io.Writer, agentUpdater, currentRuntimeController, meshRuntimeBudgetReporter, splitReadinessPoller, execCommandRunner(), serviceLoop, heartbeatLoop() (+1 more)

### Community 40 - "runService"
Cohesion: 0.15
Nodes (18): ServiceInstall, net/http.Server, runtimeTargetFunc, TestConfigFlagResolvesExplicitConfigPath(), configPathFromArgs(), defaultDataDir(), main(), runInstall() (+10 more)

### Community 41 - "D1Store"
Cohesion: 0.14
Nodes (6): normalizeModelProfile(), D1Store, materializeNode(), nodeFromRow(), parseJson(), ModelProfile

### Community 42 - "client.go"
Cohesion: 0.22
Nodes (17): ClaimRequest, ClaimResponse, Client, TestREQNODE013AppliesDesiredRuntimeVersions(), TestREQNODE014RepositoryFollowsRouterExactly(), activeDesiredProfiles(), ApplyClaim(), ApplyDesiredProfiles() (+9 more)

### Community 43 - "dashboard.go"
Cohesion: 0.27
Nodes (12): net/http.HandlerFunc, dashboardCard(), dashboardControlAllowed(), dashboardHTML(), dashboardRuntimeCard(), DashboardStatus, NodeMetrics, isLoopbackAddress() (+4 more)

### Community 44 - "profiles.ts"
Cohesion: 0.13
Nodes (19): buildCustomProfile(), DEFAULT_MODEL_PROFILES, LLAMACPP_PROFILE_DEFAULTS, MESHLLM_RECURRENT_REF_MARKERS, MESHLLM_TUNABLE_DEFAULTS, meshllmPayloadMode(), modelRefSegment(), parseLlamaCppModelRef() (+11 more)

### Community 45 - "meshProcess"
Cohesion: 0.21
Nodes (3): meshProcess, context.CancelFunc, containsString()

### Community 46 - "package.json"
Cohesion: 0.10
Nodes (20): oxlint, description, devDependencies, knip, oxlint, engines, node, knip (+12 more)

### Community 47 - "installers.ts"
Cohesion: 0.21
Nodes (13): INSTALLER_ANCHORS, InstallerArch, installerCommand(), InstallerInput, installerPlan, InstallerPlatform, installScript(), InstallScriptInput (+5 more)

### Community 48 - "rate-limit.ts"
Cohesion: 0.27
Nodes (9): bearerToken(), BUCKET_BINDING, classifyRoute(), isRateLimited(), RateBucket, rateKey(), sha256Hex(), TOKEN_KEYED (+1 more)

### Community 49 - "types.ts"
Cohesion: 0.06
Nodes (34): ApiEnvelope, CLOUDFLARE_API_ANCHORS, CustomDomainProvisionRequest, CustomDomainProvisionResult, DnsRecord, GatewayProvisionStatus, GatewayRecord, GatewaySyncRequest (+26 more)

### Community 50 - "compilerOptions"
Cohesion: 0.12
Nodes (15): @cloudflare/workers-types, ES2022, node, WebWorker, compilerOptions, exactOptionalPropertyTypes, lib, module (+7 more)

### Community 51 - "context.Context"
Cohesion: 0.16
Nodes (18): fakeRuntimeController, context.Context, provisionMeshPeerFirewall(), EnsureInboundRule(), ensureLinuxRule(), ensureWindowsRule(), TestREQNODE010EnsureInboundRule(), appleGPUInUseMiB() (+10 more)

### Community 52 - "meshRuntime"
Cohesion: 0.15
Nodes (14): time.Duration, meshRuntime, serviceLoop, runtimeKindMismatch(), beginRestart(), beginRuntimeProfileRestart(), finishRestart(), serviceLoop (+6 more)

### Community 53 - "rasterize-og.mjs"
Cohesion: 0.08
Nodes (23): fontFiles, here, png, pngPath, resvg, svg, svgPath, ignoreDependencies (+15 more)

### Community 54 - "0001_initial.sql"
Cohesion: 0.25
Nodes (7): audit_events, model_profiles, nodes, reservations, router_config, sessions, tokens

### Community 55 - "resolve-deploy-settings.mjs"
Cohesion: 0.33
Nodes (5): DEPLOY_SETTINGS_ANCHORS, output, validHostnameLabel(), validWorkerBaseUrl(), workerBaseUrl

### Community 56 - "tsconfig.json"
Cohesion: 0.15
Nodes (12): compilerOptions, noEmit, rootDir, exclude, extends, include, dist, node_modules (+4 more)

### Community 57 - "llamacpp_manager.go"
Cohesion: 0.17
Nodes (14): io.Reader, LlamaCppInput, hfRepoWithQuant(), llamaCppRuntimeEnv(), llamaCppRuntimeEnvFor(), NewLlamaCppManager(), parseLlamaCounters(), TestREQNODE013LlamaCppLaunchEnvIncludesRuntimeLibraryPath() (+6 more)

### Community 58 - "fuzzAddr"
Cohesion: 0.40
Nodes (3): fuzzAddr, testing.F, FuzzDetectMeshIP()

### Community 59 - ".ServeHTTP"
Cohesion: 0.47
Nodes (3): net/http.Request, net/http.ResponseWriter, TestREQNODE003ProxyReadsRuntimeTargetPerRequest()

### Community 60 - "runtimeLog"
Cohesion: 0.24
Nodes (5): runtimeLog, containsLevelToken(), containsMarker(), isWordByte(), letterLevelChatter()

### Community 61 - "node-protocol.ts"
Cohesion: 0.21
Nodes (22): desiredAgentVersion(), desiredRuntimeVersionsPayload(), getOrCreateUpstreamToken(), handleNodeClaim(), handleNodeHeartbeat(), meshProfilesFor(), selectedMeshProfile(), stableNodeId() (+14 more)

### Community 62 - "runtime.go"
Cohesion: 0.70
Nodes (4): LlamaCppSettings, MeshLLMSettings, PrefixCacheSettings, ReasoningSettings

### Community 63 - "sync.Mutex"
Cohesion: 0.12
Nodes (14): consoleFixture, eventLog, fakeLaunch, fakeMeshProcess, launchRecord, managerFixture, os.Signal, sync.Mutex (+6 more)

### Community 64 - "ActiveCounter"
Cohesion: 0.17
Nodes (12): activeRequestGeneration, RuntimeTargetProvider, staticTarget, net/http.Handler, net/http.Header, sync/atomic.Pointer, TestREQNODE003UpstreamProxyEnforcesBearerAndStreams(), filterRuntimeHeaders() (+4 more)

### Community 74 - "src/inference.ts"
Cohesion: 0.22
Nodes (17): approvedNodeHeaders(), responseMetadataHeaders(), decideDirectSessionWithAffinity(), directAffinitySecret(), directSessionBody(), directSessionPart(), forwardInference(), gatewayMetadataDirectSession() (+9 more)

### Community 75 - "speed-test.ts"
Cohesion: 0.24
Nodes (15): routablePublicModel(), runInference(), boundedInt(), measureSpeedStream(), rate(), rateFromTiming(), readWithinDeadline(), runSpeedTest() (+7 more)

### Community 76 - "NewMeshLLMManager"
Cohesion: 0.15
Nodes (12): TestREQOBS009ReportsLastRuntimeError(), NewMeshLLMManager(), TestREQRUN010MissingBinaryReportsDependencyMissing(), TestREQOBS011RuntimeErrorDetailReflectsRing(), TestREQOBS011RuntimeLogCapturesLastErrorLine(), TestREQOBS011RuntimeLogErrorMarkersAnchorAtWordStart(), TestREQOBS011RuntimeLogHandlesSplitWrites(), TestREQOBS011RuntimeLogIgnoresLlamaCppLetterLevelLines() (+4 more)

### Community 77 - "workflows.test.ts"
Cohesion: 0.20
Nodes (6): Job, repoRoot, runShellBlock(), runShellBlockWithFiles(), Step, Workflow

### Community 78 - "ignorePatterns"
Cohesion: 0.20
Nodes (9): categories, correctness, ignorePatterns, dist, node_modules, overrides, $schema, graphify-out (+1 more)

### Community 79 - "direct-affinity.ts"
Cohesion: 0.22
Nodes (7): decideDirectSession(), DIRECT_AFFINITY_ANCHORS, DIRECT_SESSION_TTL_MS, DirectAffinityOutcome, DirectSessionDecisionRequest, directSessionKey(), selectNode()

## Knowledge Gaps
- **216 isolated node(s):** `$schema`, `correctness`, `node_modules`, `dist`, `.wrangler` (+211 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `router-test-support.ts` to `store.test.ts`, `admin-ui-test-support.ts`, `CloudflareGatewayClient`, `scheduler.ts`, `profiles.ts`, `mesh-state.ts`, `workflows.test.ts`, `rate-limit.ts`, `migrations.test.ts`, `compilerOptions`, `admin-ui-mesh.test.ts`, `router-setup.test.ts`, `runtime-versions.ts`, `access.ts`, `handlers/meshes.ts`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `CloudflareGatewayClient` connect `CloudflareGatewayClient` to `types.ts`, `router.ts`, `router-test-support.ts`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `LlamaCppManager` connect `LlamaCppManager` to `llamacpp_manager_test.go`, `newSelfUpdateFixture`, `meshProcess`, `MeshLLMStatus`, `meshRuntime`, `llamacpp_manager.go`, `runtimeLog`, `sync.Mutex`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Are the 133 inferred relationships involving `Release and CI verification` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Release and CI verification` has 133 INFERRED edges - model-reasoned connections that need verification._
- **Are the 129 inferred relationships involving `Observability and diagnostics` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Observability and diagnostics` has 129 INFERRED edges - model-reasoned connections that need verification._
- **Are the 120 inferred relationships involving `Router Worker` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Router Worker` has 120 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `correctness`, `node_modules` to the rest of the system?**
  _216 weakly-connected nodes found - possible documentation gaps or missing edges._