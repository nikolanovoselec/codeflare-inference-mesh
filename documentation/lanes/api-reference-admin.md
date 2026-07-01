# Admin API Reference

## Contents

- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

Admin routes use the MVP admin token or an admin session derived from it after first-run setup completes. They never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity. Admin routes do not implement a dedicated Origin-header gate; bearer/admin authentication is the route guard. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## Endpoints

### GET /

Serves the responsive command-center Admin configuration UI shell.

```http
GET /
```

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Command-center Admin UI shell is served with anti-framing headers; the shell loads without a bearer token, while admin controls still require bearer authentication after setup completes. | HTML. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md), [REQ-ADM-007](../../sdd/spec/setup-admin.md)

### GET /admin

Serves the same responsive command-center Admin configuration UI shell as `/`.

```http
GET /admin
```

**Authentication:** none

**Origin check:** n/a

**Request body:** None.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Same command-center Admin UI shell and anti-framing headers as `/`. | HTML. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md), [REQ-ADM-007](../../sdd/spec/setup-admin.md)

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
| `200` | Router state is returned with credentials redacted. | Nodes, profiles, recent audit entries, and generated timestamp. |
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-OBS-002](../../sdd/spec/observability.md)

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
| `200` | Node is marked revoked, stored node credentials are revoked, and later node heartbeats/unregister calls cannot restore eligibility. | `{ "ok": true }` |
| `401` | Admin credential is missing or invalid. | Error object. |

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md)

### POST /admin/cloudflare/gateway/sync

Creates or updates the AI Gateway custom-provider route for the Worker origin.

```http
POST /admin/cloudflare/gateway/sync
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** No required body fields in the current implementation; account, gateway, token, and Worker URL come from Worker environment unless a validated custom domain is stored.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Cloudflare AI Gateway metadata is stored in D1. | Provider, route, route version, and deployment identifiers. |
| `503` | Required runtime Cloudflare configuration is missing. | Configuration error. |

**Implements:** [REQ-GWY-003](../../sdd/spec/gateway.md)

### POST /admin/custom-domain/validate

Validates and stores a custom-domain hostname and Cloudflare zone ID.

```http
POST /admin/custom-domain/validate
```

**Authentication:** admin bearer token

**Origin check:** n/a

**Request body:** JSON body with `hostname` and a 32-character hexadecimal Cloudflare `zoneId`.

**Response**

| Status | Outcome | Body |
| --- | --- | --- |
| `200` | Hostname and zone ID are stored for later Gateway/DNS operations. | `{ "valid": true, "hostname": string, "zoneId": string }` |
| `400` | Hostname or zone ID is missing or invalid. | `{ "valid": false, "hostname": string }` |

**Implements:** [REQ-ADM-005](../../sdd/spec/setup-admin.md)

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

**Implements:** [REQ-RUN-004](../../sdd/spec/runtime-profiles.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
