# Codeflare Inference Mesh SDD

Codeflare Inference Mesh provides one stable AI Gateway route for private local inference nodes. The product hides local machine topology, delegates cache-warm session affinity to mesh-llm's AffinityRouter across the peered mesh, and keeps node access private through Cloudflare One, Mesh, and Workers VPC.

## Actors

| Actor | Role |
| --- | --- |
| Client | Coding agent or application that calls AI Gateway. |
| Admin | Operator who configures the router, Gateway route, node setup tokens, and releases. |
| Node Operator | Person who installs and runs a local node agent on a private machine. |
| Node Agent | Local service that heartbeats, proxies inference, supervises runtime state, and reports metrics. |

## Design Principles

1. Keep only the Worker public; nodes stay private and require no inbound public hostname.
2. Separate inference traffic from setup, admin, release, and heartbeat flows.
3. Prefer deterministic, token-scoped trust boundaries over shared credentials.
4. Delegate cache-warm session affinity to mesh-llm's AffinityRouter; the entry router stays a stateless, load-spreading forwarder.
5. Prove the Worker-to-Mesh transport before building installers, model downloads, or fleet rollout.
6. Keep AI Gateway configuration stable while the router owns internal model rollout.
7. Treat tests, specs, documentation, and source anchors as one change when implementation begins.

## Domains

| Domain | File | Summary | Priority |
| --- | --- | --- | --- |
| Gateway Integration | [gateway.md](spec/gateway.md) | AI Gateway custom provider, dynamic route, and provider-token contract. | P0 |
| Router Worker | [router-worker.md](spec/router-worker.md) | Worker routes, auth gates, request rewriting, Mesh forwarding, and streaming. | P0 |
| State And Scheduling | [state-scheduling.md](spec/state-scheduling.md) | D1 records, mesh seed election, stateless entry-node selection, and scheduler miss behavior. | P0 |
| Node Agent | [node-agent.md](spec/node-agent.md) | Node claim, heartbeat, local UI, upstream proxy, and service lifecycle. | P0 |
| Runtime Profiles | [runtime-profiles.md](spec/runtime-profiles.md) | Stable public aliases, MeshLLM mesh profiles, private mesh formation, split serving, and runtime supervision. | P1 |
| Setup And Admin | [setup-admin.md](spec/setup-admin.md) | First-run setup, admin session, setup tokens, and one-line installation. | P0 |
| Security | [security.md](spec/security.md) | Credential classes, route-level authorization, token storage, and header filtering. | P0 |
| Release And CI | [release-ci.md](spec/release-ci.md) | PR checks, deploy workflow, signed node-agent artifacts, and update metadata. | P1 |
| Observability | [observability.md](spec/observability.md) | Status surfaces, response headers, node metrics, audit records, and failure reporting. | P1 |
| Control-Plane API | [control-plane-api.md](spec/control-plane-api.md) | Automation credentials and the `/api/v1` surface for programmatic fleet orchestration. | P1 |

## Support files

| File | Purpose |
| --- | --- |
| [constraints.md](spec/constraints.md) | Cross-cutting technology, security, testing, and delivery constraints. |
| [glossary.md](spec/glossary.md) | Canonical vocabulary used by specs and docs. |
| [changes.md](spec/changes.md) | User-facing spec changelog. |
| [config.yml](spec/config.yml) | SDD mode, TDD enforcement, and discovery globs. |

## Out of Scope

- Public per-node Cloudflare Tunnel hostnames as the default transport.
- AI Gateway routing directly to individual nodes.
- Native desktop shells for the first node UI.
- Automatic BYOK secret creation in the first implementation.
- Automatic agent-version selection, release channels, and partial-fleet version targeting; the operator chooses one fleet-wide version.
- Public or unauthenticated Nostr relay discovery without an operator-configured private relay allowlist, public MeshLLM discovery, and public mesh publishing.
- Direct MeshLLM cloud routing.

## Documentation

Operational documentation starts at [../documentation/README.md](../documentation/README.md). Founding decisions live in [../documentation/decisions/README.md](../documentation/decisions/README.md).
