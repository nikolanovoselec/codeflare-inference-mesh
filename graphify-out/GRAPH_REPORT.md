# Graph Report - codeflare-inference-mesh  (2026-08-21)

## Corpus Check
- 198 files · ~312,738 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2096 nodes · 6596 edges · 76 communities (67 shown, 9 thin omitted)
- Extraction: 78% EXTRACTED · 22% INFERRED · 0% AMBIGUOUS · INFERRED: 1452 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ef1fb553`
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
- profile-config.ts
- types.ts
- admin-ui-views.ts
- mesh-state.ts
- profiles.ts
- MeshLLMManager
- meshllm_manager_test.go
- agent_node_test.go
- Glossary
- context.Context
- admin-ui-mesh.test.ts
- auth-gates.ts
- router-worker/package.json
- router-setup.test.ts
- runtime-versions.ts
- adminUiHarness
- MeshLLMRenderInput
- agent-versions.test.ts
- handlers/meshes.ts
- router-test-support.ts
- Config
- routerFixture
- store.test.ts
- parseLlamaCounters
- workflow-safety.mjs
- admin-ui-test-support.ts
- admin-ui-client.ts
- config.go
- llamacpp_manager_test.go
- serviceLoop
- runService
- DefaultConfig
- DashboardHandler
- package.json
- setup.ts
- rate-limit.ts
- deps.ts
- compilerOptions
- GPUFallbackMetrics
- rasterize-og.mjs
- 0001_initial.sql
- resolve-deploy-settings.mjs
- tsconfig.json
- llamacpp_manager.go
- fuzzAddr
- .ServeHTTP
- runtimeLog
- node-protocol.ts
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
- migrations.test.ts

## God Nodes (most connected - your core abstractions)
1. `Constraints` - 132 edges
2. `json()` - 77 edges
3. `MeshLLMManager` - 47 edges
4. `Store` - 46 edges
5. `Setup Admin` - 44 edges
6. `vitest` - 42 edges
7. `MemoryStore` - 41 edges
8. `Config` - 38 edges
9. `Runtime Profiles` - 38 edges
10. `fakeMeshRuntime` - 35 edges

## Surprising Connections (you probably didn't know these)
- `TestREQRUN007RestartWithInputRelaunchesWithNewProfileArgs()` --calls--> `argvContains()`  [INFERRED]
  packages/node-agent/internal/agent/agent_runtime_test.go → packages/node-agent/internal/agent/agent_fakes_test.go
- `TestREQOBS009MeshStatusGPUMetrics()` --calls--> `applyMeshStatusMetrics()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/heartbeat_test.go → packages/node-agent/cmd/inference-mesh-agent/runtime_metrics.go
- `runService()` --calls--> `runtimeTargetFunc`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/cmd/inference-mesh-agent/service_loop.go
- `runService()` --calls--> `launchInitialRuntime()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/cmd/inference-mesh-agent/runtime_launch.go
- `runService()` --calls--> `provisionMeshPeerFirewall()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/cmd/inference-mesh-agent/runtime_launch.go

## Import Cycles
- None detected.

## Communities (76 total, 9 thin omitted)

### Community 0 - "Release and CI verification"
Cohesion: 0.10
Nodes (168): CON-CF-001: Cloudflare-first public control plane, CON-CF-002: Worker runtime compatibility, CON-CI-001: CI is the verification surface, CON-MODEL-001: Stable Gateway aliases, CON-NET-001: Mesh destination validation, CON-REL-001: Release artifacts are verifiable, CON-RUNTIME-001: Runtime boundaries, CON-SDD-001: SDD and TDD stay coupled (+160 more)

### Community 1 - "llamacpp_install.go"
Cohesion: 0.06
Nodes (97): fakeArchiveEntry, LlamaCppAsset, LlamaCppInstallOption, llamaCppInstallOptions, LlamaCppReleaseAsset, llamaCppReleaseResponse, MeshLLMAsset, MeshLLMInstallOption (+89 more)

### Community 3 - "router.ts"
Cohesion: 0.12
Nodes (35): recordBreakGlassEntry(), generateBearerToken(), handleChat(), handleModels(), handleApiEnrollmentToken(), handleApiEvents(), handleApiKeyCreate(), handleApiKeyList() (+27 more)

### Community 4 - "CloudflareGatewayClient"
Cohesion: 0.07
Nodes (22): ACCESS_PROVISIONING_ANCHORS, AccessAppRecord, AccessGroupRecord, AccessPolicyRecord, ADMIN_APP_NAME, BYPASS_APP_NAME, CloudflareAccessClient, MACHINE_BYPASS_SUFFIXES (+14 more)

