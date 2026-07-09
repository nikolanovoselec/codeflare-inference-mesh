# API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

All API responses that represent errors use an OpenAI-style `error` object when they are visible to AI Gateway or OpenAI-compatible clients. Provider routes require the provider token; node routes require setup or node credentials; installer routes contain no permanent secrets. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

Public endpoints are rate-limited per route class. A request over its bucket's limit receives `429` with body `{ "error": "rate_limited", "requestId": string }` and a `Retry-After` header, returned before the route handler runs; the per-route Response tables below omit this shared rate-limit `429`. A scheduler miss on `POST /v1/chat/completions` is never a `429`; no eligible node returns `503 no_healthy_node`. ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting))

An endpoint that reads a JSON request body rejects a malformed body with `400` `{ "error": "invalid_json", "requestId": string }`; the per-route Response tables below omit this shared `400`. This covers the `/node` and `/api/v1` routes documented here; `POST /v1/chat/completions` performs the same rejection through its own validation (see its Response table). ([REQ-RTR-005](../../sdd/spec/router-worker.md#req-rtr-005-malformed-request-body-handling))

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

**Request body:** JSON chat completion body with a public model alias. MeshLLM profiles need only `model` and messages. Direct llama.cpp profiles also use a session identity so the router can pin the coding session to one cache-local node without storing raw ids: callers may send OpenAI `user` in the grammar `user:<id>|session:<id>`, include metadata visible to the router (`cf-aig-metadata` if forwarded, or a JSON `metadata` body object) with `user` and optional `session` values, or rely on the provider-scoped fallback `ai-gateway/provider-default` when AI Gateway REST dynamic-route log metadata is observability-only and not forwarded.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Selected node response is returned; streaming responses stay streamed. | Node response body. |
| `400` | JSON is invalid or `model` is missing. | `{ "error": "invalid_json", "requestId": string }` |
| `401` | Provider token is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | Public model alias has no configured profile. | `{ "error": "no-profile", "requestId": string }` |
| `413` | Request body exceeds `MAX_REQUEST_BYTES`. | `{ "error": "request_too_large", "requestId": string }` |
| `502` | The selected node could not be reached over Mesh transport. | `{ "error": "node_unreachable", "requestId": string }` |
| `503` | No eligible node is ready to serve, or no upstream token is available. | `{ "error": "no_healthy_node" \| "upstream_token_missing", "requestId": string }` |

**Implements:** [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-003](../../sdd/spec/router-worker.md), [REQ-SCH-003](../../sdd/spec/state-scheduling.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md#req-sch-004-direct-session-affinity), [REQ-SCH-005](../../sdd/spec/state-scheduling.md)

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

The `/api/v1` surface lets fleet managers and MDM systems orchestrate the mesh programmatically. It authenticates with a scoped, revocable **automation key** presented as a bearer token — no Cloudflare Access session — and the `/api/v1/*` paths are covered by the machine Access-bypass, so automation reaches them from anywhere. Every `/api/v1` request is metered by a dedicated `api` rate-limit bucket keyed by a hash of the automation key, so one caller's burst cannot spend another's budget. Over-limit requests receive the shared `429`, and a malformed JSON body the shared `400` `invalid_json`, both described in [Conventions](#conventions). ([REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials), [REQ-API-002](../../sdd/spec/control-plane-api.md#req-api-002-control-plane-access-and-status))

An admin mints automation keys with `POST /api/v1/keys` (which itself requires an admin credential). The key-management API accepts either the admin's Access session or the admin bearer credential, so operators can clean up machine keys from automation even after Access is provisioned; other human admin routes still require Access outside break-glass recovery. The secret is returned once at creation — store it securely, because it is never retrievable again. List active keys with `GET /api/v1/keys`, revoke one with `DELETE /api/v1/keys/{id}` (a revoked key stops authenticating immediately), or rotate one with `POST /api/v1/keys/{id}/rotate` (issues a fresh secret and retires the old key). Admins can also create, rotate, and revoke keys from the console **Settings → API keys** panel under their Access session, rather than calling the API by hand. ([REQ-ADM-022](../../sdd/spec/setup-admin.md#req-adm-022-api-key-management-console))

The full fleet lifecycle is drivable from these endpoints alone. First, bootstrap a fleet — mint a key, read status, enroll machines, and list nodes:

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
```

Then operate and retire — configure and switch on a model, pin the agent version, poll events, and decommission nodes:

```bash
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

Mints a new automation key. Requires an admin credential; the secret is returned once.

```http
POST /api/v1/keys
```

**Authentication:** admin Access session or admin bearer credential

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | A new automation key was minted. | `{ "id": string, "token": string, "createdAt": number }` — `token` is shown only here. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### GET /api/v1/keys

Lists the active automation keys. Requires an admin credential; secrets are never returned.

```http
GET /api/v1/keys
```

**Authentication:** admin Access session or admin bearer credential

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The active automation keys. | `{ "keys": [{ "id": string, "createdAt": number }] }`. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### DELETE /api/v1/keys/{id}

Revokes an automation key by id. Requires an admin credential; the key stops authenticating immediately.

```http
DELETE /api/v1/keys/{id}
```

**Authentication:** admin Access session or admin bearer credential

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The key was revoked. | `{ "ok": true, "id": string }`. |
| `401` | No valid admin credential was presented. | `unauthorized` error body. |
| `404` | No automation key with that id exists. | `not_found` error body. |

**Implements:** [REQ-API-001](../../sdd/spec/control-plane-api.md#req-api-001-automation-credentials)

### POST /api/v1/keys/{id}/rotate

Rotates an automation key: retires the named key and issues a replacement in one step, so the previous secret stops authenticating immediately. Requires an admin credential. The new secret is returned exactly once.

```http
POST /api/v1/keys/{id}/rotate
```

**Authentication:** admin Access session or admin bearer credential

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
| `200` | Fleet snapshot. | `{ "generatedAt": number, "nodes": { "total": number, "online": number }, "models": { "total": number, "active": number }, "runtimeVersions": { "meshllm": string, "llamacpp": string }, "runtimeInstalls": RuntimeInstallStatus[], "lastSpeedTest"?: LastSpeedTestSummary, "agentVersion"?: string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Notes:** `lastSpeedTest`, when present, carries `{ at, requestId, model, nodeId?, requestedPromptTokens, requestedMaxTokens, promptTokens, completionTokens, promptTokensEstimated, completionTokensEstimated, promptTokensPerSecond, generationTokensPerSecond, timeToFirstTokenMs, generationMs, totalMs, cacheTokens? }`.

**Implements:** [REQ-API-002](../../sdd/spec/control-plane-api.md#req-api-002-control-plane-access-and-status)

### POST /api/v1/speed-test

Runs a bounded synthetic prompt through the router's direct scheduling path, returns prompt-ingestion and generation throughput for automation, and stores the result as the latest Speed Test summary returned by status endpoints. This bypasses AI Gateway and measures the Worker → node-agent → runtime leg. The synthetic prompt starts with a per-request nonce so raw ingestion is not dominated by prompt-cache reuse.

```http
POST /api/v1/speed-test
```

**Authentication:** automation key

**Request body:** Optional JSON body. `model` selects the callable model and defaults to `codeflare-mesh`. `promptTokens` is clamped from `64` to `8192` and defaults to `2048`; `maxTokens` is clamped from `16` to `512` and defaults to `160`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Speed test completed. | `{ model, nodeId?, cacheTokens?, promptChars, requestedPromptTokens, requestedMaxTokens, timingsMs, tokens, throughput, chunks, outputChars, usage, upstreamTimings }`. `timingsMs` is end-to-end wall-clock; `throughput` prefers llama.cpp upstream timing fields when present (`upstreamTimings.prompt_per_second` / `predicted_per_second`) and otherwise falls back to wall-clock estimates. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No profile matched the model. | `no-profile` error body. |
| `502` | The selected node could not be reached over Mesh transport. | `node_unreachable` error body. |
| `503` | No eligible node is ready to serve, or the node upstream token is not configured. | `no_healthy_node` or `upstream_token_missing` error body. |

**Implements:** [REQ-API-009](../../sdd/spec/control-plane-api.md#req-api-009-programmatic-speed-test), [REQ-ADM-034](../../sdd/spec/setup-admin.md#req-adm-034-direct-router-speed-test)

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

Lists the fleet as machine-facing node projections. Supports filtering, search, and id-cursor pagination. Token verifiers and internal ports are never returned. Revoked nodes are never listed — a revoked node is on its way out of the fleet.

```http
GET /api/v1/nodes?status={status}&q={search}&limit={n}&cursor={id}
```

**Authentication:** automation key

**Query parameters:** `status` (exact node status: `online`, `offline`, `draining` — revoked nodes are excluded from every listing, so `revoked` never matches even if a tombstone row survives a mid-revoke failure), `q` (case-insensitive match on node id or display name), `limit` (page size, default 100, max 1000), `cursor` (return nodes with id greater than this value).

`NodeProjection.runtimeInstall` reports the node runtime binary state for automation and UI parity: `{ "runtime": "meshllm" | "llamacpp", "desiredVersion": string, "installedVersion": string | null, "state": "pending" | "installing" | "installed" | "failed", "error": string | null }`.

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | A page of node projections. | `{ "nodes": NodeProjection[], "nextCursor": string \| null }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-004](../../sdd/spec/control-plane-api.md#req-api-004-programmatic-node-management), [REQ-SEC-002](../../sdd/spec/security.md)

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
| `404` | No node with that id exists, or the node is revoked (treated as gone here; only `DELETE` can still reach a tombstone to reap it). | `not_found` error body. |

**Implements:** [REQ-API-004](../../sdd/spec/control-plane-api.md#req-api-004-programmatic-node-management)

### DELETE /api/v1/nodes/{id}

Decommissions a node: deletes its record and revokes its node and mesh tokens so it disappears from the fleet at once, must re-enroll, and can no longer authenticate. It reaches even a revoked tombstone row, so a node left behind by a mid-revoke failure can still be reaped.

```http
DELETE /api/v1/nodes/{id}
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node's node and mesh tokens are revoked and the node record is deleted (`node_revoked` audit event), so it disappears from the fleet and can no longer authenticate. | `{ "ok": true, "id": string }`. |
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
| `404` | No node with that id exists, or the node is revoked (a revoked tombstone is treated as gone). | `unknown_node` error body. |

**Implements:** [REQ-ADM-023](../../sdd/spec/setup-admin.md#req-adm-023-per-node-vram-override)

### POST /api/v1/nodes/{id}/deactivate

Deactivates a node: it stays a mesh participant and keeps heartbeating, but is told to run no model and is excluded from inference selection. Reversible with `activate`. Requires an automation key.

```http
POST /api/v1/nodes/{id}/deactivate
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node is marked `deactivated`; its next heartbeat receives an empty desired-profile set and the `deactivated` signal, so the agent stops (and never relaunches) `mesh-llm`. | `{ "ok": true, "node": NodeProjection }` (the projection includes `deactivated: true`). |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No node with that id exists, or the node is revoked. | `unknown_node` error body. |

**Implements:** [REQ-ADM-030](../../sdd/spec/setup-admin.md#req-adm-030-node-deactivation-and-activation), [REQ-NODE-011](../../sdd/spec/node-agent.md#req-node-011-deactivated-nodes-run-no-model)

### POST /api/v1/nodes/{id}/activate

Clears a node's deactivation so it resumes serving: its next heartbeat carries the active desired profiles again and the agent relaunches `mesh-llm`. Requires an automation key.

```http
POST /api/v1/nodes/{id}/activate
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The `deactivated` flag is cleared and the node becomes eligible again. | `{ "ok": true, "node": NodeProjection }` (the projection includes `deactivated: false`). |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No node with that id exists, or the node is revoked. | `unknown_node` error body. |

**Implements:** [REQ-ADM-030](../../sdd/spec/setup-admin.md#req-adm-030-node-deactivation-and-activation), [REQ-NODE-011](../../sdd/spec/node-agent.md#req-node-011-deactivated-nodes-run-no-model)

### POST /api/v1/nodes/{id}/reload

Force Reload: restarts the node's `mesh-llm` runtime on demand to recover a wedged runtime without SSH. Reversible and never decommissions the node. The automation twin of the console's Force Reload control. Requires an automation key.

```http
POST /api/v1/nodes/{id}/reload
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | A one-shot reload nonce is stamped on the node; its next heartbeat carries the nonce, the agent drains and restarts `mesh-llm` exactly once, then echoes the nonce back so the directive retires. | `{ "ok": true, "reloadNonce": string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No node with that id exists, or the node is revoked. | `unknown_node` error body. |

**Implements:** [REQ-ADM-032](../../sdd/spec/setup-admin.md#req-adm-032-node-force-reload), [REQ-NODE-012](../../sdd/spec/node-agent.md#req-node-012-on-demand-runtime-reload)

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
| `200` | The models. | `{ "models": [ModelProjection] }` (schema below). |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

A `ModelProjection` is `{ "id": string, "displayName": string, "callableNames": string[], "active": boolean, "rolloutPercent": number, "contextWindow": number, "modelRef": string, "split": boolean, "maxVramGb": number, "tunables": { "parallel": number|null, "cacheTypeK": string|null, "cacheTypeV": string|null, "batch": number|null, "ubatch": number|null, "flashAttn": boolean|null, "maxOutputTokens": number|null, "reasoning": object|null } }`. `split` is `true` when the model serves as a layer package across several machines. `contextWindow` `0` means Auto. `maxVramGb` is the per-model GB VRAM budget (`0` = no cap). Each `tunables` field is `null` when Auto (unset, MeshLLM auto-plans it).

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### POST /api/v1/models

Adds a new model to the catalog from a model reference, serving mode, and runtime (the automation twin of the console add-model form).

```http
POST /api/v1/models
```

**Authentication:** automation key

**Request body:** `{ "modelRef": string, "mode"?: "single" | "split", "runtime"?: "meshllm" | "llamacpp", "name"?: string }` — `modelRef` is required, trimmed, and non-empty; `mode` defaults to `single` (`split` builds a layer-package profile); `runtime` defaults to `meshllm`. Direct `llamacpp` profiles are single-machine only and ship with prompt caching/cache reuse enabled for coding-session affinity. `name` is an optional display name (defaults to the model-file segment). The model id and callable alias are derived from the reference.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | A new inactive model is created carrying the stable `codeflare-mesh` callable name; it reaches production only through `POST /api/v1/models/{id}/enable`. | `{ "ok": true, "model": ModelProjection }`. |
| `400` | `modelRef` is missing/blank, `runtime` is invalid, or `runtime: "llamacpp"` was requested with `mode: "split"`. | `invalid_model_ref` / `invalid_runtime` / `split_requires_meshllm` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `409` | The reference's derived id already exists. | `duplicate_profile` error body. |

**Implements:** [REQ-API-007](../../sdd/spec/control-plane-api.md#req-api-007-programmatic-model-onboarding), [REQ-ADM-027](../../sdd/spec/setup-admin.md#req-adm-027-model-naming-and-rename)

### POST /api/v1/models/{id}

Updates a model's context window, model reference, VRAM budget, display name, callable name, and runtime-specific tunables.

```http
POST /api/v1/models/{id}
```

**Authentication:** automation key

**Request body:** `{ "contextWindow"?: number, "modelRef"?: string, "maxVramGb"?: number, "name"?: string, "callName"?: string, "runtime"?: "meshllm" | "llamacpp", "llamacpp"?: { "parallel"?: number, "gpuLayers"?: number | string | null, "cachePrompt"?: boolean, "cacheReuse"?: number, "cacheTypeK"?: string, "cacheTypeV"?: string, "batch"?: number, "ubatch"?: number, "flashAttn"?: boolean | null, "maxOutputTokens"?: number | null, "reasoning"?: object | null, "bindPort"?: number }, "parallel"?: number, "cacheTypeK"?: string, "cacheTypeV"?: string, "batch"?: number, "ubatch"?: number, "flashAttn"?: boolean, "maxOutputTokens"?: number, "reasoning"?: object }`. Every field is optional; an omitted field is left unchanged. MeshLLM context window must be a non-negative integer (`0` = Auto); direct llama.cpp context window must be at least `4096`; model reference must be non-empty; VRAM budget is MeshLLM-only and must be a number `≥ 0` (`0` = no cap); `name` sets the display name (non-blank); `callName` sets the model's own callable alias (slugified, non-empty, not the reserved `codeflare-mesh`, not a collision) while keeping the shared alias.

For MeshLLM profiles, the tunables mirror `POST /admin/profiles/config`: `parallel`/`batch`/`ubatch`/`maxOutputTokens` are positive integers, `cacheTypeK`/`cacheTypeV` one of `f16`/`q8_0`/`q4_0`, `flashAttn` a boolean, and `reasoning` a `{ enabled?, format?, budget? }` object (layered onto the existing block). A `null` / `0` / `""` value clears a tunable back to Auto. For direct llama.cpp profiles, send `runtime: "llamacpp"` and a `llamacpp` block; `parallel` must be `>= 1`, `gpuLayers` accepts `0` or a positive integer plus `"auto"` / `"all"` (`null`/`""` clears), `cacheReuse` must be `>= 0`, `cachePrompt` is boolean, `cacheTypeK`/`cacheTypeV` accept llama.cpp KV cache types, `batch`/`ubatch`/`maxOutputTokens` are positive integers (`null`/`0` clears optional values), `flashAttn` is boolean (`null` clears), `reasoning` layers or clears the direct reasoning block, and reserved bind ports are rejected.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The updated model projection (`callableNames` reflects a changed call name). | `{ "ok": true, "model": ModelProjection }`. |
| `400` | The context window, model reference, VRAM budget, display name, call name, runtime, or runtime tunable was invalid. | `invalid_context_window` / `invalid_model_ref` / `invalid_max_vram` / `invalid_display_name` / `invalid_call_name` / `invalid_runtime` / `invalid_parallel` / `invalid_batch` / `invalid_ubatch` / `invalid_maxOutputTokens` / `invalid_cacheTypeK` / `invalid_cacheTypeV` / `invalid_flash_attn` / `invalid_reasoning` / `invalid_llamacpp` / `invalid_cachePrompt` / `bind_port_conflict` / `invalid_model_config` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No model with that id exists. | `unknown_profile` error body. |
| `409` | The call name is the reserved `codeflare-mesh` alias or collides with another model. | `call_name_conflict` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management), [REQ-ADM-027](../../sdd/spec/setup-admin.md#req-adm-027-model-naming-and-rename)

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

### DELETE /api/v1/models/{id}

Permanently removes a custom, switched-off model from the catalog.

```http
DELETE /api/v1/models/{id}
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The model was removed. | `{ "ok": true, "id": string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No model with that id exists. | `unknown_profile` error body. |
| `409` | The model is a built-in (it re-seeds on boot) or is active; nothing was removed. | `model_builtin` or `model_active` error body. |

**Implements:** [REQ-API-008](../../sdd/spec/control-plane-api.md#req-api-008-programmatic-model-deletion)

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

**Request body:** `{ "version": string }` — must be one of the available versions; the router refreshes the release list once when the requested tag is missing from the warm cache.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The desired fleet version was set after release-list validation, including a cache refresh when needed. | `{ "ok": true, "desired": string }`. |
| `400` | The version was missing or absent from the available list after refresh. | `invalid_version` / `unknown_version` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management)

### POST /api/v1/gateway/sync

Runs the same Gateway sync as the console and rotates the router provider token, returning the new provider token once to the automation caller. The token is shown only in this response; stored state keeps only its verifier and audit entries never include the secret.

```http
POST /api/v1/gateway/sync
```

**Authentication:** automation key

**Request body:** Optional JSON with `accountId`, `gatewayId`, and `providerName`; omitted values fall back to stored settings and environment defaults. Route name and public model stay pinned to `codeflare-mesh`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Gateway resources were reconciled, prior provider tokens were retired, and a fresh provider token was created for the public `/v1/chat/completions` route. | Gateway sync metadata plus `{ "providerToken": string, "byokInstruction": string }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `409` | A custom-domain or Worker URL prerequisite is missing. | `custom_domain_required` / `custom_domain_not_provisioned` error body. |
| `424` | Cloudflare rejected the sync; the raw cause is recorded to audit only. | Actionable sync failure error body. |
| `503` | Cloudflare runtime configuration is missing. | `cloudflare_runtime_config_missing` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management), [REQ-GWY-003](../../sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation)

### GET /api/v1/runtime-versions

Lists available MeshLLM and llama.cpp runtime binary versions with the current desired selection for each runtime.

```http
GET /api/v1/runtime-versions
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Available runtime versions. | `{ "meshllm": { "tags": string[], "fetchedAt"?: number, "stale": boolean, "desired": string, "error"?: string }, "llamacpp": { "tags": string[], "fetchedAt"?: number, "stale": boolean, "desired": string, "error"?: string } }`. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management), [REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility)

### PUT /api/v1/runtime-versions

Sets the fleet-wide desired MeshLLM and/or llama.cpp runtime binary versions; nodes pick up changes on heartbeat and bootstrap the selected binary under the agent data directory.

```http
PUT /api/v1/runtime-versions
```

**Authentication:** automation key

**Request body:** `{ "meshllm"?: string, "llamacpp"?: string }` — each provided value must be in the corresponding release-tag list.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Desired runtime versions were stored and audited. | `{ "ok": true, "desired": { "meshllm": string, "llamacpp": string } }`. |
| `400` | No version was provided, a version string was invalid, or a tag is absent from the release-tag list. | `invalid_runtime_versions`, `invalid_meshllm_version`, `invalid_llamacpp_version`, `unknown_meshllm_version`, or `unknown_llamacpp_version` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-API-005](../../sdd/spec/control-plane-api.md#req-api-005-programmatic-model-and-version-management), [REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility)

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

### POST /api/v1/mesh/rotate

Rotates a model's mesh join secret: increments the profile's rotation counter and clears stored mesh state so peers re-form under a fresh secret. The automation twin of the console's "Reset sharing key". Requires an automation key.

```http
POST /api/v1/mesh/rotate
```

**Authentication:** automation key

**Request body:** `{ "profileId": string }` — the model profile whose mesh secret to rotate.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The profile's rotation counter is incremented and its mesh state cleared; the rotation is audited to the automation caller. | `{ "ok": true, "profileId": string, "rotation": number }`. |
| `400` | No `profileId` was supplied. | `invalid_rotate` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |
| `404` | No model profile with that id exists. | `unknown_profile` error body. |
| `500` | The `MESH_STATE_KEY` Worker secret is absent, so mesh state cannot be sealed. | `mesh_state_key_missing` error body. |

**Implements:** [REQ-SEC-006](../../sdd/spec/security.md#req-sec-006-mesh-token-lifecycle)

### GET /api/v1/settings

Reads the fleet-tunable operator settings. The automation twin of the console Settings section. Requires an automation key.

```http
GET /api/v1/settings
```

**Authentication:** automation key

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The current settings. | `{ "offlinePruneSeconds": number }` — a machine offline longer than this is pruned (`0` disables). |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-ADM-020](../../sdd/spec/setup-admin.md#req-adm-020-node-status-clarity-and-filtering)

### PUT /api/v1/settings

Writes the fleet-tunable operator settings through the same validation core as the console. Requires an automation key.

```http
PUT /api/v1/settings
```

**Authentication:** automation key

**Request body:** `{ "offlinePruneSeconds": number }` — a non-negative integer number of seconds (`0` disables offline-node pruning).

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The setting is persisted; the write is audited to the automation caller. | `{ "ok": true, "offlinePruneSeconds": number }`. |
| `400` | The value was negative or not an integer. | `invalid_settings` error body. |
| `401` | No valid automation key was presented. | `unauthorized` error body. |

**Implements:** [REQ-ADM-020](../../sdd/spec/setup-admin.md#req-adm-020-node-status-clarity-and-filtering)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider routes | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding routes | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node proxy | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Mesh bootstrap | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Dashboard controls | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
