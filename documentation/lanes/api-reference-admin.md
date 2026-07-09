# Admin API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

Admin routes accept the bootstrap admin bearer token until Cloudflare Access is provisioned; once Access configuration is stored, every human admin request must carry a valid Access JWT, and bearer credentials work only during break-glass recovery. "Admin authentication" below means this guard. Once Access is configured, each verified caller resolves to a console **role** — `admin` or read-only `user` — from their Access groups and email ([security.md](security.md#role-based-console-access)); "any console role" below means the reader guard both roles pass, while "admin authentication" requires the `admin` role. Admin routes never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity, and do not implement a dedicated Origin-header gate. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-009](../../sdd/spec/security.md)) ([REQ-SEC-010](../../sdd/spec/security.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

Any admin route can also return `500` with body `{ "error": "internal_error", "requestId": string }` when the Worker's top-level handler catches an uncaught exception (commonly a transient D1 cold-start); the per-route Response tables below list only route-specific statuses and omit this shared catch-all. `POST /admin/cloudflare/gateway/sync` is the one admin route that no longer relies on this shared catch-all for Cloudflare-rejection failures — see its own Response table. ([REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances))

Admin routes are also rate-limited: `RL_AUTH` covers `/admin/login`, `/admin/setup`, `/admin/recovery/reset`, and `/admin/setup-tokens`; every other admin route falls to `RL_PUBLIC`. An over-limit request receives `429` with body `{ "error": "rate_limited", "requestId": string }` before its handler runs, and the per-route Response tables below omit this shared `429` the same way they omit the shared `500`. ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting))

An admin route that reads a JSON body rejects a malformed body with `400` `{ "error": "invalid_json", "requestId": string }`; the per-route Response tables below omit this shared `400`. The optional-body routes — `POST /admin/cloudflare/gateway/sync`, `POST /admin/mesh/rotate`, `POST /admin/playground/chat`, `POST /admin/playground/direct-chat`, and `POST /admin/playground/speed-test` — still accept a request with no body (applying route defaults, or returning that route's own required-field error); only a present, unparseable body is rejected. ([REQ-RTR-005](../../sdd/spec/router-worker.md#req-rtr-005-malformed-request-body-handling))

## Endpoints

### GET /

Serves the state-gated Admin UI shell: the setup wizard until setup completes, and the sectioned operator dashboard on the custom domain afterwards. After completion, non-custom-domain hostnames receive a console-moved page instead (or the recovery wizard while break-glass is active).

```http
GET /
```

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Admin UI shell with anti-framing headers, pre-rendered from host and setup phase (wizard until complete, dashboard on the custom domain, moved page elsewhere); the shell loads without a bearer token. `HEAD` returns the same status and headers. | HTML. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md), [REQ-ADM-007](../../sdd/spec/setup-admin.md), [REQ-ADM-011](../../sdd/spec/setup-admin.md), [REQ-ADM-014](../../sdd/spec/setup-admin.md)

### GET /admin

Serves the same state-gated Admin UI shell as `/`.

```http
GET /admin
```

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Same state-gated Admin UI shell and anti-framing headers as `/`. | HTML. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md), [REQ-ADM-007](../../sdd/spec/setup-admin.md), [REQ-ADM-011](../../sdd/spec/setup-admin.md)

### POST /admin/setup

Performs first-run setup and returns one-time-visible credentials.

```http
POST /admin/setup
```

**Authentication:** none until first setup; admin bearer token after setup

**Origin check:** n/a

**Request body:** No required body fields in the current implementation.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | Credentials are generated once; durable storage keeps verifiers/config only. | Generated admin, provider, setup, and upstream credentials. |
| `401` | Setup has completed and admin auth is missing or invalid. | Error object. |

**Implements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md)

**Notes:** After setup completes, the console renders the `401` as inline recovery guidance (setup already complete, sign in with the existing admin token) rather than raw JSON. ([REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances))

### POST /admin/login

Validates an admin credential and returns the admin session contract.

