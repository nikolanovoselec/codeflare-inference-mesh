# Architecture

## Overview

Cloudflare Inference Mesh exposes private local inference nodes through one Cloudflare AI Gateway custom provider. The public Worker validates Gateway traffic, consults durable state and a Durable Object scheduler, forwards requests through Workers VPC to a Mesh IP, and streams the local runtime response back. (REQ-GWY-001) (REQ-RTR-002)

## Component map

| Component | Planned path | Role | Implements |
| --- | --- | --- | --- |
| Router Worker | `packages/router-worker/src/` | HTTP entry point, auth gates, setup/admin UI, Gateway provider endpoints. | REQ-RTR-001, REQ-RTR-002 |
| RegistryDO | `packages/router-worker/src/registry-do.ts` | Serialized reservations, leases, scoring, session affinity. | REQ-SCH-002, REQ-SCH-004 |
| D1 migrations | `packages/router-worker/migrations/` | Durable schema for config, nodes, sessions, profiles, and audit. | REQ-SCH-001 |
| Node Agent | `packages/node-agent/` | Local service, node claim, heartbeat, proxy, UI, runtime supervision. | REQ-NODE-001, REQ-NODE-002 |
| GitHub workflows | `.github/workflows/` | CI, security checks, deploy, release artifacts. | REQ-REL-001, REQ-REL-002 |

## Data plane lifecycle

1. Client calls AI Gateway using `dynamic/<route-name>`. (REQ-GWY-003)
2. AI Gateway forwards to the custom provider URL on the router Worker. (REQ-GWY-001)
3. Worker verifies provider credentials and validates the chat body. (REQ-GWY-002) (REQ-RTR-002)
4. Worker maps the public alias to the active model profile. (REQ-RUN-001)
5. Worker asks the Durable Object scheduler for a reservation. (REQ-SCH-002)
6. Worker forwards through `env.MESH.fetch` to the validated node Mesh IP and port. (REQ-RTR-004)
7. Node agent validates upstream token and proxies to the local runtime. (REQ-NODE-003)
8. Runtime response streams back through node, Worker, Gateway, and client. (REQ-RTR-003)

## Control plane lifecycle

1. Admin completes first-run setup on `workers.dev`. (REQ-ADM-001)
2. Admin configures AI Gateway provider and route through setup automation. (REQ-GWY-003)
3. Admin creates a one-time setup token. (REQ-ADM-003)
4. Node operator runs the generated install command. (REQ-ADM-004)
5. Node agent claims the token and starts heartbeat. (REQ-NODE-002)
6. Admin observes readiness and active profiles in status surfaces. (REQ-OBS-002)

## State flow

D1 is durable truth for records that must survive restarts. RegistryDO is hot state for serialized reservations, leases, and session affinity. The scheduler rebuilds from D1 after isolate restart and writes durable changes back when state must survive. (REQ-SCH-001) (REQ-SCH-002)

## Runtime flow

Phase 1 proves Worker-to-Mesh against an existing `llama-server`. Later phases let the node agent download verified model files, start `llama-server`, track profile versions, and report runtime metrics. (REQ-RUN-003) (REQ-OBS-003)

## Boundaries

Only the Worker is public. Node listeners are reachable through Mesh and still require upstream bearer tokens. Admin, provider, setup, node, upstream, deploy, and runtime Cloudflare credentials are separate. (REQ-SEC-001)
