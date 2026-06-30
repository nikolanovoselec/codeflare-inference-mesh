# Security

## Trust boundaries

| Boundary | Credential | Purpose | REQs |
| --- | --- | --- | --- |
| Client to AI Gateway | Gateway auth token | Lets clients call the selected Gateway. | REQ-SEC-001 |
| AI Gateway to Worker | Provider token | Lets Gateway call router `/v1/*` routes. | REQ-GWY-002, REQ-SEC-001 |
| Admin to Worker | Admin token/session | Protects setup and admin routes. | REQ-ADM-002 |
| Installer to Worker | Setup token | Claims one node once. | REQ-ADM-003 |
| Node to Worker | Node token | Authorizes heartbeat and unregister. | REQ-NODE-002 |
| Worker to node | Upstream token | Authorizes Mesh-facing inference proxy. | REQ-NODE-003 |
| Workflow to Cloudflare | Deploy token | Deploys Worker and migrates D1. | REQ-REL-002 |
| Worker to Cloudflare API | Runtime token | Creates Gateway and optional domain resources. | REQ-GWY-003, REQ-ADM-005 |

## Route authorization

Provider auth applies only to `/v1/models` and `/v1/chat/completions`. Node claim, heartbeat, admin, installer, and health routes each use their own policy. This avoids using one credential across unrelated trust boundaries. (REQ-RTR-001) (REQ-SEC-001)

## Token storage

The durable default is verifier-only storage. Plaintext token display is one-time at creation. Rotation flows create new verifiers and revoke old credentials when the relevant actor can switch safely. (REQ-SEC-002)

## Header filtering

The Worker forwards only approved inference metadata and the upstream token to a node. Node proxy code strips credentials before forwarding to the runtime unless the runtime is deliberately configured to require its own API key. (REQ-SEC-003)

## Runtime safety

Managed `llama-server` profiles must not expose built-in tools, local file access, or web UI surfaces through the Mesh listener by default. Local dashboard auth is separate from Worker upstream auth. (REQ-SEC-004)

## Access position

Cloudflare Access is an optional admin-hardening layer after a custom domain exists. It is not part of the first implementation because Gateway and node traffic still require app-level identities. (REQ-ADM-002)
