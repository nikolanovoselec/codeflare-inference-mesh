# Admin API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

Admin routes use the MVP admin token or an admin session derived from it after first-run setup completes. They never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity. Admin routes do not implement a dedicated Origin-header gate; bearer/admin authentication is the route guard. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## Endpoints

### GET /

Serves the state-gated Admin UI shell: the setup wizard while setup is open, the sign-in view once locked, and the sectioned operator dashboard after sign-in.

```http
GET /
```

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Admin UI shell with anti-framing headers, pre-rendered into the setup wizard while setup is open and the sign-in view once locked; the shell loads without a bearer token. `HEAD` returns the same status and headers. | HTML. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md), [REQ-ADM-007](../../sdd/spec/setup-admin.md), [REQ-ADM-011](../../sdd/spec/setup-admin.md)

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

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Router state is returned with credentials redacted. | Nodes (each with its reported `agentVersion`), profiles, profile readiness counts, `meshHealth` entries, setup/gateway/domain state, recent audit entries, optional `desiredAgentVersion`, and generated timestamp. |
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-OBS-007](../../sdd/spec/observability.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md)

**Notes:** `meshHealth` carries one entry per MeshLLM profile: `{ profileId, meshId?, rotation, seedNodeId?, coordinatorNodeId?, peerNodeIds, tokenCount, secretAgeMs?, lastError?, readyModels, failedNodeIds }`. Mesh secrets appear only as presence, age, and count (`tokenCount`, `secretAgeMs`); invite-token values are never included in any admin response. When the `MESH_STATE_KEY` Worker secret is not configured, each entry reports `lastError: "mesh_state_key_missing"`. ([REQ-OBS-007](../../sdd/spec/observability.md)) ([REQ-SEC-007](../../sdd/spec/security.md))

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
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md)

### GET /admin/installers/:platform

Returns a one-line installer command for a supported node-agent platform.

```http
GET /admin/installers/{platform}
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `platform` must be `linux`, `macos`, or `windows`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Installer command fetches the platform installer and passes only router URL plus setup token. | One-line install command. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `404` | Unsupported platform. | `{ "error": "unknown_platform" }` |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

### POST /admin/nodes/:nodeId/revoke

Revokes a node token and removes the node from eligible scheduling.

```http
POST /admin/nodes/{nodeId}/revoke
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Path parameters:** `nodeId` is the URL-encoded node identifier to revoke.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Node is marked revoked, stored node credentials are revoked, the node's mesh invite-token entry is removed from every active MeshLLM profile's mesh state (`mesh_token_removed` audit event), and later node heartbeats/unregister calls cannot restore eligibility. | `{ "ok": true }` |
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md), [REQ-SEC-007](../../sdd/spec/security.md)

### POST /admin/cloudflare/gateway/sync

Creates or reuses the AI Gateway custom-provider dynamic route for the selected Worker origin.

```http
POST /admin/cloudflare/gateway/sync
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** Optional JSON with `accountId`, `gatewayId`, `routeName`, `providerName`, `publicModel`, and `workerUrl` — all optional. For account and Gateway fields, request body values override stored settings, then the environment defaults documented in [configuration.md](configuration.md) apply. For `workerUrl`, request body overrides a stored explicit Worker URL; when neither exists, Gateway sync uses the provisioned custom domain.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Cloudflare AI Gateway metadata and selected sync settings are stored in D1. | Provider, route, route version, deployment identifiers, and selected settings. |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |
| `409` | No provisioned custom domain exists for Gateway sync, or the stored custom domain is not provisioned and no `workerUrl` override was supplied. | `{ "error": "custom_domain_required" }` or `{ "error": "custom_domain_not_provisioned", "hostname": string }` |
| `503` | Required runtime Cloudflare configuration is missing. | `{ "error": "cloudflare_runtime_config_missing" }` |

**Implements:** [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-010](../../sdd/spec/setup-admin.md)

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

### POST /admin/mesh/rotate

Rotates a profile's mesh: increments the rotation counter and clears the stored mesh id, seed, and invite-token set so the fleet reforms a new mesh.

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

Selects the fleet-wide desired node-agent version from the cached release-tag list.

```http
POST /admin/agent-version
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `version`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Version is validated against the release-tag list, stored as the single fleet-wide desired agent version, and recorded as an `agent_version_selected` audit event; nodes receive it as `desiredAgentVersion` in subsequent heartbeat responses. | `{ "ok": true, "desired": string }` |
| `400` | `version` is missing, or the tag is absent from the release-tag list. | `{ "error": "invalid_version" }` or `{ "error": "unknown_version", "version": string }` |
| `401` | Admin credential is missing or invalid. | `{ "error": "unauthorized" }` |

**Implements:** [REQ-ADM-008](../../sdd/spec/setup-admin.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
| Mesh rotation | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Agent versions | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS` <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> |
