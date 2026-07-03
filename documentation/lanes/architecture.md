# Architecture

## Contents

- [Overview](#overview)
- [Component map](#component-map)
- [Data plane lifecycle](#data-plane-lifecycle)
- [Control plane lifecycle](#control-plane-lifecycle)
- [State flow](#state-flow)
- [Runtime flow](#runtime-flow)
- [Boundaries](#boundaries)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Overview

Codeflare Inference Mesh exposes private local inference nodes through one Cloudflare AI Gateway custom provider. The public Worker validates Gateway traffic, consults durable state and a Durable Object scheduler, forwards requests through Workers VPC to a Mesh IP, and streams the local runtime response back. ([REQ-GWY-001](../../sdd/spec/gateway.md)) ([REQ-RTR-002](../../sdd/spec/router-worker.md))

## Component map

| Component | Responsibility | Source | Implements |
| --- | --- | --- | --- |
| Router Worker | HTTP entry point, auth gates, setup/admin UI, Gateway provider endpoints. | `packages/router-worker/src/` | [REQ-RTR-001](../../sdd/spec/router-worker.md), [REQ-RTR-002](../../sdd/spec/router-worker.md) |
| RegistryDO | Durable Object entry point for reservation, release, and mesh seed election requests; scheduler logic handles leases, scoring, and session affinity. | `packages/router-worker/src/durable.ts`, `packages/router-worker/src/scheduler.ts` | [REQ-SCH-002](../../sdd/spec/state-scheduling.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md), [REQ-RUN-008](../../sdd/spec/runtime-profiles.md) |
| D1 migrations | Durable schema for config, nodes, sessions, profiles, and audit. | `packages/router-worker/migrations/` | [REQ-SCH-001](../../sdd/spec/state-scheduling.md) |
| Mesh state | Router-owned mesh membership: seed election, encrypted invite-token set, rotation counter, mesh health. | `packages/router-worker/src/mesh-state.ts`, `packages/router-worker/src/mesh-crypto.ts` | [REQ-RUN-008](../../sdd/spec/runtime-profiles.md), [REQ-SEC-006](../../sdd/spec/security.md) |
| Agent versions | GitHub release-tag cache and fleet-wide desired agent version distribution. | `packages/router-worker/src/agent-versions.ts` | [REQ-ADM-008](../../sdd/spec/setup-admin.md) |
| Node Agent | Local service, node claim, heartbeat, proxy, UI, runtime supervision. | `packages/node-agent/` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| GitHub workflows | CI, security checks, deploy, release artifacts. | `.github/workflows/` | [REQ-REL-001](../../sdd/spec/release-ci.md), [REQ-REL-002](../../sdd/spec/release-ci.md) |

## Data plane lifecycle

1. Client calls AI Gateway using `dynamic/<route-name>`. ([REQ-GWY-003](../../sdd/spec/gateway.md))
2. AI Gateway forwards to the custom provider URL on the router Worker. ([REQ-GWY-001](../../sdd/spec/gateway.md))
3. Worker verifies provider credentials and validates the chat body. ([REQ-GWY-002](../../sdd/spec/gateway.md)) ([REQ-RTR-002](../../sdd/spec/router-worker.md))
4. Worker maps the public alias to the active model profile. ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md))
5. Worker asks the Durable Object scheduler for a reservation. ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))
6. Worker forwards through the `env.MESH.fetch` Workers VPC binding to the validated node Mesh IP and port on the WARP CGNAT range (`100.96.0.0/12`). ([REQ-RTR-004](../../sdd/spec/router-worker.md))
7. Node agent validates upstream token and proxies to the local `mesh-llm` OpenAI API (default `127.0.0.1:9337`); `mesh-llm` routes internally across the mesh when another member serves the model. ([REQ-NODE-003](../../sdd/spec/node-agent.md))
8. Runtime response streams back through node, Worker, Gateway, and client. ([REQ-RTR-003](../../sdd/spec/router-worker.md))

## Control plane lifecycle

1. Admin opens `/` or `/admin` on the bootstrap origin; the Worker pre-renders the guided wizard, which claims the deployment, provisions the custom domain from the account's zones, and provisions Cloudflare Access (admin-email allow policy plus machine-path bypass) before handing off to the custom domain. Setup advances through `claimed` → `domain_ready` → `access_ready` → `complete` phases stored in `router_config` (`packages/router-worker/src/setup-state.ts`); after completion the bootstrap origin serves only a console-moved page. ([REQ-ADM-011](../../sdd/spec/setup-admin.md)) ([REQ-ADM-012](../../sdd/spec/setup-admin.md)) ([REQ-ADM-014](../../sdd/spec/setup-admin.md))
2. Admin connects AI Gateway from the wizard's Gateway step — gateway and route dropdowns populated from the live account, with one-click default provisioning — or later from the dashboard Routing section. ([REQ-GWY-005](../../sdd/spec/gateway.md)) ([REQ-GWY-003](../../sdd/spec/gateway.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
3. Admin creates a one-time setup token from the wizard's enrollment step or the dashboard Nodes section. ([REQ-ADM-003](../../sdd/spec/setup-admin.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
4. Node operator runs the generated install command. ([REQ-ADM-004](../../sdd/spec/setup-admin.md))
5. Node agent claims the token and starts heartbeat. ([REQ-NODE-002](../../sdd/spec/node-agent.md))
6. For each active MeshLLM profile, the router elects the first eligible heartbeating node as mesh seed (store-if-absent, serialized through RegistryDO) and answers it with `meshBootstrap.action: "create"`; other nodes receive `wait` and do not start `mesh-llm` yet. ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md))
7. The seed's `mesh-llm` mints the mesh identity, and every node reports its invite token and mesh id in each heartbeat. ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md)) ([REQ-SEC-006](../../sdd/spec/security.md))
   - The router stores the token set encrypted and returns all live tokens as `joinTokens` in heartbeat responses, so remaining nodes join. ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md))
