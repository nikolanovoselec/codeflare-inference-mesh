# Architecture Decisions

This ledger records binding technical choices for the first implementation. It is not a bug log or implementation diary.

## ADR index

| ID | Status | Decision | Related requirements |
| --- | --- | --- | --- |
| [AD-001](#ad-001-cloudflare-router-plane) | Accepted | Use Cloudflare Workers, AI Gateway, Workers VPC, Mesh, D1, and Durable Objects for the router plane. | [REQ-GWY-001](../../sdd/spec/gateway.md#req-gwy-001-gateway-custom-provider), [REQ-RTR-002](../../sdd/spec/router-worker.md#req-rtr-002-chat-completion-forwarding), [REQ-SCH-001](../../sdd/spec/state-scheduling.md#req-sch-001-durable-router-state) |
| [AD-002](#ad-002-app-level-bearer-token-auth-first) | Superseded by AD-013 | Use app-level bearer-token classes instead of Cloudflare Access as the MVP auth spine. | [REQ-SEC-001](../../sdd/spec/security.md#req-sec-001-credential-boundaries), [REQ-ADM-002](../../sdd/spec/setup-admin.md#req-adm-002-admin-authentication) |
| [AD-003](#ad-003-d1-plus-durable-object-scheduler) | Accepted | Use D1 for durable truth and a Durable Object for live scheduling. | [REQ-SCH-001](../../sdd/spec/state-scheduling.md#req-sch-001-durable-router-state), [REQ-SCH-002](../../sdd/spec/state-scheduling.md#req-sch-002-node-reservations) |
| [AD-004](#ad-004-go-service-with-localhost-ui) | Accepted | Use Go for the node agent and a localhost web UI instead of a native desktop shell. | [REQ-NODE-001](../../sdd/spec/node-agent.md#req-node-001-cross-platform-service), [REQ-NODE-004](../../sdd/spec/node-agent.md#req-node-004-local-dashboard) |
| [AD-005](#ad-005-llamacpp-first-runtime) | Superseded by AD-012 | Use `llama-server` as the first managed runtime. | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-meshllm-runtime) |
| [AD-006](#ad-006-default-model-profile-set) | Superseded by AD-012 | Make Qwen3.6 27B the primary `mesh-default` profile, Gemma 4 26B-A4B the fallback benchmark profile, and a small smoke-test profile available. | [REQ-RUN-002](../../sdd/spec/runtime-profiles.md#req-run-002-default-model-profiles) |
| [AD-007](#ad-007-gateway-route-automation-with-manual-byok) | Accepted | Automate Gateway provider and dynamic route creation, but keep BYOK/provider-key entry manual in v1. | [REQ-GWY-002](../../sdd/spec/gateway.md#req-gwy-002-provider-token-contract), [REQ-GWY-003](../../sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation) |
| [AD-008](#ad-008-node-listener-binding-policy) | Accepted | Bind the node listener to Mesh IP when possible and allow `0.0.0.0` fallback only with strict token auth. | [REQ-NODE-001](../../sdd/spec/node-agent.md#req-node-001-cross-platform-service), [REQ-RTR-004](../../sdd/spec/router-worker.md#req-rtr-004-mesh-destination-safety) |
| [AD-009](#ad-009-best-effort-hardware-metrics-first) | Accepted | Start hardware metrics with best-effort platform probes rather than native GPU libraries. | [REQ-OBS-009](../../sdd/spec/observability.md#req-obs-009-hardware-and-throughput-metrics) |
| [AD-010](#ad-010-public-release-artifacts-after-mesh-proof) | Accepted | Publish public GitHub Release artifacts for installers and update staging after the first Worker path is proven. | [REQ-REL-003](../../sdd/spec/release-ci.md#req-rel-003-node-agent-release-artifacts), [REQ-NODE-005](../../sdd/spec/node-agent.md#req-node-005-agent-update-staging) |
| [AD-011](#ad-011-first-run-setup-is-the-one-time-bootstrap-gate) | Accepted | Keep first-run setup open until completed; do not require a separate initial setup token. | [REQ-ADM-001](../../sdd/spec/setup-admin.md#req-adm-001-first-run-setup), [REQ-ADM-002](../../sdd/spec/setup-admin.md#req-adm-002-admin-authentication) |
| [AD-012](#ad-012-meshllm-only-private-inference-backend) | Accepted | Remove llama.cpp from the product contract; the agent installs and supervises a pinned `mesh-llm` as the only runtime, with router-owned private-mesh membership and private-only shipped profiles. | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-meshllm-runtime), [REQ-RUN-006](../../sdd/spec/runtime-profiles.md#req-run-006-private-mesh-formation), [REQ-RUN-008](../../sdd/spec/runtime-profiles.md#req-run-008-router-mesh-membership-authority), [REQ-NODE-006](../../sdd/spec/node-agent.md#req-node-006-meshllm-binary-install-and-update), [REQ-SEC-006](../../sdd/spec/security.md#req-sec-006-mesh-token-lifecycle) |
| [AD-013](#ad-013-cloudflare-access-is-the-human-admin-entrance) | Accepted | Gate human admin access with Cloudflare Access on the operator's custom domain; bearer tokens remain machine-and-recovery-only and the bootstrap origin locks after handoff. | [REQ-SEC-009](../../sdd/spec/security.md#req-sec-009-cloudflare-access-admin-authentication), [REQ-SEC-010](../../sdd/spec/security.md#req-sec-010-role-based-console-access), [REQ-ADM-012](../../sdd/spec/setup-admin.md#req-adm-012-domain-and-access-provisioning), [REQ-ADM-013](../../sdd/spec/setup-admin.md#req-adm-013-break-glass-recovery), [REQ-ADM-014](../../sdd/spec/setup-admin.md#req-adm-014-host-gating-and-console-lock) |

## AD-013: Cloudflare Access is the human admin entrance

**Status:** Accepted

**Context:** AD-002 chose bearer-token classes over Cloudflare Access for the MVP so Gateway and node traffic needed no Zero Trust wiring. That left humans managing a long-lived admin token on a public `workers.dev` URL. Cloudflare Access provides email One-time PIN login with zero identity-provider setup, and the sibling codeflare product already runs wizard-provisioned Access applications with machine-path bypass policies in production. <!-- @impl: packages/router-worker/src/access.ts::verifyAccessRequest -->

**Decision:** The setup wizard provisions the custom domain, an Access application whose allow policy gates on the admin and user identity sets captured at setup (Access groups and emails; open to everyone as read-only when no user set is configured), and bypass coverage for machine paths. After handoff the Worker verifies the Access JWT for every human admin request and maps each verified caller to an `admin` or read-only `user` console role, the bootstrap origin serves only a moved page, and machine traffic rides the custom domain through the bypass. Bearer admin credentials survive only for bootstrap and wrangler-secret break-glass recovery; provider, node, setup, and upstream token classes are unchanged.

**Alternatives considered:** Keeping permanent token sign-in on `workers.dev` beside an Access-gated custom domain (two auth models to maintain); wizard-configured identity providers (more wizard API surface for what the Zero Trust dashboard already does); machine paths on both hostnames (two permanent hostnames with diverging roles).

**Rationale:** Access removes the human-managed secret entirely, One-time PIN works on any Cloudflare account without IdP configuration, and a single custom-domain gate for humans and machines keeps the mental model — and the enroll commands — to one hostname.

**Consequences:** AD-002 is superseded for human auth; its bearer-token classes remain the machine spine. The wizard gains domain and Access steps before Gateway configuration, the Worker gains JWT verification and host gating, and lockout recovery becomes a documented `wrangler secret put` runbook instead of a memorized credential.

**Related requirements:** [REQ-SEC-009](../../sdd/spec/security.md), [REQ-SEC-010](../../sdd/spec/security.md), [REQ-ADM-002](../../sdd/spec/setup-admin.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-012](../../sdd/spec/setup-admin.md), [REQ-ADM-013](../../sdd/spec/setup-admin.md), [REQ-ADM-014](../../sdd/spec/setup-admin.md)

## AD-012: MeshLLM-only private inference backend

**Status:** Accepted

**Context:** The llama.cpp path required an operator-installed CUDA `llama-server` on every node and bound each node to one loaded model process. MeshLLM is a supervisable Apache-2.0 Rust binary with an OpenAI-compatible API, invite-token private meshes that run over WARP CGNAT unicast, and Skippy split serving across nodes. AD-006 had also drifted: it names Qwen3.6 27B and Gemma 4 profiles while the shipped defaults were already Qwen3.6-35B. <!-- @impl: packages/node-agent/internal/agent/meshllm_manager.go::MeshLLMManager -->

**Decision:** Remove llama.cpp from the product contract entirely. The agent installs and supervises a pinned `mesh-llm` as the only managed runtime. Mesh membership is router-owned: the invite-token set, AES-GCM-encrypted mesh state, and a rotation counter live in the Worker. Shipped profiles are private-only with zero public discovery, publishing, Nostr, or relay/STUN egress. Fleet agent versions are router-driven.

**Alternatives considered:** Keeping llama.cpp as a fallback runtime; a dual-runtime adapter layer. Both rejected — the plan removes llama.cpp rather than keeping it beside MeshLLM.

**Rationale:** One supervised binary removes the operator-installed CUDA prerequisite and the one-model-per-node limit, the OpenAI-compatible API keeps the proxy and Gateway path unchanged, and invite-token private meshes fit the existing WARP overlay.

**Consequences:** Profile schema, eligibility, heartbeat metrics, dashboards, and installers move to MeshLLM semantics in one coupled spec, test, and doc change. AD-005 and AD-006 are superseded. The mesh invite token becomes a new stored credential class. The darwin/amd64 agent lane is dropped.

**Related requirements:** [REQ-RUN-003](../../sdd/spec/runtime-profiles.md), [REQ-RUN-006](../../sdd/spec/runtime-profiles.md), [REQ-RUN-008](../../sdd/spec/runtime-profiles.md), [REQ-RUN-007](../../sdd/spec/runtime-profiles.md), [REQ-NODE-006](../../sdd/spec/node-agent.md), [REQ-SEC-006](../../sdd/spec/security.md), [REQ-REL-003](../../sdd/spec/release-ci.md)

## AD-011: First-run setup is the one-time bootstrap gate

**Status:** Accepted

**Context:** The router is deployed to a controlled Worker during initial setup. Before setup is complete there is no durable admin credential yet; after setup completes, admin auth and optional Cloudflare Access protect the control plane. <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS -->

**Decision:** First-run `/admin/setup` stays open until the initial admin configuration completes. Do not add a separate `INITIAL_SETUP_TOKEN`, pre-admin setup token, or equivalent extra gate for this one-time bootstrap path.

**Alternatives considered:** Requiring a configured initial setup token before first-run setup.

**Rationale:** A separate initial setup token adds operator friction and another secret without improving the intended controlled bootstrap flow. The real boundary is completing setup quickly, storing only verifiers, then requiring admin authentication and optional Access hardening.

**Consequences:** Setup must generate credentials exactly once, store setup-complete state, and require admin auth after an active admin token exists. Future changes must not reintroduce a pre-admin setup-token gate.

**Related requirements:** [REQ-ADM-001](../../sdd/spec/setup-admin.md), [REQ-ADM-002](../../sdd/spec/setup-admin.md)

## AD-001: Cloudflare router plane

**Status:** Accepted

**Context:** The product needs one public provider endpoint while local nodes stay private. Cloudflare documents Workers VPC Mesh bindings with `network_id: "cf1:network"`, and AI Gateway custom providers require an HTTPS upstream origin. <!-- @impl: packages/router-worker/src/index.ts::INDEX_ANCHORS -->

**Decision:** The router plane uses AI Gateway custom provider and dynamic route, a public Cloudflare Worker, Workers VPC bound to Cloudflare Mesh, D1, and a Durable Object scheduler.

**Alternatives considered:** Per-node Tunnel hostnames; AI Gateway direct-to-node providers; a non-Cloudflare public API server.

**Rationale:** This keeps the public surface small and lets the Worker reach Mesh IPs without registering one service binding per node.

**Consequences:** The first validation gate is Worker-to-Mesh fetch before installers, model download, or multi-node scheduling.

**Related requirements:** [REQ-GWY-001](../../sdd/spec/gateway.md), [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-SCH-001](../../sdd/spec/state-scheduling.md)

## AD-002: App-level bearer-token auth first

**Status:** Superseded by AD-013 (human auth only — bearer-token classes remain the machine-auth spine)

**Context:** Gateway, admin UI, setup flow, node heartbeat, and Worker-to-node calls have different trust boundaries. <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS -->

**Decision:** MVP auth uses separate app-level bearer-token classes. Cloudflare Access was optional admin hardening after a custom domain existed; [AD-013](#ad-013-cloudflare-access-is-the-human-admin-entrance) supersedes this for human admin auth, making Access mandatory once provisioned.

**Alternatives considered:** One shared token; Cloudflare Access as mandatory primary auth; mTLS between Worker and nodes.

**Rationale:** Separate tokens constrain blast radius and avoid forcing Gateway and node agents through Access service-token headers in the first version.

**Consequences:** The implementation must keep route-family auth strict and never reuse credentials across boundaries.

**Related requirements:** [REQ-SEC-001](../../sdd/spec/security.md), [REQ-ADM-002](../../sdd/spec/setup-admin.md)

## AD-003: D1 plus Durable Object scheduler

**Status:** Accepted

**Context:** Durable state must survive Worker restarts, but live reservations need serialized updates. <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS -->

**Decision:** D1 stores durable truth. A Durable Object owns live scheduling, reservations, leases, and sticky sessions.

**Alternatives considered:** D1-only scheduling; KV; R2; in-memory Worker state only.

**Rationale:** D1 is durable and inspectable, while Durable Objects prevent concurrent isolates from overbooking one node.

**Consequences:** Scheduler state must be rebuildable from D1 after eviction or deploy.

**Related requirements:** [REQ-SCH-001](../../sdd/spec/state-scheduling.md), [REQ-SCH-002](../../sdd/spec/state-scheduling.md)

## AD-004: Go service with localhost UI

**Status:** Accepted

**Context:** The node must run on Windows, macOS, Linux, and headless hosts. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors -->

**Decision:** The node agent is a Go service with an embedded localhost web UI.

**Alternatives considered:** Electron; Tauri; Wails; platform-native apps.

**Rationale:** One service binary is easier to package across OSes and works on headless Linux.

**Consequences:** UI polish is web-based, and OS-specific service integration lives behind Go packages.

**Related requirements:** [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-004](../../sdd/spec/node-agent.md)

## AD-005: llama.cpp first runtime

**Status:** Superseded by AD-012

**Context:** The first runtime must work across Windows, macOS, and Linux and expose OpenAI-compatible chat endpoints. <!-- @impl: packages/node-agent/internal/agent/runtime.go::RuntimeAnchors -->

**Decision:** Use `llama-server` as the first managed runtime.

**Alternatives considered:** Ollama; LM Studio; vLLM as default.

**Rationale:** `llama-server` is cross-platform, exposes OpenAI-compatible endpoints, and provides direct control over long-context and KV-cache flags.

**Consequences:** Other runtimes are adapter work after the Mesh and llama.cpp path works.

**Related requirements:** [REQ-RUN-003](../../sdd/spec/runtime-profiles.md)

## AD-006: Default model profile set

**Status:** Superseded by AD-012

**Context:** The original plan had an open question about whether `mesh-default` should start with Qwen, Gemma, or a smoke-test profile. <!-- @impl: packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES -->

**Decision:** `mesh-default` initially targets Qwen3.6 27B for serious coding validation. Gemma 4 26B-A4B is the fallback benchmark profile. A small 32K smoke-test profile exists for fast validation.

**Alternatives considered:** Gemma 4 as primary; smoke-test profile as the only initial default.

**Rationale:** Qwen3.6 27B is documented as a coding-focused long-context model, while Gemma 4 provides a useful comparable fallback.

**Consequences:** Hardware validation must prove the 27B profile on target nodes before claiming production readiness.

**Related requirements:** [REQ-RUN-002](../../sdd/spec/runtime-profiles.md)

## AD-007: Gateway route automation with manual BYOK

**Status:** Accepted

**Context:** The setup flow should avoid manual route construction, but automatic provider-key storage requires Secrets Store permissions. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::CLOUDFLARE_API_ANCHORS -->

**Decision:** The Worker setup UI creates or updates the custom provider and the dynamic route, with the route's routing elements set inline so the same call yields its version and deployment; re-running sync reuses the existing provider and route without creating a new version or deployment. The Admin manually enters the generated provider token into AI Gateway BYOK/provider-key settings in v1.

**Alternatives considered:** Manual route instructions only; full BYOK automation through Secrets Store.

**Rationale:** Route automation removes tedious setup while avoiding extra Secrets Store permissions for the first implementation.

**Consequences:** Setup UI must clearly show the provider token once and verify the header shape after manual entry.

**Related requirements:** [REQ-GWY-002](../../sdd/spec/gateway.md), [REQ-GWY-003](../../sdd/spec/gateway.md)

## AD-008: Node listener binding policy

**Status:** Accepted

**Context:** Binding directly to a Mesh IP is safest but can be unreliable across operating systems. <!-- @impl: packages/node-agent/internal/agent/config.go::ListenerAddress -->

**Decision:** The agent prefers Mesh IP binding. It may fall back to `0.0.0.0` only with strict upstream bearer-token auth and a firewall warning.

**Alternatives considered:** Require Mesh IP binding always; bind `0.0.0.0` by default.

**Rationale:** The fallback keeps setup practical while token auth and warnings prevent silent widening of access.

**Consequences:** Admin status and local dashboard must expose binding mode and firewall warning state.

**Related requirements:** [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-RTR-004](../../sdd/spec/router-worker.md)

## AD-009: Best-effort hardware metrics first

**Status:** Accepted

**Context:** Hardware metrics are useful but platform libraries add packaging and permissions complexity. <!-- @impl: packages/node-agent/internal/agent/metrics.go::ParseNvidiaSMI -->

**Decision:** Start with best-effort platform probes such as `nvidia-smi` where available, and report absent metrics when unsupported.

**Alternatives considered:** Native GPU libraries from the first release; no hardware metrics.

**Rationale:** Best-effort probes give useful scheduling and UI signals without delaying the core transport path.

**Consequences:** Metrics must never be fabricated, and scheduling must tolerate missing GPU metrics.

**Related requirements:** [REQ-OBS-009](../../sdd/spec/observability.md)

## AD-010: Public release artifacts after Mesh proof

**Status:** Accepted

**Context:** Installers and update staging need downloadable artifacts with verifiable checksums. <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors -->

**Decision:** Keep the repository private until the first Worker-to-Mesh path works, then make releases public enough for installer and updater downloads.

**Alternatives considered:** Worker/R2 download broker; private GitHub Releases requiring node credentials.

**Rationale:** Public GitHub Release assets reduce infrastructure and align with standard updater flows.

**Consequences:** Agent release publication waits until the core path is proven, and install scripts verify artifacts before installation.

**Related requirements:** [REQ-REL-003](../../sdd/spec/release-ci.md), [REQ-NODE-005](../../sdd/spec/node-agent.md)