### Community 5 - "LlamaCppManager"
Cohesion: 0.14
Nodes (3): LlamaCppManager, containsString(), NodeMetrics

### Community 6 - "testing.T"
Cohesion: 0.13
Nodes (42): testing.T, TestREQOBS007CollectCarriesSplitReadinessAndLaunchedBudget(), TestREQOBS008DashboardStatusAndControlsTrackCurrentManager(), TestREQOBS009CollectFillsMeshLLMUsedVRAMFromHostTelemetry(), TestREQOBS009MeshStatusGPUMetrics(), TestREQOBS011RuntimeDetailAndNodeStateRideHeartbeat(), TestREQNODE002HeartbeatFailuresSurfaceAndClear(), TestREQNODE002HeartbeatTelemetryProbeIsBounded() (+34 more)

### Community 7 - "SDD requirements index"
Cohesion: 0.05
Nodes (40): Setup and admin API routes, Agent self-update, Authenticated AI Gateway, Behavioral verification, Cloudflare Access admin authentication, Codeflare Inference Mesh, codeflare-mesh public alias, GitHub Actions deployment workflow (+32 more)

### Community 8 - "newSelfUpdateFixture"
Cohesion: 0.10
Nodes (32): fakeSelfUpdateEnv, SelfUpdateOption, SelfUpdater, time.Time, argvContains(), containsEnv(), applyStagedBinary(), atomicSwap() (+24 more)

### Community 9 - "admin-ui.ts"
Cohesion: 0.14
Nodes (26): ADMIN_UI_ANCHORS, AdminUiState, ADMIN_UI_ACTIONS, ADMIN_UI_AGENT_VERSION, ADMIN_UI_CONFIRM, ADMIN_UI_MESH_HEALTH, ADMIN_UI_MESH_ROLE, ADMIN_UI_MESHES (+18 more)

### Community 10 - "profile-config.ts"
Cohesion: 0.11
Nodes (38): duplicateProfileCore(), handleApiModelAdd(), handleApiModelConfigure(), handleApiModelList(), handleProfileAdd(), handleProfileConfig(), handleProfileDuplicate(), resolveOnboardingMesh() (+30 more)

### Community 11 - "types.ts"
Cohesion: 0.04
Nodes (44): AuthDeps, decideDirectSession(), DIRECT_AFFINITY_ANCHORS, DIRECT_SESSION_TTL_MS, DirectAffinityOutcome, DirectSessionDecisionRequest, RegistryDO, SessionAffinityDO (+36 more)

### Community 12 - "admin-ui-views.ts"
Cohesion: 0.15
Nodes (39): ADMIN_UI_FIELD_ANCHOR, button(), ButtonOptions, commandChip(), CommandChipOptions, commandRow(), CommandRowOptions, escapeHtml() (+31 more)

### Community 13 - "mesh-state.ts"
Cohesion: 0.08
Nodes (55): decryptJson(), EncryptedEnvelope, encryptJson(), fromBase64(), importMeshStateKey(), MESH_CRYPTO_ANCHORS, toBase64(), appendMeshAudit() (+47 more)

### Community 14 - "profiles.ts"
Cohesion: 0.05
Nodes (30): DirectSessionDecision, LLAMACPP_PROFILE_DEFAULTS, MESHLLM_RECURRENT_REF_MARKERS, MESHLLM_TUNABLE_DEFAULTS, normalizeModelProfile(), PROFILE_ANCHORS, D1Store, DEFAULT_PROFILES_SEEDED_KEY (+22 more)

### Community 15 - "MeshLLMManager"
Cohesion: 0.08
Nodes (10): execMeshProcess, MeshCoordinator, meshLauncher, meshProcess, context.CancelFunc, io.Writer, os/exec.Cmd, MeshBootstrap (+2 more)

### Community 16 - "meshllm_manager_test.go"
Cohesion: 0.17
Nodes (31): modelsFixture, TestREQRUN005APIReadyFailsClosedWhenModelsUnreachable(), TestREQRUN005RuntimeManagerUsesProcessLifetimeContext(), TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline(), TestREQRUN006HeartbeatCarriesMeshTokenAndMeshId(), TestREQRUN007RestartWithInputRelaunchesWithNewProfileArgs(), envContains(), equalStrings() (+23 more)

