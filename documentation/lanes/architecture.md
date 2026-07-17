# Architecture

## Contents

- [Overview](#overview)
- [Component map](#component-map)
- [Data plane lifecycle](#data-plane-lifecycle)
- [Control plane lifecycle](#control-plane-lifecycle)
- [Meshes](#meshes)
- [State flow](#state-flow)
- [Runtime flow](#runtime-flow)
- [Boundaries](#boundaries)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Overview

Codeflare Inference Mesh exposes private local inference nodes through one Cloudflare AI Gateway custom provider. The public Worker validates Gateway traffic, selects an eligible node from durable state, forwards the request through Workers VPC to its Mesh IP, and streams the local runtime response back; `mesh-llm` owns concurrency and KV-aware routing across the mesh, so the router holds no per-request reservation state. ([REQ-GWY-001](../../sdd/spec/gateway.md)) ([REQ-RTR-002](../../sdd/spec/router-worker.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))

## Component map

| Component | Responsibility | Source | Implements |
| --- | --- | --- | --- |
| Router Worker | HTTP entry point, auth gates, setup/admin UI, Gateway provider endpoints. | `packages/router-worker/src/` | [REQ-RTR-001](../../sdd/spec/router-worker.md), [REQ-RTR-002](../../sdd/spec/router-worker.md) |
| RegistryDO | Durable Object entry point for mesh seed election only; the inference request path is stateless. | `packages/router-worker/src/durable.ts` | [REQ-RUN-008](../../sdd/spec/runtime-profiles.md) |
| Entry-node selection | Stateless per-request selection of an eligible node from D1; applies no reservation or capacity gate. | `packages/router-worker/src/scheduler.ts` | [REQ-SCH-002](../../sdd/spec/state-scheduling.md), [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| D1 migrations | Durable schema for config, nodes, sessions, profiles, and audit; the legacy `sessions`/`reservations` tables remain as dead schema after the move to stateless forwarding, pending a drop migration. | `packages/router-worker/migrations/` | [REQ-SCH-001](../../sdd/spec/state-scheduling.md) |
| Mesh state | Router-owned mesh membership: seed election, encrypted invite-token set, rotation counter, mesh health. | `packages/router-worker/src/mesh-state.ts`, `packages/router-worker/src/mesh-crypto.ts` | [REQ-RUN-008](../../sdd/spec/runtime-profiles.md), [REQ-SEC-006](../../sdd/spec/security.md) |
| Mesh registry | Operator-named machine groups: durable mesh registry, name validation, per-mesh route aliases. | `packages/router-worker/src/meshes.ts` | [REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership) |
| Agent versions | GitHub release-tag cache and fleet-wide desired agent version distribution. | `packages/router-worker/src/agent-versions.ts` | [REQ-ADM-008](../../sdd/spec/setup-admin.md) |
| Runtime versions | MeshLLM/llama.cpp release-tag caches, fleet-wide desired runtime versions, and heartbeat distribution. | `packages/router-worker/src/runtime-versions.ts` | [REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility) |
| Node Agent | Local service, node claim, heartbeat, proxy, UI, runtime supervision. | `packages/node-agent/` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| GitHub workflows | CI, security checks, deploy, release artifacts. | `.github/workflows/` | [REQ-REL-001](../../sdd/spec/release-ci.md), [REQ-REL-002](../../sdd/spec/release-ci.md) |

Router configuration records in D1 include the agent release-tag cache (`agent_versions_cache`) and selected fleet version (`desired_agent_version`); the runtime release caches and selections (`meshllm_versions_cache`, `llamacpp_versions_cache`, `desired_meshllm_version`, `desired_llamacpp_version`); the mesh registry (`meshes`); and the starter-seeding marker (`default_profiles_seeded`). ([REQ-SCH-001](../../sdd/spec/state-scheduling.md))

## Data plane lifecycle

AI Gateway routes retry failed model calls up to 3 times with a 120s timeout per try, so a hung upstream can take a few minutes to surface. ([REQ-GWY-003](../../sdd/spec/gateway.md))

1. Client calls AI Gateway using `dynamic/<route-name>`. ([REQ-GWY-003](../../sdd/spec/gateway.md))
2. AI Gateway forwards to the custom provider URL on the router Worker. ([REQ-GWY-001](../../sdd/spec/gateway.md))
3. Worker verifies provider credentials and validates the chat body. ([REQ-GWY-002](../../sdd/spec/gateway.md)) ([REQ-RTR-002](../../sdd/spec/router-worker.md))
4. Worker maps the requested stable public model id to that mesh's single active model profile via `getProfileByPublicModel`. ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md#req-run-001-stable-public-model)) ([REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership))
5. The default mesh's active model answers `codeflare-mesh`; every other mesh's active model answers `codeflare-mesh-<id>` — each profile carries its mesh's stable alias, and per-mesh single-active leaves exactly one owner per alias. ([REQ-RUN-016](../../sdd/spec/runtime-profiles.md#req-run-016-per-mesh-model-assignment))
6. Worker selects an eligible node directly from durable state (least-loaded ready node; no reservation, lease, or capacity gate) and rewrites the body to the profile's upstream model. ([REQ-SCH-002](../../sdd/spec/state-scheduling.md)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))
7. Worker forwards through the `env.MESH.fetch` Workers VPC binding to the validated node Mesh IP and port on the WARP CGNAT range (`100.96.0.0/12`); an unreachable node surfaces as `502 node_unreachable`. ([REQ-RTR-004](../../sdd/spec/router-worker.md))
8. Node agent validates upstream token and proxies to the local `mesh-llm` OpenAI API (default `127.0.0.1:9337`); `mesh-llm` owns concurrency and KV-aware routing, dispatching internally across the mesh when another member is cache-warm for the request. ([REQ-NODE-003](../../sdd/spec/node-agent.md))
9. Runtime response streams back through node, Worker, Gateway, and client. ([REQ-RTR-003](../../sdd/spec/router-worker.md))

## Control plane lifecycle

Setup and day-two control flows are the happy path; Gateway and first-node enrollment are skippable during setup and remain available from the dashboard after completion. ([REQ-ADM-011](../../sdd/spec/setup-admin.md#req-adm-011-guided-first-run-setup))

1. Admin opens the bootstrap origin; the wizard claims the deployment. ([REQ-ADM-011](../../sdd/spec/setup-admin.md#req-adm-011-guided-first-run-setup))
2. The shared setup hero and step rail guide claim, domain, Access, optional Gateway, optional node, and review milestones. ([REQ-ADM-011](../../sdd/spec/setup-admin.md#req-adm-011-guided-first-run-setup))
3. The wizard provisions the custom domain, role-gated Access, and machine-path bypass. ([REQ-ADM-012](../../sdd/spec/setup-admin.md)) ([REQ-SEC-010](../../sdd/spec/security.md))
4. The custom-domain handoff moves operators to Access, then setup completion locks the bootstrap origin. ([REQ-ADM-014](../../sdd/spec/setup-admin.md))
5. Admin connects AI Gateway from the wizard Gateway step or dashboard Routing. ([REQ-GWY-005](../../sdd/spec/gateway.md)) ([REQ-GWY-003](../../sdd/spec/gateway.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md)) ([REQ-ADM-024](../../sdd/spec/setup-admin.md#req-adm-024-routing-operational-status))
6. Admin creates one-time setup tokens from wizard enrollment or dashboard Nodes. ([REQ-ADM-003](../../sdd/spec/setup-admin.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
7. Node operator runs the generated install command. ([REQ-ADM-004](../../sdd/spec/setup-admin.md))
8. Node agent claims the token and starts heartbeat. ([REQ-NODE-002](../../sdd/spec/node-agent.md))
9. Router elects the first eligible heartbeating node as mesh seed; other nodes wait. ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md))
10. The seed mints mesh identity; router stores encrypted invite tokens and returns live `joinTokens` through heartbeats. ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md)) ([REQ-SEC-006](../../sdd/spec/security.md)) ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md))
11. Mesh rotation clears stored mesh state, increments per-profile rotation, and forces drain, re-election, and reform. ([REQ-SEC-006](../../sdd/spec/security.md))
12. Admin observes topology, drawers, stats, sortable nodes, and throughput trace. ([REQ-OBS-002](../../sdd/spec/observability.md)) ([REQ-OBS-007](../../sdd/spec/observability.md)) ([REQ-OBS-010](../../sdd/spec/observability.md)) ([REQ-ADM-015](../../sdd/spec/setup-admin.md)) ([REQ-ADM-028](../../sdd/spec/setup-admin.md#req-adm-028-topology-connector-bounds))
13. Admin verifies inference from Playground. ([REQ-ADM-016](../../sdd/spec/setup-admin.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
14. Each verified caller resolves to admin or read-only user. ([REQ-SEC-010](../../sdd/spec/security.md)) ([REQ-ADM-017](../../sdd/spec/setup-admin.md))
15. Admin adds models from the dashboard or `POST /admin/profiles/add`. ([REQ-RUN-011](../../sdd/spec/runtime-profiles.md#req-run-011-custom-model-onboarding)) ([REQ-RUN-013](../../sdd/spec/runtime-profiles.md#req-run-013-direct-llamacpp-custom-profiles)) ([REQ-ADM-025](../../sdd/spec/setup-admin.md#req-adm-025-add-a-model-console-control))
16. Admin removes switched-off models from dashboard or API. ([REQ-RUN-012](../../sdd/spec/runtime-profiles.md#req-run-012-model-removal)) ([REQ-ADM-026](../../sdd/spec/setup-admin.md#req-adm-026-delete-a-model-console-control)) ([REQ-API-008](../../sdd/spec/control-plane-api.md#req-api-008-programmatic-model-deletion))

## Meshes

Nodes and model profiles are grouped into operator-named meshes (machine groups). Every node and every model profile belongs to exactly one mesh; the implicit `default` mesh (display name "Default") always exists and cannot be deleted. A mesh name is letters-only up to 32 characters, normalized to a capitalized display name (for example `Development`) and a lowercase id, and each mesh's active model answers its own stable route alias: `codeflare-mesh` for the default mesh, `codeflare-mesh-<id>` for every other mesh. ([REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership)) ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md#req-run-001-stable-public-model)) ([REQ-RUN-016](../../sdd/spec/runtime-profiles.md#req-run-016-per-mesh-model-assignment))

Membership is router authority and scopes distribution end to end: claim and heartbeat responses carry only the node's own mesh's profiles (a newly claimed node joins the default mesh), and scheduler eligibility, seed election, mesh-state membership, and profile readiness all require the node's mesh to match the profile's mesh server-side, so a node still self-reporting a foreign mesh's profile ids receives no mesh bootstrap for it. Activation is single-active per mesh: activating a model deactivates the other active models in its mesh plus any alias-overlapping active model anywhere, leaving other meshes' alias-disjoint active models untouched. ([REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership)) ([REQ-RUN-009](../../sdd/spec/runtime-profiles.md#req-run-009-profile-seeding-and-activation-exclusivity))

Reassigning a node to another mesh strips its mesh invite tokens from its old mesh's profiles; reassigning a model swaps in the new mesh's stable alias, deactivates the model (rollout zero) so it arrives switched off in its new mesh, and bumps its version. A node moved to a mesh with no active model keeps running its previous model until the new mesh's model is activated — the agent ignores empty desired-profile sets — while the server-side eligibility gate keeps routing correct, so no request is forwarded to a mesh-mismatched node. ([REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))

## State flow

D1 is durable truth for records that must survive restarts. The inference request path holds no hot state: it reads eligible nodes directly from D1 and forwards, so an isolate restart loses nothing to rebuild. RegistryDO serializes only mesh seed election, so exactly one node is ever told to create a mesh. Per-profile mesh state (rotation counter, seed, mesh id, and the invite-token set) is AES-GCM-encrypted under the `MESH_STATE_KEY` Worker secret before it is written to `router_config`. The mesh registry (`meshes` key) and the seed-once starter-catalog marker (`default_profiles_seeded` key) are plaintext `router_config` records alongside it. ([REQ-SCH-001](../../sdd/spec/state-scheduling.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md)) ([REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership)) ([REQ-RUN-002](../../sdd/spec/runtime-profiles.md#req-run-002-default-model-profiles)) ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md)) ([REQ-SEC-006](../../sdd/spec/security.md))

## Runtime flow

The claimed node stores desired profiles, resolves the active profile, and supervises the MeshLLM runtime:

- It installs the pinned `mesh-llm` binary when it is missing (SHA-256-verified download; install failure reports `dependency-missing`). ([REQ-NODE-006](../../sdd/spec/node-agent.md))
- It runs one headless `mesh-llm serve` process from the profile. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md))
- The command carries mesh address, Nostr discovery, disabled iroh relays, split-mode flags, and invite tokens. ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md))
- Deactivated nodes keep heartbeating but launch no runtime. ([REQ-NODE-011](../../sdd/spec/node-agent.md))
- Readiness combines the `mesh-llm` console status with the node's own OpenAI model list. A `loading` console state extends the readiness deadline instead of failing the runtime. ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting)) ([REQ-OBS-008](../../sdd/spec/observability.md))
- The console API (default `127.0.0.1:3131`) is localhost-only on the node and is never exposed through the router or the mesh; the agent proxies Worker traffic only to the OpenAI API (default `127.0.0.1:9337`). ([REQ-RUN-010](../../sdd/spec/runtime-profiles.md))
- Heartbeat `meshBootstrap` responses drive drain-then-restart triggers for rotation, foreign mesh ids, and seed promotion. Draining waits for local proxy and MeshLLM `inflight_requests` counters to reach zero before restart. ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md))
- Runtime start, stop, and restart controls exist only on the localhost dashboard and require the dashboard token. ([REQ-NODE-004](../../sdd/spec/node-agent.md))
- Browser `Origin` headers are accepted only when same-origin if present. ([REQ-OBS-003](../../sdd/spec/observability.md))
- Heartbeats and dashboard status derive runtime state from the live runtime manager. ([REQ-OBS-003](../../sdd/spec/observability.md))

## Boundaries

Only the Worker is public. Node listeners are reachable through Mesh and still require upstream bearer tokens. The `mesh-llm` console API binds to localhost on the node and is never exposed through the router or the mesh. Admin, provider, setup, node, dashboard, upstream, mesh invite-token, deploy, and runtime Cloudflare credentials are separate. ([REQ-SEC-001](../../sdd/spec/security.md)) ([REQ-SEC-004](../../sdd/spec/security.md)) ([REQ-SEC-008](../../sdd/spec/security.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Router Worker | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Scheduler | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS` <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> |
| D1 store | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/store.ts::STORE_ANCHORS` <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> |
| Node agent | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/client.go::ClientAnchors` <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> |
| Agent command | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/cmd/inference-mesh-agent/main.go::MainAnchors` <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::MainAnchors --> |
| Mesh state | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Mesh registry | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/meshes.ts::MESHES_ANCHORS` <!-- @impl: packages/router-worker/src/meshes.ts::MESHES_ANCHORS --> |
| Model profiles | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/profiles.ts::STABLE_PUBLIC_MODEL` <!-- @impl: packages/router-worker/src/profiles.ts::STABLE_PUBLIC_MODEL --> |
| Agent versions | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS` <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> |
| MeshLLM manager | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManagerAnchors` <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManagerAnchors --> |
| Router type contracts | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/types.ts::RouterEnv` <!-- @impl: packages/router-worker/src/types.ts::RouterEnv --> |
| Router test fixtures | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/test-helpers.ts::MemoryStore` <!-- @impl: packages/router-worker/src/test-helpers.ts::MemoryStore --> |
| Router behavioral tests | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor` <!-- @impl: packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor --> |
| Agent behavioral tests | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy` <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy --> |
