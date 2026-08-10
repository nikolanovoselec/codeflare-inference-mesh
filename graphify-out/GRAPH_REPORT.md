# Graph Report - codeflare-inference-mesh  (2026-08-10)

## Corpus Check
- 121 files · ~293,699 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1962 nodes · 5994 edges · 74 communities (64 shown, 10 thin omitted)
- Extraction: 77% EXTRACTED · 23% INFERRED · 0% AMBIGUOUS · INFERRED: 1371 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `16d25139`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- SDD Requirements Corpus
- Runtime Binary Installers
- Agent Test Runtime Fakes
- Router Inference Handlers
- Cloudflare Provisioning Clients
- LlamaCpp Runtime Manager
- Router Auth Handlers
- Public Documentation Corpus
- Agent Self Update
- Admin UI Shell
- Router Test Store Types
- Scheduler Type Contracts
- Admin UI Views
- Mesh State Bootstrap
- D1 Store Profiles
- MeshLLM Runtime Manager
- MeshLLM Manager Tests
- Agent Heartbeat Tests
- SDD Glossary Terms
- MeshLLM Status Parser
- Admin Mesh Harness
- Node Auth Endpoints
- Worker Workflow Tests
- Router End-To-End Tests
- Runtime Version Controls
- Direct Affinity Durable
- MeshLLM Argument Rendering
- Access JWT Tests
- Worker Entry Versions
- Mesh Crypto Tests
- Agent Runtime Profiles
- Agent HTTP Client
- D1 Store Unit Tests
- Agent Service Metrics
- Workflow Safety Script
- Agent Version Controls
- Setup State Access
- Agent Config Detection
- Mesh Manager Test Fakes
- Runtime Profile Restart
- Agent Command Entrypoint
- Admin Status APIs
- Agent Config Persistence
- Agent Dashboard Controls
- Model Management APIs
- GPU Metrics Parsing
- Workspace Package Metadata
- Installer Script Generation
- Rate Limit Logic
- Model Profile Builder
- TypeScript Base Config
- Firewall Rule Provisioning
- Runtime Lifecycle Tests
- OG Image Rasterizer
- Initial D1 Schema
- Deploy Settings Resolver
- Router TypeScript Config
- Mesh Console Fixture
- Mesh IP Fuzzing
- Mesh Process Signals
- Runtime Error Log Tests
- Script Lint Walker
- Service Install Plan
- Unix Signal Handling
- Windows Signal Handling
- Deploy Gate Script
- Direct Session Migration
- Mesh Token Lifecycle
- Review Queue Spec
- SDD Change Log
- Node Agent Module

## God Nodes (most connected - your core abstractions)
1. `Constraints` - 132 edges
2. `createRouter()` - 92 edges
3. `json()` - 92 edges
4. `MeshLLMManager` - 46 edges
5. `Setup Admin` - 44 edges
6. `LlamaCppManager` - 38 edges
7. `Store` - 38 edges
8. `Runtime Profiles` - 38 edges
9. `requireAdmin()` - 37 edges
10. `serviceLoop` - 35 edges

