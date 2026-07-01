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
| RegistryDO | Durable Object entry point for reservation and release requests; scheduler logic handles leases, scoring, and session affinity. | `packages/router-worker/src/durable.ts`, `packages/router-worker/src/scheduler.ts` | [REQ-SCH-002](../../sdd/spec/state-scheduling.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md) |
| D1 migrations | Durable schema for config, nodes, sessions, profiles, and audit. | `packages/router-worker/migrations/` | [REQ-SCH-001](../../sdd/spec/state-scheduling.md) |
| Node Agent | Local service, node claim, heartbeat, proxy, UI, runtime supervision. | `packages/node-agent/` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| GitHub workflows | CI, security checks, deploy, release artifacts. | `.github/workflows/` | [REQ-REL-001](../../sdd/spec/release-ci.md), [REQ-REL-002](../../sdd/spec/release-ci.md) |

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

1. Admin opens `/` or `/admin` on the Worker command center and completes first-run setup in the browser. ([REQ-ADM-001](../../sdd/spec/setup-admin.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
2. Admin uses command-center controls to configure AI Gateway provider and route automation. ([REQ-GWY-003](../../sdd/spec/gateway.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
3. Admin creates a one-time setup token from the command center. ([REQ-ADM-003](../../sdd/spec/setup-admin.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md)) ([REQ-ADM-007](../../sdd/spec/setup-admin.md))
4. Node operator runs the generated install command. ([REQ-ADM-004](../../sdd/spec/setup-admin.md))
5. Node agent claims the token and starts heartbeat. ([REQ-NODE-002](../../sdd/spec/node-agent.md))
6. Admin observes readiness and active profiles in responsive status surfaces. ([REQ-OBS-002](../../sdd/spec/observability.md)) ([REQ-ADM-006](../../sdd/spec/setup-admin.md))

## State flow

D1 is durable truth for records that must survive restarts. RegistryDO is hot state for serialized reservations, leases, and session affinity. The scheduler rebuilds from D1 after isolate restart and writes durable changes back when state must survive. ([REQ-SCH-001](../../sdd/spec/state-scheduling.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))

## Runtime flow

The claimed node stores desired profiles, resolves the active profile, verifies or downloads the GGUF model, starts `llama-server`, and proxies Worker traffic to the local runtime. Runtime start/stop/restart controls are exposed only on the localhost dashboard, require the dashboard token, and validate same-origin browser Origin headers when present; heartbeats and dashboard status derive runtime state from the live runtime manager. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md)) ([REQ-NODE-004](../../sdd/spec/node-agent.md)) ([REQ-OBS-003](../../sdd/spec/observability.md))

## Boundaries

Only the Worker is public. Node listeners are reachable through Mesh and still require upstream bearer tokens. Admin, provider, setup, node, dashboard, upstream, deploy, and runtime Cloudflare credentials are separate. ([REQ-SEC-001](../../sdd/spec/security.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Router Worker | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Scheduler | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS` <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> |
| D1 store | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/store.ts::STORE_ANCHORS` <!-- @impl: packages/router-worker/src/store.ts::STORE_ANCHORS --> |
| Node agent | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/client.go::ClientAnchors` <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> |
| Agent command | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/cmd/inference-mesh-agent/main.go::MainAnchors` <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::MainAnchors --> |
| Router type contracts | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/types.ts::RouterEnv` <!-- @impl: packages/router-worker/src/types.ts::RouterEnv --> |
| Router test fixtures | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/test-helpers.ts::MemoryStore` <!-- @impl: packages/router-worker/src/test-helpers.ts::MemoryStore --> |
| Router behavioral tests | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor` <!-- @impl: packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor --> |
| Agent behavioral tests | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy` <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE001ServiceSkeletonAndListenerPolicy --> |
