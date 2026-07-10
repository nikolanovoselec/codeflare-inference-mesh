# Graph Report - /home/user/workspace/codeflare-inference-mesh  (2026-07-09)

## Corpus Check
- label apply mode — file stats not available

## Summary
- 1501 nodes · 3836 edges · 58 communities (52 shown, 6 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 296 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `26dde025`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Mesh LLM process manager|Mesh LLM process manager]]
- [[_COMMUNITY_Model binary installation|Model binary installation]]
- [[_COMMUNITY_Agent service runtime orchestration|Agent service runtime orchestration]]
- [[_COMMUNITY_Inference request routing|Inference request routing]]
- [[_COMMUNITY_Cloudflare API access provisioning|Cloudflare API access provisioning]]
- [[_COMMUNITY_Mesh state and bootstrap|Mesh state and bootstrap]]
- [[_COMMUNITY_Agent service integration tests|Agent service integration tests]]
- [[_COMMUNITY_Mesh LLM manager unit tests|Mesh LLM manager unit tests]]
- [[_COMMUNITY_Agent self-update mechanism|Agent self-update mechanism]]
- [[_COMMUNITY_Router admin API handlers|Router admin API handlers]]
- [[_COMMUNITY_Request authentication|Request authentication]]
- [[_COMMUNITY_LlamaCpp runtime management|LlamaCpp runtime management]]
- [[_COMMUNITY_Router D1 database store|Router D1 database store]]
- [[_COMMUNITY_Agent test helpers and config|Agent test helpers and config]]
- [[_COMMUNITY_Inference request scheduler|Inference request scheduler]]
- [[_COMMUNITY_Admin UI view components|Admin UI view components]]
- [[_COMMUNITY_Admin UI test harness|Admin UI test harness]]
- [[_COMMUNITY_Cloudflare Workers workflow tests|Cloudflare Workers workflow tests]]
- [[_COMMUNITY_Access JWT verification|Access JWT verification]]
- [[_COMMUNITY_Agent configuration management|Agent configuration management]]
- [[_COMMUNITY_Router test fixtures|Router test fixtures]]
- [[_COMMUNITY_Admin UI contract and CSS|Admin UI contract and CSS]]
- [[_COMMUNITY_Upstream proxy handler|Upstream proxy handler]]
- [[_COMMUNITY_Agent version cache|Agent version cache]]
- [[_COMMUNITY_Runtime version cache|Runtime version cache]]
- [[_COMMUNITY_Memory store test helpers|Memory store test helpers]]
- [[_COMMUNITY_Agent HTTP client|Agent HTTP client]]
- [[_COMMUNITY_Store interface definition|Store interface definition]]
- [[_COMMUNITY_D1 database test fakes|D1 database test fakes]]
- [[_COMMUNITY_Workflow safety validation|Workflow safety validation]]
- [[_COMMUNITY_Model profile configuration|Model profile configuration]]
- [[_COMMUNITY_Admin dashboard tests|Admin dashboard tests]]
- [[_COMMUNITY_API node management|API node management]]
- [[_COMMUNITY_Admin setup state machine|Admin setup state machine]]
- [[_COMMUNITY_Agent operational dashboard|Agent operational dashboard]]
- [[_COMMUNITY_Root workspace package config|Root workspace package config]]
- [[_COMMUNITY_Direct session affinity|Direct session affinity]]
- [[_COMMUNITY_Install script generation|Install script generation]]
- [[_COMMUNITY_GPU and runtime metrics|GPU and runtime metrics]]
- [[_COMMUNITY_Request rate limiting|Request rate limiting]]
- [[_COMMUNITY_Shared TypeScript compiler config|Shared TypeScript compiler config]]
- [[_COMMUNITY_Router test utility helpers|Router test utility helpers]]
- [[_COMMUNITY_Model profile defaults and parsing|Model profile defaults and parsing]]
- [[_COMMUNITY_OG image generation|OG image generation]]
- [[_COMMUNITY_Initial D1 migration schema|Initial D1 migration schema]]
- [[_COMMUNITY_Agent runtime manager tests|Agent runtime manager tests]]
- [[_COMMUNITY_Deploy settings resolution|Deploy settings resolution]]
- [[_COMMUNITY_Router TypeScript configuration|Router TypeScript configuration]]
- [[_COMMUNITY_Address fuzz testing|Address fuzz testing]]
- [[_COMMUNITY_Script linting|Script linting]]
- [[_COMMUNITY_Unix service signals|Unix service signals]]
- [[_COMMUNITY_Windows service signals|Windows service signals]]
- [[_COMMUNITY_Deploy gate evaluation|Deploy gate evaluation]]
- [[_COMMUNITY_Direct sessions migration|Direct sessions migration]]
- [[_COMMUNITY_Node agent Go module|Node agent Go module]]

