# Admin API Reference

## Conventions

Admin routes use the MVP admin token or an admin session derived from it. They never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## GET / ([REQ-ADM-001](../../sdd/spec/setup-admin.md))

**Purpose:** Redirect to setup or admin UI based on setup state.

**Auth:** Initial setup token before setup; admin auth after setup.

**Success:** Returns or redirects to the appropriate UI.

## GET /setup ([REQ-ADM-001](../../sdd/spec/setup-admin.md))

**Purpose:** Serve first-run setup UI while setup is incomplete.

**Auth:** Initial setup token.

**Success:** Shows setup state, provider-token generation, and Gateway setup steps.

## GET /admin ([REQ-ADM-002](../../sdd/spec/setup-admin.md))

**Purpose:** Serve admin dashboard after setup completes.

**Auth:** Admin token or admin session.

**Success:** Shows fleet, routes, setup-token controls, and profile state.

## GET /admin/status ([REQ-OBS-002](../../sdd/spec/observability.md))

**Purpose:** Return machine-readable fleet and session status.

**Auth:** Admin token or admin session.

**Success:** Returns nodes, active sessions, profiles, lease state, and failure penalties.

## GET /admin/nodes ([REQ-OBS-002](../../sdd/spec/observability.md))

**Purpose:** List registered nodes and durable node state.

**Auth:** Admin token or admin session.

**Success:** Returns node records without token hashes or plaintext credentials.

## GET /admin/routes ([REQ-GWY-003](../../sdd/spec/gateway.md))

**Purpose:** Show configured Gateway provider and dynamic route resources.

**Auth:** Admin token or admin session.

**Success:** Returns selected Gateway ID, provider ID, route ID, version, and deployment state.

## POST /admin/setup-tokens ([REQ-ADM-003](../../sdd/spec/setup-admin.md))

**Purpose:** Create a short-lived setup token for one node.

**Auth:** Admin token or admin session.

**Success:** Displays the token once and stores only its verifier.

## POST /admin/nodes/:nodeId/revoke ([REQ-SEC-002](../../sdd/spec/security.md))

**Purpose:** Revoke a node credential and remove the node from scheduling.

**Auth:** Admin token or admin session.

**Success:** Marks the node revoked and clears live eligibility.

## POST /admin/cloudflare/custom-domain ([REQ-ADM-005](../../sdd/spec/setup-admin.md))

**Purpose:** Attach or update an optional Worker custom domain.

**Auth:** Admin token or admin session.

**Success:** Stores zone and hostname resource IDs when Cloudflare accepts the change.

## POST /admin/cloudflare/ai-gateway ([REQ-GWY-003](../../sdd/spec/gateway.md))

**Purpose:** Create or update Gateway custom provider and dynamic route resources.

**Auth:** Admin token or admin session.

**Success:** Stores provider, route, route version, and deployment identifiers in D1.

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
