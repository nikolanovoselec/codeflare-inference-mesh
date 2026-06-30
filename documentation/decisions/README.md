# Architecture Decisions

This ledger records binding technical choices for the first implementation. It is not a bug log or implementation diary.

## ADR index

| ID | Status | Decision | Related requirements |
| --- | --- | --- | --- |
| AD-001 | Accepted | Use Cloudflare Workers, AI Gateway, Workers VPC, Mesh, D1, and Durable Objects for the router plane. | REQ-GWY-001, REQ-RTR-002, REQ-SCH-001 |
| AD-002 | Accepted | Use app-level bearer-token classes instead of Cloudflare Access as the MVP auth spine. | REQ-SEC-001, REQ-ADM-002 |
| AD-003 | Accepted | Use D1 for durable truth and a Durable Object for live scheduling. | REQ-SCH-001, REQ-SCH-002 |
| AD-004 | Accepted | Use Go for the node agent and a localhost web UI instead of a native desktop shell. | REQ-NODE-001, REQ-NODE-004 |
| AD-005 | Accepted | Use `llama-server` as the first managed runtime. | REQ-RUN-003 |
| AD-006 | Accepted | Make Qwen3.6 27B the primary `mesh-default` profile, Gemma 4 26B-A4B the fallback benchmark profile, and a small smoke-test profile available. | REQ-RUN-002 |
| AD-007 | Accepted | Automate Gateway provider and dynamic route creation, but keep BYOK/provider-key entry manual in v1. | REQ-GWY-002, REQ-GWY-003 |
| AD-008 | Accepted | Bind the node listener to Mesh IP when possible and allow `0.0.0.0` fallback only with strict token auth. | REQ-NODE-001, REQ-RTR-004 |
| AD-009 | Accepted | Start hardware metrics with best-effort platform probes rather than native GPU libraries. | REQ-OBS-003 |
| AD-010 | Accepted | Publish public GitHub Release artifacts for installers and self-update after the first Worker path is proven. | REQ-REL-003, REQ-NODE-005 |

## AD-001: Cloudflare router plane

**Status:** Accepted

**Context:** The product needs one public provider endpoint while local nodes stay private. Cloudflare documents Workers VPC Mesh bindings with `network_id: "cf1:network"`, and AI Gateway custom providers require an HTTPS upstream origin.

**Decision:** The router plane uses AI Gateway custom provider and dynamic route, a public Cloudflare Worker, Workers VPC bound to Cloudflare Mesh, D1, and a Durable Object scheduler.

**Alternatives considered:** Per-node Tunnel hostnames; AI Gateway direct-to-node providers; a non-Cloudflare public API server.

**Rationale:** This keeps the public surface small and lets the Worker reach Mesh IPs without registering one service binding per node.

**Consequences:** The first validation gate is Worker-to-Mesh fetch before installers, model download, or multi-node scheduling.

**Related requirements:** REQ-GWY-001, REQ-RTR-002, REQ-SCH-001

## AD-002: App-level bearer-token auth first

**Status:** Accepted

**Context:** Gateway, admin UI, setup flow, node heartbeat, and Worker-to-node calls have different trust boundaries.

**Decision:** MVP auth uses separate app-level bearer-token classes. Cloudflare Access is optional admin hardening after a custom domain exists.

**Alternatives considered:** One shared token; Cloudflare Access as mandatory primary auth; mTLS between Worker and nodes.

**Rationale:** Separate tokens constrain blast radius and avoid forcing Gateway and node agents through Access service-token headers in the first version.

**Consequences:** The implementation must keep route-family auth strict and never reuse credentials across boundaries.

**Related requirements:** REQ-SEC-001, REQ-ADM-002

## AD-003: D1 plus Durable Object scheduler

**Status:** Accepted

**Context:** Durable state must survive Worker restarts, but live reservations need serialized updates.

**Decision:** D1 stores durable truth. A Durable Object owns live scheduling, reservations, leases, and sticky sessions.

**Alternatives considered:** D1-only scheduling; KV; R2; in-memory Worker state only.

**Rationale:** D1 is durable and inspectable, while Durable Objects prevent concurrent isolates from overbooking one node.

**Consequences:** Scheduler state must be rebuildable from D1 after eviction or deploy.

**Related requirements:** REQ-SCH-001, REQ-SCH-002

## AD-004: Go service with localhost UI

**Status:** Accepted

