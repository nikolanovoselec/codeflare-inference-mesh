# Graph Report - /home/user/workspace/cloudflare-inference-mesh  (2026-07-01)

## Corpus Check
- label apply mode — file stats not available

## Summary
- 843 nodes · 1382 edges · 71 communities (68 shown, 3 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 46 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f95dffb6`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Router Store Persistence|Router Store Persistence]]
- [[_COMMUNITY_Router Auth Installers|Router Auth Installers]]
- [[_COMMUNITY_Router Admin Scheduling|Router Admin Scheduling]]
- [[_COMMUNITY_Agent Metrics Tests|Agent Metrics Tests]]
- [[_COMMUNITY_Agent Runtime Manager|Agent Runtime Manager]]
- [[_COMMUNITY_Agent Upstream Proxy|Agent Upstream Proxy]]
- [[_COMMUNITY_Router Package Scripts|Router Package Scripts]]
- [[_COMMUNITY_Agent Router Client|Agent Router Client]]
- [[_COMMUNITY_Workspace Package Scripts|Workspace Package Scripts]]
- [[_COMMUNITY_SDD Requirements Corpus|SDD Requirements Corpus]]
- [[_COMMUNITY_TypeScript Compiler Base|TypeScript Compiler Base]]
- [[_COMMUNITY_Agent Mesh IP Fuzz|Agent Mesh IP Fuzz]]
- [[_COMMUNITY_Workflow Contract Tests|Workflow Contract Tests]]
- [[_COMMUNITY_Router D1 Schema|Router D1 Schema]]
- [[_COMMUNITY_Router TSConfig|Router TSConfig]]
- [[_COMMUNITY_Router Lint Script|Router Lint Script]]
- [[_COMMUNITY_Agent Module Definition|Agent Module Definition]]
- [[_COMMUNITY_Store Profile Tests|Store Profile Tests]]
- [[_COMMUNITY_Admin API Reference|Admin API Reference]]
- [[_COMMUNITY_Agent Config Credentials|Agent Config Credentials]]
- [[_COMMUNITY_Agent Local Dashboard|Agent Local Dashboard]]
- [[_COMMUNITY_Architecture Decision Records|Architecture Decision Records]]
- [[_COMMUNITY_Public API Reference|Public API Reference]]
- [[_COMMUNITY_Pending Task Ledger|Pending Task Ledger]]
- [[_COMMUNITY_Project README Overview|Project README Overview]]
- [[_COMMUNITY_Specification Constraints|Specification Constraints]]
- [[_COMMUNITY_Agent Service Entrypoint|Agent Service Entrypoint]]
- [[_COMMUNITY_Agent Architecture Plan|Agent Architecture Plan]]
- [[_COMMUNITY_Contribution Guide|Contribution Guide]]
- [[_COMMUNITY_Configuration Documentation|Configuration Documentation]]
- [[_COMMUNITY_Architecture Documentation|Architecture Documentation]]
- [[_COMMUNITY_Project Plan Bootstrap|Project Plan Bootstrap]]
- [[_COMMUNITY_Plan Alternatives Analysis|Plan Alternatives Analysis]]
- [[_COMMUNITY_Plan State Scheduling|Plan State Scheduling]]
- [[_COMMUNITY_Security Policy Guide|Security Policy Guide]]
- [[_COMMUNITY_Deployment Documentation|Deployment Documentation]]
- [[_COMMUNITY_Security Documentation|Security Documentation]]
- [[_COMMUNITY_Model Alias Plan|Model Alias Plan]]
- [[_COMMUNITY_Implementation Phase Plan|Implementation Phase Plan]]
- [[_COMMUNITY_Product Design Brief|Product Design Brief]]
- [[_COMMUNITY_Troubleshooting Documentation|Troubleshooting Documentation]]
- [[_COMMUNITY_Actions Release Plan|Actions Release Plan]]
- [[_COMMUNITY_Admin Setup Requirements|Admin Setup Requirements]]
- [[_COMMUNITY_Observability Documentation|Observability Documentation]]
- [[_COMMUNITY_Documentation Index|Documentation Index]]
- [[_COMMUNITY_Plan Failure Modes|Plan Failure Modes]]
- [[_COMMUNITY_Router Architecture Plan|Router Architecture Plan]]
- [[_COMMUNITY_Component Responsibility Plan|Component Responsibility Plan]]
- [[_COMMUNITY_Plan Design Principles|Plan Design Principles]]
- [[_COMMUNITY_Validation Gate Plan|Validation Gate Plan]]
- [[_COMMUNITY_SDD Overview|SDD Overview]]
- [[_COMMUNITY_Node Agent Requirements|Node Agent Requirements]]
- [[_COMMUNITY_Security Requirements|Security Requirements]]
- [[_COMMUNITY_Runtime Controller Tests|Runtime Controller Tests]]
- [[_COMMUNITY_Agent Update Staging|Agent Update Staging]]
- [[_COMMUNITY_Security Trust Plan|Security Trust Plan]]
- [[_COMMUNITY_Runtime Model Strategy|Runtime Model Strategy]]
- [[_COMMUNITY_Gateway Requirements|Gateway Requirements]]
- [[_COMMUNITY_Observability Requirements|Observability Requirements]]
- [[_COMMUNITY_Release CI Requirements|Release CI Requirements]]
- [[_COMMUNITY_Router Requirements|Router Requirements]]
- [[_COMMUNITY_Runtime Profile Requirements|Runtime Profile Requirements]]
- [[_COMMUNITY_Scheduling Requirements|Scheduling Requirements]]
- [[_COMMUNITY_Router Session Storage|Router Session Storage]]
- [[_COMMUNITY_Implementation Task Plan|Implementation Task Plan]]
- [[_COMMUNITY_Gateway Setup Plan|Gateway Setup Plan]]
- [[_COMMUNITY_Target Architecture Plan|Target Architecture Plan]]
- [[_COMMUNITY_Cloudflare Token Scopes|Cloudflare Token Scopes]]
- [[_COMMUNITY_End To End Flows|End To End Flows]]

## God Nodes (most connected - your core abstractions)
1. `D1Store` - 30 edges
2. `MemoryStore` - 28 edges
3. `Codeflare Inference Mesh Plan` - 26 edges
4. `json()` - 16 edges
5. `runService()` - 15 edges
6. `authenticateKind()` - 15 edges
7. `ModelProfile` - 15 edges
8. `Admin API Reference` - 15 edges
9. `RuntimeManager` - 13 edges
10. `TokenRecord` - 13 edges

## Surprising Connections (you probably didn't know these)
- `runService()` --calls--> `ProxyHandler()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/proxy.go
- `runService()` --calls--> `EnsureModel()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/runtime.go
- `runService()` --calls--> `LlamaCommand()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/runtime.go
- `runService()` --calls--> `NewRuntimeManager()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/runtime.go
- `runService()` --calls--> `RuntimeListenAddress()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/runtime.go

## Import Cycles
- None detected.

## Communities (71 total, 3 thin omitted)

### Community 0 - "Router Store Persistence"
Cohesion: 0.14
Nodes (5): D1Store, nodeFromRow(), parseJson(), reservationFromRow(), ModelProfile

### Community 1 - "Router Auth Installers"
Cohesion: 0.08
Nodes (57): approvedNodeHeaders(), AUTH_ANCHORS, bearerToken(), createTokenId(), createTokenRecord(), generateBearerToken(), hashToken(), randomHex() (+49 more)

### Community 2 - "Router Admin Scheduling"
Cohesion: 0.16
Nodes (12): DurableSchedulerClient, eligibleNodes(), isEligible(), isSafeMeshTarget(), meshUrl(), SCHEDULER_ANCHORS, selectNode(), StoreScheduler (+4 more)

### Community 3 - "Agent Metrics Tests"
Cohesion: 0.05
Nodes (64): Addr, ClaimRequest, ClaimResponse, Client, Config, DashboardStatus, fakeRuntimeController, HeartbeatRequest (+56 more)

### Community 4 - "Agent Runtime Manager"
Cohesion: 0.15
Nodes (20): ModelProfile, RuntimeCommand, RuntimeManager, CancelFunc, Cmd, Mutex, DownloadModel(), EnsureModel() (+12 more)

### Community 5 - "Agent Upstream Proxy"
Cohesion: 0.29
Nodes (6): ActiveCounter, Header, filterRuntimeHeaders(), Handler, ProxyHandler(), singleJoiningSlash()

### Community 6 - "Router Package Scripts"
Cohesion: 0.10
Nodes (19): dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler, yaml (+11 more)

### Community 7 - "Agent Router Client"
Cohesion: 0.33
Nodes (3): 2026-06-30, Changes, Glossary

### Community 8 - "Workspace Package Scripts"
Cohesion: 0.14
Nodes (13): description, engines, node, name, private, scripts, cf-types, dry-run (+5 more)

### Community 9 - "SDD Requirements Corpus"
Cohesion: 0.07
Nodes (24): ADMIN_FORMS, ADMIN_UI_ACTIONS, ADMIN_UI_ANCHORS, ADMIN_UI_RESPONSIVE, AdminUiAction, adminUiCss(), adminUiHtml(), adminUiScript() (+16 more)

### Community 10 - "TypeScript Compiler Base"
Cohesion: 0.17
Nodes (11): compilerOptions, exactOptionalPropertyTypes, lib, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+3 more)

