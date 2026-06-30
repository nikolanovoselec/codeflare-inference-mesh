# Gateway Integration

This domain covers how Cloudflare AI Gateway reaches the router and how the router keeps Gateway-facing names stable.

---

### REQ-GWY-001: Gateway custom provider

**Intent:** AI Gateway must call one router Worker as the only public model provider for private inference traffic. Clients should not need to know node addresses, local runtime names, or router internals.

**Applies To:** Client

**Acceptance Criteria:**

1. A configured AI Gateway custom provider uses the router Worker HTTPS origin as its base URL. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS -->
2. The provider-specific Gateway endpoint appends `/v1/chat/completions` to the router origin when forwarding chat requests. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS -->
3. The custom provider slug is stable after setup so client configuration does not change across router releases. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS -->
4. The router exposes `/v1/models` using public aliases rather than per-node runtime names. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-GWY-002: Provider token contract

**Intent:** AI Gateway-to-router calls must use a credential that is separate from admin, node, setup, and Cloudflare API credentials. This limits blast radius when one integration secret is rotated or leaked.

**Applies To:** Admin

**Acceptance Criteria:**

1. The router accepts `/v1/*` requests only when the provider bearer token verifies successfully. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->
2. The setup flow displays the generated provider token once for manual AI Gateway BYOK/provider-key entry. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->
3. Durable router state stores only a verifier for the provider token unless a later rotation flow requires encrypted recovery. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->
4. Missing or invalid provider credentials produce an authentication error without revealing expected token material. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-GWY-003: Dynamic route automation

**Intent:** The setup UI should create the Gateway route needed by coding agents so the operator does not manually reproduce a versioned routing flow in the dashboard.

**Applies To:** Admin

**Acceptance Criteria:**

1. The setup flow lists available AI Gateways for the configured Cloudflare account. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS -->
2. The Admin can choose a route name and public model alias for the initial route. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS -->
3. The router creates or updates the custom provider, route draft, route version, and deployment for the selected Gateway. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS -->
4. The created model node uses the custom provider and `mesh-default` unless the Admin selects another public alias. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS -->
5. The created route config uses low retry settings for long-running local inference traffic. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P0

**Dependencies:** [REQ-GWY-001](#req-gwy-001-gateway-custom-provider), [REQ-GWY-002](#req-gwy-002-provider-token-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-GWY-004: Gateway header validation

**Intent:** The first implementation must verify the exact provider-auth header shape sent by AI Gateway without logging secrets. This prevents building the router around an assumed header contract.

**Applies To:** Admin

**Acceptance Criteria:**

1. A temporary validation endpoint records header names received from AI Gateway without recording header values. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->
2. The validation endpoint is disabled or removed before production hardening completes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->
3. The verified provider-token header name becomes the only accepted provider-auth source for `/v1/*` routes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->
4. Validation logs redact any header whose name implies credentials or identity tokens. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface)

**Priority:** P0

**Dependencies:** [REQ-GWY-002](#req-gwy-002-provider-token-contract)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
