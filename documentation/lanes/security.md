# Security

## Contents

- [Trust boundaries](#trust-boundaries)
- [Route authorization](#route-authorization)
- [Token storage](#token-storage)
- [Header filtering](#header-filtering)
- [Runtime safety](#runtime-safety)
- [Access position](#access-position)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Trust boundaries

**Threat:** A leaked provider, setup, node, upstream, dashboard, admin, deploy, or Cloudflare runtime credential could be reused across another trust boundary.

**Mitigation:** Each boundary uses a separate credential class with route-specific authorization.

**Verification:** The credential-boundary router test checks cross-family credential rejection; `TestREQNODE004DashboardRuntimeControlsUseController` checks dashboard-token enforcement. <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController -->

**Implements:** [REQ-SEC-001](../../sdd/spec/security.md)

| Boundary | Credential | Purpose | REQs |
| --- | --- | --- | --- |
| Client to AI Gateway | Gateway auth token | Lets clients call the selected Gateway. | [REQ-SEC-001](../../sdd/spec/security.md) |
| AI Gateway to Worker | Provider token | Lets Gateway call router `/v1/*` routes. | [REQ-GWY-002](../../sdd/spec/gateway.md), [REQ-SEC-001](../../sdd/spec/security.md) |
| Admin to Worker | Admin token/session | Protects setup and admin routes after first-run setup completes. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| Installer to Worker | Setup token | Claims one node once. | [REQ-ADM-003](../../sdd/spec/setup-admin.md) |
| Node to Worker | Node token | Authorizes heartbeat and unregister. | [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-OBS-004](../../sdd/spec/observability.md) |
| Local dashboard to node agent | Dashboard token | Authorizes localhost runtime-control POSTs. | [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md) |
| Worker to node | Upstream token | Authorizes Mesh-facing inference proxy. | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| Workflow to Cloudflare | Deploy token | Deploys Worker and migrates D1. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Worker to Cloudflare API | Runtime token | Creates Gateway and optional domain resources. | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |

## Route authorization

**Threat:** A credential for one actor could call routes intended for another actor.

**Mitigation:** Provider auth applies only to `/v1/models` and `/v1/chat/completions`; node claim, heartbeat, unregister, admin, installer, and health routes use their own policy.

**Verification:** The route-family router test covers public/provider/admin separation, the credential-boundary router test covers REQ-SEC-001 cross-family rejection, and the node-unregister router test covers node authorization. <!-- @impl: packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::NodeUnregisterAuthorizationTestAnchor -->

**Implements:** [REQ-RTR-001](../../sdd/spec/router-worker.md), [REQ-SEC-001](../../sdd/spec/security.md)

## Token storage

**Threat:** Durable plaintext credentials could be recovered from D1 or logs after initial setup.

**Mitigation:** Durable token records are verifier-only by default. Plaintext token display is one-time at creation. The generated Worker-to-node upstream token is recoverable in router config only because the Worker must present it to nodes during forwarding. The dashboard token is node-local config state; legacy configs without it backfill and persist one during load. ([REQ-SEC-005](../../sdd/spec/security.md))

**Verification:** The token-verifier router test asserts verifier-only token records, the upstream-token reuse router test asserts generated upstream-token reuse, the admin-status router test asserts admin status redaction, and `TestREQSEC005LegacyConfigBackfillsDashboardToken` asserts dashboard-token backfill persistence. <!-- @impl: packages/router-worker/src/router.test.ts::TokenVerifierStorageTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::UpstreamTokenReuseTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::AdminStatusRedactionTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQSEC005LegacyConfigBackfillsDashboardToken -->

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md), [REQ-SEC-005](../../sdd/spec/security.md)

## Header filtering

**Threat:** Client, Cloudflare, admin, setup, or node credentials could leak to a local runtime during proxying.

**Mitigation:** The Worker forwards only approved inference metadata and the upstream token to a node. The node proxy strips credentials before forwarding to `llama-server`.

**Verification:** The Worker header-filtering router test and `TestREQNODE003UpstreamProxyEnforcesBearerAndStreams` assert forbidden headers are absent at the next hop. <!-- @impl: packages/router-worker/src/router.test.ts::WorkerHeaderFilteringTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams -->

**Implements:** [REQ-SEC-003](../../sdd/spec/security.md)

## Runtime safety

**Threat:** A local or remote web page could control the node runtime, or a Mesh caller could access the local runtime without authorization.

**Mitigation:** Managed `llama-server` runs behind the node proxy. The Mesh-facing listener requires the upstream token. Dashboard runtime controls are localhost-only, require the dashboard token, and reject browser Origin headers that do not match the dashboard origin.

**Verification:** `packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController` asserts dashboard-token enforcement; `packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams` asserts upstream proxy auth and header filtering. <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams -->

**Implements:** [REQ-SEC-004](../../sdd/spec/security.md), [REQ-NODE-004](../../sdd/spec/node-agent.md)

## Access position

**Threat:** Admin UI exposure could exceed the intended bootstrap/admin boundary.

**Mitigation:** First-run setup is intentionally open only until setup completes; after an active admin token exists, setup/admin routes require admin auth. Cloudflare Access is an optional hardening layer after a custom domain exists.

**Verification:** The first-run setup router test asserts setup token generation and claim, the admin-status router test asserts admin-only status, and the credential-boundary router test asserts credential-class separation. <!-- @impl: packages/router-worker/src/router.test.ts::FirstRunSetupTokenTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::AdminStatusRedactionTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor -->

**Implements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md), [REQ-ADM-002](../../sdd/spec/setup-admin.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Credential classes | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/auth.ts::AUTH_ANCHORS` <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> |
| Header filtering | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Runtime exposure | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::ConfigAnchors` <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> |
| Dashboard token lifecycle | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::LoadConfig` <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig --> |
| Dashboard controls | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