### Community 11 - "Agent Mesh IP Fuzz"
Cohesion: 0.40
Nodes (3): fuzzAddr, F, FuzzDetectMeshIP()

### Community 12 - "Workflow Contract Tests"
Cohesion: 0.28
Nodes (7): allRunText(), Job, repoRoot, runLines(), Step, stepRuns(), Workflow

### Community 13 - "Router D1 Schema"
Cohesion: 0.25
Nodes (7): audit_events, model_profiles, nodes, reservations, router_config, sessions, tokens

### Community 14 - "Router TSConfig"
Cohesion: 0.29
Nodes (6): compilerOptions, noEmit, rootDir, exclude, extends, include

### Community 17 - "Store Profile Tests"
Cohesion: 0.12
Nodes (5): MemoryStore, nodeFixture(), AuditEvent, NodeRecord, ReservationRecord

### Community 18 - "Admin API Reference"
Cohesion: 0.17
Nodes (12): desc(), FakeD1Database, FakeD1Statement, maybe(), nullableNumber(), nullableText(), number(), ok() (+4 more)

### Community 19 - "Agent Config Credentials"
Cohesion: 0.16
Nodes (7): NodeRow, ReservationRow, STORE_ANCHORS, tokenFromRow(), TokenRow, CredentialKind, TokenRecord

