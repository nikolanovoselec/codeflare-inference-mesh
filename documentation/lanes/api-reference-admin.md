# Admin API Reference

## Contents

- [Conventions](#conventions)
- [GET /](#get-)
- [GET /admin](#get-admin)
- [POST /admin/setup](#post-adminsetup)
- [POST /admin/login](#post-adminlogin)
- [GET /admin/status](#get-adminstatus)
- [POST /admin/setup-tokens](#post-adminsetup-tokens)
- [GET /admin/installers/:platform](#get-admininstallersplatform)
- [POST /admin/nodes/:nodeId/revoke](#post-adminnodesnodeidrevoke)
- [POST /admin/cloudflare/gateway/sync](#post-admincloudflaregatewaysync)
- [POST /admin/custom-domain/validate](#post-admincustom-domainvalidate)
- [POST /admin/profiles/rollout](#post-adminprofilesrollout)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

Admin routes use the MVP admin token or an admin session derived from it after first-run setup completes. They never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity. Admin routes do not implement a dedicated Origin-header gate; bearer/admin authentication is the route guard. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## GET /

Serves the guided responsive Admin configuration UI shell.

```http
GET /
```

**Authentication:** None for the UI shell.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | HTML | Guided responsive Admin configuration UI. Admin actions still require bearer authentication after setup completes. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md)

## GET /admin

Serves the same guided responsive Admin configuration UI shell as `/`.

```http
GET /admin
```

**Authentication:** None for the UI shell.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | HTML | Same guided responsive Admin configuration UI as `/`. |

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md)

## POST /admin/setup

Performs first-run setup and returns one-time-visible credentials.

```http
POST /admin/setup
```

**Authentication:** Open only while no active admin token exists; admin auth is required after setup completes.

**Origin check:** n/a

**Request:** No required body fields in the current implementation.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `201` | Generated admin, provider, setup, and upstream credentials | Credentials are displayed once; durable storage keeps verifiers/config only. |
| `401` | Error object | Setup has completed and admin auth is missing or invalid. |

**Implements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md)

## POST /admin/login

Validates an admin credential and returns the admin session contract.

```http
POST /admin/login
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Request:** No required body fields in the current implementation.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Admin session contract | Confirms the presented admin credential. |
| `401` | Error object | Admin credential is missing or invalid. |

**Implements:** [REQ-ADM-002](../../sdd/spec/setup-admin.md)

## GET /admin/status

Returns the admin dashboard status contract with secrets redacted.

```http
GET /admin/status
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Nodes, profiles, recent audit entries, and generated timestamp | Credentials are redacted. |
| `401` | Error object | Admin credential is missing or invalid. |

**Implements:** [REQ-OBS-002](../../sdd/spec/observability.md)

## POST /admin/setup-tokens

Creates a new one-time setup token for node enrollment.

```http
POST /admin/setup-tokens
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Request:** No body.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `201` | `{ "setupToken": string, "expiresAt": number }` | Displays the setup token once, stores only its verifier, and sets `expiresAt` to creation time + 24h. |
| `401` | Error object | Admin credential is missing or invalid. |

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md)

## GET /admin/installers/:platform

Returns a one-line installer command for a supported node-agent platform.

```http
GET /admin/installers/{platform}
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Path parameters:** `platform` must be `linux`, `macos`, or `windows`.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | One-line install command | Fetches `/install.sh` or `/install.ps1` and passes only router URL plus setup token. |
| `404` | `{ "error": "unknown_platform" }` | Unsupported platform. |

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

## POST /admin/nodes/:nodeId/revoke

Revokes a node and removes it from eligible scheduling.

```http
POST /admin/nodes/{nodeId}/revoke
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Path parameters:** `nodeId` is the URL-encoded node identifier to revoke.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ "ok": true }` | Marks the node revoked and clears live eligibility. |
| `401` | Error object | Admin credential is missing or invalid. |

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md)

## POST /admin/cloudflare/gateway/sync

Creates or updates the AI Gateway custom-provider route for the Worker origin.

```http
POST /admin/cloudflare/gateway/sync
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Request:** No required body fields in the current implementation; account, gateway, token, and Worker URL come from Worker environment unless a validated custom domain is stored.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | Provider, route, route version, and deployment identifiers | Stores Cloudflare AI Gateway metadata in D1. |
| `503` | Configuration error | Required runtime Cloudflare configuration is missing. |

**Implements:** [REQ-GWY-003](../../sdd/spec/gateway.md)

## POST /admin/custom-domain/validate

Validates and stores a custom-domain hostname and Cloudflare zone ID.

```http
POST /admin/custom-domain/validate
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Request:** JSON body with `hostname` and a 32-character hexadecimal Cloudflare `zoneId`.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ "valid": true, "hostname": string, "zoneId": string }` | Stores the selected hostname and zone ID for later Gateway/DNS operations. |
| `400` | `{ "valid": false, "hostname": string }` | Hostname or zone ID is missing or invalid. |

**Implements:** [REQ-ADM-005](../../sdd/spec/setup-admin.md)

## POST /admin/profiles/rollout

Stores a versioned profile rollout percentage.

```http
POST /admin/profiles/rollout
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a

**Request:** JSON body with `profileId` and numeric `rolloutPercent`.

**Response**

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ "ok": true }` | Stores a versioned profile rollout update. |
| `400` | Error object | Profile ID or rollout percentage is invalid. |

**Implements:** [REQ-RUN-004](../../sdd/spec/runtime-profiles.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