```http
POST /admin/login
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** No required body fields in the current implementation.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Presented admin credential is valid. | Admin session contract. |
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-ADM-002](../../sdd/spec/setup-admin.md)

### POST /admin/recovery/reset

Replaces a lost admin token when the configured recovery secret is presented.

```http
POST /admin/recovery/reset
```

**Authentication:** recovery token in `Authorization: Bearer <ADMIN_RECOVERY_TOKEN>`

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | New admin token is displayed once and only its verifier is stored. | `{ "adminToken": string }` |
| `401` | Recovery token is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-002](../../sdd/spec/setup-admin.md)

### GET /admin/status

Returns the admin dashboard status contract with secrets redacted.

```http
GET /admin/status
```

**Authentication:** any console role (admin or read-only user)

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Router state is returned with credentials redacted. | Nodes (each with its reported `agentVersion`), profiles, profile readiness counts, `meshHealth` entries, setup/gateway/domain state, recent audit entries, the caller's `viewerRole` (`"admin"` or `"user"`), optional `desiredAgentVersion`, and generated timestamp. |
| `401` | No valid console role resolved for the caller. | Error object. |

**Implements:** [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-OBS-007](../../sdd/spec/observability.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md), [REQ-ADM-017](../../sdd/spec/setup-admin.md)

**Notes:** `viewerRole` lets the console tailor its surface — the read-only user role sees only the overview and playground, and configuration-mutating endpoints reject it server-side regardless of the surface ([REQ-ADM-017](../../sdd/spec/setup-admin.md)). `meshHealth` carries one entry per MeshLLM profile: `{ profileId, meshId?, rotation, seedNodeId?, coordinatorNodeId?, peerNodeIds, tokenCount, secretAgeMs?, lastError?, readyModels, failedNodeIds }`. Mesh secrets appear only as presence, age, and count (`tokenCount`, `secretAgeMs`); invite-token values are never included in any admin response. When the `MESH_STATE_KEY` Worker secret is not configured, each entry reports `lastError: "mesh_state_key_missing"`. ([REQ-OBS-007](../../sdd/spec/observability.md)) ([REQ-SEC-007](../../sdd/spec/security.md))

### GET /admin/whoami

Returns the caller's resolved console role and actor identity.

```http
GET /admin/whoami
```

**Authentication:** any console role (admin or read-only user)

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Role resolved. | `{ "role": "admin" \| "user", "actor": string }` |
| `401` | No valid console role resolved for the caller. | Error object. |

**Implements:** [REQ-ADM-017](../../sdd/spec/setup-admin.md), [REQ-SEC-010](../../sdd/spec/security.md)

### POST /admin/playground/chat

Proxies a chat completion through the selected AI Gateway's dynamic route (sent as `dynamic/<route>`) so operators can verify inference end to end. The request never carries a provider key: the Worker attaches the AI Gateway credential server-side and streams the upstream response back.

```http
POST /admin/playground/chat
```

**Authentication:** any console role (admin or read-only user)

**Origin check:** n/a

**Request body:** JSON body with `gatewayId` (the target gateway) and `route` (the dynamic route to forward as `dynamic/<route>`), plus `messages` (chat message array) and, for direct llama.cpp-backed routes, `user` in the grammar `user:<id>|session:<id>`. The Admin console supplies a stable browser-session `user` automatically. Optional `tools` (an OpenAI-format tool-definitions array) and `maxTokens` (a positive integer generation cap) are forwarded to the upstream route as `tools` and `max_tokens` when supplied, so an agentic (tool-calling) request can be reproduced and a runaway response bounded; when absent, neither is sent. The body is optional — absent fields fall back to the resolved gateway defaults — but a present, malformed body is rejected with the shared `400` `invalid_json`. A non-admin (read-only user) caller's `gatewayId` and `route` are ignored and forced to the default gateway and route, so a viewer cannot target an arbitrary gateway.

The console Playground's **Stop** button aborts an in-flight stream client-side (no additional request is sent), and starting a new prompt supersedes any stream still running. This applies to both playground endpoints.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Upstream response streamed back to the caller. | Event-stream / JSON pass-through from the AI Gateway route. |
| `401` | No valid console role resolved for the caller. | Error object. |
| `409` | No account or gateway resolved to send through. | `{ "error": "gateway_not_configured", "requestId": string }` |
| `503` | The AI Gateway Run token is not configured. | `{ "error": "gateway_auth_token_missing", "requestId": string }` |

**Implements:** [REQ-ADM-016](../../sdd/spec/setup-admin.md#req-adm-016-operator-playground), [REQ-ADM-029](../../sdd/spec/setup-admin.md#req-adm-029-playground-inference-endpoints), [REQ-ADM-031](../../sdd/spec/setup-admin.md#req-adm-031-operator-playground-target-selection), [REQ-ADM-017](../../sdd/spec/setup-admin.md)

### POST /admin/playground/direct-chat

Runs a chat completion straight through the router's scheduler to a serving node, bypassing the AI Gateway, so operators can verify inference even when no gateway is reachable. Direct llama.cpp models use the same session-affinity contract as public OpenAI-compatible calls.

```http
POST /admin/playground/direct-chat
```

**Authentication:** any console role (admin or read-only user)

**Origin check:** n/a

**Request body:** JSON body with `model` (an internal callable model), `messages`, and — for direct llama.cpp profiles — `user` in the grammar `user:<id>|session:<id>`. The Admin console supplies a stable browser-session value automatically. Optional `tools` (an OpenAI-format tool-definitions array) and `maxTokens` (a positive integer cap, forwarded as `max_tokens`) are passed through when supplied. `model` is required; a present, malformed body is rejected with the shared `400` `invalid_json`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Node response streamed back to the caller. | Event-stream / JSON pass-through from the serving node. |
| `400` | The request omitted a model or called a direct llama.cpp model without a valid session user. | `{ "error": "model_required" \| "invalid_user", "requestId": string }` |
| `401` | No valid console role resolved for the caller. | Error object. |
| `404` | No profile matched the model. | `{ "error": "no-profile", "requestId": string }` |
| `502` | The selected node could not be reached over Mesh transport. | `{ "error": "node_unreachable", "requestId": string }` |
| `503` | No eligible node is ready to serve, or the node upstream token is not configured. | `{ "error": "no_healthy_node" \| "upstream_token_missing", "requestId": string }` |

**Implements:** [REQ-ADM-016](../../sdd/spec/setup-admin.md#req-adm-016-operator-playground), [REQ-ADM-029](../../sdd/spec/setup-admin.md#req-adm-029-playground-inference-endpoints), [REQ-ADM-031](../../sdd/spec/setup-admin.md#req-adm-031-operator-playground-target-selection), [REQ-ADM-017](../../sdd/spec/setup-admin.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md#req-sch-004-direct-session-affinity)

### POST /admin/playground/speed-test

Runs a bounded synthetic prompt through the router's direct scheduling path and returns timing measurements for prompt ingestion and generation. This bypasses AI Gateway so the result isolates Worker → node-agent → runtime behavior. The synthetic prompt starts with a per-request nonce so raw ingestion is not dominated by prompt-cache reuse.

```http
POST /admin/playground/speed-test
```

**Authentication:** any console role (admin or read-only user)

**Origin check:** n/a

**Request body:** Optional JSON body. `model` selects the callable model and defaults to `codeflare-mesh`. `promptTokens` bounds the synthetic prompt size from `64` to `8192` tokens and defaults to `2048`. `maxTokens` bounds generated output from `16` to `512` tokens and defaults to `160`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Speed test completed. | `{ model, promptChars, requestedPromptTokens, requestedMaxTokens, timingsMs, tokens, throughput, chunks, outputChars, usage, upstreamTimings }`. `timingsMs` is end-to-end wall-clock; `throughput` prefers llama.cpp upstream timing fields when present (`upstreamTimings.prompt_per_second` / `predicted_per_second`) and otherwise falls back to wall-clock estimates. |
| `401` | No valid console role resolved for the caller. | Error object. |
| `404` | No profile matched the model. | `{ "error": "no-profile", "requestId": string }` |
| `502` | The selected node could not be reached over Mesh transport. | `{ "error": "node_unreachable", "requestId": string }` |
| `503` | No eligible node is ready to serve, or the node upstream token is not configured. | `{ "error": "no_healthy_node" \| "upstream_token_missing", "requestId": string }` |

**Implements:** [REQ-ADM-034](../../sdd/spec/setup-admin.md#req-adm-034-direct-router-speed-test), [REQ-SCH-002](../../sdd/spec/state-scheduling.md#req-sch-002-stateless-entry-node-forwarding)

### POST /admin/setup-tokens

Creates a new one-time setup token for node enrollment.

```http
POST /admin/setup-tokens
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | Setup token is displayed once, stored as a verifier, and expires after 24h. | `{ "setupToken": string, "expiresAt": number }` |
| `401` | Admin credential is missing or invalid; the response is identical whether or not setup has completed. | Error object. |

