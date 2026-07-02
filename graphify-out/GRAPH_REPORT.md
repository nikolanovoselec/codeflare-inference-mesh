# Graph Report - /home/user/workspace/codeflare-inference-mesh  (2026-07-02)

## Corpus Check
- 79 files · ~70,192 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 628 nodes · 1313 edges · 31 communities (25 shown, 6 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 104 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

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

## God Nodes (most connected - your core abstractions)
1. `Store` - 32 edges
2. `D1Store` - 30 edges
3. `MemoryStore` - 28 edges
4. `RuntimeManager` - 24 edges
5. `Config` - 20 edges
6. `heartbeatLoop()` - 18 edges
7. `CloudflareGatewayClient` - 18 edges
8. `json()` - 17 edges
9. `runService()` - 16 edges
10. `authenticateKind()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `runInstall()` --calls--> `DefaultConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runInstall()` --calls--> `ServiceInstallPlan()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/service.go
- `runService()` --calls--> `ApplyClaim()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go
- `runService()` --calls--> `LoadConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/config.go
- `runService()` --calls--> `DashboardHandler()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/dashboard.go

## Import Cycles
- None detected.

## Communities (31 total, 6 thin omitted)

### Community 0 - "Router API & Auth Handlers"
Cohesion: 0.06
Nodes (72): approvedNodeHeaders(), AUTH_ANCHORS, bearerToken(), createTokenId(), createTokenRecord(), generateBearerToken(), hashToken(), randomHex() (+64 more)

### Community 1 - "Agent Config & Tests"
Cohesion: 0.06
Nodes (58): Addr, fakeRuntimeController, fuzzAddr, NodeMetrics, ServiceInstall, F, HandlerFunc, IP (+50 more)

### Community 2 - "Agent Service Lifecycle & Proxy"
Cohesion: 0.08
Nodes (46): ActiveCounter, Config, Duration, Header, runtimeLoadState, runtimeTelemetry, beginRestart(), beginRuntimeProfileRestart() (+38 more)

### Community 3 - "Reservation Scheduler"
Cohesion: 0.06
Nodes (12): DurableSchedulerClient, eligibleNodes(), isEligible(), isSafeMeshTarget(), meshUrl(), SCHEDULER_ANCHORS, selectNode(), StoreScheduler (+4 more)

### Community 4 - "Llama Runtime Manager"
Cohesion: 0.12
Nodes (25): ModelProfile, RuntimeCommand, RuntimeManager, runtimeTemplateValues, CancelFunc, Cmd, DownloadModel(), EnsureModel() (+17 more)

### Community 5 - "Admin UI & Router Tests"
Cohesion: 0.09
Nodes (22): actionRow(), ActionRowOptions, ADMIN_UI_ACTION_ROW_ANCHOR, ADMIN_UI_ACTIONS, ADMIN_UI_ANCHORS, ADMIN_UI_COMMAND_CENTER, ADMIN_UI_OPERATOR_FLOW, ADMIN_UI_RESPONSIVE (+14 more)

### Community 6 - "Cloudflare Gateway Client"
Cohesion: 0.10
Nodes (17): ApiEnvelope, CLOUDFLARE_API_ANCHORS, CloudflareGatewayClient, DeploymentRecord, DnsRecord, dnsRecordBody(), listFrom(), originOnly() (+9 more)

### Community 7 - "Workflow Tests & Packaging"
Cohesion: 0.07
Nodes (25): dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler, yaml (+17 more)

### Community 8 - "Store Tests & Model Profiles"
Cohesion: 0.13
Nodes (14): DEFAULT_MODEL_PROFILES, PROFILE_ANCHORS, desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText() (+6 more)

### Community 9 - "Workflow Safety Linter"
Cohesion: 0.22
Nodes (17): actionUses(), checkoutSteps(), hasHardenedWorkflowRunJob(), hasWorkflowRunTrigger(), indentOf(), invalidActionPin(), invalidRunnerPin(), jobBlocks() (+9 more)

### Community 10 - "Agent Claim & Heartbeat Client"
Cohesion: 0.25
Nodes (14): ClaimRequest, ClaimResponse, Client, HeartbeatRequest, HeartbeatResponse, activeDesiredProfiles(), ApplyClaim(), ApplyDesiredProfiles() (+6 more)

### Community 11 - "Memory Store & Audit"
Cohesion: 0.14
Nodes (3): MemoryStore, AuditEvent, NodeRecord

### Community 12 - "Worker Entry & Registry DO"
Cohesion: 0.16
Nodes (12): DURABLE_ANCHORS, RegistryDO, fetch(), INDEX_ANCHORS, createRouter(), ClaimRequest, HeartbeatRequest, ModelSourceMode (+4 more)

### Community 13 - "Root Package Manifest"
Cohesion: 0.14
Nodes (13): description, engines, node, name, private, scripts, cf-types, dry-run (+5 more)

### Community 14 - "D1 Store Implementation"
Cohesion: 0.22
Nodes (3): D1Store, nodeFromRow(), parseJson()

### Community 15 - "Agent Dashboard Controls"
Cohesion: 0.24
Nodes (12): DashboardStatus, RuntimeController, dashboardCard(), dashboardControlAllowed(), dashboardHTML(), Context, NodeMetrics, isLoopbackAddress() (+4 more)

### Community 16 - "Profile Store Interface"
Cohesion: 0.19
Nodes (6): NodeRow, ReservationRow, retiredDefaultProfiles(), shouldRefreshDefaultProfile(), STORE_ANCHORS, ModelProfile

### Community 17 - "Token Credential Store"
Cohesion: 0.23
Nodes (4): tokenFromRow(), TokenRow, CredentialKind, TokenRecord

### Community 18 - "Base TypeScript Config"
Cohesion: 0.17
Nodes (11): compilerOptions, exactOptionalPropertyTypes, lib, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+3 more)

### Community 19 - "Session Store & Fixtures"
Cohesion: 0.22
Nodes (4): nodeFixture(), retiredDefaultProfiles(), shouldRefreshDefaultProfile(), SessionRecord

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
Cohesion: 0.40
Nodes (4): UpdateAsset, UpdatePlan, StageUpdate(), Reader

## Knowledge Gaps
- **91 isolated node(s):** `name`, `version`, `private`, `description`, `workspaces` (+86 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `Reservation Scheduler` to `Router API & Auth Handlers`, `Memory Store & Audit`, `Worker Entry & Registry DO`, `D1 Store Implementation`, `Profile Store Interface`, `Session Store & Fixtures`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `CloudflareGatewayClient` connect `Cloudflare Gateway Client` to `Router API & Auth Handlers`, `Admin UI & Router Tests`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `MemoryStore` connect `Memory Store & Audit` to `Reservation Scheduler`, `Admin UI & Router Tests`, `Profile Store Interface`, `Token Credential Store`, `Session Store & Fixtures`, `Reservation Records`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _91 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Router API & Auth Handlers` be split into smaller, more focused modules?**
  _Cohesion score 0.06393606393606394 - nodes in this community are weakly interconnected._
- **Should `Agent Config & Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.06351236146632566 - nodes in this community are weakly interconnected._
- **Should `Agent Service Lifecycle & Proxy` be split into smaller, more focused modules?**
  _Cohesion score 0.08240794856808883 - nodes in this community are weakly interconnected._