### Community 20 - "Agent Local Dashboard"
Cohesion: 0.17
Nodes (11): DURABLE_ANCHORS, RegistryDO, fetch(), INDEX_ANCHORS, createRouter(), ClaimRequest, HeartbeatRequest, NodeMetrics (+3 more)

### Community 21 - "Architecture Decision Records"
Cohesion: 0.13
Nodes (15): Admin API Reference, Contents, Conventions, GET /admin/installers/:platform ([REQ-ADM-004](../../sdd/spec/setup-admin.md)), GET /admin ([REQ-ADM-006](../../sdd/spec/setup-admin.md)), GET /admin/status ([REQ-OBS-002](../../sdd/spec/observability.md)), GET / ([REQ-ADM-006](../../sdd/spec/setup-admin.md)), POST /admin/cloudflare/gateway/sync ([REQ-GWY-003](../../sdd/spec/gateway.md)) (+7 more)

### Community 22 - "Public API Reference"
Cohesion: 0.15
Nodes (13): AD-001: Cloudflare router plane, AD-002: App-level bearer-token auth first, AD-003: D1 plus Durable Object scheduler, AD-004: Go service with localhost UI, AD-005: llama.cpp first runtime, AD-006: Default model profile set, AD-007: Gateway route automation with manual BYOK, AD-008: Node listener binding policy (+5 more)

### Community 23 - "Pending Task Ledger"
Cohesion: 0.15
Nodes (13): API Reference, Contents, Conventions, GET /health ([REQ-RTR-001](../../sdd/spec/router-worker.md)), GET /install.ps1 ([REQ-ADM-004](../../sdd/spec/setup-admin.md)), GET /install.sh ([REQ-ADM-004](../../sdd/spec/setup-admin.md)), GET /v1/models ([REQ-GWY-001](../../sdd/spec/gateway.md)) ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md)), Node dashboard local routes ([REQ-NODE-004](../../sdd/spec/node-agent.md)) ([REQ-SEC-004](../../sdd/spec/security.md)) (+5 more)

### Community 24 - "Project README Overview"
Cohesion: 0.15
Nodes (13): 1. Repository and CI foundation, 2. Router Worker behavior, 3. Durable state and scheduling, 4. Setup and admin, 5. Runtime profiles, 6. Node agent, 7. Observability and failure reporting, 8. SDD/doc closure (+5 more)

