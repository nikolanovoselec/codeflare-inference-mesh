# Security

## Trust boundaries

| Boundary | Credential | Purpose | REQs |
| --- | --- | --- | --- |
| Client to AI Gateway | Gateway auth token | Lets clients call the selected Gateway. | [REQ-SEC-001](../../sdd/spec/security.md) |
| AI Gateway to Worker | Provider token | Lets Gateway call router `/v1/*` routes. | [REQ-GWY-002](../../sdd/spec/gateway.md), [REQ-SEC-001](../../sdd/spec/security.md) |
| Admin to Worker | Admin token/session | Protects setup and admin routes. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| Installer to Worker | Setup token | Claims one node once. | [REQ-ADM-003](../../sdd/spec/setup-admin.md) |
| Node to Worker | Node token | Authorizes heartbeat and unregister. | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| Worker to node | Upstream token | Authorizes Mesh-facing inference proxy. | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| Workflow to Cloudflare | Deploy token | Deploys Worker and migrates D1. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Worker to Cloudflare API | Runtime token | Creates Gateway and optional domain resources. | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |

## Route authorization

Provider auth applies only to `/v1/models` and `/v1/chat/completions`. Node claim, heartbeat, admin, installer, and health routes each use their own policy. This avoids using one credential across unrelated trust boundaries. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## Token storage

The durable default is verifier-only storage. Plaintext token display is one-time at creation. Rotation flows create new verifiers and revoke old credentials when the relevant actor can switch safely. ([REQ-SEC-002](../../sdd/spec/security.md))

## Header filtering

The Worker forwards only approved inference metadata and the upstream token to a node. Node proxy code strips credentials before forwarding to the runtime unless the runtime is deliberately configured to require its own API key. ([REQ-SEC-003](../../sdd/spec/security.md))

## Runtime safety

Managed `llama-server` profiles must not expose built-in tools, local file access, or web UI surfaces through the Mesh listener by default. Local dashboard auth is separate from Worker upstream auth. ([REQ-SEC-004](../../sdd/spec/security.md))

## Access position

Cloudflare Access is an optional admin-hardening layer after a custom domain exists. It is not part of the first implementation because Gateway and node traffic still require app-level identities. ([REQ-ADM-002](../../sdd/spec/setup-admin.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Credential classes | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/auth.ts::AUTH_ANCHORS` <!-- @impl: packages/router-worker/src/auth.ts::AUTH_ANCHORS --> |
| Header filtering | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
| Runtime exposure | [security.md](../../sdd/spec/security.md) | `packages/node-agent/internal/agent/config.go::ConfigAnchors` <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> |
