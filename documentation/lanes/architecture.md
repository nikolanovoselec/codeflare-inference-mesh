# Architecture

## Overview

Codeflare Inference Mesh exposes private local inference nodes through one Cloudflare AI Gateway custom provider. The public Worker validates Gateway traffic, consults durable state and a Durable Object scheduler, forwards requests through Workers VPC to a Mesh IP, and streams the local runtime response back. ([REQ-GWY-001](../../sdd/spec/gateway.md)) ([REQ-RTR-002](../../sdd/spec/router-worker.md))

## Component map

| Component | Planned path | Role | Implements |
| --- | --- | --- | --- |
| Router Worker | `packages/router-worker/src/` | HTTP entry point, auth gates, setup/admin UI, Gateway provider endpoints. | [REQ-RTR-001](../../sdd/spec/router-worker.md), [REQ-RTR-002](../../sdd/spec/router-worker.md) |
| RegistryDO | `packages/router-worker/src/registry-do.ts` | Serialized reservations, leases, scoring, session affinity. | [REQ-SCH-002](../../sdd/spec/state-scheduling.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md) |
| D1 migrations | `packages/router-worker/migrations/` | Durable schema for config, nodes, sessions, profiles, and audit. | [REQ-SCH-001](../../sdd/spec/state-scheduling.md) |
| Node Agent | `packages/node-agent/` | Local service, node claim, heartbeat, proxy, UI, runtime supervision. | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| GitHub workflows | `.github/workflows/` | CI, security checks, deploy, release artifacts. | [REQ-REL-001](../../sdd/spec/release-ci.md), [REQ-REL-002](../../sdd/spec/release-ci.md) |

## Data plane lifecycle

1. Client calls AI Gateway using `dynamic/<route-name>`. ([REQ-GWY-003](../../sdd/spec/gateway.md))
2. AI Gateway forwards to the custom provider URL on the router Worker. ([REQ-GWY-001](../../sdd/spec/gateway.md))
3. Worker verifies provider credentials and validates the chat body. ([REQ-GWY-002](../../sdd/spec/gateway.md)) ([REQ-RTR-002](../../sdd/spec/router-worker.md))
4. Worker maps the public alias to the active model profile. ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md))
5. Worker asks the Durable Object scheduler for a reservation. ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))
6. Worker forwards through `env.MESH.fetch` to the validated node Mesh IP and port. ([REQ-RTR-004](../../sdd/spec/router-worker.md))
7. Node agent validates upstream token and proxies to the local runtime. ([REQ-NODE-003](../../sdd/spec/node-agent.md))
8. Runtime response streams back through node, Worker, Gateway, and client. ([REQ-RTR-003](../../sdd/spec/router-worker.md))

## Control plane lifecycle

1. Admin completes first-run setup on `workers.dev`. ([REQ-ADM-001](../../sdd/spec/setup-admin.md))
2. Admin configures AI Gateway provider and route through setup automation. ([REQ-GWY-003](../../sdd/spec/gateway.md))
3. Admin creates a one-time setup token. ([REQ-ADM-003](../../sdd/spec/setup-admin.md))
4. Node operator runs the generated install command. ([REQ-ADM-004](../../sdd/spec/setup-admin.md))
5. Node agent claims the token and starts heartbeat. ([REQ-NODE-002](../../sdd/spec/node-agent.md))
6. Admin observes readiness and active profiles in status surfaces. ([REQ-OBS-002](../../sdd/spec/observability.md))

## State flow

D1 is durable truth for records that must survive restarts. RegistryDO is hot state for serialized reservations, leases, and session affinity. The scheduler rebuilds from D1 after isolate restart and writes durable changes back when state must survive. ([REQ-SCH-001](../../sdd/spec/state-scheduling.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))

## Runtime flow

Phase 1 proves Worker-to-Mesh against an existing `llama-server`. Later phases let the node agent download verified model files, start `llama-server`, track profile versions, and report runtime metrics. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md)) ([REQ-OBS-003](../../sdd/spec/observability.md))

## Boundaries

Only the Worker is public. Node listeners are reachable through Mesh and still require upstream bearer tokens. Admin, provider, setup, node, upstream, deploy, and runtime Cloudflare credentials are separate. ([REQ-SEC-001](../../sdd/spec/security.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Router Worker | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Scheduler | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS` <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> |
| D1 store | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/store.ts::STORE_ANCHORS` <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> |
| Node agent | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/client.go::ClientAnchors` <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> |
| Agent command | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/cmd/inference-mesh-agent/main.go::MainAnchors` <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::MainAnchors --> |
| Router type contracts | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/types.ts::RouterEnv` <!-- @impl: packages/router-worker/src/types.ts::RouterEnv --> |
| Router test fixtures | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/test-helpers.ts::MemoryStore` <!-- @impl: packages/router-worker/src/test-helpers.ts::MemoryStore --> |
| Router behavioral tests | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.test.ts::routerFixture` <!-- @impl: packages/router-worker/src/router.test.ts::routerFixture --> |
| Agent behavioral tests | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy` <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy --> |