### Community 25 - "Specification Constraints"
Cohesion: 0.15
Nodes (13): After deploy, `CLOUDFLARE_API_TOKEN_DEPLOY`, `CLOUDFLARE_API_TOKEN_RUNTIME`, Cloudflare API token scopes, Cloudflare configuration, Cloudflare One / Mesh prerequisite, Codeflare Inference Mesh, Current status (+5 more)

### Community 26 - "Agent Service Entrypoint"
Cohesion: 0.15
Nodes (13): CON-CF-001: Cloudflare-first public control plane, CON-CF-002: Worker runtime compatibility, CON-CI-001: CI is the verification surface, CON-MODEL-001: Stable Gateway aliases, CON-NET-001: Mesh destination validation, CON-REL-001: Release artifacts are verifiable, CON-RUNTIME-001: llama.cpp first runtime, CON-SCHED-001: Serialized live reservations (+5 more)

### Community 27 - "Agent Architecture Plan"
Cohesion: 0.17
Nodes (12): Agent Dashboard Fields, Agent Local API, Agent Runtime Responsibilities, Agent Self-Update, Language And UI Choice, Node Agent Architecture, Repository Location, Service Installation (+4 more)

### Community 28 - "Contribution Guide"
Cohesion: 0.18
Nodes (11): Branches and Pull Requests, Code Style, Contributing to Codeflare Inference Mesh, Development, Getting Started, License, Project Structure, Questions (+3 more)

### Community 29 - "Configuration Documentation"
Cohesion: 0.18
Nodes (11): Cloudflare One prerequisite, Configuration, Contents, GitHub secrets, Node agent config, SDD config, Source anchors and specification backlinks, Worker secrets (+3 more)

### Community 30 - "Architecture Documentation"
Cohesion: 0.20
Nodes (10): Architecture, Boundaries, Component map, Contents, Control plane lifecycle, Data plane lifecycle, Overview, Runtime flow (+2 more)

### Community 31 - "Project Plan Bootstrap"
Cohesion: 0.20
Nodes (10): Admin Setup Flow, Codeflare Inference Mesh Plan, Core Cloudflare References, Finalized Decisions, Initial Bootstrap, Optional Custom Domain, Product Goal, Purpose (+2 more)

### Community 32 - "Plan Alternatives Analysis"
Cohesion: 0.20
Nodes (10): AI Gateway Directly To Each Node, Alternatives Considered, Cloudflare Access As Primary Auth, Concrete Model Names In AI Gateway, D1 Only, KV, Or R2 Instead Of Durable Object, Native Desktop App, Ollama Or LM Studio As Default Engine, Per-Node Cloudflare Tunnel Hostnames (+2 more)

### Community 33 - "Plan State Scheduling"
Cohesion: 0.20
Nodes (10): Busy Behavior, D1 Persistent Records, Model Record, Node Eligibility, Node Record, Reservation Record, Scheduling Score, Session ID Sources (+2 more)

### Community 34 - "Security Policy Guide"
Cohesion: 0.20
Nodes (10): Disclosure Process, In Scope, Out of Scope, Reporting a Vulnerability, Secure Configuration Notes, Security Boundaries, Security Documentation, Security Policy (+2 more)

### Community 35 - "Deployment Documentation"
Cohesion: 0.22
Nodes (9): CI verification policy, Contents, Delivery model, Deploy workflow, Deployment, PR checks, Release channels, Rollback (+1 more)

### Community 36 - "Security Documentation"
Cohesion: 0.22
Nodes (9): Access position, Contents, Header filtering, Route authorization, Runtime safety, Security, Source anchors and specification backlinks, Token storage (+1 more)

### Community 37 - "Model Alias Plan"
Cohesion: 0.22
Nodes (9): Compatibility With AI Gateway, Compatibility With OpenAI APIs, Intent, Model Virtualization And Stable Gateway Names, Profile Versioning, Public Model Alias, Request Rewriting, Rollout Flow (+1 more)

### Community 38 - "Implementation Phase Plan"
Cohesion: 0.22
Nodes (9): Implementation Phases, Phase 1: Prove Worker To One WARP Client, Phase 2: D1 State And Durable Object Scheduler, Phase 3: Node Agent MVP, Phase 4: Engine Management, Phase 5: Admin Setup And One-Line Install, Phase 6: Multi-Node Routing, Phase 7: GitHub Actions (+1 more)

### Community 39 - "Product Design Brief"
Cohesion: 0.22
Nodes (8): Accessibility & Inclusion, Anti-references, Brand Personality, Design Principles, Product, Product Purpose, Register, Users

