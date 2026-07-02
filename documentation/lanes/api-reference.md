# API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

All API responses that represent errors use an OpenAI-style `error` object when they are visible to AI Gateway or OpenAI-compatible clients. Provider routes require the provider token; node routes require setup or node credentials; installer routes contain no permanent secrets. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## Endpoints

### GET /health

Returns Worker health for routing and deploy verification.

```http
GET /health
```

**Authentication:** none

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

**Authentication:** provider bearer token

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Public aliases of active profiles are listed without exposing internal runtime names; aliases of inactive or retired profiles are excluded. | OpenAI-compatible model list. |
| `401` | Provider token is missing or invalid. | Error object. |

**Implements:** [REQ-GWY-001](../../sdd/spec/gateway.md), [REQ-RUN-001](../../sdd/spec/runtime-profiles.md)

### POST /v1/chat/completions

Forwards an OpenAI-compatible chat completion request to an eligible node.

```http
POST /v1/chat/completions
```

**Authentication:** provider bearer token

**Origin check:** n/a

**Request body:** JSON chat completion body with a public model alias.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Selected node response is returned; streaming responses stay streamed. | Node response body. |
| `400` | JSON is invalid or `model` is missing. | `{ "error": "invalid_json", "requestId": string }` |
| `401` | Provider token is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | Public model alias has no configured profile. | `{ "error": "no-profile", "requestId": string }` |
| `413` | Request body exceeds `MAX_REQUEST_BYTES`. | `{ "error": "request_too_large", "requestId": string }` |
| `429` | No eligible node is available; current handler does not emit `Retry-After`. | `{ "error": "no-node", "requestId": string }` |
| `503` | No upstream token is available after reservation. | `{ "error": "upstream_token_missing", "requestId": string }` |
| `5xx` | Upstream forwarding failed after releasing any reservation and recording a node failure signal. | Gateway-style error. |

**Implements:** [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-003](../../sdd/spec/router-worker.md), [REQ-SCH-003](../../sdd/spec/state-scheduling.md)

### POST /node/claim

Claims a node with a one-time setup token and returns node credentials.

```http
POST /node/claim
```

**Authentication:** setup bearer token

**Origin check:** n/a

**Request body:** JSON node claim body with display name, Mesh IP, inference port, capacity, public models, and active profiles.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | Setup token is consumed and node credentials are created. | Node credentials, desired profile state, optional `meshBootstrap`, and optional `desiredAgentVersion`. |
| `400` | Claim body is missing required node fields or has invalid capacity. | `{ "error": "invalid_claim", "fields": string[] }` |
| `401` | Setup token is expired, claimed, missing, or invalid. | Error object. |

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-RUN-006](../../sdd/spec/runtime-profiles.md)

**Notes:** `meshBootstrap` and `desiredAgentVersion` follow the same contract as `POST /node/heartbeat` responses. Mesh material never rides the installer or enrollment path itself; it is returned only inside this credentialed claim response and later node-token-authenticated heartbeat responses. ([REQ-SEC-006](../../sdd/spec/security.md))

### POST /node/heartbeat

Refreshes node lease, runtime metrics, mesh membership state, and desired profile state.

```http
POST /node/heartbeat
```

**Authentication:** node bearer token

**Origin check:** n/a

**Request body:** JSON heartbeat body with node status, Mesh address, capacity, active profiles, `runtime: "meshllm"`, `agentVersion`, the node's current `meshId` and `meshToken` (its own invite token, resent on every heartbeat), and metrics.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Node lease, metrics, and mesh token set are refreshed. | `ok`, `desiredProfiles`, optional `meshBootstrap`, optional `desiredAgentVersion`. |
| `400` | `nodeId` is missing. | `{ "error": "invalid_heartbeat" }` |
| `401` | Node token is invalid. | `{ "error": "unauthorized" }` |
| `403` | Node is revoked and cannot restore eligibility. | `{ "error": "node_revoked" }` |
| `404` | Node record does not exist. | `{ "error": "unknown_node" }` |