**Implements:** [REQ-ADM-002](../../sdd/spec/setup-admin.md), [REQ-ADM-003](../../sdd/spec/setup-admin.md)

### GET /admin/installers/:platform

Returns a one-line installer command for a supported node-agent platform. Fetching does not mint a setup token; the command carries a placeholder that the console fills with a token created via `POST /admin/setup-tokens`, so one token backs each enrollment.

```http
GET /admin/installers/{platform}
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `platform` must be `linux`, `macos`, or `windows`.

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Installer command fetches the platform installer and passes only the router URL and a setup-token placeholder; no token is minted on fetch. | One-line install command. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | Unsupported platform. | `{ "error": "unknown_platform" }` |

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md#req-adm-003-setup-token-lifecycle), [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### POST /admin/nodes/:nodeId/revoke

Removes a node: revokes its node and mesh tokens and deletes the node record so it disappears from the console at once and must re-enroll.

```http
POST /admin/nodes/{nodeId}/revoke
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `nodeId` is the URL-encoded node identifier to revoke.

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node's node and mesh tokens are revoked, its mesh invite-token entry is removed from every active MeshLLM profile's mesh state (`mesh_token_removed` audit event), and the node record is deleted (`node_revoked` audit event), so it disappears from the console at once and later heartbeats/unregister calls are rejected. | `{ "ok": true }` |
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md), [REQ-SEC-007](../../sdd/spec/security.md)

### POST /admin/nodes/:nodeId/config

Sets or clears a per-node VRAM override from the node detail drawer, capping that node's inference VRAM below the model's global budget.

