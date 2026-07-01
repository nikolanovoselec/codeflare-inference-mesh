# API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

All API responses that represent errors use an OpenAI-style `error` object when they are visible to AI Gateway or OpenAI-compatible clients. Provider routes require the provider token; node routes require setup or node credentials; installer routes contain no permanent secrets. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## Endpoints

### GET /health ([REQ-RTR-001](../../sdd/spec/router-worker.md))

Returns Worker health for routing and deploy verification.

```http
GET /health
```

**Authentication:** None.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | JSON health object | Confirms the Worker route family is reachable. |

**Implements:** [REQ-RTR-001](../../sdd/spec/router-worker.md)

### GET /v1/models ([REQ-GWY-001](../../sdd/spec/gateway.md)) ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md))

Lists public OpenAI-compatible model aliases exposed through the mesh.

```http
GET /v1/models
```

**Authentication:** Provider bearer token.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | OpenAI-compatible model list | Lists public aliases such as `mesh-default`, not internal runtime names. |
| `401` | Error object | Provider token is missing or invalid. |

**Implements:** [REQ-GWY-001](../../sdd/spec/gateway.md), [REQ-RUN-001](../../sdd/spec/runtime-profiles.md)

### POST /v1/chat/completions ([REQ-RTR-002](../../sdd/spec/router-worker.md)) ([REQ-RTR-003](../../sdd/spec/router-worker.md))

Forwards an OpenAI-compatible chat completion request to an eligible node.

```http
POST /v1/chat/completions
```

**Authentication:** Provider bearer token.

**Origin check:** n/a

**Request:** JSON chat completion body with a public model alias.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Selected node response | Streams when the selected node streams. |
| `429` | `inference_mesh_busy` error | Includes `Retry-After` when no eligible node has capacity. |
| `5xx` | Gateway-style error | Releases any reservation before returning. |

**Implements:** [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-003](../../sdd/spec/router-worker.md)

### POST /node/claim ([REQ-ADM-003](../../sdd/spec/setup-admin.md)) ([REQ-NODE-002](../../sdd/spec/node-agent.md))

Claims a node with a one-time setup token and returns node credentials.

```http
POST /node/claim
```

**Authentication:** One-time setup bearer token.

**Origin check:** n/a

**Request:** JSON node claim body with display name, Mesh IP, inference port, capacity, public models, and active profiles.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `201` | Node credentials and desired profile state | Setup token is consumed. |
| `401` | Error object | Setup token is expired, claimed, missing, or invalid. |

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md)

### POST /node/heartbeat ([REQ-NODE-002](../../sdd/spec/node-agent.md)) ([REQ-OBS-003](../../sdd/spec/observability.md))

Refreshes node lease, runtime metrics, and desired profile state.

```http
POST /node/heartbeat
```

**Authentication:** Node bearer token.

**Origin check:** n/a

**Request:** JSON heartbeat body with node status, Mesh address, capacity, active profiles, runtime state, and metrics.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Desired profile actions and alias state | Refreshes the node lease. |
| `401` | Error object | Node token is invalid. |

**Implements:** [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-OBS-003](../../sdd/spec/observability.md)

### POST /node/unregister ([REQ-OBS-005](../../sdd/spec/observability.md))

Lets an authenticated node remove itself from scheduling before shutdown.

```http
POST /node/unregister
```

**Authentication:** Node bearer token.

**Origin check:** n/a

**Request:** JSON body with `nodeId`.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ "ok": true }` | Marks the node offline and clears live eligibility. |
| `401` | Error object | Node token is invalid. |

**Implements:** [REQ-OBS-005](../../sdd/spec/observability.md)

### GET /install.sh ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

Returns a Unix installer for Linux or macOS node agents.

```http
GET /install.sh
```

**Authentication:** None.

**Origin check:** n/a

**Request:** Optional `platform=linux` or `platform=macos` query parameter.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Unix shell installer | Downloads from the configured `AGENT_RELEASE_TAG` release and verifies checksums. |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### GET /install.ps1 ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

Returns a Windows installer for node agents.

```http
GET /install.ps1
```

**Authentication:** None.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Windows PowerShell installer | Downloads from the configured `AGENT_RELEASE_TAG` release and verifies checksums. |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### Node dashboard local routes ([REQ-NODE-004](../../sdd/spec/node-agent.md)) ([REQ-SEC-004](../../sdd/spec/security.md))

Exposes localhost-only node status and runtime controls.

```http
GET /api/status
POST /api/runtime/start
POST /api/runtime/stop
POST /api/runtime/restart
```

**Authentication:** Local dashboard status is localhost-only. Runtime-control POSTs require the local dashboard token.

**Origin check:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-004](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

**Request:** Runtime-control POSTs do not require a request body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Dashboard status or runtime-control result | Local node dashboard only; not exposed by the public Worker. |
| `401` | Error body | Runtime-control token is missing or invalid. |
| `403` | Error body | Browser Origin does not match the dashboard origin. |

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider routes | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding routes | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node proxy | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Dashboard controls | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
