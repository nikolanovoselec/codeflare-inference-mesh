# API Reference

## Contents

- [Conventions](#conventions)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

All API responses that represent errors use an OpenAI-style `error` object when they are visible to AI Gateway or OpenAI-compatible clients. Provider routes require the provider token; node routes require setup or node credentials; installer routes contain no permanent secrets. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

### GET /health

Returns Worker health for routing and deploy verification.

```http
GET /health
```

**Authentication:** None.

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Worker route family is reachable. | JSON health object. |

**Implements:** [REQ-RTR-001](../../sdd/spec/router-worker.md)

### GET /v1/models

Lists public OpenAI-compatible model aliases exposed through the mesh.

```http
GET /v1/models
```

**Authentication:** Provider bearer token.

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Public aliases are listed without exposing internal runtime names. | OpenAI-compatible model list. |
| `401` | Provider token is missing or invalid. | Error object. |

**Implements:** [REQ-GWY-001](../../sdd/spec/gateway.md), [REQ-RUN-001](../../sdd/spec/runtime-profiles.md)

### POST /v1/chat/completions

Forwards an OpenAI-compatible chat completion request to an eligible node.

```http
POST /v1/chat/completions
```

**Authentication:** Provider bearer token.

**Origin check:** n/a

**Request body:** JSON chat completion body with a public model alias.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Selected node response is returned; streaming responses stay streamed. | Node response body. |
| `404` | Public model alias has no configured profile. | `{ "error": "no-profile", "requestId": string }` |
| `429` | No eligible node is available or all eligible nodes are busy; current handler does not emit `Retry-After`. | `{ "error": "no-node" | "busy", "requestId": string }` |
| `5xx` | Upstream forwarding failed after releasing any reservation. | Gateway-style error. |

**Implements:** [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-003](../../sdd/spec/router-worker.md)

### POST /node/claim

Claims a node with a one-time setup token and returns node credentials.

```http
POST /node/claim
```

**Authentication:** One-time setup bearer token.

**Origin check:** n/a

**Request body:** JSON node claim body with display name, Mesh IP, inference port, capacity, public models, and active profiles.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | Setup token is consumed and node credentials are created. | Node credentials and desired profile state. |
| `401` | Setup token is expired, claimed, missing, or invalid. | Error object. |

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md)

### POST /node/heartbeat

Refreshes node lease, runtime metrics, and desired profile state.

```http
POST /node/heartbeat
```

**Authentication:** Node bearer token.

**Origin check:** n/a

**Request body:** JSON heartbeat body with node status, Mesh address, capacity, active profiles, runtime state, and metrics.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Node lease and metrics are refreshed. | Desired profile actions and alias state. |
| `400` | `nodeId` is missing. | `{ "error": "invalid_heartbeat" }` |
| `401` | Node token is invalid. | `{ "error": "unauthorized" }` |
| `403` | Node is revoked and cannot restore eligibility. | `{ "error": "node_revoked" }` |
| `404` | Node record does not exist. | `{ "error": "unknown_node" }` |

**Implements:** [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-OBS-003](../../sdd/spec/observability.md)

### POST /node/unregister

Lets an authenticated node remove itself from scheduling before shutdown.

```http
POST /node/unregister
```

**Authentication:** Node bearer token.

**Origin check:** n/a

**Request body:** JSON body with `nodeId`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Node is marked offline and live eligibility is cleared. | `{ "ok": true }` |
| `400` | `nodeId` is missing. | `{ "error": "invalid_unregister" }` |
| `401` | Node token is invalid. | `{ "error": "unauthorized" }` |
| `403` | Node is revoked and cannot overwrite terminal revocation. | `{ "error": "node_revoked" }` |
| `404` | Node record does not exist. | `{ "error": "unknown_node" }` |

**Implements:** [REQ-OBS-005](../../sdd/spec/observability.md)

### GET /install.sh

Returns a Unix installer for Linux or macOS node agents.

```http
GET /install.sh
```

**Authentication:** None.

**Origin check:** n/a

**Query parameters:** Optional `platform=linux|macos`; defaults to `linux`.

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Installer downloads from the configured `AGENT_RELEASE_TAG` release and verifies checksums. | Unix shell installer. |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### GET /install.ps1

Returns a Windows installer for node agents.

```http
GET /install.ps1
```

**Authentication:** None.

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Installer downloads from the configured `AGENT_RELEASE_TAG` release and verifies checksums. | Windows PowerShell installer. |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### Node dashboard local routes

Exposes localhost-only node status and runtime controls.

```http
GET /api/status
POST /api/runtime/start
POST /api/runtime/stop
POST /api/runtime/restart
```

**Authentication:** Local dashboard status is localhost-only. Runtime-control POSTs require the local dashboard token.

**Origin check:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-004](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

**Request body:** Runtime-control POSTs do not require a request body.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Dashboard status or runtime control succeeded. | Dashboard status or `{ "ok": true }`. |
| `403` | Runtime-control token is missing/invalid, or browser Origin does not match the dashboard origin. | `forbidden` error body. |
| `409` | Runtime control was requested when no managed runtime controller is available. | `runtime controller unavailable` error body. |
| `502` | Runtime controller returned an error. | Controller error body. |

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider routes | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding routes | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node proxy | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Dashboard controls | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
