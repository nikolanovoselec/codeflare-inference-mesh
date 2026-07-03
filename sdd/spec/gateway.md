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
2. The gateway sync step displays a freshly minted provider token once for manual AI Gateway BYOK/provider-key entry, retiring prior provider tokens. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-002 gateway sync mints and reveals a fresh provider key, rotating prior ones) -->
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
3. The router creates the missing custom provider and the dynamic route with its routing elements set inline, which yields the route's version and deployment in one call. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts) -->
4. Re-running sync reuses the existing matching provider and route without creating a new route version or deployment. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 reuses existing Cloudflare Gateway resources on repeat sync) -->
5. A matching route left disabled out of band is re-enabled by sync, accepting a new route version and deployment, instead of remaining silently non-serving. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 re-enables a disabled route even when its routing elements already match) -->
6. Re-running sync patches existing provider drift before route deployment. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 patches an existing Gateway provider when Worker URL drifts) -->
7. The created route config uses the selected public alias for the model node and low retry settings for long-running local inference traffic. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::syncCustomProvider --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-003 uses idempotent Cloudflare custom-provider and dynamic-route payload contracts) -->

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

### REQ-GWY-005: Gateway selection and provisioning

**Intent:** The Gateway step should feel like choosing from what the account already has — or creating sensible defaults in one action — instead of presenting empty identifier fields to fill by hand.

**Applies To:** Admin

**Acceptance Criteria:**

1. The gateway options endpoint lists the account's AI Gateways and the selected gateway's dynamic routes. <!-- @impl: packages/router-worker/src/router.ts::handleGatewayOptions --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-005 lists gateways, routes, and defaults for the gateway step) -->
2. The Gateway step renders gateway and route selections populated from the options endpoint, each with a create-new choice. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-005 gateway step renders selects from live options and syncs the selection) -->
3. When the account has no gateway, the step offers a single primary action that creates the default gateway and route. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CloudflareGatewayClient.ensureGateway --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-005 gateway step offers one-click provisioning when the account has no gateway) -->
4. Provisioning a selection stores it and runs the existing sync flow against it. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-005 gateway step renders selects from live options and syncs the selection) -->
5. Provider name, public model alias, and Worker URL overrides are folded behind an explicit advanced disclosure. <!-- @impl: packages/router-worker/src/admin-ui-views.ts::setupWizardView --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-ADM-011 renders the setup wizard with its step sequence while setup is open) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane), [CON-MODEL-001](constraints.md#con-model-001-stable-gateway-aliases)

**Priority:** P1

**Dependencies:** [REQ-GWY-003](#req-gwy-003-dynamic-route-automation), [REQ-ADM-011](setup-admin.md#req-adm-011-guided-first-run-setup)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-GWY-006: Cloudflare API error surfacing

**Intent:** When a Cloudflare API call made during setup fails, the operator should see Cloudflare's own error code and message, not just an HTTP status, so a rejected step is diagnosable from the audit log without redeploying.

**Applies To:** Admin

**Acceptance Criteria:**

1. A failed Cloudflare Gateway or gateway-options API call includes Cloudflare's error code and message in the thrown error. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::formatCloudflareApiErrors --> <!-- @test: packages/router-worker/src/router.test.ts (REQ-GWY-006 surfaces the Cloudflare error code and message on a failed API call) -->
2. A failed Cloudflare Access provisioning API call includes Cloudflare's error code and message in the thrown error. <!-- @impl: packages/router-worker/src/access-provisioning.ts::CloudflareAccessClient.accountRequest --> <!-- @test: packages/router-worker/src/access-provisioning.test.ts (REQ-GWY-006 surfaces the Cloudflare error code and message on a failed Access API call) -->

**Constraints:** [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane)

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/configuration.md](../../documentation/lanes/configuration.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
