# Security

## Contents

- [Trust boundaries](#trust-boundaries)
- [Route authorization](#route-authorization)
- [Token storage](#token-storage)
- [Header filtering](#header-filtering)
- [Runtime safety](#runtime-safety)
- [Mesh secret custody and rotation](#mesh-secret-custody-and-rotation)
- [Mesh egress posture](#mesh-egress-posture)
- [Update trust chain](#update-trust-chain)
- [Access position](#access-position)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Trust boundaries

**Threat:** A leaked provider, setup, node, upstream, dashboard, admin, recovery, deploy, Cloudflare runtime, or mesh invite credential could be reused across another trust boundary.

**Mitigation:** Each boundary uses a separate credential class with route-specific authorization.

**Verification:** The credential-boundary router test checks cross-family credential rejection; `TestREQNODE004DashboardRuntimeControlsUseController` checks dashboard-token enforcement. <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController -->

**Implements:** [REQ-SEC-001](../../sdd/spec/security.md)

| Boundary | Credential | Purpose | REQs |
| --- | --- | --- | --- |
| Client to AI Gateway | Gateway auth token | Lets clients call the selected Gateway. | [REQ-SEC-001](../../sdd/spec/security.md) |
| AI Gateway to Worker | Provider token | Lets Gateway call router `/v1/*` routes. | [REQ-GWY-002](../../sdd/spec/gateway.md), [REQ-SEC-001](../../sdd/spec/security.md) |
| Admin to Worker | Admin token/session | Protects setup and admin routes after first-run setup completes. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| Recovery to Worker | Admin recovery token | Replaces a lost admin token only on `POST /admin/recovery/reset`; not accepted for normal admin, provider, node, or setup routes. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| Installer to Worker | Setup token | Claims one node once. | [REQ-ADM-003](../../sdd/spec/setup-admin.md) |
| Node to Worker | Node token | Authorizes heartbeat and unregister. | [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-OBS-005](../../sdd/spec/observability.md) |
| Local dashboard to node agent | Dashboard token | Authorizes localhost runtime-control POSTs. | [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md) |
| Worker to node | Upstream token | Authorizes Mesh-facing inference proxy. | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| Node to private mesh | Mesh invite token | Admits a node's MeshLLM process to a profile's private mesh; held at rest only as an AES-GCM envelope in D1 under the `MESH_STATE_KEY` Worker secret. | [REQ-SEC-006](../../sdd/spec/security.md) |
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

**Mitigation:** The Worker forwards only approved inference metadata and the upstream token to a node. The node proxy strips credentials before forwarding to the local MeshLLM API.

**Verification:** The Worker header-filtering router test and `TestREQNODE003UpstreamProxyEnforcesBearerAndStreams` assert forbidden headers are absent at the next hop. <!-- @impl: packages/router-worker/src/router.test.ts::WorkerHeaderFilteringTestAnchor --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams -->

**Implements:** [REQ-SEC-003](../../sdd/spec/security.md)

## Runtime safety

**Threat:** A local or remote web page could control the node runtime, a Mesh caller could access the local runtime without authorization, or an exposed MeshLLM console could leak the mesh invite token.

**Mitigation:** The managed MeshLLM runtime runs behind the node proxy. The Mesh-facing listener requires the upstream token. The MeshLLM console API (default port `3131`) binds to localhost only and carries the mesh invite token, so it is never exposed or proxied; the agent reads it locally and reports the token only inside authenticated heartbeats. Dashboard runtime controls are localhost-only, require the dashboard token, and reject browser Origin headers that do not match the dashboard origin.

**Verification:** `packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController` asserts dashboard-token enforcement; `packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams` asserts upstream proxy auth and header filtering; `TestREQRUN006PollStatusCapturesTokenAndMeshID` asserts the invite token is captured from the localhost console status poll, never from process stdout. <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE004DashboardRuntimeControlsUseController --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE003UpstreamProxyEnforcesBearerAndStreams --> <!-- @impl: packages/node-agent/internal/agent/meshllm_manager_test.go::TestREQRUN006PollStatusCapturesTokenAndMeshID -->

**Implements:** [REQ-SEC-004](../../sdd/spec/security.md), [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-006](../../sdd/spec/security.md)

## Mesh secret custody and rotation

**Threat:** A leaked mesh secret or invite token could admit an attacker's node to the private inference mesh, and an eviction that only stopped token distribution would leave the evicted holder able to rejoin.

**Mitigation:** The router owns mesh secret custody. It captures each node's invite token from authenticated heartbeats, stores per-profile mesh state AES-GCM envelope-encrypted in D1 under the `MESH_STATE_KEY` Worker secret (the durable record holds only `{iv, ciphertext}`), and distributes join tokens only in heartbeat responses to live, non-revoked nodes on the mesh profile; when the key is absent, mesh rotation and bootstrap fail closed with `mesh_state_key_missing`. Rotation increments a per-profile counter that is baked into the rendered mesh identity (`--mesh-name codeflare-<profileId>-r<rotation>`), so a rotation is a hard cut into a different mesh that every member drains and restarts into; reconvergence within about two minutes is an operational constraint, not an acceptance criterion. Eviction is honest about its boundary: revoking a node removes its token entry, and rotation excludes it from the new mesh, but a malicious holder of the old secret could still rejoin the old mesh name — which no longer receives traffic. Join-level eviction of stale-token holders is upstream MeshLLM's `--trust-policy allowlist` plus `--owner-key` backstop, not managed by this project. Node tokens have no in-place rotation: a revoked node regains mesh access only by re-enrolling with a fresh single-use setup token. Admin surfaces show token presence, age, and count — never values.

**Verification:** The mesh-state tests assert ciphertext-only storage, fail-closed behavior on a missing key, live-node-only token distribution, rotate and revoke auditing, and re-enrollment-only readmission; `TestREQRUN006RestartTriggersDrainAndRelaunch` asserts members drain and relaunch on a rotation or mesh-identity change. <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @impl: packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS --> <!-- @impl: packages/node-agent/internal/agent/meshllm_manager_test.go::TestREQRUN006RestartTriggersDrainAndRelaunch -->

**Implements:** [REQ-SEC-006](../../sdd/spec/security.md), [REQ-ADM-003](../../sdd/spec/setup-admin.md)

## Mesh egress posture

**Threat:** Mesh discovery or NAT traversal could send mesh traffic to public third-party infrastructure, widening the egress surface beyond the private overlay.

**Mitigation:** Shipped profiles render `--mesh-discovery-mode mdns`, which suppresses all public discovery and relay egress — no Nostr relays, no iroh relay, no STUN. Joins are token-direct: each invite token embeds its owner's WARP IP and mesh bind port, so mesh traffic is unicast UDP between WARP addresses only. The renderer never emits `--publish`, `--listen-all`, `--auto`, `--discover`, or `--mesh-discovery-mode nostr`.

**Verification:** `TestREQRUN003RendererForbidsPublicDiscoveryFlags` asserts public discovery flags are never rendered; `TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses` asserts tokens embed the WARP bind address. <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render_test.go::TestREQRUN003RendererForbidsPublicDiscoveryFlags --> <!-- @impl: packages/node-agent/internal/agent/meshllm_render_test.go::TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses -->

**Implements:** [REQ-RUN-006](../../sdd/spec/runtime-profiles.md), [REQ-SEC-004](../../sdd/spec/security.md)

## Update trust chain

**Threat:** A compromised release channel could push a malicious agent binary to the fleet through self-update.

**Mitigation:** The trust anchor for agent updates is the GitHub repository and its release process, with an operator in the loop: the desired agent version is only ever an admin-selected tag from the validated release list, distributed via heartbeat, and the agent stages a downloaded binary only after its SHA-256 matches the release's `checksums.txt`; any failure leaves the current version running. The MeshLLM runtime binary uses a stronger pin — its per-asset checksums are embedded in the agent at build time, so a compromised MeshLLM release cannot affect nodes. The deploy pipeline additionally signs `checksums.txt` with cosign when `COSIGN_PRIVATE_KEY` is configured; the signature is an out-of-band operator verification artifact, and the agent does not verify it during self-update.

**Verification:** `TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches` asserts checksum-gated staging; `TestREQNODE005FailureReportsLastErrorAndKeepsCurrentVersion` asserts failed updates leave the running version; the agent-version selection tests assert only listed release tags are accepted. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @impl: packages/node-agent/internal/agent/agent_test.go::TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches --> <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS -->

**Implements:** [REQ-NODE-005](../../sdd/spec/node-agent.md), [REQ-NODE-006](../../sdd/spec/node-agent.md), [REQ-REL-003](../../sdd/spec/release-ci.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md)

## Access position

**Threat:** Admin UI exposure could exceed the intended bootstrap/admin boundary.

**Mitigation:** The Admin UI shell is public so first-run setup works on `workers.dev`, but state-changing admin actions require admin bearer authentication after setup completes. First-run setup is intentionally open only until setup completes; after an active admin token exists, setup/admin routes require admin auth. Cloudflare Access is an optional hardening layer after a custom domain exists.

**Verification:** The first-run setup router test asserts setup token generation and claim, the admin-status router test asserts admin-only status, and the credential-boundary router test asserts credential-class separation. <!-- @impl: packages/router-worker/src/router.test.ts::FirstRunSetupTokenTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::AdminStatusRedactionTestAnchor --> <!-- @impl: packages/router-worker/src/router.test.ts::CredentialBoundaryTestAnchor -->

**Implements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md), [REQ-ADM-002](../../sdd/spec/setup-admin.md), [REQ-ADM-006](../../sdd/spec/setup-admin.md)

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Credential classes | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/auth.ts::AUTH_ANCHORS` <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> |
| Header filtering | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Runtime exposure | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::ConfigAnchors` <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> |
| Dashboard token lifecycle | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::LoadConfig` <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig --> |
| Dashboard controls | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/dashboard.go::DashboardAnchors` <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> |
| Mesh token lifecycle | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Mesh state encryption | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-crypto.ts::MESH_CRYPTO_ANCHORS --> |
| Mesh argv egress posture | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs` <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> |
