# Graph Report - /home/user/workspace/codeflare-inference-mesh  (2026-07-10)

## Corpus Check
- 128 files · ~260,142 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1824 nodes · 5531 edges · 74 communities (64 shown, 10 thin omitted)
- Extraction: 76% EXTRACTED · 24% INFERRED · 0% AMBIGUOUS · INFERRED: 1352 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `247c4b69`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_SDD Requirements Corpus|SDD Requirements Corpus]]
- [[_COMMUNITY_Runtime Binary Installers|Runtime Binary Installers]]
- [[_COMMUNITY_Agent Test Runtime Fakes|Agent Test Runtime Fakes]]
- [[_COMMUNITY_Router Inference Handlers|Router Inference Handlers]]
- [[_COMMUNITY_Cloudflare Provisioning Clients|Cloudflare Provisioning Clients]]
- [[_COMMUNITY_LlamaCpp Runtime Manager|LlamaCpp Runtime Manager]]
- [[_COMMUNITY_Router Auth Handlers|Router Auth Handlers]]
- [[_COMMUNITY_Public Documentation Corpus|Public Documentation Corpus]]
- [[_COMMUNITY_Agent Self Update|Agent Self Update]]
- [[_COMMUNITY_Admin UI Shell|Admin UI Shell]]
- [[_COMMUNITY_Router Test Store Types|Router Test Store Types]]
- [[_COMMUNITY_Scheduler Type Contracts|Scheduler Type Contracts]]
- [[_COMMUNITY_Admin UI Views|Admin UI Views]]
- [[_COMMUNITY_Mesh State Bootstrap|Mesh State Bootstrap]]
- [[_COMMUNITY_D1 Store Profiles|D1 Store Profiles]]
- [[_COMMUNITY_MeshLLM Runtime Manager|MeshLLM Runtime Manager]]
- [[_COMMUNITY_MeshLLM Manager Tests|MeshLLM Manager Tests]]
- [[_COMMUNITY_Agent Heartbeat Tests|Agent Heartbeat Tests]]
- [[_COMMUNITY_SDD Glossary Terms|SDD Glossary Terms]]
- [[_COMMUNITY_MeshLLM Status Parser|MeshLLM Status Parser]]
- [[_COMMUNITY_Admin Mesh Harness|Admin Mesh Harness]]
- [[_COMMUNITY_Node Auth Endpoints|Node Auth Endpoints]]
- [[_COMMUNITY_Worker Workflow Tests|Worker Workflow Tests]]
- [[_COMMUNITY_Router End-To-End Tests|Router End-To-End Tests]]
- [[_COMMUNITY_Runtime Version Controls|Runtime Version Controls]]
- [[_COMMUNITY_Direct Affinity Durable|Direct Affinity Durable]]
- [[_COMMUNITY_MeshLLM Argument Rendering|MeshLLM Argument Rendering]]
- [[_COMMUNITY_Access JWT Tests|Access JWT Tests]]
- [[_COMMUNITY_Worker Entry Versions|Worker Entry Versions]]
- [[_COMMUNITY_Mesh Crypto Tests|Mesh Crypto Tests]]
- [[_COMMUNITY_Agent Runtime Profiles|Agent Runtime Profiles]]
- [[_COMMUNITY_Agent HTTP Client|Agent HTTP Client]]
- [[_COMMUNITY_D1 Store Unit Tests|D1 Store Unit Tests]]
- [[_COMMUNITY_Agent Service Metrics|Agent Service Metrics]]
- [[_COMMUNITY_Workflow Safety Script|Workflow Safety Script]]
- [[_COMMUNITY_Agent Version Controls|Agent Version Controls]]
- [[_COMMUNITY_Setup State Access|Setup State Access]]
- [[_COMMUNITY_Agent Config Detection|Agent Config Detection]]
- [[_COMMUNITY_Mesh Manager Test Fakes|Mesh Manager Test Fakes]]
- [[_COMMUNITY_Runtime Profile Restart|Runtime Profile Restart]]
- [[_COMMUNITY_Agent Command Entrypoint|Agent Command Entrypoint]]
- [[_COMMUNITY_Admin Status APIs|Admin Status APIs]]
- [[_COMMUNITY_Agent Config Persistence|Agent Config Persistence]]
- [[_COMMUNITY_Agent Dashboard Controls|Agent Dashboard Controls]]
- [[_COMMUNITY_Model Management APIs|Model Management APIs]]
- [[_COMMUNITY_GPU Metrics Parsing|GPU Metrics Parsing]]
- [[_COMMUNITY_Workspace Package Metadata|Workspace Package Metadata]]
- [[_COMMUNITY_Installer Script Generation|Installer Script Generation]]
- [[_COMMUNITY_Rate Limit Logic|Rate Limit Logic]]
- [[_COMMUNITY_Model Profile Builder|Model Profile Builder]]
- [[_COMMUNITY_TypeScript Base Config|TypeScript Base Config]]
- [[_COMMUNITY_Firewall Rule Provisioning|Firewall Rule Provisioning]]
- [[_COMMUNITY_Runtime Lifecycle Tests|Runtime Lifecycle Tests]]
- [[_COMMUNITY_OG Image Rasterizer|OG Image Rasterizer]]
- [[_COMMUNITY_Initial D1 Schema|Initial D1 Schema]]
- [[_COMMUNITY_Deploy Settings Resolver|Deploy Settings Resolver]]
- [[_COMMUNITY_Router TypeScript Config|Router TypeScript Config]]
- [[_COMMUNITY_Mesh Console Fixture|Mesh Console Fixture]]
- [[_COMMUNITY_Mesh IP Fuzzing|Mesh IP Fuzzing]]
- [[_COMMUNITY_Mesh Process Signals|Mesh Process Signals]]
- [[_COMMUNITY_Runtime Error Log Tests|Runtime Error Log Tests]]
- [[_COMMUNITY_Script Lint Walker|Script Lint Walker]]
- [[_COMMUNITY_Service Install Plan|Service Install Plan]]
- [[_COMMUNITY_Unix Signal Handling|Unix Signal Handling]]
- [[_COMMUNITY_Windows Signal Handling|Windows Signal Handling]]
- [[_COMMUNITY_Deploy Gate Script|Deploy Gate Script]]
- [[_COMMUNITY_Direct Session Migration|Direct Session Migration]]
- [[_COMMUNITY_Mesh Token Lifecycle|Mesh Token Lifecycle]]
- [[_COMMUNITY_Review Queue Spec|Review Queue Spec]]
- [[_COMMUNITY_SDD Change Log|SDD Change Log]]
- [[_COMMUNITY_Node Agent Module|Node Agent Module]]