## God Nodes (most connected - your core abstractions)
1. `createRouter()` - 84 edges
2. `json()` - 79 edges
3. `MeshLLMManager` - 44 edges
4. `Store` - 37 edges
5. `LlamaCppManager` - 34 edges
6. `MemoryStore` - 32 edges
7. `fakeMeshRuntime` - 31 edges
8. `Config` - 31 edges
9. `requireAdmin()` - 31 edges
10. `D1Store` - 30 edges

## Surprising Connections (you probably didn't know these)
- `runInstall()` --calls--> `DefaultConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `ListenerAddress()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `SaveConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `ServiceInstallPlan()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/service.go
- `runService()` --calls--> `ApplyClaim()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go

## Import Cycles
- None detected.

## Communities (58 total, 6 thin omitted)

### Community 0 - "Mesh LLM process manager"
Cohesion: 0.05
Nodes (55): execMeshProcess, GPUStatus, meshLauncher, MeshLLMManager, MeshLLMRenderInput, MeshLLMStatus, meshProcess, Cmd (+47 more)

### Community 1 - "Model binary installation"
Cohesion: 0.07
Nodes (84): fakeArchiveEntry, LlamaCppAsset, LlamaCppInstallOption, llamaCppInstallOptions, LlamaCppReleaseAsset, llamaCppReleaseResponse, MeshLLMAsset, MeshLLMInstallOption (+76 more)

### Community 2 - "Agent service runtime orchestration"
Cohesion: 0.06
Nodes (63): CommandRunner, HeartbeatIdentity, LlamaCppInput, LlamaCppSettings, MeshLLMSettings, ModelProfile, PrefixCacheSettings, ReasoningSettings (+55 more)

### Community 3 - "Inference request routing"
Cohesion: 0.05
Nodes (71): approvedNodeHeaders(), directSessionKey(), validateCustomDomain(), isDefaultModelId(), boundedInt(), classifyModelDeletion(), cleanString(), ConsoleRole (+63 more)

### Community 4 - "Cloudflare API access provisioning"
Cohesion: 0.05
Nodes (39): ACCESS_PROVISIONING_ANCHORS, AccessAppRecord, AccessGroupRecord, AccessPolicyRecord, AccessProvisionRequest, AccessProvisionResult, CloudflareAccessClient, MACHINE_BYPASS_SUFFIXES (+31 more)

### Community 5 - "Mesh state and bootstrap"
Cohesion: 0.07
Nodes (53): DURABLE_ANCHORS, RegistryDO, SessionAffinityDO, decryptJson(), EncryptedEnvelope, encryptJson(), fromBase64(), importMeshStateKey() (+45 more)

### Community 6 - "Agent service integration tests"
Cohesion: 0.08
Nodes (37): HeartbeatRequest, fakeMeshRuntime, fakeUpdater, routerFixture, runtimeMetrics(), Context, HeartbeatResponse, MeshBootstrap (+29 more)

### Community 7 - "Mesh LLM manager unit tests"
Cohesion: 0.10
Nodes (44): consoleFixture, eventLog, fakeLaunch, fakeMeshProcess, launchRecord, managerFixture, modelsFixture, Once (+36 more)

### Community 8 - "Agent self-update mechanism"
Cohesion: 0.10
Nodes (37): fakeSelfUpdateEnv, SelfUpdateOption, SelfUpdater, UpdateAsset, UpdatePlan, containsEnv(), applyStagedBinary(), atomicSwap() (+29 more)

### Community 9 - "Router admin API handlers"
Cohesion: 0.12
Nodes (46): applyFleetSettings(), createRouter(), handleAdminAgentVersions(), handleAdminAgentVersionSelect(), handleAdminLogin(), handleAdminMeshRotate(), handleAdminRuntimeVersions(), handleAdminRuntimeVersionSelect() (+38 more)

### Community 10 - "Request authentication"
Cohesion: 0.10
Nodes (37): AUTH_ANCHORS, bearerToken(), createTokenId(), createTokenRecord(), generateBearerToken(), hashToken(), isSecretFieldName(), randomHex() (+29 more)

### Community 11 - "LlamaCpp runtime management"
Cohesion: 0.08
Nodes (10): LlamaCppManager, runtimeLog, containsString(), CancelFunc, Context, Duration, MeshBootstrap, Mutex (+2 more)

### Community 12 - "Router D1 database store"
Cohesion: 0.10
Nodes (16): normalizeModelProfile(), D1Store, directSessionFromRow(), DirectSessionRow, GATE_CONFIG_KEYS, gateConfigCache, materializeNode(), nodeFromRow() (+8 more)

### Community 13 - "Agent test helpers and config"
Cohesion: 0.14
Nodes (35): argvContains(), T, TestConfigPathHonorsExplicitConfigEnv(), TestREQLLAMACPPHeartbeatReportsSelectedDirectRuntime(), TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(), TestREQNODE004DashboardRendersOperationalStatusUI(), TestREQNODE004DashboardReportsMeshLLMRuntimePanel(), TestREQNODE004DashboardRuntimeControlsReportUnavailableWithoutController() (+27 more)

### Community 14 - "Inference request scheduler"
Cohesion: 0.09
Nodes (24): fetch(), INDEX_ANCHORS, DEFAULT_MODEL_PROFILES, eligibleNodes(), isDirectEligible(), isEligible(), isSafeMeshTarget(), SCHEDULER_ANCHORS (+16 more)

### Community 15 - "Admin UI view components"
Cohesion: 0.19
Nodes (31): ADMIN_UI_FIELD_ANCHOR, button(), ButtonOptions, escapeHtml(), field(), FieldOptions, navItem(), NavItemOptions (+23 more)

### Community 16 - "Admin UI test harness"
Cohesion: 0.08
Nodes (19): ADMIN_UI_AGENT_VERSION, ADMIN_UI_DRAWER, ADMIN_UI_MESH_HEALTH, MeshHealthEntry, MeshUiStatusNode, AdminUiHarness, descendants(), elementStub() (+11 more)

### Community 17 - "Cloudflare Workers workflow tests"
Cohesion: 0.07
Nodes (25): dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler, yaml (+17 more)

### Community 18 - "Access JWT verification"
Cohesion: 0.12
Nodes (20): ACCESS_ANCHORS, AccessConfig, AccessJwk, AccessVerification, base64UrlToBytes(), claimsValid(), decodeSegment(), extractAccessJwt() (+12 more)

### Community 19 - "Agent configuration management"
Cohesion: 0.16
Nodes (24): Addr, Config, NamedInterface, RuntimeBinaryVersions, ServiceInstall, IP, TestREQNODE001ServiceSkeletonAndListenerPolicy(), ApplyDetectedMeshIP() (+16 more)

### Community 20 - "Router test fixtures"
Cohesion: 0.10
Nodes (9): resetJwksCache(), bearer(), identityGroupsFetcher(), makeMesh(), mintKey(), roleRouter(), routerFixture(), accessJwksFetcher() (+1 more)

### Community 21 - "Admin UI contract and CSS"
Cohesion: 0.16
Nodes (22): ADMIN_UI_ANCHORS, AdminUiState, ActivationProfileView, ADMIN_UI_ACTIONS, ADMIN_UI_CONFIRM, ADMIN_UI_NAV, ADMIN_UI_PLAYGROUND, ADMIN_UI_POLLING (+14 more)

### Community 22 - "Upstream proxy handler"
Cohesion: 0.13
Nodes (18): ActiveCounter, mutableTarget, RuntimeTargetProvider, staticTarget, HandlerFunc, Header, TestREQNODE003UpstreamProxyEnforcesBearerAndStreams(), containsArgSequence() (+10 more)

### Community 23 - "Agent version cache"
Cohesion: 0.12
Nodes (15): AGENT_VERSIONS_ANCHORS, AgentVersionsCache, AgentVersionsEnv, extractReleaseTags(), fetchReleaseTags(), handleAgentVersionSelect(), handleAgentVersionsList(), isCacheFresh() (+7 more)

### Community 24 - "Runtime version cache"
Cohesion: 0.14
Nodes (18): InvalidJsonBodyError, currentTags(), fetchReleaseTags(), handleRuntimeVersionsList(), handleRuntimeVersionsSelect(), isCacheFresh(), json(), JSON_HEADERS (+10 more)

### Community 25 - "Memory store test helpers"
Cohesion: 0.13
Nodes (7): seedAutomationKey(), tokenFromRow(), TokenRow, MemoryStore, AuditEvent, CredentialKind, TokenRecord

### Community 26 - "Agent HTTP client"
Cohesion: 0.22
Nodes (18): ClaimRequest, ClaimResponse, Client, HeartbeatRequest, HeartbeatResponse, MeshBootstrap, activeDesiredProfiles(), ApplyClaim() (+10 more)

### Community 27 - "Store interface definition"
Cohesion: 0.10
Nodes (3): decideDirectSession(), selectNode(), Store

### Community 28 - "D1 database test fakes"
Cohesion: 0.19
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 29 - "Workflow safety validation"
Cohesion: 0.22
Nodes (18): actionUses(), checkoutSteps(), escapeRegExp(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin() (+10 more)

### Community 30 - "Model profile configuration"
Cohesion: 0.21
Nodes (17): buildCustomProfile(), modelRefSegment(), slugify(), slugifyModelRef(), configureLlamaCppProfile(), handleApiModelAdd(), handleApiModelConfigure(), handleProfileAdd() (+9 more)

### Community 31 - "Admin dashboard tests"
Cohesion: 0.17
Nodes (13): adminUiHtml(), ADMIN_UI_NODES_TABLE, ADMIN_UI_RUNTIME_VERSION, dashboardHarness(), dashboardNodes, DashboardOptions, dashboardProfiles, rowOrder() (+5 more)

### Community 32 - "API node management"
Cohesion: 0.20
Nodes (15): desiredAgentVersion(), apiSetNodeDeactivated(), handleAdminStatus(), handleApiNodeActivate(), handleApiNodeDeactivate(), handleApiNodeGet(), handleApiNodeList(), handleApiNodeReconfigure() (+7 more)

### Community 33 - "Admin setup state machine"
Cohesion: 0.18
Nodes (14): adminUiState(), handleSetupAccess(), handleSetupComplete(), normalizeGroupList(), provisionAccess(), resolveHostGate(), resolveRole(), accessConfig() (+6 more)

### Community 34 - "Agent operational dashboard"
Cohesion: 0.24
Nodes (13): DashboardStatus, RuntimeController, dashboardCard(), dashboardControlAllowed(), dashboardHTML(), dashboardRuntimeCard(), Context, NodeMetrics (+5 more)

### Community 35 - "Root workspace package config"
Cohesion: 0.14
Nodes (13): description, engines, node, name, private, scripts, cf-types, dry-run (+5 more)

### Community 36 - "Direct session affinity"
Cohesion: 0.18
Nodes (6): DIRECT_AFFINITY_ANCHORS, DirectAffinityOutcome, DirectSessionDecision, DirectSessionDecisionRequest, DirectSessionRecord, NodeRecord

### Community 37 - "Install script generation"
Cohesion: 0.21
Nodes (13): INSTALLER_ANCHORS, InstallerArch, installerCommand(), InstallerInput, InstallerPlan, InstallerPlatform, installScript(), InstallScriptInput (+5 more)

### Community 38 - "GPU and runtime metrics"
Cohesion: 0.27
Nodes (11): NodeMetrics, Context, NodeMetrics, GPUFallbackMetrics(), nvidiaSMIArgs(), parseSystemProfilerVRAM(), parseVRAMToMiB(), atoi() (+3 more)

### Community 39 - "Request rate limiting"
Cohesion: 0.28
Nodes (9): bearerToken(), BUCKET_BINDING, classifyRoute(), isRateLimited(), RateBucket, rateKey(), sha256Hex(), TOKEN_KEYED (+1 more)

### Community 40 - "Shared TypeScript compiler config"
Cohesion: 0.17
Nodes (11): compilerOptions, exactOptionalPropertyTypes, lib, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+3 more)

### Community 41 - "Router test utility helpers"
Cohesion: 0.31
Nodes (7): meshNode(), accessBase64Url(), nodeFixture(), retiredDefaultProfiles(), seedDefaultActivation(), shouldRefreshDefaultProfile(), signAccessJwt()

### Community 42 - "Model profile defaults and parsing"
Cohesion: 0.25
Nodes (7): LLAMACPP_PROFILE_DEFAULTS, MESHLLM_RECURRENT_REF_MARKERS, MESHLLM_TUNABLE_DEFAULTS, meshllmPayloadMode(), parseLlamaCppModelRef(), PROFILE_ANCHORS, RuntimeKind

### Community 43 - "OG image generation"
Cohesion: 0.25
Nodes (7): fontFiles, here, png, pngPath, resvg, svg, svgPath

### Community 44 - "Initial D1 migration schema"
Cohesion: 0.25
Nodes (7): audit_events, model_profiles, nodes, reservations, router_config, sessions, tokens

### Community 45 - "Agent runtime manager tests"
Cohesion: 0.48
Nodes (4): fakeRuntimeController, Context, TestREQRUN005RuntimeManagerUsesProcessLifetimeContext(), TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline()

### Community 46 - "Deploy settings resolution"
Cohesion: 0.33
Nodes (5): DEPLOY_SETTINGS_ANCHORS, output, validHostnameLabel(), validWorkerBaseUrl(), workerBaseUrl

### Community 47 - "Router TypeScript configuration"
Cohesion: 0.29
Nodes (6): compilerOptions, noEmit, rootDir, exclude, extends, include

### Community 48 - "Address fuzz testing"
Cohesion: 0.40
Nodes (3): fuzzAddr, F, FuzzDetectMeshIP()

## Knowledge Gaps
- **164 isolated node(s):** `here`, `svgPath`, `pngPath`, `fontFiles`, `svg` (+159 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MeshLLMManager` connect `Mesh LLM process manager` to `Agent service runtime orchestration`, `Agent service integration tests`, `Mesh LLM manager unit tests`, `LlamaCpp runtime management`, `Agent HTTP client`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `Config` connect `Agent configuration management` to `Agent operational dashboard`, `Agent service runtime orchestration`, `Agent service integration tests`, `Agent test helpers and config`, `Agent HTTP client`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `startMeshRuntime()` connect `Agent service runtime orchestration` to `Mesh LLM process manager`, `Model binary installation`, `Agent configuration management`, `Mesh LLM manager unit tests`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `here`, `svgPath`, `pngPath` to the rest of the system?**
  _164 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Mesh LLM process manager` be split into smaller, more focused modules?**
  _Cohesion score 0.052503052503052504 - nodes in this community are weakly interconnected._
- **Should `Model binary installation` be split into smaller, more focused modules?**
  _Cohesion score 0.07175689479060265 - nodes in this community are weakly interconnected._
- **Should `Agent service runtime orchestration` be split into smaller, more focused modules?**
  _Cohesion score 0.05799373040752351 - nodes in this community are weakly interconnected._