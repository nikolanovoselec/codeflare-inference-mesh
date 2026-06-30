# Admin API Reference

## Conventions

Admin routes use the MVP admin token or an admin session derived from it after first-run setup completes. They never accept provider tokens, node tokens, setup tokens, or Worker-to-node upstream tokens as admin identity. ([REQ-ADM-002](../../sdd/spec/setup-admin.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## POST /admin/setup ([REQ-ADM-001](../../sdd/spec/setup-admin.md))

**Purpose:** Complete first-run setup and generate the initial admin, provider, node-setup, and upstream credentials.

**Auth:** Open only while no active admin token exists; admin auth is required after setup completes.

**Success:** Stores setup-complete state and displays generated credentials once.

## POST /admin/login ([REQ-ADM-002](../../sdd/spec/setup-admin.md))

**Purpose:** Verify admin credentials for the MVP bearer-token admin flow.

**Auth:** Admin token or admin session.

**Success:** Returns a bearer-token session contract.

## GET /admin/status ([REQ-OBS-002](../../sdd/spec/observability.md))

**Purpose:** Return machine-readable fleet and router status.

**Auth:** Admin token or admin session.

**Success:** Returns nodes, profiles, recent audit entries, and generated timestamp with credentials redacted.

## POST /admin/setup-tokens ([REQ-ADM-003](../../sdd/spec/setup-admin.md))

**Purpose:** Create a short-lived setup token for one node.

**Auth:** Admin token or admin session.

**Success:** Displays the setup token once and stores only its verifier.

## GET /admin/installers/:platform ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

**Purpose:** Create a setup token and return a one-line installer command for `linux`, `macos`, or `windows`.

**Auth:** Admin token or admin session.

**Success:** Returns a command that fetches `/install.sh` or `/install.ps1` and passes only router URL plus setup token.

## POST /admin/nodes/:nodeId/revoke ([REQ-SEC-002](../../sdd/spec/security.md))

**Purpose:** Revoke a node credential and remove the node from scheduling.

**Auth:** Admin token or admin session.

**Success:** Marks the node revoked and clears live eligibility.

## POST /admin/cloudflare/gateway/sync ([REQ-GWY-003](../../sdd/spec/gateway.md))

**Purpose:** Create Gateway custom provider and dynamic route resources.

**Auth:** Admin token or admin session.

**Success:** Stores provider, route, route version, and deployment identifiers in D1.

## POST /admin/custom-domain/validate ([REQ-ADM-005](../../sdd/spec/setup-admin.md))

**Purpose:** Validate an optional custom-domain hostname before accepting it.

**Auth:** Admin token or admin session.

**Success:** Returns the hostname validation result without changing the active Worker origin.

## POST /admin/profiles/rollout ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

**Purpose:** Change a model profile rollout percentage.

**Auth:** Admin token or admin session.

**Success:** Stores a versioned profile rollout update.

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Admin routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Installer routes | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/installers.ts::INSTALLER_ANCHORS` <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS --> |
| Gateway sync | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS` <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS --> |