## God Nodes (most connected - your core abstractions)
1. `Constraints` - 132 edges
2. `createRouter()` - 84 edges
3. `json()` - 79 edges
4. `MeshLLMManager` - 46 edges
5. `Setup Admin` - 44 edges
6. `Runtime Profiles` - 38 edges
7. `Store` - 37 edges
8. `fakeMeshRuntime` - 34 edges
9. `LlamaCppManager` - 34 edges
10. `requireAdmin()` - 34 edges

## Surprising Connections (you probably didn't know these)
- `runInstall()` --calls--> `DefaultConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `SaveConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `ServiceInstallPlan()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/service.go
- `runService()` --calls--> `ApplyClaim()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go
- `runService()` --calls--> `DetectWARPInterfaceName()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go

## Import Cycles
- None detected.

## Communities (74 total, 10 thin omitted)

### Community 0 - "SDD Requirements Corpus"
Cohesion: 0.10
Nodes (167): CON-CF-001: Cloudflare-first public control plane, CON-CF-002: Worker runtime compatibility, CON-CI-001: CI is the verification surface, CON-MODEL-001: Stable Gateway aliases, CON-NET-001: Mesh destination validation, CON-REL-001: Release artifacts are verifiable, CON-RUNTIME-001: Runtime boundaries, CON-SDD-001: SDD and TDD stay coupled (+159 more)

### Community 1 - "Runtime Binary Installers"
Cohesion: 0.07
Nodes (88): fakeArchiveEntry, LlamaCppAsset, LlamaCppInstallOption, llamaCppInstallOptions, LlamaCppReleaseAsset, llamaCppReleaseResponse, MeshLLMAsset, MeshLLMInstallOption (+80 more)

### Community 2 - "Agent Test Runtime Fakes"
Cohesion: 0.05
Nodes (54): ActiveCounter, RuntimeTargetProvider, staticTarget, HandlerFunc, Header, HeartbeatRequest, fakeMeshRuntime, fakeUpdater (+46 more)

### Community 3 - "Router Inference Handlers"
Cohesion: 0.05
Nodes (76): AccessJwtSource, approvedNodeHeaders(), directSessionKey(), validateCustomDomain(), boundedInt(), cleanString(), ConsoleRole, decideDirectSessionWithAffinity() (+68 more)

### Community 4 - "Cloudflare Provisioning Clients"
Cohesion: 0.05
Nodes (39): ACCESS_PROVISIONING_ANCHORS, AccessAppRecord, AccessGroupRecord, AccessPolicyRecord, AccessProvisionRequest, AccessProvisionResult, CloudflareAccessClient, MACHINE_BYPASS_SUFFIXES (+31 more)

### Community 5 - "LlamaCpp Runtime Manager"
Cohesion: 0.06
Nodes (28): LlamaCppInput, LlamaCppManager, LlamaCppSettings, MeshLLMSettings, ModelProfile, mutableTarget, PrefixCacheSettings, ReasoningSettings (+20 more)

### Community 6 - "Router Auth Handlers"
Cohesion: 0.10
Nodes (51): createTokenRecord(), generateBearerToken(), DEFAULT_MODEL_PROFILES, isDefaultModelId(), applyFleetSettings(), classifyModelDeletion(), createRouter(), handleAdminLogin() (+43 more)

### Community 7 - "Public Documentation Corpus"
Cohesion: 0.05
Nodes (43): Setup and admin API routes, Agent self-update, Authenticated AI Gateway, Behavioral verification, Cloudflare Access admin authentication, Codeflare Inference Mesh, codeflare-mesh public alias, GitHub Actions deployment workflow (+35 more)

### Community 8 - "Agent Self Update"
Cohesion: 0.10
Nodes (37): fakeSelfUpdateEnv, SelfUpdateOption, SelfUpdater, UpdateAsset, UpdatePlan, containsEnv(), applyStagedBinary(), atomicSwap() (+29 more)

### Community 9 - "Admin UI Shell"
Cohesion: 0.10
Nodes (36): ADMIN_UI_ANCHORS, AdminUiState, ActivationProfileView, ADMIN_UI_ACTIONS, ADMIN_UI_AGENT_VERSION, ADMIN_UI_CONFIRM, ADMIN_UI_DRAWER, ADMIN_UI_MESH_HEALTH (+28 more)

### Community 10 - "Router Test Store Types"
Cohesion: 0.08
Nodes (15): DirectSessionDecision, seedAutomationKey(), tokenFromRow(), TokenRow, accessBase64Url(), MemoryStore, retiredDefaultProfiles(), seedDefaultActivation() (+7 more)

### Community 11 - "Scheduler Type Contracts"
Cohesion: 0.08
Nodes (32): MeshHealthEntry, allowedMeshCidrs(), allowedMeshPorts(), cidrContains(), DEFAULT_MESH_CIDRS, DEFAULT_MESH_PORTS, eligibleDirectNodes(), eligibleNodes() (+24 more)

### Community 12 - "Admin UI Views"
Cohesion: 0.16
Nodes (37): ADMIN_UI_FIELD_ANCHOR, button(), ButtonOptions, commandChip(), CommandChipOptions, commandRow(), CommandRowOptions, escapeHtml() (+29 more)

### Community 13 - "Mesh State Bootstrap"
Cohesion: 0.14
Nodes (37): appendMeshAudit(), applyHeartbeatMeshState(), bootstrapFromState(), captureMeshId(), clearedDetail(), electSeedIfAbsent(), emptyMeshState(), handleMeshRotate() (+29 more)

### Community 14 - "D1 Store Profiles"
Cohesion: 0.10
Nodes (16): normalizeModelProfile(), D1Store, directSessionFromRow(), DirectSessionRow, GATE_CONFIG_KEYS, gateConfigCache, materializeNode(), nodeFromRow() (+8 more)

### Community 15 - "MeshLLM Runtime Manager"
Cohesion: 0.09
Nodes (9): meshLauncher, MeshLLMManager, CancelFunc, Duration, MeshBootstrap, Mutex, Time, MeshLLMEnv() (+1 more)

### Community 16 - "MeshLLM Manager Tests"
Cohesion: 0.19
Nodes (30): modelsFixture, TestREQRUN005APIReadyFailsClosedWhenModelsUnreachable(), NewMeshLLMManager(), envContains(), equalStrings(), flagValues(), Server, T (+22 more)

### Community 17 - "Agent Heartbeat Tests"
Cohesion: 0.14
Nodes (34): HeartbeatRequest, T, TestConfigPathHonorsExplicitConfigEnv(), TestREQLLAMACPPHeartbeatReportsSelectedDirectRuntime(), TestREQNODE001ServiceSkeletonAndListenerPolicy(), TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(), TestREQNODE004DashboardRendersOperationalStatusUI(), TestREQNODE004DashboardReportsMeshLLMRuntimePanel() (+26 more)

### Community 18 - "SDD Glossary Terms"
Cohesion: 0.06
Nodes (35): Access Application, Access JWT, Agent Release, AI Gateway, Bootstrap Origin, Break-Glass Recovery, Cloudflare Mesh, Console API (+27 more)

### Community 19 - "MeshLLM Status Parser"
Cohesion: 0.13
Nodes (30): GPUStatus, MeshLLMSplitCapacityAdvice, MeshLLMSplitParticipant, MeshLLMSplitReadiness, MeshLLMSplitReadinessBlocker, MeshLLMStage, MeshLLMStatus, runtimeStagePayload (+22 more)

### Community 20 - "Admin Mesh Harness"
Cohesion: 0.08
Nodes (18): adminUiHtml(), adminUiCss(), AdminUiHarness, descendants(), elementStub(), FetchCall, HarnessOptions, PendingTimer (+10 more)

### Community 21 - "Node Auth Endpoints"
Cohesion: 0.11
Nodes (29): desiredAgentVersion(), AUTH_ANCHORS, bearerToken(), createTokenId(), hashToken(), isSecretFieldName(), randomHex(), redactSecrets() (+21 more)

### Community 22 - "Worker Workflow Tests"
Cohesion: 0.07
Nodes (25): dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler, yaml (+17 more)

### Community 23 - "Router End-To-End Tests"
Cohesion: 0.09
Nodes (9): resetJwksCache(), bearer(), identityGroupsFetcher(), makeMesh(), mintKey(), roleRouter(), routerFixture(), accessJwksFetcher() (+1 more)

### Community 24 - "Runtime Version Controls"
Cohesion: 0.11
Nodes (21): handleAdminRuntimeVersions(), handleAdminRuntimeVersionSelect(), handleApiRuntimeVersions(), handleApiRuntimeVersionSet(), currentTags(), fetchReleaseTags(), handleRuntimeVersionsList(), handleRuntimeVersionsSelect() (+13 more)

### Community 25 - "Direct Affinity Durable"
Cohesion: 0.09
Nodes (7): decideDirectSession(), DIRECT_AFFINITY_ANCHORS, DirectAffinityOutcome, DirectSessionDecisionRequest, DURABLE_ANCHORS, selectNode(), Store

### Community 26 - "MeshLLM Argument Rendering"
Cohesion: 0.26
Nodes (21): MeshLLMRenderInput, flashAttentionValue(), MeshLLMConfigTOML(), RenderMeshLLMArgs(), allRenderForms(), argvValue(), assertNoForbiddenFlags(), T (+13 more)

### Community 27 - "Access JWT Tests"
Cohesion: 0.12
Nodes (17): ACCESS_ANCHORS, AccessConfig, AccessJwk, AccessVerification, base64UrlToBytes(), claimsValid(), decodeSegment(), findKey() (+9 more)

### Community 28 - "Worker Entry Versions"
Cohesion: 0.10
Nodes (10): emptyEnv, FetchCall, ListBody, StoredCache, RegistryDO, SessionAffinityDO, fetch(), INDEX_ANCHORS (+2 more)

### Community 29 - "Mesh Crypto Tests"
Cohesion: 0.14
Nodes (18): decryptJson(), EncryptedEnvelope, encryptJson(), fromBase64(), importMeshStateKey(), MESH_CRYPTO_ANCHORS, toBase64(), MeshStateRecord (+10 more)

### Community 30 - "Agent Runtime Profiles"
Cohesion: 0.18
Nodes (16): Config, RuntimeBinaryVersions, runtimeLoadState, beginRuntimeProfileRestart(), MeshBootstrap, ModelProfile, llamaCppBinaryPath(), llamaCppInput() (+8 more)

### Community 31 - "Agent HTTP Client"
Cohesion: 0.22
Nodes (13): ClaimRequest, Client, meshProcess, Context, CancelFunc, fetchLocalBody(), fetchMeshLLMModels(), fetchMeshLLMRuntimeStages() (+5 more)

### Community 32 - "D1 Store Unit Tests"
Cohesion: 0.19
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 33 - "Agent Service Metrics"
Cohesion: 0.19
Nodes (10): agentUpdater, runtimeTelemetry, serviceLoop, applyMeshStatusMetrics(), NodeMetrics, heartbeatLoop(), meshWaitStuck(), runtimeMetrics() (+2 more)

### Community 34 - "Workflow Safety Script"
Cohesion: 0.22
Nodes (18): actionUses(), checkoutSteps(), escapeRegExp(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin() (+10 more)

### Community 35 - "Agent Version Controls"
Cohesion: 0.17
Nodes (16): AGENT_VERSIONS_ANCHORS, AgentVersionsCache, AgentVersionsEnv, extractReleaseTags(), fetchReleaseTags(), handleAgentVersionSelect(), handleAgentVersionsList(), isCacheFresh() (+8 more)

### Community 36 - "Setup State Access"
Cohesion: 0.15
Nodes (17): extractAccessJwt(), fetchIdentityGroups(), verifyAccessRequest(), adminUiState(), handleSetupAccess(), handleSetupComplete(), normalizeGroupList(), provisionAccess() (+9 more)

### Community 37 - "Agent Config Detection"
Cohesion: 0.28
Nodes (15): Addr, NamedInterface, IP, TestREQNODE008DetectsWARPAdapterAndIP(), DetectHostMeshIP(), DetectMeshIP(), detectWARPInterfaceIP(), DetectWARPInterfaceName() (+7 more)

### Community 38 - "Mesh Manager Test Fakes"
Cohesion: 0.24
Nodes (9): eventLog, fakeLaunch, fakeMeshProcess, launchRecord, managerFixture, Once, Mutex, Signal (+1 more)

### Community 39 - "Runtime Profile Restart"
Cohesion: 0.25
Nodes (12): meshRuntime, beginRestart(), finishRestart(), CancelFunc, Context, Duration, HeartbeatResponse, Mutex (+4 more)

### Community 40 - "Agent Command Entrypoint"
Cohesion: 0.22
Nodes (14): meshRuntimeBudgetReporter, runtimeTargetFunc, splitReadinessPoller, configPathFromArgs(), defaultDataDir(), execCommandRunner(), Server, main() (+6 more)

### Community 41 - "Admin Status APIs"
Cohesion: 0.20
Nodes (16): apiSetNodeDeactivated(), handleAdminStatus(), handleApiNodeActivate(), handleApiNodeDeactivate(), handleApiNodeGet(), handleApiNodeList(), handleApiNodeReconfigure(), handleApiSettingsGet() (+8 more)

### Community 42 - "Agent Config Persistence"
Cohesion: 0.33
Nodes (14): ClaimResponse, HeartbeatIdentity, HeartbeatResponse, MeshBootstrap, activeDesiredProfiles(), ApplyClaim(), ApplyDesiredProfiles(), ApplyDesiredRuntimeVersions() (+6 more)

### Community 43 - "Agent Dashboard Controls"
Cohesion: 0.25
Nodes (14): DashboardStatus, dashboardCard(), dashboardControlAllowed(), DashboardHandler(), dashboardHTML(), dashboardRuntimeCard(), Context, Handler (+6 more)

### Community 44 - "Model Management APIs"
Cohesion: 0.22
Nodes (15): slugify(), configureLlamaCppProfile(), handleApiModelAdd(), handleApiModelConfigure(), handleApiModelList(), handleProfileAdd(), handleProfileConfig(), LLAMACPP_CACHE_TYPES (+7 more)

### Community 45 - "GPU Metrics Parsing"
Cohesion: 0.24
Nodes (12): NodeMetrics, TestREQOBS009ReportsLastRuntimeError(), Context, NodeMetrics, GPUFallbackMetrics(), nvidiaSMIArgs(), parseSystemProfilerVRAM(), parseVRAMToMiB() (+4 more)

### Community 46 - "Workspace Package Metadata"
Cohesion: 0.14
Nodes (13): description, engines, node, name, private, scripts, cf-types, dry-run (+5 more)

### Community 47 - "Installer Script Generation"
Cohesion: 0.21
Nodes (13): INSTALLER_ANCHORS, InstallerArch, installerCommand(), InstallerInput, InstallerPlan, InstallerPlatform, installScript(), InstallScriptInput (+5 more)

### Community 48 - "Rate Limit Logic"
Cohesion: 0.28
Nodes (9): bearerToken(), BUCKET_BINDING, classifyRoute(), isRateLimited(), RateBucket, rateKey(), sha256Hex(), TOKEN_KEYED (+1 more)

### Community 49 - "Model Profile Builder"
Cohesion: 0.26
Nodes (10): buildCustomProfile(), LLAMACPP_PROFILE_DEFAULTS, MESHLLM_RECURRENT_REF_MARKERS, MESHLLM_TUNABLE_DEFAULTS, meshllmPayloadMode(), modelRefSegment(), parseLlamaCppModelRef(), PROFILE_ANCHORS (+2 more)

### Community 50 - "TypeScript Base Config"
Cohesion: 0.17
Nodes (11): compilerOptions, exactOptionalPropertyTypes, lib, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+3 more)

### Community 51 - "Firewall Rule Provisioning"
Cohesion: 0.36
Nodes (8): CommandRunner, provisionMeshPeerFirewall(), EnsureInboundRule(), ensureLinuxRule(), ensureWindowsRule(), Context, T, TestREQNODE010EnsureInboundRule()

### Community 52 - "Runtime Lifecycle Tests"
Cohesion: 0.33
Nodes (6): fakeRuntimeController, argvContains(), Context, TestREQRUN005RuntimeManagerUsesProcessLifetimeContext(), TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline(), TestREQRUN007RestartWithInputRelaunchesWithNewProfileArgs()

### Community 53 - "OG Image Rasterizer"
Cohesion: 0.25
Nodes (7): fontFiles, here, png, pngPath, resvg, svg, svgPath

### Community 54 - "Initial D1 Schema"
Cohesion: 0.25
Nodes (7): audit_events, model_profiles, nodes, reservations, router_config, sessions, tokens

### Community 55 - "Deploy Settings Resolver"
Cohesion: 0.33
Nodes (5): DEPLOY_SETTINGS_ANCHORS, output, validHostnameLabel(), validWorkerBaseUrl(), workerBaseUrl

### Community 56 - "Router TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, noEmit, rootDir, exclude, extends, include

### Community 57 - "Mesh Console Fixture"
Cohesion: 0.40
Nodes (3): consoleFixture, Request, ResponseWriter

### Community 58 - "Mesh IP Fuzzing"
Cohesion: 0.40
Nodes (3): fuzzAddr, F, FuzzDetectMeshIP()

### Community 59 - "Mesh Process Signals"
Cohesion: 0.40
Nodes (3): execMeshProcess, Cmd, Signal

### Community 60 - "Runtime Error Log Tests"
Cohesion: 0.60
Nodes (4): T, TestREQOBS011RuntimeErrorDetailReflectsRing(), TestREQOBS011RuntimeLogCapturesLastErrorLine(), TestREQOBS011RuntimeLogHandlesSplitWrites()

## Knowledge Gaps
- **174 isolated node(s):** `here`, `svgPath`, `pngPath`, `fontFiles`, `svg` (+169 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MeshLLMManager` connect `MeshLLM Runtime Manager` to `Agent Test Runtime Fakes`, `LlamaCpp Runtime Manager`, `Mesh Manager Test Fakes`, `MeshLLM Manager Tests`, `MeshLLM Argument Rendering`, `Agent Runtime Profiles`, `Agent HTTP Client`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `Config` connect `Agent Runtime Profiles` to `Agent Service Metrics`, `Agent Test Runtime Fakes`, `Agent Config Detection`, `Runtime Profile Restart`, `Agent Command Entrypoint`, `Agent Config Persistence`, `Agent Dashboard Controls`, `Agent Heartbeat Tests`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `startMeshRuntime()` connect `Agent Runtime Profiles` to `Runtime Binary Installers`, `Runtime Profile Restart`, `Agent Command Entrypoint`, `MeshLLM Runtime Manager`, `MeshLLM Manager Tests`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Are the 133 inferred relationships involving `Release and CI verification` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Release and CI verification` has 133 INFERRED edges - model-reasoned connections that need verification._
- **Are the 129 inferred relationships involving `Observability and diagnostics` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Observability and diagnostics` has 129 INFERRED edges - model-reasoned connections that need verification._
- **Are the 120 inferred relationships involving `Router Worker` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Router Worker` has 120 INFERRED edges - model-reasoned connections that need verification._
- **Are the 90 inferred relationships involving `Admin console and setup UI` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Admin console and setup UI` has 90 INFERRED edges - model-reasoned connections that need verification._