**Implements:** [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-OBS-003](../../sdd/spec/observability.md), [REQ-RUN-006](../../sdd/spec/runtime-profiles.md), [REQ-SEC-006](../../sdd/spec/security.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md)

**Notes:** `metrics` carries the MeshLLM status fields alongside the existing runtime state and throughput fields: `meshRole` (`coordinator` when the node owns stage 0, else `serving-peer` or `api-client`), `readyModels` (the model ids from the node's own `/v1/models` — the mesh-wide union), `peerCount`, `splitEnabled`, `stageCount`, `apiReady`, `consoleReady`, and `meshllmVersion`. `meshBootstrap` is computed per node as `{ "action": "create" | "join" | "wait", "rotation": number, "meshId"?: string, "joinTokens"?: string[] }`: the elected seed receives `create`, every node receives `join` with all live invite tokens once tokens are stored, and non-seed nodes receive `wait` before then. Invite-token values (`meshToken`, `joinTokens`) are stored encrypted, never logged, and never surfaced through any admin or status response. ([REQ-SEC-006](../../sdd/spec/security.md))

### POST /node/unregister

Lets an authenticated node remove itself from scheduling before shutdown.

```http
POST /node/unregister
```

**Authentication:** node bearer token

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

**Authentication:** none

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

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Installer downloads from the configured `AGENT_RELEASE_TAG` release and verifies checksums. | Windows PowerShell installer. |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### GET /api/status

Returns redacted localhost dashboard status for the node agent.

```http
GET /api/status
```

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Dashboard status is returned with sensitive config fields redacted. | Dashboard status JSON. |

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md)

**Notes:** This is the node agent's own localhost dashboard status (default port `17777`). It is distinct from the `mesh-llm` console `GET /api/status` (default `127.0.0.1:3131`), which is served by the managed `mesh-llm` process, stays localhost-only on the node, and is never exposed through the router or the mesh. ([REQ-SEC-004](../../sdd/spec/security.md))

### POST /api/runtime/start

Starts the managed local runtime from the node dashboard.

```http
POST /api/runtime/start
```

**Authentication:** dashboard token

**Origin check:** applies

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Managed runtime start succeeded. | `{ "ok": true }`. |
| `403` | Dashboard token is missing/invalid, or browser Origin does not match the dashboard origin. | `forbidden` error body. |
| `409` | Runtime control was requested when no managed runtime controller is available. | `runtime controller unavailable` error body. |
| `502` | Runtime controller returned an error. | Controller error body. |

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md)

**Notes:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-004](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

### POST /api/runtime/stop

Stops the managed local runtime from the node dashboard.

```http
POST /api/runtime/stop
```

**Authentication:** dashboard token

**Origin check:** applies

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Managed runtime stop succeeded. | `{ "ok": true }`. |
| `403` | Dashboard token is missing/invalid, or browser Origin does not match the dashboard origin. | `forbidden` error body. |
| `409` | Runtime control was requested when no managed runtime controller is available. | `runtime controller unavailable` error body. |
| `502` | Runtime controller returned an error. | Controller error body. |

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md)

**Notes:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-004](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

### POST /api/runtime/restart

Restarts the managed local runtime from the node dashboard.

```http
POST /api/runtime/restart
```

**Authentication:** dashboard token

**Origin check:** applies

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Managed runtime restart succeeded. | `{ "ok": true }`. |
| `403` | Dashboard token is missing/invalid, or browser Origin does not match the dashboard origin. | `forbidden` error body. |
| `409` | Runtime control was requested when no managed runtime controller is available. | `runtime controller unavailable` error body. |
| `502` | Runtime controller returned an error. | Controller error body. |

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md)

**Notes:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-004](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider routes | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding routes | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node proxy | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Mesh bootstrap | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Dashboard controls | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