```http
POST /admin/nodes/{nodeId}/config
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `nodeId` is the URL-encoded node identifier to reconfigure.

**Request body:** `{ "maxVramGbOverride": number | null }` — a number `≥ 0` caps this node (0 = uncapped on this node); a blank/`null` value clears the override so the node follows the model's global budget.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node's VRAM override was set or cleared. | `{ "ok": true, "id": string, "maxVramGbOverride": number \| null }` |
| `400` | The override was a negative or non-numeric value. | `{ "error": "invalid_max_vram", "requestId": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | No node with that id exists, or the node is revoked. | `{ "error": "unknown_node", "requestId": string }` |

**Implements:** [REQ-ADM-023](../../sdd/spec/setup-admin.md#req-adm-023-per-node-vram-override)

### POST /admin/nodes/:nodeId/deactivate

Deactivates a node from the node detail drawer: it stays a mesh participant and keeps heartbeating, but is told to run no model and is excluded from inference selection. Reversible with `activate`; unlike `revoke` it takes no destructive confirm because it is fully reversible.

```http
POST /admin/nodes/{nodeId}/deactivate
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `nodeId` is the URL-encoded node identifier to deactivate.

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The node is marked `deactivated` (`node_deactivated` audit event); its next heartbeat receives an empty desired-profile set and the `deactivated` signal, so the agent stops (and never relaunches) `mesh-llm` while continuing to heartbeat. | `{ "ok": true, "deactivated": true }` |
| `401` | Admin credential is missing or invalid. | Error object. |
| `404` | No node with that id exists, or the node is revoked. | `{ "error": "unknown_node", "requestId": string }` |

**Implements:** [REQ-ADM-030](../../sdd/spec/setup-admin.md#req-adm-030-node-deactivation-and-activation), [REQ-NODE-011](../../sdd/spec/node-agent.md#req-node-011-deactivated-nodes-run-no-model)

### POST /admin/nodes/:nodeId/activate

Clears a node's deactivation from the node detail drawer so it resumes serving: its next heartbeat carries the active desired profiles again and the agent relaunches `mesh-llm`.

```http
POST /admin/nodes/{nodeId}/activate
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `nodeId` is the URL-encoded node identifier to activate.

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The `deactivated` flag is cleared (`node_activated` audit event) and the node becomes eligible for selection again. | `{ "ok": true, "deactivated": false }` |
| `401` | Admin credential is missing or invalid. | Error object. |
| `404` | No node with that id exists, or the node is revoked. | `{ "error": "unknown_node", "requestId": string }` |

**Implements:** [REQ-ADM-030](../../sdd/spec/setup-admin.md#req-adm-030-node-deactivation-and-activation), [REQ-NODE-011](../../sdd/spec/node-agent.md#req-node-011-deactivated-nodes-run-no-model)

### POST /admin/nodes/:nodeId/reload

Restart the node's `mesh-llm` runtime on demand (Force Reload), to recover a wedged runtime without SSH. The automation twin is `POST /api/v1/nodes/{nodeId}/reload`.

```
POST /admin/nodes/{nodeId}/reload
```

**Path parameters:** `nodeId` is the URL-encoded node identifier to reload.

**Responses:**

| Status | Meaning | Body |
| --- | --- | --- |
| `200` | A one-shot reload nonce is stamped on the node (`node_reload_requested` audit event) and carried on its next heartbeat; the node drains and restarts `mesh-llm` exactly once, then echoes the nonce back so the directive is retired. | `{ "ok": true, "reloadNonce": "<nonce>" }` |
| `401` | The caller is not an admin (or, for the API twin, lacks a valid automation key). | `{ "error": "unauthorized" }` |
| `404` | No such node. | `{ "error": "unknown_node" }` |

**Implements:** [REQ-ADM-032](../../sdd/spec/setup-admin.md#req-adm-032-node-force-reload), [REQ-NODE-012](../../sdd/spec/node-agent.md#req-node-012-on-demand-runtime-reload)

### POST /admin/cloudflare/gateway/sync

Creates or reuses the AI Gateway custom-provider dynamic route for the selected Worker origin.

```http
POST /admin/cloudflare/gateway/sync
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** Optional JSON with `accountId`, `gatewayId`, and `providerName` — all optional. The dynamic route name and forwarded model are fixed to the stable public model `codeflare-mesh` and are never read from the body. For `accountId`, `gatewayId`, and `providerName`, request body values override stored settings, then the environment defaults documented in [configuration.md](configuration.md) apply (`providerName` falls back to `AI_GATEWAY_PROVIDER_NAME`, else the hardcoded `Codeflare Inference Mesh`); the Setup wizard and Routing form additionally prefill the provider-name field with `Codeflare Inference Mesh` as a friendlier starting value. The Worker URL is resolved from the provisioned custom domain (or a stored explicit override) and is not a request input.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Cloudflare AI Gateway metadata and selected sync settings are stored in D1. | Provider, route, route version, deployment identifiers, and selected settings. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | No provisioned custom domain exists for Gateway sync, or the stored custom domain is not provisioned and no `workerUrl` override was supplied. | `{ "error": "custom_domain_required" }` or `{ "error": "custom_domain_not_provisioned", "hostname": string }` |
| `424` | Cloudflare rejected the sync call itself (bad token, missing gateway, route conflict). The raw cause is recorded to the audit log as a `gateway_sync_failed` event and never returned to the caller. | `{ "error": "The AI Gateway sync could not be completed. Confirm the gateway exists and the router Cloudflare token has AI Gateway access, then re-sync." }` |
| `503` | Required runtime Cloudflare configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-010](../../sdd/spec/setup-admin.md), [REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances)

**Notes:** The custom-provider slug is derived from the provider name alone (not the Worker origin), so re-running sync from a different Worker URL reconciles the same provider instead of creating a duplicate. After upgrading to this behavior the first sync may create a new stable-slug provider — paste the returned `providerToken` into that provider's BYOK key field as the response's `byokInstruction` directs. ([REQ-GWY-007](../../sdd/spec/gateway.md#req-gwy-007-provider-identity-stability-across-worker-origins)) ([REQ-GWY-003](../../sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation))

### POST /admin/custom-domain/validate

Provisions DNS and Worker routing for a custom-domain hostname; a zone ID may be supplied by an advanced caller.

```http
POST /admin/custom-domain/validate
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `hostname`; optional `zoneId` must be a 32-character hexadecimal Cloudflare zone ID when present.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | DNS and Worker route provisioning succeeded, and the hostname is stored for later Gateway operations. | `{ "valid": true, "hostname": string, "status": "provisioned", "dnsRecordId": string, "routeId": string }` |
| `400` | Hostname is missing/invalid, or supplied zone ID is invalid. | `{ "valid": false, "hostname"?: string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | Existing DNS records conflict with the Worker route target. | `{ "error": "dns_record_conflict", "hostname": string }` |
| `503` | Runtime Cloudflare account, Worker URL, or token configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-010](../../sdd/spec/setup-admin.md)

### POST /admin/setup/domain

Provisions DNS and Worker routing for the wizard's domain step and advances the setup phase to `domain_ready`. Same request/response contract as `POST /admin/custom-domain/validate`.

```http
POST /admin/setup/domain
```

**Authentication:** admin authentication

**Origin check:** n/a

**Request body:** JSON body with `hostname`; optional `zoneId`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Domain provisioned and stored; setup phase advances to `domain_ready`. | Same shape as `POST /admin/custom-domain/validate`. |
| `400` | Hostname is missing/invalid, or supplied zone ID is invalid. | `{ "valid": false, "hostname"?: string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | Existing DNS records conflict with the Worker route target. | `{ "error": "dns_record_conflict", "hostname": string }` |
| `503` | Runtime Cloudflare account, Worker URL, or token configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-012](../../sdd/spec/setup-admin.md)

### POST /admin/setup/access

Provisions the Access application and role allow policy for the provisioned custom domain, plus machine-path bypass coverage, and advances the setup phase to `access_ready`. The captured admin and user sets become the console's admin and read-only user roles (see [security.md](security.md#role-based-console-access)).

```http
POST /admin/setup/access
```

**Authentication:** admin authentication

**Origin check:** n/a

**Request body:** JSON body with `adminEmails`, `adminGroups`, `userEmails`, and `userGroups` (arrays of strings; emails are trimmed, lowercased, deduplicated, and validated; group names are trimmed and deduplicated). A legacy `emails` field is accepted as an alias for `adminEmails`. At least one admin email or admin group is required. When both user fields are empty the allow policy opens to everyone and any Access-authenticated caller becomes a read-only user (`usersOpen: true`).

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Access application, role allow policy, and machine-path bypass provisioned; config stored; phase advances to `access_ready`. | `{ "ok": true, "teamDomain": string, "hostname": string, "consoleUrl": string, "usersOpen": boolean }` |
| `400` | No admin email or admin group supplied. | `{ "error": "admin_required", "requestId": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | Custom domain step has not completed yet. | `{ "error": "custom_domain_required", "requestId": string }` |
| `503` | Runtime Cloudflare account or token configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-ADM-012](../../sdd/spec/setup-admin.md), [REQ-ADM-011](../../sdd/spec/setup-admin.md), [REQ-SEC-010](../../sdd/spec/security.md)

### POST /admin/setup/complete

Finishes setup: locks the bootstrap origin, records break-glass consumption when recovery was active, and audits completion.

```http
POST /admin/setup/complete
```

**Authentication:** admin authentication

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Setup phase becomes `complete`; the bootstrap origin locks to the console-moved page. | `{ "ok": true, "customDomain"?: string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | Access provisioning has not completed yet. | `{ "error": "setup_incomplete", "phase": string, "requestId": string }` |

**Implements:** [REQ-ADM-013](../../sdd/spec/setup-admin.md), [REQ-ADM-014](../../sdd/spec/setup-admin.md)

### GET /admin/cloudflare/zones

Lists the account's zones for the wizard's domain-step selection.

```http
GET /admin/cloudflare/zones
```

**Authentication:** admin authentication

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Zones listed. | `{ "zones": [{ "id": string, "name": string }] }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `503` | Runtime Cloudflare account or token configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-ADM-005](../../sdd/spec/setup-admin.md)

### GET /admin/cloudflare/gateway/options

Lists the account's AI Gateways and the selected gateway's dynamic routes, alongside resolved provisioning defaults, for the wizard's gateway dropdowns.

```http
GET /admin/cloudflare/gateway/options?gateway=<id>
```

**Authentication:** admin authentication

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Gateways and routes listed. | `{ "gateways": [...], "routes": [...], "defaults": { "accountId": string, "gatewayId": string, "providerName": string, "routeName": string, "publicModel": string } }` — `routeName` and `publicModel` are always the fixed stable public model `codeflare-mesh` (not configurable), matching the sibling `POST /admin/cloudflare/gateway/sync`; only `accountId`, `gatewayId`, and `providerName` reflect resolved, request-overridable settings. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `503` | Runtime Cloudflare account or token configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-GWY-005](../../sdd/spec/gateway.md)

### GET /admin/cloudflare/gateway/provision-status

Live-verifies whether the selected gateway carries the mesh route and canonical provider, so the Routing chip reflects that gateway's true state rather than the last-synced one.

```http
GET /admin/cloudflare/gateway/provision-status?gateway=<id>
```

**Authentication:** admin authentication

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Live provision status for the selected gateway. | `{ "gatewayId": string, "provisioned": boolean, "routeEnabled": boolean, "routeId"?: string, "providerId"?: string }` — `provisioned` is `true` only when the `codeflare-mesh` route is enabled and the name-derived canonical provider exists. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `503` | Runtime Cloudflare account or token configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-GWY-008](../../sdd/spec/gateway.md), [REQ-ADM-024](../../sdd/spec/setup-admin.md)

### POST /admin/profiles/rollout

Stores a versioned profile rollout percentage.

```http
POST /admin/profiles/rollout
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `profileId` and numeric `rolloutPercent`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Versioned profile rollout update is stored. | `{ "ok": true }` |
| `400` | Profile ID or rollout percentage is invalid. | Error object. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-RUN-004](../../sdd/spec/runtime-profiles.md)

**Notes:** A rollout percentage above zero applies the alias-exclusive activation invariant: any other active profile sharing a public alias with the target is deactivated first, so no alias ever has two active owners. ([REQ-RUN-009](../../sdd/spec/runtime-profiles.md))

### POST /admin/profiles/activate

Activates a profile and atomically deactivates any active profile sharing one of its public aliases.

```http
POST /admin/profiles/activate
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `profileId`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Target profile is activated, alias-overlapping active profiles are deactivated in the same operation, and a `profile_activated` audit event records the deactivated ids. | `{ "ok": true, "activated": string, "deactivated": string[] }` |
| `400` | `profileId` is missing or not a string. | `{ "error": "invalid_activation", "requestId": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | Profile does not exist. | `{ "error": "unknown_profile", "requestId": string }` |

**Implements:** [REQ-RUN-009](../../sdd/spec/runtime-profiles.md), [REQ-ADM-009](../../sdd/spec/setup-admin.md)

### POST /admin/profiles/add

Creates a new inactive model profile from an operator-supplied model reference, serving mode, and runtime, so a model beyond the seeded set joins the catalog for rollout and activation without redeploying the Worker.

```http
POST /admin/profiles/add
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `modelRef` (required, trimmed, non-empty), `mode` (`single` or `split`, default `single`), `runtime` (`meshllm` or `llamacpp`, default `meshllm`), and optional `name` (display name; defaults to the model-file segment). Mode `split` builds a MeshLLM layer-package profile and forces `runtime: "meshllm"`; `runtime: "llamacpp"` is single-machine only and creates a direct cache-local profile. The profile id and public alias are derived from the reference.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `201` | A new inactive profile is created carrying the stable `codeflare-mesh` alias with `rolloutPercent` zero, `split` set per mode for MeshLLM, `runtime` set to the selected runtime, and a `profile_added` audit event records the reference. | `{ "ok": true, "profileId": string, "displayName": string, "split": boolean, "runtime": "meshllm" \| "llamacpp" }` |
| `400` | `modelRef` is missing/blank, `runtime` is invalid, or `runtime: "llamacpp"` was requested with `mode: "split"`. | `{ "error": "invalid_model_ref" \| "invalid_runtime" \| "split_requires_meshllm", "requestId": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | The reference's derived profile id already exists. | `{ "error": "duplicate_profile", "profileId": string, "requestId": string }` |

**Implements:** [REQ-RUN-011](../../sdd/spec/runtime-profiles.md), [REQ-ADM-025](../../sdd/spec/setup-admin.md), [REQ-ADM-027](../../sdd/spec/setup-admin.md#req-adm-027-model-naming-and-rename)

### POST /admin/profiles/config

Updates a model's serving settings — context window, model reference, VRAM budget, display name, callable name, and runtime-specific tunables — through the same validated store path the automation API uses, bumping the profile version so a later default re-seed does not overwrite the edit.

```http
POST /admin/profiles/config
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `profileId` (required) plus any of `runtime` (`meshllm` or `llamacpp`), `contextWindow`, `modelRef` (non-empty string), `maxVramGb` (MeshLLM-only number `≥ 0`, `0` = no cap), `name` (display name; non-blank), and `callName` (slugified callable alias; non-empty, not the reserved `codeflare-mesh`, not a collision). A changed call name keeps the shared alias. Each field besides `profileId` is optional; an omitted field is left unchanged. MeshLLM context window accepts `0` for Auto; direct llama.cpp context window must be at least `4096`.

MeshLLM profiles accept the per-model runtime tunables: `parallel`, `batch`, `ubatch`, `maxOutputTokens` (positive integers), `cacheTypeK` / `cacheTypeV` (`f16` \| `q8_0` \| `q4_0`), `flashAttn` (boolean), `reasoning` (`{ enabled?, format?, budget? }`, layered onto the existing block), and `prefixCache` (`{ enabled?, payloadMode?, maxEntries?, sharedStrideTokens?, sharedRecordLimit? }`, layered; `payloadMode` is `resident-kv` \| `kv-recurrent` \| `full-state`, `maxEntries` is `1`-`128`). A positive integer / allowed string / boolean sets a tunable; `null` / `0` / `""` clears it back to Auto (the field is removed, so MeshLLM auto-plans it). Direct llama.cpp profiles accept a `llamacpp` block with `parallel` (`>= 1`), `gpuLayers` (`0` or a positive integer, or `"auto"` / `"all"`; `null`/`""` clears), `cachePrompt` (boolean), `cacheReuse` (`>= 0`), `cacheTypeK` / `cacheTypeV` (`f32` \| `f16` \| `bf16` \| `q8_0` \| `q4_0` \| `q4_1` \| `iq4_nl` \| `q5_0` \| `q5_1`), `batch`, `ubatch`, `maxOutputTokens` (positive integers; `null`/`0` clears), `flashAttn` (boolean; `null` clears), `reasoning` (`{ enabled?, format?, budget? }`, `null` clears), and optional `bindPort`; reserved bind ports are rejected.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The updated profile's settings (`displayName`/`callableNames` reflect a changed name or call name); a `profile_configured` audit event records the context window, model reference, and runtime-relevant settings. | `{ "ok": true, "profileId": string, "contextWindow": number, "modelRef": string, "maxVramGb"?: number, "displayName": string, "callableNames": string[], "runtime"?: "meshllm" \| "llamacpp" }` |
| `400` | `profileId` is missing, or the context window, model reference, VRAM budget, display name, call name, runtime, or runtime tunable was invalid. | `invalid_profile_config` / `invalid_context_window` / `invalid_model_ref` / `invalid_max_vram` / `invalid_display_name` / `invalid_call_name` / `invalid_runtime` / `invalid_parallel` / `invalid_batch` / `invalid_ubatch` / `invalid_maxOutputTokens` / `invalid_cacheTypeK` / `invalid_cacheTypeV` / `invalid_flash_attn` / `invalid_reasoning` / `invalid_prefix_cache` / `invalid_llamacpp` / `invalid_cachePrompt` / `bind_port_conflict` error body. |
| `401` | Admin credential is missing or invalid. | Error object. |
| `404` | No profile with that id exists. | `unknown_profile` error body. |
| `409` | The call name is the reserved `codeflare-mesh` alias or collides with another model. | `call_name_conflict` error body. |

**Implements:** [REQ-ADM-021](../../sdd/spec/setup-admin.md#req-adm-021-model-serving-configuration), [REQ-ADM-027](../../sdd/spec/setup-admin.md#req-adm-027-model-naming-and-rename)

### POST /admin/profiles/delete

Permanently removes a custom, switched-off model profile from the catalog; built-in models (which re-seed on boot) and the active model are refused.

```http
POST /admin/profiles/delete
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `profileId`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The custom model is removed and a `profile_deleted` audit event records it. | `{ "ok": true, "profileId": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | No profile with that id exists. | `{ "error": "unknown_profile", "requestId": string }` |
| `409` | The profile is a built-in (re-seeds on boot) or is active; nothing was removed. | `{ "error": "model_builtin", "requestId": string }` or `{ "error": "model_active", "requestId": string }` |

**Implements:** [REQ-RUN-012](../../sdd/spec/runtime-profiles.md), [REQ-ADM-026](../../sdd/spec/setup-admin.md)

### POST /admin/mesh/rotate

Rotates a profile's mesh: increments the rotation counter and clears the stored mesh id, seed, and invite-token set so the fleet reforms a new mesh. The automation twin is `POST /api/v1/mesh/rotate`.

```http
POST /admin/mesh/rotate
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `profileId`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Rotation counter is incremented, mesh state is cleared, and a `mesh_token_rotated` audit event is recorded; subsequent heartbeats re-elect a seed and reform the mesh under the new `--mesh-name codeflare-<profileId>-r<N>` identity. | `{ "ok": true, "profileId": string, "rotation": number }` |
| `400` | `profileId` is missing or empty. | `{ "error": "invalid_rotate" }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | Profile does not exist. | `{ "error": "unknown_profile" }` |
| `500` | The `MESH_STATE_KEY` Worker secret is not configured. | `{ "error": "mesh_state_key_missing" }` |

**Implements:** [REQ-SEC-006](../../sdd/spec/security.md), [REQ-ADM-009](../../sdd/spec/setup-admin.md)

**Notes:** The audit event carries profile id, rotation, and the previous mesh id — never token material. Invite-token values are never returned by this or any other admin endpoint. ([REQ-SEC-006](../../sdd/spec/security.md))

### GET /admin/agent-versions

Lists node-agent release tags from the repository's GitHub releases API together with the current desired version.

```http
GET /admin/agent-versions
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Release tags are served from the `router_config` cache with a 10-minute TTL; when the GitHub fetch fails, the last cached list is served with `stale: true`, or an empty list with `error: "releases_fetch_failed"` when no cache exists yet. | `{ "tags": string[], "fetchedAt"?: number, "stale": boolean, "desired"?: string, "error"?: string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-008](../../sdd/spec/setup-admin.md)

### POST /admin/agent-version

Selects the fleet-wide desired node-agent version from the release-tag list, refreshing the cache once when the requested tag is missing.

```http
POST /admin/agent-version
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `version`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Version is validated against the release-tag list after a cache refresh when needed, stored as the single fleet-wide desired agent version, and recorded as an `agent_version_selected` audit event; nodes receive it as `desiredAgentVersion` in subsequent heartbeat responses. | `{ "ok": true, "desired": string }` |
| `400` | `version` is missing, or the tag is still absent from the release-tag list after refresh. | `{ "error": "invalid_version" }` or `{ "error": "unknown_version", "version": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-008](../../sdd/spec/setup-admin.md)

### GET /admin/runtime-versions

Lists MeshLLM and llama.cpp release tags with the current desired runtime binary selections.

```http
GET /admin/runtime-versions
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Runtime release tags are served from cached GitHub release lists; stale caches are marked when a refresh fails. | `{ "meshllm": { "tags": string[], "fetchedAt"?: number, "stale": boolean, "desired": string, "error"?: string }, "llamacpp": { "tags": string[], "fetchedAt"?: number, "stale": boolean, "desired": string, "error"?: string } }`. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility)

### POST /admin/runtime-versions

Selects the fleet-wide desired MeshLLM and llama.cpp runtime binary versions. Nodes receive the desired versions in subsequent claim/heartbeat responses and bootstrap the selected binaries themselves.

```http
POST /admin/runtime-versions
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with either or both of `meshllm` and `llamacpp`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Runtime versions are validated against the release-tag lists, stored as desired versions, and recorded as a `runtime_versions_selected` audit event. | `{ "ok": true, "desired": { "meshllm": string, "llamacpp": string } }` |
| `400` | No version was supplied, a value is invalid, or a tag is absent from the corresponding release list. | `{ "error": "invalid_runtime_versions" }`, `{ "error": "invalid_meshllm_version" }`, `{ "error": "invalid_llamacpp_version" }`, `{ "error": "unknown_meshllm_version", "version": string }`, or `{ "error": "unknown_llamacpp_version", "version": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility)

### POST /admin/settings

Persists operator-tunable fleet settings. Currently accepts the offline-machine prune window. The automation twins are `GET /api/v1/settings` (read) and `PUT /api/v1/settings` (write).

```http
POST /admin/settings
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `offlinePruneSeconds` (non-negative integer; `0` disables pruning). A machine offline longer than this window is removed on the next admin status read and must re-enroll; the default when unset is 2592000 (30 days).

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | The window is stored and recorded as a `settings_updated` audit event. | `{ "ok": true, "offlinePruneSeconds": number }` |
| `400` | `offlinePruneSeconds` is missing, non-integer, or negative. | `{ "error": "invalid_settings", "requestId": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-020](../../sdd/spec/setup-admin.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
| Access verification | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/access.ts::ACCESS_ANCHORS` <!-- @impl: packages/router-worker/src/access.ts::ACCESS_ANCHORS --> |
| Access provisioning | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/access-provisioning.ts::ACCESS_PROVISIONING_ANCHORS` <!-- @impl: packages/router-worker/src/access-provisioning.ts::ACCESS_PROVISIONING_ANCHORS --> |
| Setup phases | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/setup-state.ts::SETUP_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/setup-state.ts::SETUP_STATE_ANCHORS --> |
| Mesh rotation | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Agent versions | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS` <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> |
