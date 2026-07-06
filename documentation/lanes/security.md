# Security

## Contents

- [Trust boundaries](#trust-boundaries)
- [Authenticated AI Gateway](#authenticated-ai-gateway)
- [Route authorization](#route-authorization)
- [Rate limiting](#rate-limiting)
- [Token storage](#token-storage)
- [Header filtering](#header-filtering)
- [Runtime safety](#runtime-safety)
- [Admin token storage in the browser](#admin-token-storage-in-the-browser)
- [Mesh secret custody and rotation](#mesh-secret-custody-and-rotation)
- [Mesh egress posture](#mesh-egress-posture)
- [Update trust chain](#update-trust-chain)
- [Access position](#access-position)
- [Cloudflare Access admin authentication](#cloudflare-access-admin-authentication)
- [Role-based console access](#role-based-console-access)
- [Domain and Access provisioning](#domain-and-access-provisioning)
- [Break-glass recovery and host gating](#break-glass-recovery-and-host-gating)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Trust boundaries

**Threat:** A leaked provider, setup, node, upstream, dashboard, admin, recovery, deploy, Cloudflare runtime, or mesh invite credential could be reused across another trust boundary.

**Mitigation:** Each boundary uses a separate credential class with route-specific authorization.

**Verification:** The credential-boundary router test checks cross-family credential rejection; `TestREQNODE004DashboardRuntimeControlsUseController` checks dashboard-token enforcement. <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController -->

**Implements:** [REQ-SEC-001](../../sdd/spec/security.md)

| Boundary | Credential | Purpose | REQs |
| --- | --- | --- | --- |
| Client to AI Gateway | AI Gateway Run token (`cf-aig-authorization`) | Authenticated Gateway rejects requests without a valid AI Gateway token, so the open gateway cannot forward the stored provider key on a stranger's behalf. | [REQ-SEC-012](../../sdd/spec/security.md), [REQ-SEC-001](../../sdd/spec/security.md) |
| AI Gateway to Worker | Provider token | Lets Gateway call router `/v1/*` routes. | [REQ-GWY-002](../../sdd/spec/gateway.md), [REQ-SEC-001](../../sdd/spec/security.md) |
| Admin to Worker | Admin token/session | Protects setup and admin routes after first-run setup completes. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| Recovery to Worker | Admin recovery token | Replaces a lost admin token only on `POST /admin/recovery/reset`; not accepted for normal admin, provider, node, or setup routes. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| Installer to Worker | Setup token | Claims one node once. | [REQ-ADM-003](../../sdd/spec/setup-admin.md) |
| Node to Worker | Node token | Authorizes heartbeat and unregister. | [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-OBS-005](../../sdd/spec/observability.md) |
| Local dashboard to node agent | Dashboard token | Authorizes localhost runtime-control POSTs. | [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-008](../../sdd/spec/security.md) |
| Worker to node | Upstream token | Authorizes Mesh-facing inference proxy. | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| Node to private mesh | Mesh invite token | Admits a node's MeshLLM process to a profile's private mesh; held at rest only as an AES-GCM envelope in D1 under the `MESH_STATE_KEY` Worker secret. | [REQ-SEC-006](../../sdd/spec/security.md) |
| Workflow to Cloudflare | Deploy token | Deploys Worker and migrates D1. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Worker to Cloudflare API | Runtime token | Creates Gateway and optional domain resources. | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |

## Authenticated AI Gateway

**Threat:** The mesh AI Gateway forwards inference to the router using the stored BYOK provider key. If the gateway were open, any caller who learned the gateway URL would reach the router with a valid provider credential already attached, bypassing the router's own bearer check.

**Mitigation:** The Worker provisions the gateway as an Authenticated Gateway (`authentication: true`) and reconciles any gateway created before this to authenticated on the next sync. Provider-native requests to `gateway.ai.cloudflare.com` must then carry a valid AI Gateway token in the `cf-aig-authorization` header; the operator playground sends the Worker's runtime token, and external clients of the route supply their own token created with the `AI Gateway Run` permission. AI Gateway tokens are account-scoped, so isolate tenants with separate Cloudflare accounts rather than per-gateway token scope.

**Verification:** The gateway-provisioning test asserts creation with authentication and reconciliation of an existing open gateway; the playground test asserts the `cf-aig-authorization` header. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CloudflareGatewayClient.ensureGateway --> <!-- @impl: packages/router-worker/src/router.ts::handlePlaygroundChat -->

**Implements:** [REQ-SEC-012](../../sdd/spec/security.md)

## Route authorization

**Threat:** A credential for one actor could call routes intended for another actor.

**Mitigation:** Provider auth applies only to `/v1/models` and `/v1/chat/completions`; node claim, heartbeat, unregister, admin, installer, and health routes use their own policy.

**Verification:** The route-family router test covers public/provider/admin separation, the credential-boundary router test covers REQ-SEC-001 cross-family rejection, and the node-unregister router test covers node authorization. <!-- @impl: packages/router-worker/src/router.test.ts::RouteFamilySeparationTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::NodeUnregisterAuthorizationTestAnchor -->

**Implements:** [REQ-RTR-001](../../sdd/spec/router-worker.md), [REQ-SEC-001](../../sdd/spec/security.md)

## Rate limiting

**Threat:** A single caller could flood a public endpoint — exhausting inference capacity, spamming heartbeats, or grinding setup tokens and admin credentials — before any handler-level authorization runs.

**Mitigation:** Every public route is classified into a rate-limit bucket, each backed by its own Cloudflare rate-limiting binding. The AI Gateway forwards inference from a shared Cloudflare IP, so credentialed `/v1` traffic is metered by a hash of the provider token in a high-ceiling `inference` bucket, while token-less `/v1` hits and every other anonymous caller fall to the low IP-keyed `public` bucket — the production gateway gets far more headroom than a random flood.

Heartbeat, enrollment, admin authentication, and the public catch-all each have their own bucket. A request over its bucket's limit is rejected with `429` and a `Retry-After` header before its handler runs. Token-keyed buckets hash the bearer credential so the raw secret never reaches the rate-limit key store; unauthenticated buckets key by client IP because that is the only stable signal before a credential exists and the correct axis for brute-force protection. Limiting fails open when a binding is unavailable so it cannot itself cause an outage.

**Verification:** The rate-limit unit tests cover bucket classification, per-credential and per-IP keying, and fail-open enforcement; the router integration test confirms a `429` short-circuits before the handler. <!-- @impl: packages/router-worker/src/rate-limit.ts::isRateLimited --> <!-- @impl: packages/router-worker/src/router.ts::createRouter -->

**Implements:** [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting)

## Token storage

**Threat:** Durable plaintext credentials could be recovered from D1 or logs after initial setup.

**Mitigation:** Durable token records are verifier-only by default. Plaintext token display is one-time at creation. The generated Worker-to-node upstream token is recoverable in router config only because the Worker must present it to nodes during forwarding. The dashboard token is node-local config state; legacy configs without it backfill and persist one during load. ([REQ-SEC-005](../../sdd/spec/security.md))

**Verification:** The token-verifier router test asserts verifier-only token records, the upstream-token reuse router test asserts generated upstream-token reuse, the admin-status router test asserts admin status redaction, and `TestREQSEC005LegacyConfigBackfillsDashboardToken` asserts dashboard-token backfill persistence. <!-- @impl: packages/router-worker/src/router.test.ts::TokenVerifierStorageTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::UpstreamTokenReuseTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::AdminStatusRedactionTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQSEC005LegacyConfigBackfillsDashboardToken -->

**Implements:** [REQ-SEC-002](../../sdd/spec/security.md), [REQ-SEC-005](../../sdd/spec/security.md)

## Header filtering

**Threat:** Client, Cloudflare, admin, setup, or node credentials could leak to a local runtime during proxying.

**Mitigation:** The Worker forwards only approved inference metadata and the upstream token to a node. The node proxy strips credentials before forwarding to the local MeshLLM API.

**Verification:** The Worker header-filtering router test and `TestREQNODE003UpstreamProxyEnforcesBearerAndStreams` assert forbidden headers are absent at the next hop. <!-- @impl: packages/router-worker/src/router.test.ts::WorkerHeaderFilteringTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams -->

**Implements:** [REQ-SEC-003](../../sdd/spec/security.md)

## Runtime safety

**Threat:** A local or remote web page could control the node runtime, a Mesh caller could access the local runtime without authorization, or an exposed MeshLLM console could leak the mesh invite token.

**Mitigation:** The managed MeshLLM runtime runs behind the node proxy. The Mesh-facing listener requires the upstream token. The MeshLLM console API (default port `3131`) binds to localhost only and carries the mesh invite token, so it is never exposed or proxied; the agent reads it locally and reports the token only inside authenticated heartbeats. Dashboard runtime controls are localhost-only, require the dashboard token, and reject browser Origin headers that do not match the dashboard origin.

**Verification:** `packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController` asserts dashboard-token enforcement; `packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams` asserts upstream proxy auth and header filtering; `TestREQRUN006PollStatusCapturesTokenAndMeshID` asserts the invite token is captured from the localhost console status poll, never from process stdout. <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams --> <!-- @impl: packages/node-agent/internal/agent/meshllm_manager_test.go::TestREQRUN006PollStatusCapturesTokenAndMeshID -->

**Implements:** [REQ-SEC-004](../../sdd/spec/security.md), [REQ-SEC-008](../../sdd/spec/security.md), [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-RUN-006](../../sdd/spec/runtime-profiles.md)

## Admin token storage in the browser

**Threat:** The admin bearer token is kept in browser `sessionStorage` or `localStorage` (`packages/router-worker/src/admin-ui-client.ts`) rather than an httpOnly cookie, so any JavaScript executing in the Worker's origin — including a future XSS bug in the admin UI — can read and exfiltrate it.

**Mitigation:** The UI stores a token only after `POST /admin/login` verifies it, so mistyped or attacker-suggested tokens are never persisted. The client renders all dynamic content through `textContent`/`createElement` rather than HTML interpolation, and no third-party script is loaded (the only third-party fetch is the JetBrains Mono stylesheet from Google Fonts, which cannot execute script). The admin HTML response sets `content-security-policy: frame-ancestors 'none'` and `x-frame-options: DENY` (`packages/router-worker/src/router.ts::html`), which blocks clickjacking but carries no `script-src`/`default-src` directive, so it does not mitigate script injection into the same origin. A sign-out control clears both storage locations, bounding exposure on a shared browser. Operators who need defense-in-depth against this exposure should front the admin surface with Cloudflare Access after attaching a custom domain (see [SECURITY.md](../../SECURITY.md)).

**Verification:** `packages/router-worker/src/router.test.ts` (`AdminConfigurationUiTestAnchor`) asserts the `content-security-policy` and `x-frame-options` header values on the admin response, and `packages/router-worker/src/admin-ui-mesh.test.ts` (`REQ-ADM-006 verifies the admin token before storing it`) asserts the verify-before-store order against the executed client script, and `packages/router-worker/src/admin-ui-mesh.test.ts` (`REQ-ADM-006 signs out and clears the stored admin token`) asserts sign-out removes the token from both storage locations and returns to the login view; no automated test currently asserts an admin-UI output-encoding boundary, so that narrower gap remains audit pending. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @impl: packages/router-worker/src/router.test.ts::AdminConfigurationUiTestAnchor -->

**Implements:** [REQ-ADM-002](../../sdd/spec/setup-admin.md), [REQ-ADM-006](../../sdd/spec/setup-admin.md)

## Mesh secret custody and rotation

**Threat:** A leaked mesh secret or invite token could admit an attacker's node to the private inference mesh, and an eviction that only stopped token distribution would leave the evicted holder able to rejoin.

**Mitigation:** The router owns mesh secret custody.

- It captures each node's invite token from authenticated heartbeats and stores per-profile mesh state AES-GCM envelope-encrypted in D1 under the `MESH_STATE_KEY` Worker secret (the durable record holds only `{iv, ciphertext}`).
- It distributes join tokens only in heartbeat responses to live, non-revoked nodes on the mesh profile; when the key is absent, mesh rotation and bootstrap fail closed with `mesh_state_key_missing`.
- Rotation increments a per-profile counter baked into the rendered mesh identity (`--mesh-name codeflare-<profileId>-r<rotation>`), so a rotation is a hard cut into a different mesh that every member drains and restarts into.
- Reconvergence within about two minutes is an operational constraint, not an acceptance criterion.
- Eviction is honest about its boundary: revoking a node removes its token entry and excludes it from the new mesh, but a holder of the old secret could still rejoin the old mesh name — which no longer receives traffic.
- Join-level eviction of stale-token holders is upstream MeshLLM's `--trust-policy allowlist` plus `--owner-key` backstop, not managed by this project.
- Node tokens have no in-place rotation: a revoked node regains mesh access only by re-enrolling with a fresh single-use setup token. Admin surfaces show token presence, age, and count — never values.

**Verification:** The mesh-state tests assert ciphertext-only storage, fail-closed behavior on a missing key, live-node-only token distribution, rotate and revoke auditing, and re-enrollment-only readmission; `TestREQRUN006RestartTriggersDrainAndRelaunch` asserts members drain and relaunch on a rotation or mesh-identity change. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @impl: packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS --> <!-- @impl: packages/node-agent/internal/agent/meshllm_manager_test.go::TestREQRUN006RestartTriggersDrainAndRelaunch -->

**Implements:** [REQ-SEC-006](../../sdd/spec/security.md), [REQ-SEC-007](../../sdd/spec/security.md), [REQ-RUN-008](../../sdd/spec/runtime-profiles.md), [REQ-ADM-003](../../sdd/spec/setup-admin.md)

## Mesh egress posture

**Threat:** Mesh discovery or NAT traversal could send mesh traffic to public third-party infrastructure, widening the egress surface beyond the private overlay.

**Mitigation:** Shipped profiles render `--mesh-discovery-mode nostr` for rendezvous (public relays exchange peer identity and WARP Mesh IP only, never inference) and pin iroh's encrypted data transport to the WARP overlay with `--bind-ip <MeshIP>` + `--disable-iroh-relays` (no public relay/STUN fallback), so inference traffic is unicast between WARP addresses only. A Cloudflare Gateway network policy blocking any non-`100.96.0.0/12` iroh/QUIC egress is the network-layer backstop, and operators may point `--nostr-relay` at a private relay. The renderer never emits `--publish`, `--listen-all`, `--auto`, or `--discover`.

**Verification:** `TestREQRUN003RendererForbidsPublicDiscoveryFlags` asserts public discovery flags are never rendered; `TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses` asserts tokens embed the WARP bind address. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render_test.go::TestREQRUN003RendererForbidsPublicDiscoveryFlags --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render_test.go::TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses -->

**Implements:** [REQ-RUN-006](../../sdd/spec/runtime-profiles.md), [REQ-SEC-004](../../sdd/spec/security.md)

## Update trust chain

**Threat:** A compromised release channel could push a malicious agent binary to the fleet through self-update.

**Mitigation:** The trust anchor for agent updates is the GitHub repository and its release process, with an operator in the loop: the desired agent version is only ever an admin-selected tag from the validated release list, distributed via heartbeat, and the agent stages a downloaded binary only after its SHA-256 matches the release's `checksums.txt`; any failure leaves the current version running. The MeshLLM runtime binary uses a stronger pin — its per-asset checksums are embedded in the agent at build time, so a compromised MeshLLM release cannot affect nodes. The deploy pipeline additionally signs `checksums.txt` with cosign when `COSIGN_PRIVATE_KEY` is configured; the signature is an out-of-band operator verification artifact, and the agent does not verify it during self-update.

**Verification:** `TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches` asserts checksum-gated staging; `TestREQNODE009FailureReportsLastErrorAndKeepsCurrentVersion` asserts failed updates leave the running version; the agent-version selection tests assert only listed release tags are accepted. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches --> <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS -->

**Implements:** [REQ-NODE-005](../../sdd/spec/node-agent.md), [REQ-NODE-009](../../sdd/spec/node-agent.md), [REQ-NODE-006](../../sdd/spec/node-agent.md), [REQ-REL-003](../../sdd/spec/release-ci.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md)

## Access position

**Threat:** Admin UI exposure could exceed the intended bootstrap/admin boundary.

**Mitigation:** The Admin UI shell is public so first-run setup works on the bootstrap origin, but state-changing admin actions require admin authentication. Before Cloudflare Access is provisioned, admin routes accept the bootstrap admin bearer token (or a session derived from it). Once the setup wizard provisions Access, the Worker verifies the Access JWT for every human admin request via `requireAdmin` in `packages/router-worker/src/router.ts`; bearer credentials work only before Access exists or during an active break-glass window. See [AD-013](../decisions/README.md#ad-013-cloudflare-access-is-the-human-admin-entrance). A rejected admin request returns the same 401 status and error body whether or not first-run setup has completed, so a failed-auth probe cannot fingerprint deployment state.

**Verification:** The first-run setup router test asserts setup token generation and claim, the admin-status router test asserts admin-only status, the credential-boundary router test asserts credential-class separation, and the setup-state-nondisclosure router test asserts an identical 401 response both before and after setup completes. <!-- @impl: packages/router-worker/src/router.test.ts::FirstRunSetupTokenTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::AdminStatusRedactionTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::SetupStateNondisclosureTestAnchor -->

**Implements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md), [REQ-ADM-002](../../sdd/spec/setup-admin.md), [REQ-ADM-006](../../sdd/spec/setup-admin.md), [REQ-SEC-009](../../sdd/spec/security.md), [REQ-ADM-013](../../sdd/spec/setup-admin.md)

## Cloudflare Access admin authentication

**Threat:** A long-lived human admin token on a public hostname can leak and grants full control-plane access.

**Mitigation:** Human admin identity comes from the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie), verified in the Worker against the team's published keys with audience, issuer, and validity-window checks. Keys are cached for an hour with an unknown-key-id refresh. A present-but-invalid JWT is rejected outright — it never falls back to bearer auth — and the verified email becomes the audit actor. <!-- @impl: packages/router-worker/src/access.ts::verifyAccessRequest -->

**Verification:** The access test suite signs real RS256 JWTs and asserts acceptance, audience/issuer/expiry rejection, cache behavior, and the present-versus-absent distinction; router tests assert bearer-only requests fail once Access config exists. <!-- @impl: packages/router-worker/src/access.test.ts::AccessJwtTestAnchor -->

**Implements:** [REQ-SEC-009](../../sdd/spec/security.md)

## Role-based console access

**Threat:** A single admin-only entrance forces every viewer to hold full control-plane privileges, and a client-only role check can be bypassed by calling the endpoints directly.

**Mitigation:** Once Access is configured, the Worker maps each verified caller to a console role. Admin and user identity sets (Access group names and emails) are captured at setup and stored durably. On each request `resolveRole` compares the caller's email and live Access groups (from `get-identity`, restricted to the team's `cloudflareaccess.com` domain to prevent SSRF) against those sets: admin wins over user, a user-only match is read-only, any verified identity is a read-only user when no user set is configured, and an identity matching neither set is refused when a user set exists. <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> <!-- @impl: packages/router-worker/src/access.ts::fetchIdentityGroups -->

The role is enforced server-side: `requireAdmin` gates every configuration write, so client-side hiding is convenience, not control. <!-- @impl: packages/router-worker/src/router.ts::requireAdmin -->

**Verification:** Router tests assert admin/user/deny resolution, admin-wins-on-overlap, the open-to-everyone default, and that the user role is refused on a config write; access tests assert the get-identity group lookup and its domain guard. <!-- @impl: packages/router-worker/src/router.test.ts::HostGatingTestAnchor --> <!-- @impl: packages/router-worker/src/access.test.ts::AccessIdentityGroupsTestAnchor -->

**Implements:** [REQ-SEC-010](../../sdd/spec/security.md), [REQ-ADM-017](../../sdd/spec/setup-admin.md)

## Domain and Access provisioning

**Threat:** Hand-assembled Zero Trust policies can leave the console exposed or machine paths blocked.

**Mitigation:** The setup wizard provisions the Access application with an allow policy gating on the captured roles: admin and user emails become managed Access groups (`<worker>-admins` / `<worker>-users`) and the policy includes those plus any operator-named admin/user groups; when no user set is configured the policy opens to everyone so the mesh's own role check grants read-only access. A separate bypass application covers the provider, node, health, and installer paths so machine traffic needs no Access session. If the bypass policy cannot be created, the bypass application is removed rather than left policy-less (deny-all). Re-runs update the managed applications and groups instead of duplicating them. <!-- @impl: packages/router-worker/src/access-provisioning.ts::CloudflareAccessClient.provisionAccess -->

**Verification:** Provisioning tests assert the managed-group creation, the group-gated and everyone-open policy payloads, the bypass destinations, rollback on policy failure, and idempotent re-runs. <!-- @impl: packages/router-worker/src/access-provisioning.test.ts::AccessProvisioningTestAnchor -->

**Implements:** [REQ-ADM-012](../../sdd/spec/setup-admin.md)

## Break-glass recovery and host gating

**Threat:** An operator locked out of the Access-gated custom domain has no way back in; a live bootstrap origin after handoff doubles the admin attack surface.

**Mitigation:** After setup completes, non-custom-domain hostnames serve only a console-moved page and refuse provider/node routes; the custom domain is the single gate for humans and machines. Recovery requires Cloudflare account control: `wrangler secret put SETUP_REOPEN` reopens the bootstrap admin surface until the secret value is recorded as consumed, and entering and completing recovery are both audited. <!-- @impl: packages/router-worker/src/router.ts::resolveHostGate --> <!-- @impl: packages/router-worker/src/setup-state.ts::breakGlassActive -->

**Verification:** Router tests assert the moved page, machine-route refusal, recovery reopening, single entry audit, and consumption closing the surface. <!-- @impl: packages/router-worker/src/router.test.ts::HostGatingTestAnchor -->

**Implements:** [REQ-ADM-013](../../sdd/spec/setup-admin.md), [REQ-ADM-014](../../sdd/spec/setup-admin.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Credential classes | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/auth.ts::AUTH_ANCHORS` <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> |
| Access JWT verification | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/access.ts::ACCESS_ANCHORS` <!-- @impl: packages/router-worker/src/access.ts::ACCESS_ANCHORS --> |
| Access provisioning | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/access-provisioning.ts::ACCESS_PROVISIONING_ANCHORS` <!-- @impl: packages/router-worker/src/access-provisioning.ts::ACCESS_PROVISIONING_ANCHORS --> |
| Console role resolution | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/router.ts::resolveRole` <!-- @impl: packages/router-worker/src/router.ts::resolveRole --> |
| Setup phases and break-glass | [setup-admin.md](../../sdd/spec/setup-admin.md) | `packages/router-worker/src/setup-state.ts::SETUP_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/setup-state.ts::SETUP_STATE_ANCHORS --> |
| Header filtering | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Runtime exposure | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::ConfigAnchors` <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> |
| Dashboard token lifecycle | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::LoadConfig` <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig --> |
| Dashboard controls | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
| Mesh token lifecycle | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Mesh state encryption | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS --> |
| Mesh argv egress posture | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs` <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> |