### Community 17 - "agent_node_test.go"
Cohesion: 0.14
Nodes (17): runtimeTelemetry, serviceLoop, meshWaitStuck(), applyMeshStatusMetrics(), TestREQNODE004DashboardRendersOperationalStatusUI(), TestREQNODE004DashboardReportsMeshLLMRuntimePanel(), TestREQNODE004DashboardRuntimeControlsReportUnavailableWithoutController(), TestREQNODE004DashboardRuntimeControlsUseController() (+9 more)

### Community 18 - "Glossary"
Cohesion: 0.06
Nodes (35): Access Application, Access JWT, Agent Release, AI Gateway, Bootstrap Origin, Break-Glass Recovery, Cloudflare Mesh, Console API (+27 more)

### Community 19 - "context.Context"
Cohesion: 0.08
Nodes (39): ClaimRequest, Client, fakeRuntimeController, GPUStatus, MeshLLMSplitCapacityAdvice, MeshLLMSplitParticipant, MeshLLMSplitReadinessBlocker, MeshLLMStage (+31 more)

### Community 20 - "admin-ui-mesh.test.ts"
Cohesion: 0.20
Nodes (9): adminUiCss(), CHIP_TONES, chipToneCss(), meshCard(), meshEntries, meshField(), meshNodes, statusProfiles (+1 more)

### Community 21 - "auth-gates.ts"
Cohesion: 0.07
Nodes (50): ACCESS_ANCHORS, AccessConfig, AccessJwk, accessJwtSource, AccessVerification, base64UrlToBytes(), claimsValid(), decodeSegment() (+42 more)

### Community 22 - "router-worker/package.json"
Cohesion: 0.08
Nodes (24): @cloudflare/workers-types, dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler (+16 more)

### Community 23 - "router-setup.test.ts"
Cohesion: 0.13
Nodes (12): resetJwksCache(), buildCustomProfile(), meshllmPayloadMode(), modelRefSegment(), parseLlamaCppModelRef(), slugify(), slugifyModelRef(), STABLE_PUBLIC_MODEL (+4 more)

### Community 24 - "runtime-versions.ts"
Cohesion: 0.08
Nodes (44): AGENT_VERSIONS_ANCHORS, AgentVersionsCache, AgentVersionsEnv, extractReleaseTags(), fetchReleaseTags(), handleAgentVersionSelect(), handleAgentVersionsList(), isCacheFresh() (+36 more)

### Community 26 - "MeshLLMRenderInput"
Cohesion: 0.19
Nodes (25): TestREQRUN003StartWritesContextConfigTOML(), flashAttentionValue(), MeshLLMRenderInput, MeshLLMConfigTOML(), MeshLLMEnv(), meshLLMNativeRuntimeManifestURL(), RenderMeshLLMArgs(), allRenderForms() (+17 more)

### Community 27 - "agent-versions.test.ts"
Cohesion: 0.17
Nodes (4): emptyEnv, FetchCall, ListBody, StoredCache

### Community 28 - "handlers/meshes.ts"
Cohesion: 0.26
Nodes (15): meshCreateCore(), meshDeleteCore(), meshListCore(), meshRotateCore(), meshSummary(), createMesh(), DEFAULT_MESH_ID, deleteMesh() (+7 more)

### Community 29 - "router-test-support.ts"
Cohesion: 0.10
Nodes (38): AUTH_ANCHORS, createTokenId(), createTokenRecord(), hashToken(), randomHex(), SAFE_TOKEN_FIELD_NAMES, toHex(), DEFAULT_MODEL_PROFILES (+30 more)

### Community 30 - "Config"
Cohesion: 0.09
Nodes (39): LlamaCppSettings, MeshLLMSettings, PrefixCacheSettings, ReasoningSettings, RuntimeController, time.Duration, meshInputRestarter, runtimeLoadState (+31 more)

### Community 31 - "routerFixture"
Cohesion: 0.40
Nodes (4): net/http/httptest.Server, routerFixture, HeartbeatRequest, NodeMetrics

### Community 32 - "store.test.ts"
Cohesion: 0.18
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 33 - "parseLlamaCounters"
Cohesion: 0.40
Nodes (5): io.Reader, TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches(), parseLlamaCounters(), TestREQOBS009LlamaCppCountersParseWithLabelBlobs(), StageUpdate()