8. One-click mesh rotation increments a per-profile rotation counter and clears stored mesh state; the counter is baked into the rendered `--mesh-name codeflare-<profileId>-r<N>`, so nodes drain, re-elect a seed, and reform a new mesh. ([REQ-SEC-006](../../sdd/spec/security.md))
9. Admin observes readiness, mesh health, and active profiles in responsive status surfaces. ([REQ-OBS-002](../../sdd/spec/observability.md)) ([REQ-OBS-007](../../sdd/spec/observability.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md))

## State flow

D1 is durable truth for records that must survive restarts. RegistryDO is hot state for serialized reservations, leases, and session affinity. The scheduler rebuilds from D1 after isolate restart and writes durable changes back when state must survive. Per-profile mesh state — rotation counter, seed, mesh id, and the invite-token set — is AES-GCM-encrypted under the `MESH_STATE_KEY` Worker secret before it is written to `router_config`, and seed election is serialized through RegistryDO so only one node is ever told to create a mesh. ([REQ-SCH-001](../../sdd/spec/state-scheduling.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md)) ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md)) ([REQ-SEC-006](../../sdd/spec/security.md))

## Runtime flow

The claimed node stores desired profiles, resolves the active profile, and supervises the MeshLLM runtime:

- It installs the pinned `mesh-llm` binary when it is missing (SHA-256-verified download; install failure reports `dependency-missing`). ([REQ-NODE-006](../../sdd/spec/node-agent.md))
- It runs exactly one `mesh-llm serve` process rendered from the profile (`--mesh-name`, `--bind-ip`, `--bind-port`, headless, mdns discovery, `--split` for layer packages, one `--join <token>` per invite token). ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md)) ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md))
- Readiness combines the `mesh-llm` console `GET /api/status` with a parse of the node's own OpenAI `GET /v1/models`; while the console reports `loading`, the readiness deadline extends instead of failing the runtime. ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting)) ([REQ-OBS-008](../../sdd/spec/observability.md))
- The console API (default `127.0.0.1:3131`) is localhost-only on the node and is never exposed through the router or the mesh; the agent proxies Worker traffic only to the OpenAI API (default `127.0.0.1:9337`). ([REQ-RUN-010](../../sdd/spec/runtime-profiles.md))
- Heartbeat `meshBootstrap` responses drive drain-then-restart triggers: rotation bump, foreign mesh id with join tokens present, or `create` while a mesh is running. ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md))
- Runtime start/stop/restart controls are exposed only on the localhost dashboard, require the dashboard token, and validate same-origin browser Origin headers when present; heartbeats and dashboard status derive runtime state from the live runtime manager. ([REQ-NODE-004](../../sdd/spec/node-agent.md)) ([REQ-OBS-003](../../sdd/spec/observability.md))

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
| Agent versions | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS` <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> |
| MeshLLM manager | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManagerAnchors` <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManagerAnchors --> |
| Router type contracts | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/types.ts::RouterEnv` <!-- @impl: packages/router-worker/src/types.ts::RouterEnv --> |
| Router test fixtures | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/test-helpers.ts::MemoryStore` <!-- @impl: packages/router-worker/src/test-helpers.ts::MemoryStore --> |
| Router behavioral tests | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor` <!-- @impl: packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor --> |
| Agent behavioral tests | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy` <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy --> |
