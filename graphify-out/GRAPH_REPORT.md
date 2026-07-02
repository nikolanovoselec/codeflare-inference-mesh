# Graph Report - codeflare-inference-mesh  (2026-07-03)

## Corpus Check
- 90 files · ~106,466 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1427 nodes · 2886 edges · 86 communities (81 shown, 5 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 192 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7d103912`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Router API & Auth Handlers|Router API & Auth Handlers]]
- [[_COMMUNITY_Agent Config & Tests|Agent Config & Tests]]
- [[_COMMUNITY_Agent Service Lifecycle & Proxy|Agent Service Lifecycle & Proxy]]
- [[_COMMUNITY_Reservation Scheduler|Reservation Scheduler]]
- [[_COMMUNITY_Llama Runtime Manager|Llama Runtime Manager]]
- [[_COMMUNITY_Admin UI & Router Tests|Admin UI & Router Tests]]
- [[_COMMUNITY_Cloudflare Gateway Client|Cloudflare Gateway Client]]
- [[_COMMUNITY_Workflow Tests & Packaging|Workflow Tests & Packaging]]
- [[_COMMUNITY_Store Tests & Model Profiles|Store Tests & Model Profiles]]
- [[_COMMUNITY_Workflow Safety Linter|Workflow Safety Linter]]
- [[_COMMUNITY_Agent Claim & Heartbeat Client|Agent Claim & Heartbeat Client]]
- [[_COMMUNITY_Memory Store & Audit|Memory Store & Audit]]
- [[_COMMUNITY_Worker Entry & Registry DO|Worker Entry & Registry DO]]
- [[_COMMUNITY_Root Package Manifest|Root Package Manifest]]
- [[_COMMUNITY_D1 Store Implementation|D1 Store Implementation]]
- [[_COMMUNITY_Agent Dashboard Controls|Agent Dashboard Controls]]
- [[_COMMUNITY_Profile Store Interface|Profile Store Interface]]
- [[_COMMUNITY_Token Credential Store|Token Credential Store]]
- [[_COMMUNITY_Base TypeScript Config|Base TypeScript Config]]
- [[_COMMUNITY_Session Store & Fixtures|Session Store & Fixtures]]
- [[_COMMUNITY_D1 Schema Migration|D1 Schema Migration]]
- [[_COMMUNITY_Deploy Settings Resolver|Deploy Settings Resolver]]
- [[_COMMUNITY_Worker TypeScript Config|Worker TypeScript Config]]
- [[_COMMUNITY_Agent Update Staging|Agent Update Staging]]
- [[_COMMUNITY_Reservation Records|Reservation Records]]
- [[_COMMUNITY_Repo Lint Script|Repo Lint Script]]
- [[_COMMUNITY_Unix Signal Handling|Unix Signal Handling]]
- [[_COMMUNITY_Windows Signal Handling|Windows Signal Handling]]
- [[_COMMUNITY_Deploy Gate Evaluator|Deploy Gate Evaluator]]
- [[_COMMUNITY_Go Module Definition|Go Module Definition]]
- [[_COMMUNITY_mesh-state.ts|mesh-state.ts]]
- [[_COMMUNITY_Config|Config]]
- [[_COMMUNITY_auth.ts|auth.ts]]
- [[_COMMUNITY_agent-versions.test.ts|agent-versions.test.ts]]
- [[_COMMUNITY_main_test.go|main_test.go]]
- [[_COMMUNITY_Endpoints|Endpoints]]
- [[_COMMUNITY_fakeMeshRuntime|fakeMeshRuntime]]
- [[_COMMUNITY_Endpoints|Endpoints]]
- [[_COMMUNITY_json|json]]
- [[_COMMUNITY_installers.ts|installers.ts]]
- [[_COMMUNITY_Architecture Decisions|Architecture Decisions]]
- [[_COMMUNITY_Troubleshooting|Troubleshooting]]
- [[_COMMUNITY_Codeflare Inference Mesh Plan|Codeflare Inference Mesh Plan]]
- [[_COMMUNITY_Constraints|Constraints]]
- [[_COMMUNITY_runService|runService]]
- [[_COMMUNITY_Deployment|Deployment]]
- [[_COMMUNITY_Task groups|Task groups]]
- [[_COMMUNITY_Configuration|Configuration]]
- [[_COMMUNITY_Node Agent Architecture|Node Agent Architecture]]
- [[_COMMUNITY_Codeflare Inference Mesh|Codeflare Inference Mesh]]
- [[_COMMUNITY_Contributing to Codeflare Inference Mesh|Contributing to Codeflare Inference Mesh]]
- [[_COMMUNITY_Security|Security]]
- [[_COMMUNITY_config.go|config.go]]
- [[_COMMUNITY_Architecture|Architecture]]
- [[_COMMUNITY_Alternatives Considered|Alternatives Considered]]
- [[_COMMUNITY_State Persistence And Scheduling|State Persistence And Scheduling]]
- [[_COMMUNITY_Setup And Admin|Setup And Admin]]
- [[_COMMUNITY_Security Policy|Security Policy]]
- [[_COMMUNITY_Observability|Observability]]
- [[_COMMUNITY_Model Virtualization And Stable Gateway Names|Model Virtualization And Stable Gateway Names]]
- [[_COMMUNITY_Implementation Phases|Implementation Phases]]
- [[_COMMUNITY_Product|Product]]
- [[_COMMUNITY_Observability|Observability]]
- [[_COMMUNITY_Runtime Profiles|Runtime Profiles]]
- [[_COMMUNITY_ProxyHandler|ProxyHandler]]
- [[_COMMUNITY_GitHub Actions And Releases|GitHub Actions And Releases]]
- [[_COMMUNITY_Node Agent|Node Agent]]
- [[_COMMUNITY_Security|Security]]
- [[_COMMUNITY_TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline|TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline]]
- [[_COMMUNITY_metrics.go|metrics.go]]
- [[_COMMUNITY_.collect|.collect]]
- [[_COMMUNITY_Failure Modes|Failure Modes]]
- [[_COMMUNITY_Router Worker Architecture|Router Worker Architecture]]
- [[_COMMUNITY_Component Responsibilities|Component Responsibilities]]
- [[_COMMUNITY_Design Principles|Design Principles]]
- [[_COMMUNITY_Validation Gates|Validation Gates]]
- [[_COMMUNITY_Security And Trust Model|Security And Trust Model]]
- [[_COMMUNITY_Model Runtime Strategy|Model Runtime Strategy]]
- [[_COMMUNITY_fakeUpdater|fakeUpdater]]
- [[_COMMUNITY_AI Gateway Setup Flow|AI Gateway Setup Flow]]
- [[_COMMUNITY_Architecture Summary|Architecture Summary]]
- [[_COMMUNITY_Admin UI Polish — Execution Plan|Admin UI Polish — Execution Plan]]
- [[_COMMUNITY_End-To-End Flows|End-To-End Flows]]
- [[_COMMUNITY_Observability|Observability]]

## God Nodes (most connected - your core abstractions)
1. `MeshLLMManager` - 39 edges
2. `Store` - 34 edges
3. `D1Store` - 30 edges
4. `MemoryStore` - 30 edges
5. `Config` - 27 edges
6. `fakeMeshRuntime` - 26 edges
7. `Codeflare Inference Mesh Plan` - 26 edges
8. `newMeshManagerForTest()` - 23 edges
9. `serviceLoop` - 22 edges
10. `json()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `runInstall()` --calls--> `DefaultConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `SaveConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runService()` --calls--> `ApplyClaim()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go
- `runService()` --calls--> `LoadConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runService()` --calls--> `DashboardHandler()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/dashboard.go

## Import Cycles
- None detected.

## Communities (86 total, 5 thin omitted)

### Community 0 - "Router API & Auth Handlers"
Cohesion: 0.13
Nodes (25): approvedNodeHeaders(), CustomDomainProvisionRequest, CustomDomainProvisionResult, GatewaySyncRequest, GatewaySyncResult, validateCustomDomain(), cleanString(), GatewaySettings (+17 more)

### Community 1 - "Agent Config & Tests"
Cohesion: 0.18
Nodes (26): argvContains(), T, TestREQNODE002AppliesDetectedMeshIPBeforeClaim(), TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(), TestREQNODE002DetectsUnambiguousMeshIP(), TestREQNODE002HeartbeatResendsMeshIdentityEveryTick(), TestREQNODE002ResponsesCarryMeshBootstrapAndDesiredVersion(), TestREQNODE003UpstreamProxyEnforcesBearerAndStreams() (+18 more)

### Community 2 - "Agent Service Lifecycle & Proxy"
Cohesion: 0.20
Nodes (12): MeshLLMSettings, ModelProfile, RuntimeController, meshRuntime, runtimeLoadState, beginRestart(), beginRuntimeProfileRestart(), ModelProfile (+4 more)

### Community 3 - "Reservation Scheduler"
Cohesion: 0.06
Nodes (12): DurableSchedulerClient, eligibleNodes(), isEligible(), isSafeMeshTarget(), meshUrl(), SCHEDULER_ANCHORS, selectNode(), StoreScheduler (+4 more)

### Community 4 - "Llama Runtime Manager"
Cohesion: 0.06
Nodes (48): execMeshProcess, meshLauncher, MeshLLMManager, MeshLLMRenderInput, MeshLLMStatus, meshProcess, CancelFunc, Cmd (+40 more)

### Community 5 - "Admin UI & Router Tests"
Cohesion: 0.05
Nodes (42): actionRow(), ActionRowOptions, ActivationProfileView, ADMIN_UI_ACTION_ROW_ANCHOR, ADMIN_UI_ACTIONS, ADMIN_UI_AGENT_VERSION, ADMIN_UI_ANCHORS, ADMIN_UI_COMMAND_CENTER (+34 more)

### Community 6 - "Cloudflare Gateway Client"
Cohesion: 0.10
Nodes (17): ApiEnvelope, CLOUDFLARE_API_ANCHORS, CloudflareGatewayClient, DeploymentRecord, DnsRecord, dnsRecordBody(), listFrom(), originOnly() (+9 more)

### Community 7 - "Workflow Tests & Packaging"
Cohesion: 0.07
Nodes (25): dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler, yaml (+17 more)

### Community 8 - "Store Tests & Model Profiles"
Cohesion: 0.17
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 9 - "Workflow Safety Linter"
Cohesion: 0.22
Nodes (17): actionUses(), checkoutSteps(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin(), jobBlocks() (+9 more)

### Community 10 - "Agent Claim & Heartbeat Client"
Cohesion: 0.22
Nodes (17): ClaimRequest, ClaimResponse, Client, HeartbeatIdentity, HeartbeatRequest, HeartbeatResponse, MeshBootstrap, activeDesiredProfiles() (+9 more)

### Community 11 - "Memory Store & Audit"
Cohesion: 0.10
Nodes (9): tokenFromRow(), TokenRow, MemoryStore, retiredDefaultProfiles(), shouldRefreshDefaultProfile(), AuditEvent, CredentialKind, NodeRecord (+1 more)

### Community 12 - "Worker Entry & Registry DO"
Cohesion: 0.15
Nodes (12): DURABLE_ANCHORS, RegistryDO, INDEX_ANCHORS, ClaimRequest, ClaimResponse, HeartbeatRequest, HeartbeatResponse, MeshBootstrap (+4 more)

### Community 13 - "Root Package Manifest"
Cohesion: 0.14
Nodes (13): description, engines, node, name, private, scripts, cf-types, dry-run (+5 more)

### Community 14 - "D1 Store Implementation"
Cohesion: 0.08
Nodes (12): D1Store, nodeFromRow(), NodeRow, parseJson(), reservationFromRow(), ReservationRow, retiredDefaultProfiles(), shouldRefreshDefaultProfile() (+4 more)

### Community 15 - "Agent Dashboard Controls"
Cohesion: 0.25
Nodes (14): DashboardStatus, dashboardCard(), dashboardControlAllowed(), DashboardHandler(), dashboardHTML(), dashboardRuntimeCard(), Context, Handler (+6 more)

### Community 16 - "Profile Store Interface"
Cohesion: 0.07
Nodes (50): Documentation, Jump TOC, Lane ownership, Reading order, Related, REQ backlinks, Synonym glossary, Dependency-ordered implementation phases (+42 more)

### Community 17 - "Token Credential Store"
Cohesion: 0.11
Nodes (38): consoleFixture, eventLog, fakeLaunch, fakeMeshProcess, launchRecord, managerFixture, modelsFixture, Once (+30 more)

### Community 18 - "Base TypeScript Config"
Cohesion: 0.17
Nodes (11): compilerOptions, exactOptionalPropertyTypes, lib, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+3 more)

### Community 19 - "Session Store & Fixtures"
Cohesion: 0.15
Nodes (16): decryptJson(), EncryptedEnvelope, encryptJson(), fromBase64(), importMeshStateKey(), MESH_CRYPTO_ANCHORS, toBase64(), MeshStateRecord (+8 more)

### Community 20 - "D1 Schema Migration"
Cohesion: 0.25
Nodes (7): audit_events, model_profiles, nodes, reservations, router_config, sessions, tokens

### Community 21 - "Deploy Settings Resolver"
Cohesion: 0.33
Nodes (5): DEPLOY_SETTINGS_ANCHORS, output, validHostnameLabel(), validWorkerBaseUrl(), workerBaseUrl

### Community 22 - "Worker TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, noEmit, rootDir, exclude, extends, include

### Community 23 - "Agent Update Staging"
Cohesion: 0.08
Nodes (40): fakeSelfUpdateEnv, fuzzAddr, SelfUpdateOption, SelfUpdater, UpdateAsset, UpdatePlan, F, containsEnv() (+32 more)

### Community 24 - "Reservation Records"
Cohesion: 0.17
Nodes (37): fakeArchiveEntry, MeshLLMAsset, MeshLLMInstallOption, meshLLMInstallOptions, HandlerFunc, archiveEntryBase(), DetectMeshLLMFlavor(), downloadMeshLLMAsset() (+29 more)

### Community 31 - "mesh-state.ts"
Cohesion: 0.16
Nodes (31): appendMeshAudit(), applyHeartbeatMeshState(), bootstrapFromState(), captureMeshId(), clearedDetail(), electSeedIfAbsent(), emptyMeshState(), handleMeshRotate() (+23 more)

### Community 32 - "Config"
Cohesion: 0.18
Nodes (16): ActiveCounter, Config, agentUpdater, serviceLoop, finishRestart(), Context, Duration, HeartbeatResponse (+8 more)

### Community 33 - "auth.ts"
Cohesion: 0.17
Nodes (23): AUTH_ANCHORS, bearerToken(), createTokenId(), createTokenRecord(), generateBearerToken(), hashToken(), randomHex(), timingSafeEqualText() (+15 more)

### Community 34 - "agent-versions.test.ts"
Cohesion: 0.13
Nodes (15): AGENT_VERSIONS_ANCHORS, AgentVersionsCache, desiredAgentVersion(), extractReleaseTags(), fetchReleaseTags(), handleAgentVersionSelect(), handleAgentVersionsList(), isCacheFresh() (+7 more)

### Community 35 - "main_test.go"
Cohesion: 0.24
Nodes (19): HeartbeatRequest, routerFixture, runtimeMetrics(), HeartbeatResponse, Server, T, missingBinaryMeshManager(), newFakeMeshRuntime() (+11 more)

### Community 36 - "Endpoints"
Cohesion: 0.10
Nodes (21): Admin API Reference, Contents, Conventions, Endpoints, GET /, GET /admin, GET /admin/agent-versions, GET /admin/installers/:platform (+13 more)

### Community 37 - "fakeMeshRuntime"
Cohesion: 0.15
Nodes (3): fakeMeshRuntime, Context, MeshBootstrap

### Community 38 - "Endpoints"
Cohesion: 0.12
Nodes (17): API Reference, Contents, Conventions, Endpoints, GET /api/status, GET /health, GET /install.ps1, GET /install.sh (+9 more)

### Community 39 - "json"
Cohesion: 0.20
Nodes (17): redactSecrets(), authenticateKind(), handleAdminAgentVersions(), handleAdminAgentVersionSelect(), handleAdminLogin(), handleAdminMeshRotate(), handleAdminStatus(), handleInstaller() (+9 more)

### Community 40 - "installers.ts"
Cohesion: 0.19
Nodes (14): INSTALLER_ANCHORS, InstallerArch, installerCommand(), InstallerInput, installerPlan, InstallerPlatform, installScript(), InstallScriptInput (+6 more)

### Community 41 - "Architecture Decisions"
Cohesion: 0.14
Nodes (14): AD-001: Cloudflare router plane, AD-002: App-level bearer-token auth first, AD-003: D1 plus Durable Object scheduler, AD-004: Go service with localhost UI, AD-005: llama.cpp first runtime, AD-006: Default model profile set, AD-007: Gateway route automation with manual BYOK, AD-008: Node listener binding policy (+6 more)

### Community 42 - "Troubleshooting"
Cohesion: 0.14
Nodes (14): Admin status shows mesh_state_key_missing, AI Gateway returns authentication errors, Contents, Installer cannot verify artifact, Model never appears in ready models, Node reports dependency-missing, Peer count stays at one, Requests fail briefly after mesh rotation (+6 more)

### Community 43 - "Codeflare Inference Mesh Plan"
Cohesion: 0.14
Nodes (14): Admin Setup Flow, Cloudflare API Token Scopes, Codeflare Inference Mesh Plan, Core Cloudflare References, Deploy Token, Finalized Decisions, GitHub Repository Secrets, Initial Bootstrap (+6 more)

### Community 44 - "Constraints"
Cohesion: 0.14
Nodes (14): CON-CF-001: Cloudflare-first public control plane, CON-CF-002: Worker runtime compatibility, CON-CI-001: CI is the verification surface, CON-MODEL-001: Stable Gateway aliases, CON-NET-001: Mesh destination validation, CON-REL-001: Release artifacts are verifiable, CON-RUNTIME-001: MeshLLM-only runtime, CON-SCHED-001: Serialized live reservations (+6 more)

### Community 45 - "runService"
Cohesion: 0.22
Nodes (12): ServiceInstall, defaultDataDir(), Server, main(), runInstall(), runService(), shutdownServer(), TestREQNODE001ServiceSkeletonAndListenerPolicy() (+4 more)

### Community 46 - "Deployment"
Cohesion: 0.15
Nodes (13): Agent self-update, CI verification policy, Contents, Delivery model, Deploy workflow, Deployment, Greenfield bootstrap, Mesh integration runbook (+5 more)

### Community 47 - "Task groups"
Cohesion: 0.15
Nodes (13): 1. Repository and CI foundation, 2. Router Worker behavior, 3. Durable state and scheduling, 4. Setup and admin, 5. Runtime profiles, 6. Node agent, 7. Observability and failure reporting, 8. SDD/doc closure (+5 more)

### Community 48 - "Configuration"
Cohesion: 0.17
Nodes (12): Cloudflare One prerequisite, Configuration, Contents, GitHub secrets, GitHub variables, Node agent config, SDD config, Source anchors and specification backlinks (+4 more)

### Community 49 - "Node Agent Architecture"
Cohesion: 0.17
Nodes (12): Agent Dashboard Fields, Agent Local API, Agent Runtime Responsibilities, Agent Self-Update, Language And UI Choice, Node Agent Architecture, Repository Location, Service Installation (+4 more)

### Community 50 - "Codeflare Inference Mesh"
Cohesion: 0.17
Nodes (12): After deploy, Cloudflare token scopes, Codeflare Inference Mesh, Deploy, GitHub Actions secrets, More, Node environment, Repository layout (+4 more)

### Community 51 - "Contributing to Codeflare Inference Mesh"
Cohesion: 0.18
Nodes (11): Branches and Pull Requests, Code Style, Contributing to Codeflare Inference Mesh, Development, Getting Started, License, Project Structure, Questions (+3 more)

### Community 52 - "Security"
Cohesion: 0.18
Nodes (11): Access position, Contents, Header filtering, Mesh egress posture, Mesh secret custody and rotation, Route authorization, Runtime safety, Security (+3 more)

### Community 53 - "config.go"
Cohesion: 0.33
Nodes (9): Addr, IP, DetectHostMeshIP(), DetectMeshIP(), hostname(), ipFromAddr(), isPrivateOrCGNAT(), redact() (+1 more)

### Community 54 - "Architecture"
Cohesion: 0.20
Nodes (10): Architecture, Boundaries, Component map, Contents, Control plane lifecycle, Data plane lifecycle, Overview, Runtime flow (+2 more)

### Community 55 - "Alternatives Considered"
Cohesion: 0.20
Nodes (10): AI Gateway Directly To Each Node, Alternatives Considered, Cloudflare Access As Primary Auth, Concrete Model Names In AI Gateway, D1 Only, KV, Or R2 Instead Of Durable Object, Native Desktop App, Ollama Or LM Studio As Default Engine, Per-Node Cloudflare Tunnel Hostnames (+2 more)

### Community 56 - "State Persistence And Scheduling"
Cohesion: 0.20
Nodes (10): Busy Behavior, D1 Persistent Records, Model Record, Node Eligibility, Node Record, Reservation Record, Scheduling Score, Session ID Sources (+2 more)

### Community 57 - "Setup And Admin"
Cohesion: 0.20
Nodes (10): Related documentation, REQ-ADM-001: First-run setup, REQ-ADM-002: MVP admin auth, REQ-ADM-003: Setup token lifecycle, REQ-ADM-004: One-line installers, REQ-ADM-005: Optional custom domain, REQ-ADM-006: Admin configuration UI, REQ-ADM-007: Admin command center (+2 more)

### Community 58 - "Security Policy"
Cohesion: 0.20
Nodes (10): Disclosure Process, In Scope, Out of Scope, Reporting a Vulnerability, Secure Configuration Notes, Security Boundaries, Security Documentation, Security Policy (+2 more)

### Community 59 - "Observability"
Cohesion: 0.22
Nodes (9): Admin status, Audit events, Contents, Failure states, Mesh health, Node metrics, Observability, Response metadata (+1 more)

### Community 60 - "Model Virtualization And Stable Gateway Names"
Cohesion: 0.22
Nodes (9): Compatibility With AI Gateway, Compatibility With OpenAI APIs, Intent, Model Virtualization And Stable Gateway Names, Profile Versioning, Public Model Alias, Request Rewriting, Rollout Flow (+1 more)

### Community 61 - "Implementation Phases"
Cohesion: 0.22
Nodes (9): Implementation Phases, Phase 1: Prove Worker To One WARP Client, Phase 2: D1 State And Durable Object Scheduler, Phase 3: Node Agent MVP, Phase 4: Engine Management, Phase 5: Admin Setup And One-Line Install, Phase 6: Multi-Node Routing, Phase 7: GitHub Actions (+1 more)

### Community 62 - "Product"
Cohesion: 0.22
Nodes (8): Accessibility & Inclusion, Anti-references, Brand Personality, Design Principles, Product, Product Purpose, Register, Users

### Community 63 - "Observability"
Cohesion: 0.22
Nodes (9): Observability, Related documentation, REQ-OBS-001: Provider response metadata, REQ-OBS-002: Admin status surface, REQ-OBS-003: Node metrics, REQ-OBS-004: Failure reporting, REQ-OBS-005: Node self-unregistration, REQ-OBS-006: Audit history (+1 more)

### Community 64 - "Runtime Profiles"
Cohesion: 0.22
Nodes (9): Related documentation, REQ-RUN-001: Public model aliases, REQ-RUN-002: Default model profiles, REQ-RUN-003: Managed MeshLLM runtime, REQ-RUN-004: Profile rollout, REQ-RUN-005: Runtime readiness and status reporting, REQ-RUN-006: Private mesh formation, REQ-RUN-007: Split serving via layer packages (+1 more)

### Community 65 - "ProxyHandler"
Cohesion: 0.32
Nodes (5): Header, filterRuntimeHeaders(), Handler, ProxyHandler(), singleJoiningSlash()

### Community 66 - "GitHub Actions And Releases"
Cohesion: 0.25
Nodes (8): CodeQL Workflow, Fuzz Workflow, GitHub Actions And Releases, Manual Deploy Workflow, Optional Scorecard Workflow, Planned Repository Layout, PR Checks Workflow, Workflow Design

### Community 67 - "Node Agent"
Cohesion: 0.25
Nodes (8): Node Agent, Related documentation, REQ-NODE-001: Cross-platform service, REQ-NODE-002: Node claim and heartbeat, REQ-NODE-003: Upstream proxy, REQ-NODE-004: Local dashboard, REQ-NODE-005: Agent update staging, REQ-NODE-006: MeshLLM binary install and update

### Community 68 - "Security"
Cohesion: 0.25
Nodes (8): Related documentation, REQ-SEC-001: Credential boundaries, REQ-SEC-002: Secret storage and rotation readiness, REQ-SEC-003: Header filtering, REQ-SEC-004: Runtime API exposure, REQ-SEC-005: Dashboard token lifecycle, REQ-SEC-006: Mesh token lifecycle, Security

### Community 69 - "TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline"
Cohesion: 0.48
Nodes (4): fakeRuntimeController, Context, TestREQRUN005RuntimeManagerUsesProcessLifetimeContext(), TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline()

### Community 70 - "metrics.go"
Cohesion: 0.48
Nodes (6): NodeMetrics, TestREQOBS003ReportsLastRuntimeError(), atoi(), MergeRuntimeMetrics(), ParseNvidiaSMI(), RuntimeMetricsWithError()

### Community 71 - ".collect"
Cohesion: 0.43
Nodes (3): runtimeTelemetry, NodeMetrics, RWMutex

### Community 72 - "Failure Modes"
Cohesion: 0.29
Nodes (7): AI Gateway Retries, Context Cache Thrash, Failure Modes, Node Crashes Mid-Stream, Node Is Busy, Node Stops Heartbeating, WARP Disconnects

### Community 73 - "Router Worker Architecture"
Cohesion: 0.29
Nodes (7): Chat Completion Handling, Public API, Repository Location, Request Handling Rules, Router Worker Architecture, Streaming Rules, Worker Inputs

### Community 74 - "Component Responsibilities"
Cohesion: 0.29
Nodes (7): Cloudflare AI Gateway, Cloudflare Worker Router, Component Responsibilities, D1 Database, Durable Object Scheduler, Node Agent, Workers VPC And Cloudflare Mesh

### Community 75 - "Design Principles"
Cohesion: 0.29
Nodes (7): Design Principles, Keep The Public Surface Small, Make The Node Agent Opinionated, Prefer Private Network Routing Over Public Per-Node URLs, Preserve Session Affinity, Separate Control Plane From Data Plane, Start Narrow, Then Generalize

### Community 76 - "Validation Gates"
Cohesion: 0.29
Nodes (7): Gate 1: Worker To Mesh, Gate 2: AI Gateway To Worker, Gate 3: Streaming And Long Prefill, Gate 4: Node Agent MVP, Gate 5: Multi-Node Routing, Gate 6: Agent Self-Update, Validation Gates

### Community 77 - "Security And Trust Model"
Cohesion: 0.33
Nodes (6): Cloudflare Access Position, Public Routes And Auth, Security And Trust Model, Token Classes, Trust Boundaries, Why Not One Token

### Community 78 - "Model Runtime Strategy"
Cohesion: 0.33
Nodes (6): Default Engine: llama.cpp, Gemma 4 26B-A4B Profile, Initial Runtime Scope, Model Profiles, Model Runtime Strategy, Qwen 3.6 27B Profile

### Community 79 - "fakeUpdater"
Cohesion: 0.40
Nodes (3): fakeUpdater, Mutex, Time

### Community 80 - "AI Gateway Setup Flow"
Cohesion: 0.40
Nodes (5): AI Gateway Setup Flow, Custom Provider, Dynamic Route, Provider Bearer Token, Required Validation

### Community 81 - "Architecture Summary"
Cohesion: 0.40
Nodes (5): Architecture Summary, Control Plane Node Path, Data Plane Request Path, Logical Planes, Target Architecture

### Community 82 - "Admin UI Polish — Execution Plan"
Cohesion: 0.40
Nodes (4): Admin UI Polish — Execution Plan, Behavioral verification plan, Execution tasks, Success criteria & verification

### Community 83 - "End-To-End Flows"
Cohesion: 0.50
Nodes (4): End-To-End Flows, First Deployment Flow, Inference Flow, Node Install Flow

### Community 84 - "Observability"
Cohesion: 0.50
Nodes (4): Node Metrics, Observability, Response Headers, Router Status

## Knowledge Gaps
- **480 isolated node(s):** `name`, `version`, `private`, `description`, `workspaces` (+475 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Codeflare Inference Mesh Plan` connect `Codeflare Inference Mesh Plan` to `GitHub Actions And Releases`, `Failure Modes`, `Router Worker Architecture`, `Component Responsibilities`, `Design Principles`, `Validation Gates`, `Security And Trust Model`, `Model Runtime Strategy`, `Profile Store Interface`, `Architecture Summary`, `AI Gateway Setup Flow`, `End-To-End Flows`, `Node Agent Architecture`, `Observability`, `Alternatives Considered`, `State Persistence And Scheduling`, `Model Virtualization And Stable Gateway Names`, `Implementation Phases`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `runService()` connect `runService` to `Config`, `Agent Config & Tests`, `Agent Service Lifecycle & Proxy`, `main_test.go`, `ProxyHandler`, `Agent Claim & Heartbeat Client`, `Agent Dashboard Controls`, `Agent Update Staging`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `startMeshRuntime()` connect `Config` to `Agent Service Lifecycle & Proxy`, `Llama Runtime Manager`, `runService`, `Token Credential Store`, `Reservation Records`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _480 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Router API & Auth Handlers` be split into smaller, more focused modules?**
  _Cohesion score 0.12962962962962962 - nodes in this community are weakly interconnected._
- **Should `Reservation Scheduler` be split into smaller, more focused modules?**
  _Cohesion score 0.0611764705882353 - nodes in this community are weakly interconnected._
- **Should `Llama Runtime Manager` be split into smaller, more focused modules?**
  _Cohesion score 0.06044303797468355 - nodes in this community are weakly interconnected._