### Community 34 - "workflow-safety.mjs"
Cohesion: 0.22
Nodes (18): actionUses(), checkoutSteps(), escapeRegExp(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin() (+10 more)

### Community 35 - "admin-ui-test-support.ts"
Cohesion: 0.17
Nodes (22): adminUiHtml(), ADMIN_UI_DRAWER, ADMIN_UI_NODES_TABLE, descendants(), elementStub(), FetchCall, HarnessOptions, PendingTimer (+14 more)

### Community 36 - "admin-ui-client.ts"
Cohesion: 0.09
Nodes (17): ADMIN_UI_CLIENT_FRAGMENTS, ADMIN_UI_CLIENT_SCRIPT, CLIENT_ACTIONS, CLIENT_BOOT, CLIENT_DRAWERS, CLIENT_EVENTS, CLIENT_FORMAT, CLIENT_LOADERS (+9 more)

### Community 37 - "config.go"
Cohesion: 0.23
Nodes (17): NamedInterface, RuntimeBinaryVersions, net.Addr, net.IP, TestREQNODE008DetectsUnambiguousMeshIP(), TestREQNODE008DetectsWARPAdapterAndIP(), DetectHostMeshIP(), DetectMeshIP() (+9 more)

### Community 38 - "llamacpp_manager_test.go"
Cohesion: 0.21
Nodes (16): fakeLlamaMetrics, mutableTarget, RenderLlamaCppArgs(), containsArgSequence(), hasExactArg(), joinArgs(), portOf(), TestREQOBS009LlamaCppLiveThroughputFromCounterDeltas() (+8 more)

### Community 39 - "serviceLoop"
Cohesion: 0.15
Nodes (10): sync.RWMutex, agentUpdater, currentRuntimeController, meshRuntimeBudgetReporter, runtimeTargetFunc, runtimeThroughputPoller, splitReadinessPoller, execCommandRunner() (+2 more)

### Community 40 - "runService"
Cohesion: 0.11
Nodes (23): ServiceInstall, net/http.Server, TestConfigFlagResolvesExplicitConfigPath(), configPathFromArgs(), defaultDataDir(), main(), runInstall(), runService() (+15 more)

### Community 42 - "DefaultConfig"
Cohesion: 0.16
Nodes (26): ClaimResponse, TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(), TestREQNODE008AppliesDetectedMeshIPBeforeClaim(), TestREQNODE013AppliesDesiredRuntimeVersions(), TestREQRUN003ClaimAppliesDesiredProfilesBeforeRuntimeStart(), TestREQRUN003HeartbeatDesiredProfilesUpdateConfig(), TestREQRUN014DesiredProfileContentChangeRestartsRuntime(), TestREQLLAMACPPHeartbeatReportsSelectedDirectRuntime() (+18 more)

### Community 43 - "DashboardHandler"
Cohesion: 0.31
Nodes (12): net/http.HandlerFunc, dashboardCard(), dashboardControlAllowed(), DashboardHandler(), dashboardHTML(), dashboardRuntimeCard(), DashboardStatus, NodeMetrics (+4 more)

### Community 46 - "package.json"
Cohesion: 0.10
Nodes (20): oxlint, description, devDependencies, knip, oxlint, engines, node, knip (+12 more)

### Community 47 - "setup.ts"
Cohesion: 0.09
Nodes (38): resolveHostGate(), handleAdminLogin(), handleCustomDomain(), handleInstaller(), handleInstallScript(), handleSetupAccess(), handleSetupComplete(), handleWhoami() (+30 more)

### Community 48 - "rate-limit.ts"
Cohesion: 0.27
Nodes (9): bearerToken(), BUCKET_BINDING, classifyRoute(), isRateLimited(), RateBucket, rateKey(), sha256Hex(), TOKEN_KEYED (+1 more)

### Community 49 - "deps.ts"
Cohesion: 0.11
Nodes (21): AccessProvisionRequest, AccessProvisionResult, ConsoleRole, ApiEnvelope, CLOUDFLARE_API_ANCHORS, CustomDomainProvisionRequest, CustomDomainProvisionResult, DnsRecord (+13 more)

### Community 50 - "compilerOptions"
Cohesion: 0.12
Nodes (15): @cloudflare/workers-types, ES2022, node, WebWorker, compilerOptions, exactOptionalPropertyTypes, lib, module (+7 more)

### Community 51 - "GPUFallbackMetrics"
Cohesion: 0.19
Nodes (16): EnsureInboundRule(), ensureLinuxRule(), ensureWindowsRule(), TestREQNODE010EnsureInboundRule(), appleGPUInUseMiB(), appleUnifiedMemoryBudgetMiB(), CommandRunner, NodeMetrics (+8 more)

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
Cohesion: 0.23
Nodes (11): LlamaCppInput, hfRepoWithQuant(), llamaCppRuntimeEnv(), llamaCppRuntimeEnvFor(), NewLlamaCppManager(), TestREQNODE013LlamaCppLaunchEnvIncludesRuntimeLibraryPath(), TestREQNODE013LlamaCppLaunchEnvLeavesHuggingFaceCacheUnsetWithoutDataDir(), TestREQNODE013LlamaCppLaunchEnvPinsHuggingFaceCacheToDataDir() (+3 more)

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
Cohesion: 0.14
Nodes (36): desiredAgentVersion(), isSecretFieldName(), redactSecrets(), desiredRuntimeVersionsPayload(), getOrCreateUpstreamToken(), handleNodeClaim(), handleNodeHeartbeat(), meshProfilesFor() (+28 more)

### Community 63 - "sync.Mutex"
Cohesion: 0.13
Nodes (13): consoleFixture, eventLog, fakeLaunch, fakeMeshProcess, launchRecord, managerFixture, os.Signal, sync.Mutex (+5 more)

### Community 64 - "ActiveCounter"
Cohesion: 0.17
Nodes (12): activeRequestGeneration, RuntimeTargetProvider, staticTarget, net/http.Handler, net/http.Header, sync/atomic.Pointer, TestREQNODE003UpstreamProxyEnforcesBearerAndStreams(), filterRuntimeHeaders() (+4 more)

### Community 74 - "src/inference.ts"
Cohesion: 0.20
Nodes (20): approvedNodeHeaders(), directSessionKey(), responseMetadataHeaders(), decideDirectSessionWithAffinity(), directAffinitySecret(), directSessionBody(), directSessionPart(), forwardInference() (+12 more)

### Community 75 - "speed-test.ts"
Cohesion: 0.13
Nodes (28): InvalidJsonBodyError, gatewaySettings, handleGatewayOptions(), handleGatewayProvisionStatus(), syncGatewayForActor(), handlePlaygroundChat(), handlePlaygroundDirect(), playgroundMaxTokens() (+20 more)

### Community 76 - "NewMeshLLMManager"
Cohesion: 0.17
Nodes (11): NewMeshLLMManager(), TestREQRUN010MissingBinaryReportsDependencyMissing(), TestREQOBS011RuntimeErrorDetailReflectsRing(), TestREQOBS011RuntimeLogCapturesLastErrorLine(), TestREQOBS011RuntimeLogErrorMarkersAnchorAtWordStart(), TestREQOBS011RuntimeLogHandlesSplitWrites(), TestREQOBS011RuntimeLogIgnoresLlamaCppLetterLevelLines(), TestREQOBS011RuntimeLogIgnoresNonErrorLevelLines() (+3 more)

### Community 77 - "workflows.test.ts"
Cohesion: 0.20
Nodes (6): Job, repoRoot, runShellBlock(), runShellBlockWithFiles(), Step, Workflow

### Community 78 - "ignorePatterns"
Cohesion: 0.20
Nodes (9): categories, correctness, ignorePatterns, dist, node_modules, overrides, $schema, graphify-out (+1 more)

## Knowledge Gaps
- **218 isolated node(s):** `$schema`, `correctness`, `node_modules`, `dist`, `.wrangler` (+213 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `router-test-support.ts` to `store.test.ts`, `admin-ui-test-support.ts`, `CloudflareGatewayClient`, `types.ts`, `mesh-state.ts`, `workflows.test.ts`, `rate-limit.ts`, `migrations.test.ts`, `compilerOptions`, `admin-ui-mesh.test.ts`, `auth-gates.ts`, `router-setup.test.ts`, `runtime-versions.ts`, `agent-versions.test.ts`, `handlers/meshes.ts`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `CloudflareGatewayClient` connect `CloudflareGatewayClient` to `deps.ts`, `speed-test.ts`, `router-test-support.ts`, `setup.ts`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Why does `Store` connect `types.ts` to `src/inference.ts`, `profile-config.ts`, `speed-test.ts`, `mesh-state.ts`, `profiles.ts`, `setup.ts`, `deps.ts`, `auth-gates.ts`, `runtime-versions.ts`, `handlers/meshes.ts`, `node-protocol.ts`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Are the 133 inferred relationships involving `Release and CI verification` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Release and CI verification` has 133 INFERRED edges - model-reasoned connections that need verification._
- **Are the 129 inferred relationships involving `Observability and diagnostics` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Observability and diagnostics` has 129 INFERRED edges - model-reasoned connections that need verification._
- **Are the 120 inferred relationships involving `Router Worker` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Router Worker` has 120 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `correctness`, `node_modules` to the rest of the system?**
  _218 weakly-connected nodes found - possible documentation gaps or missing edges._