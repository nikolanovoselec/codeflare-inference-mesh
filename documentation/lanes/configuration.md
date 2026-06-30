# Configuration

## Worker secrets

| Name | Purpose | REQs |
| --- | --- | --- |
| `ROUTER_PROVIDER_TOKEN` | Provider token verifier source during bootstrap or rotation. | REQ-GWY-002 |
| `ADMIN_TOKEN` | MVP admin access credential before stronger admin sessions or Access hardening. | REQ-ADM-002 |
| `NODE_UPSTREAM_TOKEN` | MVP Worker-to-node bearer token before per-node upstream tokens. | REQ-SEC-001 |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Runtime token used by setup UI for Gateway and optional custom domain provisioning. | REQ-GWY-003, REQ-ADM-005 |

## Worker vars

| Name | Purpose | REQs |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account used for Gateway, D1, Workers, and Mesh resources. | REQ-GWY-003 |
| `NODE_LEASE_SECONDS` | Node heartbeat lease duration. | REQ-SCH-003 |
| `DEFAULT_NODE_PORT` | Default Mesh-facing node-agent port. | REQ-RTR-004 |
| `ALLOWED_MESH_CIDRS` | CIDR allowlist for node Mesh IP validation. | REQ-RTR-004 |

## Wrangler bindings

| Binding | Purpose | REQs |
| --- | --- | --- |
| `DB` | D1 database for durable router state. | REQ-SCH-001 |
| `REGISTRY` | Durable Object namespace for scheduling and reservations. | REQ-SCH-002 |
| `MESH` | Workers VPC binding using `network_id: "cf1:network"`. | REQ-RTR-002, REQ-RTR-004 |

## Node agent config

| Field | Purpose | REQs |
| --- | --- | --- |
| `router_url` | Router origin used for claim and heartbeat. | REQ-NODE-002 |
| `node_token` | Node-to-Worker heartbeat credential. | REQ-NODE-002 |
| `upstream_token` | Worker-to-node inference credential. | REQ-NODE-003 |
| `display_name` | Human-readable node label. | REQ-NODE-004 |
| `listen_port` | Mesh-facing inference listener port. | REQ-NODE-001 |
| `ui_port` | Localhost dashboard port. | REQ-NODE-004 |
| `model_cache_dir` | Directory for downloaded model files. | REQ-RUN-003 |
| `release_channel` | Stable or prerelease update channel. | REQ-NODE-005 |

## GitHub secrets

| Name | Purpose | REQs |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID for deployment workflow. | REQ-REL-002 |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | Scoped token for Worker deploy and D1 migration. | REQ-REL-002 |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Value written to Worker secrets for setup automation. | REQ-GWY-003 |
| `INFERENCE_MESH_INIT_TOKEN` | Optional first-run setup token. | REQ-ADM-001 |
| `CLOUDFLARE_ZONE_ID` | Optional default zone for custom domain setup. | REQ-ADM-005 |
| `CLOUDFLARE_D1_DATABASE_ID` | Optional existing D1 database ID. | REQ-SCH-001 |

## SDD config

`mode: unleashed`, `enforce_tdd: true`, and `transition: false` are intentional for this greenfield bootstrap. Implementation begins with RED tests and source anchors are added when REQs move out of `Planned`. (REQ-REL-001)
