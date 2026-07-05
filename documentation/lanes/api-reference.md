# API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

All API responses that represent errors use an OpenAI-style `error` object when they are visible to AI Gateway or OpenAI-compatible clients. Provider routes require the provider token; node routes require setup or node credentials; installer routes contain no permanent secrets. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

Public endpoints are rate-limited per route class. A request over its bucket's limit receives `429` with body `{ "error": "rate_limited", "requestId": string }` and a `Retry-After` header, returned before the route handler runs; the per-route Response tables below omit this shared rate-limit `429`. This is distinct from the `429` `no-node` response on `POST /v1/chat/completions`, which means no node is available rather than a rate limit. ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting))

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

**Implements:** [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-003](../../sdd/spec/router-worker.md), [REQ-SCH-003](../../sdd/spec/state-scheduling.md), [REQ-SCH-005](../../sdd/spec/state-scheduling.md)

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

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-NODE-007](../../sdd/spec/node-agent.md), [REQ-RUN-008](../../sdd/spec/runtime-profiles.md)

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

**Implements:** [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-NODE-007](../../sdd/spec/node-agent.md), [REQ-OBS-003](../../sdd/spec/observability.md), [REQ-RUN-008](../../sdd/spec/runtime-profiles.md), [REQ-SEC-006](../../sdd/spec/security.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md)

**Notes:** Invite-token values (`meshToken`, `joinTokens`) are stored encrypted, never logged, and never surfaced through any admin or status response. ([REQ-SEC-006](../../sdd/spec/security.md)) The `metrics` and `meshBootstrap` shapes are detailed below.

#### Heartbeat `metrics` fields

`metrics` carries the MeshLLM status fields alongside the existing runtime-state and throughput fields:

- `meshRole` — `coordinator` when the node owns stage 0, else `serving-peer` or `api-client`.
- `readyModels` — the model ids from the node's own `/v1/models` (the mesh-wide union).
- `peerCount`, `splitEnabled`, `stageCount`, `apiReady`, `consoleReady`, and `meshllmVersion`.

#### `meshBootstrap` envelope

Computed per node as `{ "action": "create" | "join" | "wait", "rotation": number, "meshId"?: string, "joinTokens"?: string[] }`:

- The elected seed receives `create`.
- Every node receives `join` with all live invite tokens once tokens are stored.
- Non-seed nodes receive `wait` before then.

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

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-008](../../sdd/spec/security.md)

**Notes:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-008](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

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

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-008](../../sdd/spec/security.md)

