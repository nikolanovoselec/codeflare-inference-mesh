# Configuration

## Contents

- [Worker secrets](#worker-secrets)
- [Worker vars](#worker-vars)
- [Wrangler bindings](#wrangler-bindings)
- [Wrangler environments](#wrangler-environments)
- [Cloudflare One prerequisite](#cloudflare-one-prerequisite)
- [Node agent config](#node-agent-config)
- [GitHub secrets](#github-secrets)
- [GitHub variables](#github-variables)
- [SDD config](#sdd-config)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Worker secrets

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `ROUTER_PROVIDER_TOKEN` | n/a | yes for seeded provider auth | `packages/router-worker/src/router.ts::authenticateKind` | [REQ-GWY-002](../../sdd/spec/gateway.md) |
| `ADMIN_TOKEN` | n/a | no after browser setup creates admin token records | `packages/router-worker/src/router.ts::authenticateKind` | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| `ADMIN_RECOVERY_TOKEN` | n/a | yes only for emergency admin reset | `packages/router-worker/src/router.ts::handleAdminRecovery` | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| `NODE_UPSTREAM_TOKEN` | generated during first setup when absent | no | `packages/router-worker/src/router.ts::resolveUpstreamToken` | [REQ-SEC-001](../../sdd/spec/security.md) |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | n/a | yes for Gateway/domain automation | `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleCustomDomain` | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |
| `CLOUDFLARE_ACCOUNT_ID` | n/a | yes for Gateway/domain automation | `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleCustomDomain` | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |
| `MESH_STATE_KEY` | n/a | yes for mesh bootstrap and rotation | `packages/router-worker/src/mesh-state.ts::meshKeyFor` | [REQ-SEC-006](../../sdd/spec/security.md) |

`MESH_STATE_KEY` is the AES-GCM key for the per-profile mesh state envelope, so D1 holds only `{iv, ciphertext}` and never plaintext invite tokens. Deploy sets it from the GitHub secret of the same name via `wrangler secret put`. When it is absent, mesh bootstrap and rotation fail closed with `mesh_state_key_missing` and the Admin UI shows a missing-key banner, while claim, heartbeat persistence, and scheduling of already-ready nodes continue. ([REQ-SEC-006](../../sdd/spec/security.md)) <!-- @impl: packages/router-worker/src/mesh-state.ts::meshKeyFor --> <!-- @impl: packages/router-worker/src/admin-ui.ts::keyMissingError -->

## Worker vars

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `AI_GATEWAY_ACCOUNT_ID` | `set-by-deploy-or-runtime-secret` | no | `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleCustomDomain` | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |
| `MAX_REQUEST_BYTES` | `16777216` | no | `packages/router-worker/src/router.ts::handleChat` | [REQ-RTR-002](../../sdd/spec/router-worker.md) |
| `HEARTBEAT_TTL_SECONDS` | `45` | no | Declared in Wrangler but not consumed; live heartbeat TTL is hard-coded to 45s in `packages/router-worker/src/scheduler.ts` and `packages/router-worker/src/store.ts`. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| `AI_GATEWAY_ID` | `inference-mesh` | no | `packages/router-worker/src/router.ts::handleGatewaySync` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `AI_GATEWAY_ROUTE_NAME` | `mesh-default` | no | `packages/router-worker/src/router.ts::handleGatewaySync` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `AI_GATEWAY_PROVIDER_NAME` | `codeflare-inference-mesh` | no | `packages/router-worker/src/router.ts::handleGatewaySync` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `AI_GATEWAY_PUBLIC_MODEL` | `mesh-default` | no | `packages/router-worker/src/router.ts::handleGatewaySync` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `WORKER_BASE_URL` | optional bootstrap origin override | no; custom-domain setup and installers use the request origin when unset or still a placeholder; Gateway sync only uses it to distinguish stored explicit overrides | `packages/router-worker/src/router.ts::handleCustomDomain`, `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleInstaller` | [REQ-ADM-004](../../sdd/spec/setup-admin.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-GWY-003](../../sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation), [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `WORKER_NAME` | `codeflare-inference-mesh-router` (`codeflare-inference-mesh-router-integration` in integration) | no | `packages/router-worker/src/router.ts::handleCustomDomain` | [REQ-ADM-005](../../sdd/spec/setup-admin.md) |
| `AGENT_RELEASE_TAG` | `agent-release-tag-placeholder` | set by deploy for real installers | `packages/router-worker/src/router.ts::handleInstallScript` | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| `GITHUB_REPOSITORY` | `nikolanovoselec/codeflare-inference-mesh` | yes for installers and agent-version listing | `packages/router-worker/src/router.ts::handleInstaller`, `packages/router-worker/src/router.ts::handleInstallScript`, `packages/router-worker/src/agent-versions.ts::handleAgentVersionsList` | [REQ-ADM-004](../../sdd/spec/setup-admin.md), [REQ-REL-003](../../sdd/spec/release-ci.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md) |

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

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `routerUrl` | n/a | yes | `packages/node-agent/internal/agent/config.go::Config` | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `setupToken` | n/a | yes until claim | `packages/node-agent/internal/agent/client.go::Claim` | [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `nodeId` | assigned by claim | yes after claim | `packages/node-agent/internal/agent/client.go::Heartbeat` | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `nodeToken` | assigned by claim | yes after claim | `packages/node-agent/internal/agent/client.go::Heartbeat` | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `upstreamToken` | assigned by claim | yes after claim | `packages/node-agent/internal/agent/proxy.go::ProxyHandler` | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| `displayName` | hostname-derived | no | `packages/node-agent/internal/agent/config.go::DefaultConfig` | [REQ-NODE-004](../../sdd/spec/node-agent.md) |
| `meshIp` | auto-detected before claim when unambiguous | yes when detection is ambiguous | `packages/node-agent/internal/agent/config.go::DetectMeshIP`, `packages/node-agent/internal/agent/config.go::ApplyDetectedMeshIP`, `packages/node-agent/internal/agent/config.go::ListenerAddress` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `listenAddress` | derived | no | `packages/node-agent/cmd/inference-mesh-agent/main.go` | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `inferencePort` | `8080` | no | `packages/node-agent/internal/agent/config.go::ListenerAddress` | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `dashboardAddress` | `127.0.0.1:17777` | no | `packages/node-agent/internal/agent/dashboard.go::DashboardHandler` | [REQ-NODE-004](../../sdd/spec/node-agent.md) |
| `dashboardToken` | generated on config load | yes for dashboard controls | `packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed` | [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md), [REQ-SEC-005](../../sdd/spec/security.md) |
| `meshllmApiPort` | `9337` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs`, `packages/node-agent/cmd/inference-mesh-agent/main.go` | [REQ-NODE-003](../../sdd/spec/node-agent.md), [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `meshllmConsolePort` | `3131` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs`, `packages/node-agent/internal/agent/meshllm_manager.go::PollStatus` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md), [REQ-RUN-005](../../sdd/spec/runtime-profiles.md) |
| `meshllmFlavor` | auto-detected: `cuda-12` when `nvidia-smi` is present, `metal` on darwin/arm64, else `cpu` | no | `packages/node-agent/internal/agent/meshllm_install.go::DetectMeshLLMFlavor`, `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` | [REQ-NODE-006](../../sdd/spec/node-agent.md) |
| `meshllmAllowUnpinned` | `false` | no | `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` | [REQ-NODE-006](../../sdd/spec/node-agent.md) |
| `runtimeModel` | `unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/metrics.go::RuntimeMetrics` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `publicModels` | `["mesh-default"]` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/client.go::HeartbeatFromConfig` | [REQ-RUN-001](../../sdd/spec/runtime-profiles.md) |
| `activeProfileIds` | `["mesh-default-qwen36-35b"]` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/client.go::HeartbeatFromConfig` | [REQ-RUN-004](../../sdd/spec/runtime-profiles.md) |
| `profiles` | claim/heartbeat response | no | `packages/node-agent/internal/agent/client.go::ApplyDesiredProfiles`, `packages/node-agent/internal/agent/runtime.go::SelectedProfile`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs` | [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-RUN-002](../../sdd/spec/runtime-profiles.md), [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `HF_TOKEN` | node service environment | no, only for gated Hugging Face models pulled by `mesh-llm` | `packages/node-agent/internal/agent/meshllm_render.go::MeshLLMEnv` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `capacity` | `1` | no | `packages/node-agent/internal/agent/client.go::HeartbeatFromConfig` | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| `dataDir` | `.inference-mesh` | no | `packages/node-agent/cmd/inference-mesh-agent/main.go::defaultDataDir` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `allowAllInterfaces` | `false` | no | `packages/node-agent/internal/agent/config.go::ListenerAddress` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md) |

Legacy config loads persist a generated `dashboardToken` before dashboard controls are served. ([REQ-SEC-005](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig -->

Before first claim, config startup persists `meshIp` only when private-interface detection finds exactly one candidate; ambiguous hosts must supply it explicitly. ([REQ-NODE-002](../../sdd/spec/node-agent.md)) <!-- @impl: packages/node-agent/internal/agent/config.go::ApplyDetectedMeshIP -->

The router calls `seedDefaultProfiles(DEFAULT_MODEL_PROFILES)` at request entry, so D1 deployments receive and refresh shipped defaults before setup/status/provider/admin reads. Shipped defaults are MeshLLM profiles carrying `runtime: 'meshllm'` with `modelRef`, `split`, and `bindPort`. `seedDefaultProfiles` refreshes changed managed defaults, deactivates every active profile row whose runtime is not `meshllm` regardless of version, and retires stale managed defaults that still own a shipped public alias. ([REQ-RUN-002](../../sdd/spec/runtime-profiles.md)) <!-- @impl: packages/router-worker/src/router.ts::createRouter --> <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles -->

`HF_TOKEN` is not stored in router profiles. When a gated Hugging Face model is used, provide `HF_TOKEN` in the node service environment; `MeshLLMEnv` passes the inherited service environment through to the supervised `mesh-llm` process (adding only `MESH_LLM_NO_SELF_UPDATE=1`) so `mesh-llm` can pull the model from Hugging Face without the Worker returning secrets to nodes. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md)) <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMEnv -->

## GitHub secrets

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | n/a | yes for deploy | `.github/workflows/deploy.yml` | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | n/a | yes for deploy | `.github/workflows/deploy.yml` | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | n/a | yes for Gateway/domain setup | `.github/workflows/deploy.yml` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `MESH_STATE_KEY` | n/a | yes for deploy; the workflow validates it and fails closed when absent | `.github/workflows/deploy.yml`, pushed to the Worker via `wrangler secret put` | [REQ-SEC-006](../../sdd/spec/security.md) |
| `ADMIN_RECOVERY_TOKEN` | n/a | no | `.github/workflows/deploy.yml`, `packages/router-worker/src/router.ts::handleAdminRecovery` | [REQ-ADM-002](../../sdd/spec/setup-admin.md) |
| `COSIGN_PRIVATE_KEY` | n/a | no | `.github/workflows/deploy.yml` | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| `COSIGN_PASSWORD` | n/a | no | `.github/workflows/deploy.yml` | [REQ-REL-003](../../sdd/spec/release-ci.md) |

## GitHub variables

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `WORKER_BASE_URL` | n/a | optional bootstrap URL; when set, must be HTTPS origin-only | `packages/router-worker/scripts/resolve-deploy-settings.mjs` | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `PRODUCTION_WORKER_BASE_URL` | n/a | optional production bootstrap URL; when set, must be HTTPS origin-only | `packages/router-worker/scripts/resolve-deploy-settings.mjs` | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `INTEGRATION_WORKER_BASE_URL` | n/a | optional integration bootstrap URL; when set, must be HTTPS origin-only | `packages/router-worker/scripts/resolve-deploy-settings.mjs` | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN` | n/a | optional helper for deriving a bootstrap workers.dev URL | `packages/router-worker/scripts/resolve-deploy-settings.mjs` | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |

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
| Mesh state key | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::meshKeyFor` <!-- @impl: packages/router-worker/src/mesh-state.ts::meshKeyFor --> |
| Profiles | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES` <!-- @impl: packages/router-worker/src/profiles.ts::DEFAULT_MODEL_PROFILES --> |