### Community 40 - "Troubleshooting Documentation"
Cohesion: 0.25
Nodes (8): AI Gateway returns authentication errors, Installer cannot verify artifact, Node update is staged but not applied, Requests return busy, Session latency suddenly increases, Source anchors and specification backlinks, Troubleshooting, Worker cannot reach node

### Community 41 - "Actions Release Plan"
Cohesion: 0.25
Nodes (8): CodeQL Workflow, Fuzz Workflow, GitHub Actions And Releases, Manual Deploy Workflow, Optional Scorecard Workflow, Planned Repository Layout, PR Checks Workflow, Workflow Design

### Community 42 - "Admin Setup Requirements"
Cohesion: 0.25
Nodes (8): Related documentation, REQ-ADM-001: First-run setup, REQ-ADM-002: MVP admin auth, REQ-ADM-003: Setup token lifecycle, REQ-ADM-004: One-line installers, REQ-ADM-005: Optional custom domain, REQ-ADM-006: Admin configuration UI, Setup And Admin

### Community 43 - "Observability Documentation"
Cohesion: 0.29
Nodes (7): Admin status, Audit events, Failure states, Node metrics, Observability, Response metadata, Source anchors and specification backlinks

### Community 44 - "Documentation Index"
Cohesion: 0.29
Nodes (7): Documentation, Jump TOC, Lane ownership, Reading order, Related, REQ backlinks, Synonym glossary

### Community 45 - "Plan Failure Modes"
Cohesion: 0.29
Nodes (7): AI Gateway Retries, Context Cache Thrash, Failure Modes, Node Crashes Mid-Stream, Node Is Busy, Node Stops Heartbeating, WARP Disconnects

### Community 46 - "Router Architecture Plan"
Cohesion: 0.29
Nodes (7): Chat Completion Handling, Public API, Repository Location, Request Handling Rules, Router Worker Architecture, Streaming Rules, Worker Inputs

### Community 47 - "Component Responsibility Plan"
Cohesion: 0.29
Nodes (7): Cloudflare AI Gateway, Cloudflare Worker Router, Component Responsibilities, D1 Database, Durable Object Scheduler, Node Agent, Workers VPC And Cloudflare Mesh

### Community 48 - "Plan Design Principles"
Cohesion: 0.29
Nodes (7): Design Principles, Keep The Public Surface Small, Make The Node Agent Opinionated, Prefer Private Network Routing Over Public Per-Node URLs, Preserve Session Affinity, Separate Control Plane From Data Plane, Start Narrow, Then Generalize

### Community 49 - "Validation Gate Plan"
Cohesion: 0.29
Nodes (7): Gate 1: Worker To Mesh, Gate 2: AI Gateway To Worker, Gate 3: Streaming And Long Prefill, Gate 4: Node Agent MVP, Gate 5: Multi-Node Routing, Gate 6: Agent Self-Update, Validation Gates

### Community 50 - "SDD Overview"
Cohesion: 0.29
Nodes (7): Actors, Codeflare Inference Mesh SDD, Design Principles, Documentation, Domains, Out of Scope, Support files

### Community 51 - "Node Agent Requirements"
Cohesion: 0.29
Nodes (7): Node Agent, Related documentation, REQ-NODE-001: Cross-platform service, REQ-NODE-002: Node claim and heartbeat, REQ-NODE-003: Upstream proxy, REQ-NODE-004: Local dashboard, REQ-NODE-005: Agent self-update

### Community 52 - "Security Requirements"
Cohesion: 0.29
Nodes (7): Related documentation, REQ-SEC-001: Credential boundaries, REQ-SEC-002: Secret storage and rotation readiness, REQ-SEC-003: Header filtering, REQ-SEC-004: Runtime API exposure, REQ-SEC-005: Dashboard token lifecycle, Security

### Community 53 - "Runtime Controller Tests"
Cohesion: 0.40
Nodes (4): UpdateAsset, UpdatePlan, StageUpdate(), Reader

### Community 54 - "Agent Update Staging"
Cohesion: 0.33
Nodes (6): Cloudflare Access Position, Public Routes And Auth, Security And Trust Model, Token Classes, Trust Boundaries, Why Not One Token

### Community 55 - "Security Trust Plan"
Cohesion: 0.33
Nodes (6): Default Engine: llama.cpp, Gemma 4 26B-A4B Profile, Initial Runtime Scope, Model Profiles, Model Runtime Strategy, Qwen 3.6 27B Profile