## Surprising Connections (you probably didn't know these)
- `runInstall()` --calls--> `DefaultConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `SaveConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runService()` --calls--> `ApplyClaim()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go
- `runService()` --calls--> `DetectWARPInterfaceName()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runService()` --calls--> `LoadConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go

## Import Cycles
- None detected.

## Communities (74 total, 10 thin omitted)

### Community 0 - "SDD Requirements Corpus"
Cohesion: 0.10
Nodes (168): CON-CF-001: Cloudflare-first public control plane, CON-CF-002: Worker runtime compatibility, CON-CI-001: CI is the verification surface, CON-MODEL-001: Stable Gateway aliases, CON-NET-001: Mesh destination validation, CON-REL-001: Release artifacts are verifiable, CON-RUNTIME-001: Runtime boundaries, CON-SDD-001: SDD and TDD stay coupled (+160 more)

### Community 1 - "Runtime Binary Installers"
Cohesion: 0.07
Nodes (91): fakeArchiveEntry, LlamaCppAsset, LlamaCppInstallOption, llamaCppInstallOptions, LlamaCppReleaseAsset, llamaCppReleaseResponse, MeshLLMAsset, MeshLLMInstallOption (+83 more)

### Community 2 - "Agent Test Runtime Fakes"
Cohesion: 0.06
Nodes (57): ActiveCounter, RuntimeTargetProvider, staticTarget, Header, HeartbeatRequest, fakeMeshRuntime, fakeUpdater, routerFixture (+49 more)

### Community 3 - "Router Inference Handlers"
Cohesion: 0.04
Nodes (83): accessJwtSource, approvedNodeHeaders(), directSessionKey(), validateCustomDomain(), boundedInt(), cleanString(), ConsoleRole, decideDirectSessionWithAffinity() (+75 more)

### Community 4 - "Cloudflare Provisioning Clients"
Cohesion: 0.05
Nodes (41): ACCESS_PROVISIONING_ANCHORS, AccessAppRecord, AccessGroupRecord, AccessPolicyRecord, AccessProvisionRequest, AccessProvisionResult, ADMIN_APP_NAME, BYPASS_APP_NAME (+33 more)

### Community 5 - "LlamaCpp Runtime Manager"
Cohesion: 0.10
Nodes (8): LlamaCppManager, meshLauncher, CancelFunc, Duration, MeshBootstrap, Mutex, NodeMetrics, Time

### Community 6 - "Router Auth Handlers"
Cohesion: 0.10
Nodes (57): applyFleetSettings(), classifyModelDeletion(), createRouter(), duplicateProfileCore(), handleAdminAgentVersions(), handleAdminAgentVersionSelect(), handleAdminLogin(), handleAdminMeshRotate() (+49 more)

### Community 7 - "Public Documentation Corpus"
Cohesion: 0.05
Nodes (40): Setup and admin API routes, Agent self-update, Authenticated AI Gateway, Behavioral verification, Cloudflare Access admin authentication, Codeflare Inference Mesh, codeflare-mesh public alias, GitHub Actions deployment workflow (+32 more)

### Community 8 - "Agent Self Update"
Cohesion: 0.10
Nodes (37): fakeSelfUpdateEnv, SelfUpdateOption, SelfUpdater, UpdateAsset, UpdatePlan, containsEnv(), applyStagedBinary(), atomicSwap() (+29 more)

### Community 9 - "Admin UI Shell"
Cohesion: 0.13
Nodes (29): ADMIN_UI_ANCHORS, AdminUiState, ActivationProfileView, ADMIN_UI_ACTIONS, ADMIN_UI_AGENT_VERSION, ADMIN_UI_CONFIRM, ADMIN_UI_DRAWER, ADMIN_UI_MESH_HEALTH (+21 more)

### Community 10 - "Router Test Store Types"
Cohesion: 0.18
Nodes (16): GPUStatus, MeshLLMStatus, applyMeshStatusMetrics(), DeriveMeshRole(), MapMeshLLMState(), ParseMeshLLMStatus(), ParseModelsResponse(), T (+8 more)

### Community 11 - "Scheduler Type Contracts"
Cohesion: 0.17
Nodes (17): DEFAULT_MODEL_PROFILES, allowedMeshCidrs(), allowedMeshPorts(), cidrContains(), DEFAULT_MESH_CIDRS, DEFAULT_MESH_PORTS, eligibleDirectNodes(), eligibleNodes() (+9 more)

### Community 12 - "Admin UI Views"
Cohesion: 0.15
Nodes (39): ADMIN_UI_FIELD_ANCHOR, button(), ButtonOptions, commandChip(), CommandChipOptions, commandRow(), CommandRowOptions, escapeHtml() (+31 more)

### Community 13 - "Mesh State Bootstrap"
Cohesion: 0.12
Nodes (41): appendMeshAudit(), applyHeartbeatMeshState(), bootstrapFromState(), captureMeshId(), clearedDetail(), electSeedIfAbsent(), emptyMeshState(), handleMeshRotate() (+33 more)

### Community 14 - "D1 Store Profiles"
Cohesion: 0.05
Nodes (33): DirectSessionDecision, LLAMACPP_PROFILE_DEFAULTS, MESHLLM_RECURRENT_REF_MARKERS, MESHLLM_TUNABLE_DEFAULTS, meshllmPayloadMode(), normalizeModelProfile(), parseLlamaCppModelRef(), PROFILE_ANCHORS (+25 more)

### Community 15 - "MeshLLM Runtime Manager"
Cohesion: 0.10
Nodes (7): MeshLLMManager, meshProcess, CancelFunc, Duration, MeshBootstrap, Mutex, Time

### Community 16 - "MeshLLM Manager Tests"
Cohesion: 0.09
Nodes (50): consoleFixture, eventLog, fakeLaunch, fakeMeshProcess, launchRecord, managerFixture, modelsFixture, Once (+42 more)

### Community 17 - "Agent Heartbeat Tests"
Cohesion: 0.12
Nodes (42): NodeMetrics, argvContains(), T, TestConfigPathHonorsExplicitConfigEnv(), TestREQLLAMACPPHeartbeatReportsSelectedDirectRuntime(), TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(), TestREQNODE003UpstreamProxyEnforcesBearerAndStreams(), TestREQNODE004DashboardRendersOperationalStatusUI() (+34 more)

### Community 18 - "SDD Glossary Terms"
Cohesion: 0.06
Nodes (35): Access Application, Access JWT, Agent Release, AI Gateway, Bootstrap Origin, Break-Glass Recovery, Cloudflare Mesh, Console API (+27 more)

### Community 19 - "MeshLLM Status Parser"
Cohesion: 0.22
Nodes (17): MeshLLMSplitCapacityAdvice, MeshLLMSplitParticipant, MeshLLMSplitReadiness, MeshLLMSplitReadinessBlocker, MeshLLMStage, runtimeStagePayload, fetchMeshLLMSplitReadiness(), firstNonEmpty() (+9 more)

### Community 20 - "Admin Mesh Harness"
Cohesion: 0.07
Nodes (29): adminUiHtml(), adminUiCss(), CHIP_TONES, chipToneCss(), dashboardHarness(), dashboardNodes, DashboardOptions, dashboardProfiles (+21 more)

### Community 21 - "Node Auth Endpoints"
Cohesion: 0.10
Nodes (37): desiredAgentVersion(), AUTH_ANCHORS, bearerToken(), createTokenId(), createTokenRecord(), generateBearerToken(), hashToken(), isSecretFieldName() (+29 more)

### Community 22 - "Worker Workflow Tests"
Cohesion: 0.06
Nodes (31): @cloudflare/workers-types, dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler (+23 more)

### Community 23 - "Router End-To-End Tests"
Cohesion: 0.08
Nodes (14): resetJwksCache(), ADMIN_UI_CLIENT_SCRIPT, bearer(), identityGroupsFetcher(), LEGACY_MESH_DEFAULT, LEGACY_MESH_SPLIT, makeMesh(), mintKey() (+6 more)

### Community 24 - "Runtime Version Controls"
Cohesion: 0.11
Nodes (30): activeMeshllmRepository(), cacheMatchesRepository(), currentTags(), DEFAULT_LLAMACPP_VERSION, DEFAULT_MESHLLM_VERSION, desiredRuntimeVersions(), fetchReleaseTags(), handleRuntimeVersionsList() (+22 more)

### Community 25 - "Direct Affinity Durable"
Cohesion: 0.06
Nodes (16): decideDirectSession(), DIRECT_AFFINITY_ANCHORS, DIRECT_SESSION_TTL_MS, DirectAffinityOutcome, DirectSessionDecisionRequest, DURABLE_ANCHORS, RegistryDO, SessionAffinityDO (+8 more)

### Community 26 - "MeshLLM Argument Rendering"
Cohesion: 0.22
Nodes (25): MeshLLMRenderInput, flashAttentionValue(), MeshLLMConfigTOML(), MeshLLMEnv(), meshLLMNativeRuntimeManifestURL(), RenderMeshLLMArgs(), allRenderForms(), argvValue() (+17 more)

### Community 27 - "Access JWT Tests"
Cohesion: 0.12
Nodes (19): ACCESS_ANCHORS, AccessConfig, AccessJwk, AccessVerification, base64UrlToBytes(), claimsValid(), decodeSegment(), findKey() (+11 more)

### Community 28 - "Worker Entry Versions"
Cohesion: 0.19
Nodes (17): createMesh(), DEFAULT_MESH_ID, deleteMesh(), listMeshes(), meshAliasFor(), MESHES_ANCHORS, MESHES_CONFIG_KEY, MeshRecord (+9 more)

### Community 29 - "Mesh Crypto Tests"
Cohesion: 0.14
Nodes (18): decryptJson(), EncryptedEnvelope, encryptJson(), fromBase64(), importMeshStateKey(), MESH_CRYPTO_ANCHORS, toBase64(), MeshStateRecord (+10 more)

### Community 30 - "Agent Runtime Profiles"
Cohesion: 0.29
Nodes (8): runtimeLoadState, beginRestart(), beginRuntimeProfileRestart(), finishRestart(), ModelProfile, Mutex, profileKey(), selectedProfileKey()

### Community 31 - "Agent HTTP Client"
Cohesion: 0.21
Nodes (11): Client, execMeshProcess, Cmd, fetchLocalBody(), fetchMeshLLMModels(), fetchMeshLLMRuntimeStages(), fetchMeshLLMStatus(), Context (+3 more)

### Community 32 - "D1 Store Unit Tests"
Cohesion: 0.19
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 33 - "Agent Service Metrics"
Cohesion: 0.60
Nodes (3): runtimeTelemetry, NodeMetrics, RWMutex

### Community 34 - "Workflow Safety Script"
Cohesion: 0.22
Nodes (18): actionUses(), checkoutSteps(), escapeRegExp(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin() (+10 more)

### Community 35 - "Agent Version Controls"
Cohesion: 0.11
Nodes (16): AGENT_VERSIONS_ANCHORS, AgentVersionsCache, AgentVersionsEnv, extractReleaseTags(), fetchReleaseTags(), handleAgentVersionSelect(), handleAgentVersionsList(), isCacheFresh() (+8 more)

### Community 36 - "Setup State Access"
Cohesion: 0.12
Nodes (20): extractAccessJwt(), fetchIdentityGroups(), verifyAccessRequest(), adminUiState(), handleApiKeyList(), handleApiKeyRevoke(), handleSetupComplete(), requireKeyAdmin() (+12 more)

### Community 37 - "Agent Config Detection"
Cohesion: 0.24
Nodes (16): Addr, NamedInterface, RuntimeBinaryVersions, IP, DetectHostMeshIP(), DetectMeshIP(), detectWARPInterfaceIP(), DetectWARPInterfaceName() (+8 more)

### Community 38 - "Mesh Manager Test Fakes"
Cohesion: 0.23
Nodes (16): mutableTarget, Reader, parseLlamaCounters(), containsArgSequence(), T, Time, hasExactArg(), joinArgs() (+8 more)

### Community 39 - "Runtime Profile Restart"
Cohesion: 0.12
Nodes (26): Config, currentRuntimeController, meshRuntime, serviceLoop, CancelFunc, Context, Duration, HeartbeatResponse (+18 more)

### Community 40 - "Agent Command Entrypoint"
Cohesion: 0.14
Nodes (20): ServiceInstall, agentUpdater, meshRuntimeBudgetReporter, runtimeTargetFunc, splitReadinessPoller, configPathFromArgs(), defaultDataDir(), execCommandRunner() (+12 more)

### Community 41 - "Admin Status APIs"
Cohesion: 0.22
Nodes (13): apiSetNodeDeactivated(), handleAdminStatus(), handleApiNodeActivate(), handleApiNodeDeactivate(), handleApiStatus(), newestSpeedTest(), nodeDisplayStatus(), offlinePruneSeconds() (+5 more)

### Community 42 - "Agent Config Persistence"
Cohesion: 0.20
Nodes (18): ClaimRequest, ClaimResponse, HeartbeatIdentity, HeartbeatRequest, HeartbeatResponse, MeshBootstrap, activeDesiredProfiles(), ApplyClaim() (+10 more)

### Community 43 - "Agent Dashboard Controls"
Cohesion: 0.24
Nodes (13): DashboardStatus, RuntimeController, dashboardCard(), dashboardControlAllowed(), dashboardHTML(), dashboardRuntimeCard(), Context, NodeMetrics (+5 more)

### Community 44 - "Model Management APIs"
Cohesion: 0.17
Nodes (21): buildCustomProfile(), buildDuplicateProfile(), modelRefSegment(), slugify(), slugifyModelRef(), configureLlamaCppProfile(), handleApiModelAdd(), handleApiModelConfigure() (+13 more)

### Community 46 - "Workspace Package Metadata"
Cohesion: 0.13
Nodes (14): description, engines, node, name, private, scripts, cf-types, dry-run (+6 more)

### Community 47 - "Installer Script Generation"
Cohesion: 0.19
Nodes (14): INSTALLER_ANCHORS, InstallerArch, installerCommand(), InstallerInput, installerPlan, InstallerPlatform, installScript(), InstallScriptInput (+6 more)

### Community 48 - "Rate Limit Logic"
Cohesion: 0.28
Nodes (9): bearerToken(), BUCKET_BINDING, classifyRoute(), isRateLimited(), RateBucket, rateKey(), sha256Hex(), TOKEN_KEYED (+1 more)

### Community 49 - "Model Profile Builder"
Cohesion: 0.13
Nodes (14): MeshHealthEntry, ClaimRequest, ClaimResponse, HeartbeatResponse, LastSpeedTestSummary, LlamaCppProfileSettings, MeshBootstrap, MeshLLMProfileSettings (+6 more)

### Community 50 - "TypeScript Base Config"
Cohesion: 0.12
Nodes (15): @cloudflare/workers-types, ES2022, node, WebWorker, compilerOptions, exactOptionalPropertyTypes, lib, module (+7 more)

### Community 51 - "Firewall Rule Provisioning"
Cohesion: 0.17
Nodes (19): CommandRunner, EnsureInboundRule(), ensureLinuxRule(), ensureWindowsRule(), Context, T, TestREQNODE010EnsureInboundRule(), appleGPUInUseMiB() (+11 more)

### Community 52 - "Runtime Lifecycle Tests"
Cohesion: 0.53
Nodes (3): fakeRuntimeController, Context, TestREQRUN005RuntimeManagerUsesProcessLifetimeContext()

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
Cohesion: 0.15
Nodes (12): compilerOptions, noEmit, rootDir, exclude, extends, include, dist, node_modules (+4 more)

### Community 57 - "Mesh Console Fixture"
Cohesion: 0.33
Nodes (8): LlamaCppInput, queryLlamaCppVersion(), hfRepoWithQuant(), llamaCppRuntimeEnv(), NewLlamaCppManager(), RenderLlamaCppArgs(), TestREQNODE013LlamaCppLaunchEnvIncludesRuntimeLibraryPath(), upsertPathEnv()

### Community 58 - "Mesh IP Fuzzing"
Cohesion: 0.40
Nodes (3): fuzzAddr, F, FuzzDetectMeshIP()

### Community 59 - "Mesh Process Signals"
Cohesion: 0.25
Nodes (5): fakeLlamaMetrics, Mutex, Request, ResponseWriter, TestREQNODE003ProxyReadsRuntimeTargetPerRequest()

### Community 60 - "Runtime Error Log Tests"
Cohesion: 0.36
Nodes (4): runtimeLog, containsAny(), containsLevelToken(), Mutex

### Community 62 - "Service Install Plan"
Cohesion: 0.67
Nodes (5): LlamaCppSettings, MeshLLMSettings, ModelProfile, PrefixCacheSettings, ReasoningSettings

## Knowledge Gaps
- **196 isolated node(s):** `here`, `svgPath`, `pngPath`, `fontFiles`, `svg` (+191 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `Admin Mesh Harness` to `D1 Store Unit Tests`, `Agent Version Controls`, `Cloudflare Provisioning Clients`, `Scheduler Type Contracts`, `Rate Limit Logic`, `TypeScript Base Config`, `Worker Workflow Tests`, `Router End-To-End Tests`, `Runtime Version Controls`, `Access JWT Tests`, `Worker Entry Versions`, `Mesh Crypto Tests`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `runService()` connect `Agent Command Entrypoint` to `Agent Test Runtime Fakes`, `Agent Config Detection`, `Runtime Profile Restart`, `Agent Self Update`, `Agent Config Persistence`, `Agent Heartbeat Tests`, `Firewall Rule Provisioning`, `Agent Runtime Profiles`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `Config` connect `Runtime Profile Restart` to `Agent Test Runtime Fakes`, `Agent Config Detection`, `Agent Command Entrypoint`, `Agent Config Persistence`, `Agent Dashboard Controls`, `Agent Heartbeat Tests`, `Agent Runtime Profiles`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Are the 133 inferred relationships involving `Release and CI verification` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Release and CI verification` has 133 INFERRED edges - model-reasoned connections that need verification._
- **Are the 129 inferred relationships involving `Observability and diagnostics` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Observability and diagnostics` has 129 INFERRED edges - model-reasoned connections that need verification._
- **Are the 120 inferred relationships involving `Router Worker` (e.g. with `CON-CF-001: Cloudflare-first public control plane` and `CON-CF-002: Worker runtime compatibility`) actually correct?**
  _`Router Worker` has 120 INFERRED edges - model-reasoned connections that need verification._
- **What connects `here`, `svgPath`, `pngPath` to the rest of the system?**
  _196 weakly-connected nodes found - possible documentation gaps or missing edges._