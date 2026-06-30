# Configuration

## Contents

- [Worker secrets](#worker-secrets)
- [Worker vars](#worker-vars)
- [Wrangler bindings](#wrangler-bindings)
- [Wrangler environments](#wrangler-environments)
- [Cloudflare One prerequisite](#cloudflare-one-prerequisite)
- [Node agent config](#node-agent-config)
- [GitHub secrets](#github-secrets)
- [SDD config](#sdd-config)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Worker secrets

| Name | Purpose | REQs |
| --- | --- | --- |
| `ROUTER_PROVIDER_TOKEN` | Provider token verifier source during bootstrap or rotation. | [REQ-GWY-002](../../sdd/spec/gateway.md) |
| `ADMIN_TOKEN` | MVP admin access credential before stronger admin sessions or Access hardening. | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| `NODE_UPSTREAM_TOKEN` | MVP Worker-to-node bearer token before per-node upstream tokens. | [REQ-SEC-001](../../sdd/spec/security.md) |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Runtime token used by setup UI for Gateway and optional custom domain provisioning. | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |

## Worker vars

| Name | Purpose | REQs |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account used for Gateway, D1, Workers, and Mesh resources. | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `MAX_REQUEST_BYTES` | Maximum accepted chat request body size. | [REQ-RTR-002](../../sdd/spec/router-worker.md) |
| `HEARTBEAT_TTL_SECONDS` | Node heartbeat freshness window. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| `AI_GATEWAY_ID` | AI Gateway instance used for route automation. | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `WORKER_BASE_URL` | Public Worker origin used when registering the AI Gateway custom provider. | [REQ-GWY-001](../../sdd/spec/gateway.md) |
| `AGENT_RELEASE_TAG` | Deploy-selected GitHub Release tag used by `/install.sh` and `/install.ps1` so integration installers download prerelease artifacts from the exact release. | [REQ-REL-003](../../sdd/spec/release-ci.md) |

## Wrangler bindings

| Binding | Purpose | REQs |
| --- | --- | --- |
| `DB` | D1 database for durable router state. | [REQ-SCH-001](../../sdd/spec/state-scheduling.md) |
| `REGISTRY` | Durable Object namespace for scheduling and reservations. | [REQ-SCH-002](../../sdd/spec/state-scheduling.md) |
| `MESH` | Workers VPC Network binding using `network_id = "cf1:network"` and `remote = true`. The Worker targets runtime `IP:PORT` values through this binding. | [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-004](../../sdd/spec/router-worker.md) |

## Wrangler environments

| Environment | Worker | D1 database | Deploy path | REQs |
| --- | --- | --- | --- | --- |
| Production | `codeflare-inference-mesh-router` | `codeflare-inference-mesh` | Automatic after green `main` gates or manual from `main`. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Integration | `codeflare-inference-mesh-router-integration` | `codeflare-inference-mesh-integration` | Manual deploy from any branch. | [REQ-REL-002](../../sdd/spec/release-ci.md) |

## Cloudflare One prerequisite

Each inference node must run Cloudflare One Client / WARP enrolled into the same account network as the Worker VPC binding. The node agent advertises the Cloudflare One network-interface IP plus its Mesh-facing inference port. The router stores that `IP:PORT` and calls it through `env.MESH.fetch(...)`; it does not call public node URLs. ([REQ-NODE-001](../../sdd/spec/node-agent.md)) ([REQ-RTR-004](../../sdd/spec/router-worker.md))

## Node agent config

| Field | Purpose | REQs |
| --- | --- | --- |
| `routerUrl` | Router origin used for claim and heartbeat. | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `setupToken` | Short-lived node enrollment token, cleared after claim. | [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `nodeId` | Stable node identifier assigned by the router after claim. | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `nodeToken` | Node-to-Worker heartbeat credential. | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `upstreamToken` | Worker-to-node inference credential. | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| `displayName` | Human-readable node label. | [REQ-NODE-004](../../sdd/spec/node-agent.md) |
| `meshIp` | Cloudflare One interface IP advertised to the router. | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `listenAddress` | Concrete Mesh-facing listener address derived from `meshIp`, `inferencePort`, and fallback policy. | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `inferencePort` | Mesh-facing inference listener port. | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `dashboardAddress` | Localhost dashboard bind address. | [REQ-NODE-004](../../sdd/spec/node-agent.md) |
| `dashboardToken` | Local dashboard CSRF/control token stored only in local config, redacted from status APIs, and backfilled on legacy config load when absent. | [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md), [REQ-SEC-005](../../sdd/spec/security.md) |
| `runtimeUrl` | Local OpenAI-compatible runtime URL proxied by the node agent. | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| `runtimeModel` | Active upstream runtime model identifier. | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `publicModels` | Public aliases this node can serve. | [REQ-RUN-001](../../sdd/spec/runtime-profiles.md) |
| `activeProfileIds` | Desired profile IDs active on the node. | [REQ-RUN-004](../../sdd/spec/runtime-profiles.md) |
| `profiles` | Desired profiles persisted from claim/heartbeat responses for model preparation and runtime command generation. | [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `capacity` | Router-facing concurrent request capacity advertised by the node. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| `dataDir` | Directory for config, model cache, staged updates, and service data. | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `releaseUrl` | GitHub Release API URL used by self-update. | [REQ-NODE-005](../../sdd/spec/node-agent.md) |
| `allowAllInterfaces` | Explicit fallback allowing `0.0.0.0` listener binding when Mesh IP binding is unavailable. | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md) |

Legacy config loads persist a generated `dashboardToken` before dashboard controls are served. ([REQ-SEC-005](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig -->

## GitHub secrets

| Name | Purpose | REQs |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID for deployment workflow. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | Scoped token for Worker deploy and D1 migration. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Value written to Worker secrets for setup automation. | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `COSIGN_PRIVATE_KEY` | Optional Cosign private key for release checksum signing. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| `COSIGN_PASSWORD` | Optional password for `COSIGN_PRIVATE_KEY`. | [REQ-REL-003](../../sdd/spec/release-ci.md) |

## SDD config

`mode: unleashed`, `enforce_tdd: true`, and `transition: false` are intentional for this greenfield bootstrap. Implementation begins with RED tests and source anchors are added when REQs move out of `Planned`. ([REQ-REL-001](../../sdd/spec/release-ci.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Worker env vars | [security.md](../../sdd/spec/security.md) | `packages/router-worker/wrangler.toml::MAX_REQUEST_BYTES` <!-- @impl: packages/router-worker/wrangler.toml::MAX_REQUEST_BYTES --> |
| Agent release tag | [release-ci.md](../../sdd/spec/release-ci.md) | `packages/router-worker/wrangler.toml::AGENT_RELEASE_TAG` <!-- @impl: packages/router-worker/wrangler.toml::AGENT_RELEASE_TAG --> |
| Workers VPC Network | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/wrangler.toml::cf1:network` <!-- @impl: packages/router-worker/wrangler.toml::cf1:network --> |
| Integration Worker environment | [release-ci.md](../../sdd/spec/release-ci.md) | `packages/router-worker/wrangler.toml::codeflare-inference-mesh-router-integration` <!-- @impl: packages/router-worker/wrangler.toml::codeflare-inference-mesh-router-integration --> |
| Agent config | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/config.go::Config` <!-- @impl: packages/node-agent/internal/agent/config.go::Config --> |
| Profiles | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES` <!-- @impl: packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES --> |
