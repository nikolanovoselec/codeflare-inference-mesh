# Gateway Integration

This domain covers how Cloudflare AI Gateway reaches the router and how the router keeps Gateway-facing names stable.

---

### REQ-GWY-001: Gateway custom provider

**Intent:** AI Gateway must call one router Worker as the only public model provider for private inference traffic. Clients should not need to know node addresses, local runtime names, or router internals.

**Applies To:** Client

**Acceptance Criteria:**

1. A configured AI Gateway custom provider uses the router Worker HTTPS origin as its base URL. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->
2. The Gateway routes chat requests to the router's provider chat-completion forwarding surface. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->
3. The custom provider slug is stable after setup so client configuration does not change across router releases. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->
4. The router exposes provider model-listing surface using public aliases rather than per-node runtime names. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-001 REQ-RTR-001 separates health, provider, node, and admin route families) -->

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

1. The router accepts provider route-family requests only when the provider bearer token verifies successfully. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
2. The setup flow displays the generated provider token once for manual AI Gateway BYOK/provider-key entry. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
3. Durable router state stores only a verifier for the provider token unless a later rotation flow requires encrypted recovery. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->
4. Missing or invalid provider credentials produce an authentication error without revealing expected token material. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 REQ-SEC-002 generates distinct bearer tokens, stores only verifiers, and stages setup rotation) -->

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

1. The Admin can choose the Cloudflare account ID, Gateway ID, route name, provider name, public model alias, and Worker URL override before sync. <!-- @impl: packages/router-worker/src/admin-ui.ts::adminUiHtml --> <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 sends selected Gateway account from the Admin UI) --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 automates provider, route, version, and deployment creation while leaving BYOK manual) -->
2. The router stores selected Gateway sync settings for operator visibility and uses the provisioned custom domain for Gateway sync when no explicit override was supplied. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 uses the provisioned custom domain for Gateway sync instead of workers.dev bootstrap) -->
3. The router creates missing custom provider, route draft, route version, and deployment resources for the selected Gateway. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts) -->
4. Re-running sync reuses existing matching provider, route, version, and deployment resources. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 reuses existing Cloudflare Gateway resources on repeat sync) -->
5. Re-running sync patches existing provider drift before route deployment. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 patches an existing Gateway provider when Worker URL drifts) -->
6. The created model node uses the selected public alias. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts) -->
7. The created route config uses low retry settings for long-running local inference traffic. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts) -->

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

1. A temporary validation endpoint records header names received from AI Gateway without recording header values. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
2. The validation endpoint is disabled or removed before production hardening completes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
3. The verified provider-token header name becomes the only accepted provider-auth source for provider route-family routes. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->
4. Validation logs redact any header whose name implies credentials or identity tokens. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-004 REQ-SEC-001 prevents credential classes from crossing route families) -->

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
