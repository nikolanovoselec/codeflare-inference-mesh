# Graph Report - /home/user/workspace/cloudflare-inference-mesh  (2026-07-01)

## Corpus Check
- label apply mode — file stats not available

## Summary
- 395 nodes · 769 edges · 17 communities (15 shown, 2 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 46 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9098ddb6`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Router Persistence Store|Router Persistence Store]]
- [[_COMMUNITY_Router Auth Handlers|Router Auth Handlers]]
- [[_COMMUNITY_Router Scheduling Runtime|Router Scheduling Runtime]]
- [[_COMMUNITY_Node Agent Config Tests|Node Agent Config Tests]]
- [[_COMMUNITY_Llama Runtime Manager|Llama Runtime Manager]]
- [[_COMMUNITY_Node Proxy Dashboard|Node Proxy Dashboard]]
- [[_COMMUNITY_Router Package Scripts|Router Package Scripts]]
- [[_COMMUNITY_Node Router Client|Node Router Client]]
- [[_COMMUNITY_Monorepo Package Scripts|Monorepo Package Scripts]]
- [[_COMMUNITY_Cloudflare Gateway Sync|Cloudflare Gateway Sync]]
- [[_COMMUNITY_TypeScript Base Config|TypeScript Base Config]]
- [[_COMMUNITY_Mesh IP Detection|Mesh IP Detection]]
- [[_COMMUNITY_Workflow Contract Tests|Workflow Contract Tests]]
- [[_COMMUNITY_Router D1 Schema|Router D1 Schema]]
- [[_COMMUNITY_Router TypeScript Config|Router TypeScript Config]]
- [[_COMMUNITY_Router Lint Script|Router Lint Script]]
- [[_COMMUNITY_Node Agent Module|Node Agent Module]]

## God Nodes (most connected - your core abstractions)
1. `D1Store` - 29 edges
2. `MemoryStore` - 28 edges
3. `json()` - 16 edges
4. `runService()` - 15 edges
5. `authenticateKind()` - 15 edges
6. `ModelProfile` - 15 edges
7. `RuntimeManager` - 13 edges
8. `Config` - 12 edges
9. `CredentialKind` - 12 edges
10. `TokenRecord` - 12 edges

## Surprising Connections (you probably didn't know these)
- `runService()` --calls--> `RuntimeListenAddress()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/runtime.go
- `runService()` --calls--> `ApplyClaim()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go
- `runService()` --calls--> `HeartbeatFromConfig()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/client.go
- `runService()` --calls--> `ProxyHandler()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/proxy.go
- `runService()` --calls--> `EnsureModel()`  [INFERRED]
  packages/node-agent/cmd/inference-mesh-agent/main.go → packages/node-agent/internal/agent/runtime.go

## Import Cycles
- None detected.

## Communities (17 total, 2 thin omitted)

### Community 0 - "Router Persistence Store"
Cohesion: 0.06
Nodes (17): D1Store, nodeFromRow(), NodeRow, parseJson(), reservationFromRow(), ReservationRow, STORE_ANCHORS, tokenFromRow() (+9 more)

### Community 1 - "Router Auth Handlers"
Cohesion: 0.08
Nodes (56): approvedNodeHeaders(), AUTH_ANCHORS, bearerToken(), createTokenId(), createTokenRecord(), generateBearerToken(), hashToken(), randomHex() (+48 more)

### Community 2 - "Router Scheduling Runtime"
Cohesion: 0.07
Nodes (28): DURABLE_ANCHORS, RegistryDO, fetch(), INDEX_ANCHORS, DEFAULT_MODEL_PROFILES, PROFILE_ANCHORS, createRouter(), makeMesh() (+20 more)

### Community 3 - "Node Agent Config Tests"
Cohesion: 0.08
Nodes (40): Config, fakeRuntimeController, NodeMetrics, ServiceInstall, UpdateAsset, UpdatePlan, defaultDataDir(), main() (+32 more)

### Community 4 - "Llama Runtime Manager"
Cohesion: 0.14
Nodes (21): ModelProfile, RuntimeCommand, RuntimeManager, CancelFunc, Cmd, Mutex, TestREQRUN003LlamaRuntimeCommandAndChecksum(), DownloadModel() (+13 more)

### Community 5 - "Node Proxy Dashboard"
Cohesion: 0.13
Nodes (18): ActiveCounter, DashboardStatus, RuntimeController, HandlerFunc, Header, TestREQNODE003UpstreamProxyEnforcesBearerAndStreams(), dashboardControlAllowed(), Context (+10 more)

### Community 6 - "Router Package Scripts"
Cohesion: 0.10
Nodes (19): dependencies, devDependencies, @cloudflare/workers-types, @types/node, typescript, vitest, wrangler, yaml (+11 more)

### Community 7 - "Node Router Client"
Cohesion: 0.27
Nodes (10): ClaimRequest, ClaimResponse, Client, HeartbeatRequest, HeartbeatResponse, ApplyClaim(), Context, ModelProfile (+2 more)

### Community 8 - "Monorepo Package Scripts"
Cohesion: 0.14
Nodes (13): description, engines, node, name, private, scripts, cf-types, dry-run (+5 more)

### Community 9 - "Cloudflare Gateway Sync"
Cohesion: 0.21
Nodes (9): ApiEnvelope, CLOUDFLARE_API_ANCHORS, CloudflareGatewayClient, GatewaySyncRequest, GatewaySyncResult, originOnly(), routeGraph(), slugify() (+1 more)

### Community 10 - "TypeScript Base Config"
Cohesion: 0.17
Nodes (11): compilerOptions, exactOptionalPropertyTypes, lib, module, moduleResolution, noUncheckedIndexedAccess, resolveJsonModule, skipLibCheck (+3 more)

### Community 11 - "Mesh IP Detection"
Cohesion: 0.24
Nodes (8): Addr, fuzzAddr, F, IP, DetectMeshIP(), ipFromAddr(), isPrivateOrCGNAT(), FuzzDetectMeshIP()

### Community 12 - "Workflow Contract Tests"
Cohesion: 0.28
Nodes (7): allRunText(), Job, repoRoot, runLines(), Step, stepRuns(), Workflow

### Community 13 - "Router D1 Schema"
Cohesion: 0.25
Nodes (7): audit_events, model_profiles, nodes, reservations, router_config, sessions, tokens

### Community 14 - "Router TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, noEmit, rootDir, exclude, extends, include

## Knowledge Gaps
- **76 isolated node(s):** `name`, `version`, `private`, `description`, `workspaces` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `runService()` connect `Node Agent Config Tests` to `Llama Runtime Manager`, `Node Proxy Dashboard`, `Node Router Client`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `MemoryStore` connect `Router Persistence Store` to `Router Scheduling Runtime`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `D1Store` connect `Router Persistence Store` to `Router Scheduling Runtime`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `runService()` (e.g. with `ApplyClaim()` and `HeartbeatFromConfig()`) actually correct?**
  _`runService()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _76 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Router Persistence Store` be split into smaller, more focused modules?**
  _Cohesion score 0.055178652193577565 - nodes in this community are weakly interconnected._
- **Should `Router Auth Handlers` be split into smaller, more focused modules?**
  _Cohesion score 0.0847457627118644 - nodes in this community are weakly interconnected._