### Community 56 - "Runtime Model Strategy"
Cohesion: 0.33
Nodes (6): Gateway Integration, Related documentation, REQ-GWY-001: Gateway custom provider, REQ-GWY-002: Provider token contract, REQ-GWY-003: Dynamic route automation, REQ-GWY-004: Gateway header validation

### Community 57 - "Gateway Requirements"
Cohesion: 0.33
Nodes (6): Observability, Related documentation, REQ-OBS-001: Provider response metadata, REQ-OBS-002: Admin status surface, REQ-OBS-003: Node metrics, REQ-OBS-004: Failure reporting

### Community 58 - "Observability Requirements"
Cohesion: 0.33
Nodes (6): Related documentation, Release And CI, REQ-REL-001: Pull request checks, REQ-REL-002: Deploy workflow gating, REQ-REL-003: Node-agent release artifacts, REQ-REL-004: Security workflows

### Community 59 - "Release CI Requirements"
Cohesion: 0.33
Nodes (6): Related documentation, REQ-RTR-001: Route family separation, REQ-RTR-002: Chat completion forwarding, REQ-RTR-003: Streaming pass-through, REQ-RTR-004: Mesh destination safety, Router Worker

### Community 60 - "Router Requirements"
Cohesion: 0.33
Nodes (6): Related documentation, REQ-RUN-001: Public model aliases, REQ-RUN-002: Default model profiles, REQ-RUN-003: Managed llama.cpp runtime, REQ-RUN-004: Profile rollout, Runtime Profiles

### Community 61 - "Runtime Profile Requirements"
Cohesion: 0.33
Nodes (6): Related documentation, REQ-SCH-001: Durable router state, REQ-SCH-002: Node reservations, REQ-SCH-003: Node eligibility and busy response, REQ-SCH-004: Session affinity, State And Scheduling

### Community 62 - "Scheduling Requirements"
Cohesion: 0.40
Nodes (5): Dependency-ordered implementation phases, GitHub repository secrets needed, Implementation Plan, RED/GREEN/VERIFY task list, Success criteria & verification

### Community 64 - "Implementation Task Plan"
Cohesion: 0.40
Nodes (5): AI Gateway Setup Flow, Custom Provider, Dynamic Route, Provider Bearer Token, Required Validation

### Community 65 - "Gateway Setup Plan"
Cohesion: 0.40
Nodes (5): Architecture Summary, Control Plane Node Path, Data Plane Request Path, Logical Planes, Target Architecture

### Community 66 - "Target Architecture Plan"
Cohesion: 0.50
Nodes (4): Cloudflare API Token Scopes, Deploy Token, GitHub Repository Secrets, Runtime Token

### Community 67 - "Cloudflare Token Scopes"
Cohesion: 0.50
Nodes (4): End-To-End Flows, First Deployment Flow, Inference Flow, Node Install Flow

### Community 68 - "End To End Flows"
Cohesion: 0.50
Nodes (4): Node Metrics, Observability, Response Headers, Router Status

## Knowledge Gaps
- **410 isolated node(s):** `name`, `version`, `private`, `description`, `workspaces` (+405 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Codeflare Inference Mesh Plan` connect `Project Plan Bootstrap` to `Agent Router Client`, `Agent Architecture Plan`, `Plan Alternatives Analysis`, `Plan State Scheduling`, `Model Alias Plan`, `Implementation Phase Plan`, `Actions Release Plan`, `Plan Failure Modes`, `Router Architecture Plan`, `Component Responsibility Plan`, `Plan Design Principles`, `Validation Gate Plan`, `Agent Update Staging`, `Security Trust Plan`, `Implementation Task Plan`, `Gateway Setup Plan`, `Target Architecture Plan`, `Cloudflare Token Scopes`, `End To End Flows`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Why does `Admin API Reference` connect `Architecture Decision Records` to `Agent Router Client`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `Architecture Decisions` connect `Public API Reference` to `Agent Router Client`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `runService()` (e.g. with `ApplyClaim()` and `HeartbeatFromConfig()`) actually correct?**
  _`runService()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _410 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Router Store Persistence` be split into smaller, more focused modules?**
  _Cohesion score 0.1383399209486166 - nodes in this community are weakly interconnected._
- **Should `Router Auth Installers` be split into smaller, more focused modules?**
  _Cohesion score 0.08143839238498149 - nodes in this community are weakly interconnected._