**Context:** The node must run on Windows, macOS, Linux, and headless hosts.

**Decision:** The node agent is a Go service with an embedded localhost web UI.

**Alternatives considered:** Electron; Tauri; Wails; platform-native apps.

**Rationale:** One service binary is easier to package across OSes and works on headless Linux.

**Consequences:** UI polish is web-based, and OS-specific service integration lives behind Go packages.

**Related requirements:** REQ-NODE-001, REQ-NODE-004

## AD-005: llama.cpp first runtime

**Status:** Accepted

**Context:** The first runtime must work across Windows, macOS, and Linux and expose OpenAI-compatible chat endpoints.

**Decision:** Use `llama-server` as the first managed runtime.

**Alternatives considered:** Ollama; LM Studio; vLLM as default.

**Rationale:** `llama-server` is cross-platform, exposes OpenAI-compatible endpoints, and provides direct control over long-context and KV-cache flags.

**Consequences:** Other runtimes are adapter work after the Mesh and llama.cpp path works.

**Related requirements:** REQ-RUN-003

## AD-006: Default model profile set

**Status:** Accepted

**Context:** The original plan had an open question about whether `mesh-default` should start with Qwen, Gemma, or a smoke-test profile.

**Decision:** `mesh-default` initially targets Qwen3.6 27B for serious coding validation. Gemma 4 26B-A4B is the fallback benchmark profile. A small 32K smoke-test profile exists for fast validation.

**Alternatives considered:** Gemma 4 as primary; smoke-test profile as the only initial default.

**Rationale:** Qwen3.6 27B is documented as a coding-focused long-context model, while Gemma 4 provides a useful comparable fallback.

**Consequences:** Hardware validation must prove the 27B profile on target nodes before claiming production readiness.

**Related requirements:** REQ-RUN-002

## AD-007: Gateway route automation with manual BYOK

**Status:** Accepted

**Context:** The setup flow should avoid manual route construction, but automatic provider-key storage requires Secrets Store permissions.

**Decision:** The Worker setup UI creates or updates the custom provider, route, version, and deployment. The Admin manually enters the generated provider token into AI Gateway BYOK/provider-key settings in v1.

**Alternatives considered:** Manual route instructions only; full BYOK automation through Secrets Store.

**Rationale:** Route automation removes tedious setup while avoiding extra Secrets Store permissions for the first implementation.

**Consequences:** Setup UI must clearly show the provider token once and verify the header shape after manual entry.

**Related requirements:** REQ-GWY-002, REQ-GWY-003

## AD-008: Node listener binding policy

**Status:** Accepted

**Context:** Binding directly to a Mesh IP is safest but can be unreliable across operating systems.

**Decision:** The agent prefers Mesh IP binding. It may fall back to `0.0.0.0` only with strict upstream bearer-token auth and a firewall warning.

**Alternatives considered:** Require Mesh IP binding always; bind `0.0.0.0` by default.

**Rationale:** The fallback keeps setup practical while token auth and warnings prevent silent widening of access.

**Consequences:** Admin status and local dashboard must expose binding mode and firewall warning state.

**Related requirements:** REQ-NODE-001, REQ-RTR-004

## AD-009: Best-effort hardware metrics first

**Status:** Accepted

**Context:** Hardware metrics are useful but platform libraries add packaging and permissions complexity.

**Decision:** Start with best-effort platform probes such as `nvidia-smi` where available, and report absent metrics when unsupported.

**Alternatives considered:** Native GPU libraries from the first release; no hardware metrics.

**Rationale:** Best-effort probes give useful scheduling and UI signals without delaying the core transport path.

**Consequences:** Metrics must never be fabricated, and scheduling must tolerate missing GPU metrics.

**Related requirements:** REQ-OBS-003

## AD-010: Public release artifacts after Mesh proof

**Status:** Accepted

**Context:** Installers and self-update need downloadable artifacts with verifiable checksums.

**Decision:** Keep the repository private until the first Worker-to-Mesh path works, then make releases public enough for installer and updater downloads.

**Alternatives considered:** Worker/R2 download broker; private GitHub Releases requiring node credentials.

**Rationale:** Public GitHub Release assets reduce infrastructure and align with standard updater flows.

**Consequences:** Agent release publication waits until the core path is proven, and install scripts verify artifacts before installation.

**Related requirements:** REQ-REL-003, REQ-NODE-005