**Notes:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-008](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

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

**Implements:** [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-008](../../sdd/spec/security.md)

**Notes:** Browser runtime-control requests with an `Origin` header must match the localhost dashboard origin; no-Origin localhost clients are allowed. ([REQ-SEC-008](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed -->

## Control-plane API (`/api/v1`)

The `/api/v1` surface lets fleet managers and MDM systems orchestrate the mesh programmatically. It authenticates with a scoped, revocable **automation key** presented as a bearer token — no Cloudflare Access session — and the `/api/v1/*` paths are covered by the machine Access-bypass, so automation reaches them from anywhere. Every `/api/v1` request is metered by a dedicated `api` rate-limit bucket keyed by a hash of the automation key, so one caller's burst cannot spend another's budget. Over-limit requests receive the shared `429` described in [Conventions](#conventions). ([REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials), [REQ-API-002](../../sdd/spec/control-plane-api.md#req-api-002-control-plane-access-and-status))

An admin mints automation keys with `POST /api/v1/keys` (which itself requires the admin credential). The secret is returned once at creation — store it securely, because it is never retrievable again. List active keys with `GET /api/v1/keys`, revoke one with `DELETE /api/v1/keys/{id}` (a revoked key stops authenticating immediately), or rotate one with `POST /api/v1/keys/{id}/rotate` (issues a fresh secret and retires the old key). Admins can also create, rotate, and revoke keys from the console **Settings → API keys** panel under their Access session, rather than calling the API by hand.

The full fleet lifecycle is drivable from these endpoints alone:

```bash
BASE=https://mesh.example.com

# 1. Mint an automation key (admin credential required); capture the one-time secret.
KEY=$(curl -s -X POST "$BASE/api/v1/keys" \
  -H "authorization: Bearer $ADMIN_TOKEN" | jq -r .token)
AUTH="authorization: Bearer $KEY"

# 2. Read a fleet snapshot.
curl -s "$BASE/api/v1/status" -H "$AUTH"

# 3. Mint an enrollment token and run the installer on each machine (see the installer routes).
SETUP=$(curl -s -X POST "$BASE/api/v1/enrollment-tokens" -H "$AUTH" | jq -r .setupToken)

# 4. List nodes, filtering and paginating a large fleet.
curl -s "$BASE/api/v1/nodes?status=online&limit=100" -H "$AUTH"

# 5. Configure a model (context window + VRAM budget), switch it on, and pin the fleet's node-agent version.
curl -s -X POST "$BASE/api/v1/models/mesh-default-qwen36-35b" \
  -H "$AUTH" -H "content-type: application/json" -d '{"contextWindow":8192,"maxVramGb":20}'
curl -s -X POST "$BASE/api/v1/models/mesh-default-qwen36-35b/enable" -H "$AUTH"
curl -s -X PUT "$BASE/api/v1/agent-version" \
  -H "$AUTH" -H "content-type: application/json" -d '{"version":"v1.2.0"}'

# 6. Poll operational events for monitoring; advance with the returned cursor.
curl -s "$BASE/api/v1/events?since=0&limit=100" -H "$AUTH"

# 7. Decommission a node so it must re-enroll.
curl -s -X DELETE "$BASE/api/v1/nodes/{nodeId}" -H "$AUTH"

# 8. Revoke the automation key when the automation is retired.
curl -s -X DELETE "$BASE/api/v1/keys/{keyId}" -H "authorization: Bearer $ADMIN_TOKEN"
```

### POST /api/v1/keys

Mints a new automation key. Requires the admin credential; the secret is returned once.

```http
POST /api/v1/keys
```

**Authentication:** admin

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | A new automation key was minted. | `{ "id": string, "token": string, "createdAt": number }` — `token` is shown only here. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### GET /api/v1/keys

Lists the active automation keys. Requires the admin credential; secrets are never returned.

```http
GET /api/v1/keys
```

**Authentication:** admin

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The active automation keys. | `{ "keys": [{ "id": string, "createdAt": number }] }`. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### DELETE /api/v1/keys/{id}

Revokes an automation key by id. Requires the admin credential; the key stops authenticating immediately.

```http
DELETE /api/v1/keys/{id}
```

**Authentication:** admin

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The key was revoked. | `{ "ok": true, "id": string }`. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |
| `404` | No automation key with that id exists. | `not_found` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### POST /api/v1/keys/{id}/rotate

Rotates an automation key: retires the named key and issues a replacement in one step, so the previous secret stops authenticating immediately. Requires the admin credential. The new secret is returned exactly once.

```http
POST /api/v1/keys/{id}/rotate
```

**Authentication:** admin

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | The key was rotated. | `{ "id": string, "token": string, "createdAt": number, "rotatedFrom": string }` — `token` is the new secret, shown once. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |
| `404` | No automation key with that id exists. | `not_found` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### GET /api/v1/status

Returns a fleet status snapshot to an authenticated automation caller.

```http
GET /api/v1/status
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Fleet snapshot. | `{ "generatedAt": number, "nodes": { "total": number, "online": number }, "models": { "total": number, "active": number }, "agentVersion"?: string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-002](../../sdd/spec/control-plane-api.md#req-api-002-control-plane-access-and-status)

### POST /api/v1/enrollment-tokens

Mints a node enrollment (setup) token for programmatic provisioning at scale. Accepts an automation key or an admin credential.

```http
POST /api/v1/enrollment-tokens
```

**Authentication:** automation key or admin

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | A setup token was minted. | `{ "setupToken": string, "expiresAt": number }` — the token expires 24 hours after issue. |
| `401` | Neither an automation key nor an admin credential was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-003](../../sdd/spec/control-plane-api.md#req-api-003-programmatic-enrollment)

### GET /api/v1/nodes

Lists the fleet as machine-facing node projections. Supports filtering, search, and id-cursor pagination. Token verifiers and internal ports are never returned.

```http
GET /api/v1/nodes?status={status}&q={search}&limit={n}&cursor={id}
```

**Authentication:** automation key

**Query parameters:** `status` (exact node status: `online`, `offline`, `draining`, `revoked`), `q` (case-insensitive match on node id or display name), `limit` (page size, default 100, max 1000), `cursor` (return nodes with id greater than this value).

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | A page of node projections. | `{ "nodes": NodeProjection[], "nextCursor": string \| null }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-004](../../sdd/spec/control-plane-api.md#req-api-004-programmatic-node-management)

### GET /api/v1/nodes/{id}

Returns a single node projection.

```http
GET /api/v1/nodes/{id}
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node projection. | `{ "node": NodeProjection }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No node with that id exists. | `not_found` error body. |

**Implements:** [REQ-API-004](../../sdd/spec/control-plane-api.md#req-api-004-programmatic-node-management)

### DELETE /api/v1/nodes/{id}

Decommissions a node: revokes it and its node and mesh tokens so it must re-enroll.

```http
DELETE /api/v1/nodes/{id}
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node was decommissioned. | `{ "ok": true, "id": string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No node with that id exists. | `not_found` error body. |

**Implements:** [REQ-API-004](../../sdd/spec/control-plane-api.md#req-api-004-programmatic-node-management)

### POST /api/v1/nodes/{id}/reconfigure

Sets or clears a per-node VRAM override, capping that node's inference VRAM below the model's global budget. Requires an automation key. The override is applied to the desired profiles the node receives on its next heartbeat.

```http
POST /api/v1/nodes/{id}/reconfigure
```

**Authentication:** automation key

**Request body:** `{ "maxVramGbOverride": number | null }` — a number `≥ 0` caps this node (0 = uncapped on this node); `null` clears the override so the node follows the model's global budget.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node was reconfigured. | `{ "ok": true, "node": NodeProjection }` — the projection includes `maxVramGbOverride` (`null` when unset). |
| `400` | The override was a negative or non-numeric value. | `invalid_max_vram` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No node with that id exists. | `not_found` error body. |

**Implements:** [REQ-ADM-023](../../sdd/spec/setup-admin.md#req-adm-023-per-node-vram-override)

### GET /api/v1/models

Lists the models as machine-facing projections.

```http
GET /api/v1/models
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The models. | `{ "models": [{ "id": string, "displayName": string, "callableNames": string[], "active": boolean, "rolloutPercent": number, "contextWindow": number, "modelRef": string, "split": boolean, "maxVramGb": number }] }`. `split` is `true` when the model serves as a layer package across several machines. `maxVramGb` is the per-model GB VRAM budget (`0` = no cap). |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### POST /api/v1/models

Adds a new model to the catalog from a mesh-llm-compatible reference and serving mode (the automation twin of the console add-model form).

```http
POST /api/v1/models
```

**Authentication:** automation key

**Request body:** `{ "modelRef": string, "mode"?: "single" | "split" }` — `modelRef` is required, trimmed, and non-empty; `mode` defaults to `single` (`split` builds a layer-package profile). The model id and callable alias are derived from the reference.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | A new inactive model is created carrying the stable `codeflare-mesh` callable name; it reaches production only through `POST /api/v1/models/{id}/enable`. | `{ "ok": true, "model": ModelProjection }`. |
| `400` | `modelRef` is missing or blank. | `invalid_model_ref` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `409` | The reference's derived id already exists. | `duplicate_profile` error body. |

**Implements:** [REQ-API-007](../../sdd/spec/control-plane-api.md#req-api-007-programmatic-model-onboarding)

### POST /api/v1/models/{id}

Updates a model's context window, model reference, and/or VRAM budget.

```http
POST /api/v1/models/{id}
```

**Authentication:** automation key

**Request body:** `{ "contextWindow"?: number, "modelRef"?: string, "maxVramGb"?: number }` — context window must be a positive integer; model reference must be non-empty; VRAM budget must be a number `≥ 0` (`0` = no cap). Each field is optional; an omitted field is left unchanged.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The updated model projection. | `{ "ok": true, "model": ModelProjection }`. |
| `400` | The context window or model reference was invalid. | `invalid_context_window` / `invalid_model_ref` / `invalid_model_config` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No model with that id exists. | `unknown_profile` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### POST /api/v1/models/{id}/enable

Switches a model on, switching off any other model that answers to the same callable name.

```http
POST /api/v1/models/{id}/enable
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The model was switched on. | `{ "ok": true, "activated": string, "deactivated": string[] }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No model with that id exists. | `unknown_profile` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### POST /api/v1/models/{id}/disable

Drops a model's traffic to zero.

```http
POST /api/v1/models/{id}/disable
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The model's traffic was dropped to zero. | `{ "ok": true, "id": string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No model with that id exists. | `unknown_profile` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### GET /api/v1/agent-versions

Lists the available node-agent versions.

```http
GET /api/v1/agent-versions
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The available versions. | `{ "tags": string[], "stale": boolean, "desired"?: string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### PUT /api/v1/agent-version

Sets the fleet-wide desired node-agent version; nodes converge on it through heartbeats.

```http
PUT /api/v1/agent-version
```

**Authentication:** automation key

**Request body:** `{ "version": string }` — must be one of the available versions.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The desired fleet version was set. | `{ "ok": true, "desired": string }`. |
| `400` | The version was missing or absent from the available list. | `invalid_version` / `unknown_version` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### GET /api/v1/events

Polls operational events oldest-first for monitoring and alerting. Internal per-heartbeat bookkeeping (mesh state stored/cleared, mesh token rotated/removed) is excluded.

```http
GET /api/v1/events?since={ms}&type={t1,t2}&limit={n}
```

**Authentication:** automation key

**Query parameters:** `since` (opaque cursor `"<at>:<id>"` — return events keyset-ordered strictly after that `(at, id)`; a bare millisecond `<ms>` is still accepted and stays exclusive of events at that millisecond; default `0`), `type` (comma-separated event types to include), `limit` (page size, default 100, max 1000).

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | A page of events oldest-first. | `{ "events": AuditEvent[], "nextCursor": string \| null }` — `nextCursor` is the opaque `"<at>:<id>"` cursor of the last event; poll again with `since=nextCursor` while it is non-null. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-006](../../sdd/spec/control-plane-api.md#req-api-006-operational-events-polling)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider routes | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding routes | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node proxy | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Mesh bootstrap | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Dashboard controls | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
