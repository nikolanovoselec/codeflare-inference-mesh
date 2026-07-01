# Admin API Reference

## Contents

- [Conventions](#conventions)
- [GET /](#get--req-adm-006)
- [GET /admin](#get-admin-req-adm-006)
- [POST /admin/setup](#post-adminsetup-req-adm-001)
- [POST /admin/login](#post-adminlogin-req-adm-002)
- [GET /admin/status](#get-adminstatus-req-obs-002)
- [POST /admin/setup-tokens](#post-adminsetup-tokens-req-adm-003)
- [GET /admin/installers/:platform](#get-admininstallersplatform-req-adm-004)
- [POST /admin/nodes/:nodeId/revoke](#post-adminnodesnodeidrevoke-req-sec-002)
- [POST /admin/cloudflare/gateway/sync](#post-admincloudflaregatewaysync-req-gwy-003)
- [POST /admin/custom-domain/validate](#post-admincustom-domainvalidate-req-adm-005)
- [POST /admin/profiles/rollout](#post-adminprofilesrollout-req-run-004)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Conventions

Admin routes use the MVP admin token or an admin session derived from it after first-run setup completes. They never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity. Admin routes do not implement a dedicated Origin-header gate; bearer/admin authentication is the route guard. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## GET / ([REQ-ADM-006](../../sdd/spec/setup-admin.md))

```http
GET /
```

**Authentication:** None for the UI shell.

**Origin check:** n/a

**Request:** No body.

**Response:** Returns the responsive Admin configuration UI. Admin actions inside the UI still use bearer authentication after first-run setup completes.

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md)

## GET /admin ([REQ-ADM-006](../../sdd/spec/setup-admin.md))

```http
GET /admin
```

**Authentication:** None for the UI shell.

**Origin check:** n/a

**Request:** No body.

**Response:** Returns the same responsive Admin configuration UI as `/`.

**Implements:** [REQ-ADM-006](../../sdd/spec/setup-admin.md)

## POST /admin/setup ([REQ-ADM-001](../../sdd/spec/setup-admin.md))

```http
POST /admin/setup
```

**Authentication:** Open only while no active admin token exists; admin auth is required after setup completes.

**Origin check:** n/a


**Request:** No required body fields in the current implementation.

**Response:** Stores setup-complete state and displays generated admin, provider, setup, and upstream credentials once.

**Implements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md)

## POST /admin/login ([REQ-ADM-002](../../sdd/spec/setup-admin.md))

```http
POST /admin/login
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Request:** No required body fields in the current implementation.

**Response:** Returns the MVP bearer-token session contract.

**Implements:** [REQ-ADM-002](../../sdd/spec/setup-admin.md)

## GET /admin/status ([REQ-OBS-002](../../sdd/spec/observability.md))

```http
GET /admin/status
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Request:** No body.

**Response:** Returns nodes, profiles, recent audit entries, and generated timestamp with credentials redacted.

**Implements:** [REQ-OBS-002](../../sdd/spec/observability.md)

## POST /admin/setup-tokens ([REQ-ADM-003](../../sdd/spec/setup-admin.md))

```http
POST /admin/setup-tokens
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Request:** No required body fields in the current implementation.

**Response:** Displays the setup token once and stores only its verifier.

**Implements:** [REQ-ADM-003](../../sdd/spec/setup-admin.md)

## GET /admin/installers/:platform ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

```http
GET /admin/installers/{platform}
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Path parameters:** `platform` must be `linux`, `macos`, or `windows`.

**Response:** Returns a command that fetches `/install.sh` or `/install.ps1` and passes only router URL plus setup token.

**Implements:** [REQ-ADM-004](../../sdd/spec/setup-admin.md)

## POST /admin/nodes/:nodeId/revoke ([REQ-SEC-002](../../sdd/spec/security.md))

```http
POST /admin/nodes/{nodeId}/revoke
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Path parameters:** `nodeId` is the URL-encoded node identifier to revoke.

**Response:** Marks the node revoked and clears live eligibility.

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md)

## POST /admin/cloudflare/gateway/sync ([REQ-GWY-003](../../sdd/spec/gateway.md))

```http
POST /admin/cloudflare/gateway/sync
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Request:** No required body fields in the current implementation; account, gateway, token, and Worker URL come from Worker environment.

**Response:** Stores provider, route, route version, and deployment identifiers in D1.

**Implements:** [REQ-GWY-003](../../sdd/spec/gateway.md)

## POST /admin/custom-domain/validate ([REQ-ADM-005](../../sdd/spec/setup-admin.md))

```http
POST /admin/custom-domain/validate
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Request:** JSON body with `hostname` as the candidate custom-domain hostname.

**Response:** Returns the hostname validation result without changing the active Worker origin.

**Implements:** [REQ-ADM-005](../../sdd/spec/setup-admin.md)

## POST /admin/profiles/rollout ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

```http
POST /admin/profiles/rollout
```

**Authentication:** Admin token or admin session.

**Origin check:** n/a


**Request:** JSON body with `profileId` and numeric `rolloutPercent`.

**Response:** Stores a versioned profile rollout update.

**Implements:** [REQ-RUN-004](../../sdd/spec/runtime-profiles.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin UI | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS` <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS --> |
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
