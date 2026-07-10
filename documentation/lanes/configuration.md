# Configuration

## Contents

- [Worker secrets](#worker-secrets)
- [Worker vars](#worker-vars)
- [Wrangler bindings](#wrangler-bindings)
- [Wrangler environments](#wrangler-environments)
- [Cloudflare One prerequisite](#cloudflare-one-prerequisite)
- [Node agent config](#node-agent-config)
- [Model runtime tunables](#model-runtime-tunables)
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
| `SETUP_REOPEN` | n/a | no (break-glass only, set via wrangler) | `packages/router-worker/src/setup-state.ts::breakGlassActive`, `packages/router-worker/src/router.ts::handleSetupComplete` | [REQ-ADM-013](../../sdd/spec/setup-admin.md) |
| `NODE_UPSTREAM_TOKEN` | generated during first setup when absent | no | `packages/router-worker/src/router.ts::resolveUpstreamToken` | [REQ-SEC-001](../../sdd/spec/security.md) |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | n/a | yes for Gateway/domain automation | `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleCustomDomain`, `packages/router-worker/src/router.ts::handleSetupAccess`, `packages/router-worker/src/router.ts::handleZones`, `packages/router-worker/src/router.ts::handleGatewayOptions` | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-012](../../sdd/spec/setup-admin.md), [REQ-GWY-005](../../sdd/spec/gateway.md) |
| `CLOUDFLARE_ACCOUNT_ID` | n/a | yes for Gateway/domain automation | `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleCustomDomain`, `packages/router-worker/src/router.ts::handleSetupAccess`, `packages/router-worker/src/router.ts::handleZones`, `packages/router-worker/src/router.ts::handleGatewayOptions` | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-012](../../sdd/spec/setup-admin.md), [REQ-GWY-005](../../sdd/spec/gateway.md) |
| `MESH_STATE_KEY` | n/a | yes for mesh bootstrap and rotation | `packages/router-worker/src/mesh-state.ts::meshKeyFor` | [REQ-SEC-006](../../sdd/spec/security.md) |
| `SESSION_AFFINITY_KEY` | `ADMIN_TOKEN` only in local/test fallback | yes for deploy | `packages/router-worker/src/router.ts::directAffinitySecret` | [REQ-SCH-004](../../sdd/spec/state-scheduling.md#req-sch-004-direct-session-affinity) |

`MESH_STATE_KEY` is the AES-GCM key for the per-profile mesh state envelope, so D1 holds only `{iv, ciphertext}` and never plaintext invite tokens. Deploy sets it from the GitHub secret of the same name via `wrangler secret put`. When it is absent, mesh bootstrap and rotation fail closed with `mesh_state_key_missing` and the Admin UI shows a missing-key banner, while claim, heartbeat persistence, and scheduling of already-ready nodes continue. ([REQ-SEC-006](../../sdd/spec/security.md)) <!-- @impl: packages/router-worker/src/mesh-state.ts::meshKeyFor --> <!-- @impl: packages/router-worker/src/admin-ui.ts::ADMIN_UI_ANCHORS -->

`SESSION_AFFINITY_KEY` is the HMAC key for direct llama.cpp `body.user` values. D1 stores only hashed user/session ids in `direct_sessions`; raw ids never persist. Local tests can fall back to `ADMIN_TOKEN`, but production should set a distinct secret. ([REQ-SCH-004](../../sdd/spec/state-scheduling.md#req-sch-004-direct-session-affinity)) <!-- @impl: packages/router-worker/src/router.ts::directAffinitySecret --> <!-- @impl: packages/router-worker/src/router.ts::hmacHex -->

## Worker vars

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `AI_GATEWAY_ACCOUNT_ID` | `set-by-deploy-or-runtime-secret` | no | `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleCustomDomain` | [REQ-GWY-003](../../sdd/spec/gateway.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md) |
| `MAX_REQUEST_BYTES` | `16777216` | no | `packages/router-worker/src/router.ts::handleChat` | [REQ-RTR-002](../../sdd/spec/router-worker.md) |
| `HEARTBEAT_TTL_SECONDS` | `45` | no | Declared in Wrangler but not consumed; live heartbeat TTL is hard-coded to 45s in `packages/router-worker/src/scheduler.ts` and `packages/router-worker/src/store.ts`. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| `MESH_ALLOWED_CIDRS` | `100.64.0.0/10` | no | `packages/router-worker/src/scheduler.ts::isSafeMeshTarget` | [REQ-RTR-004](../../sdd/spec/router-worker.md#req-rtr-004-mesh-destination-safety) |
| `MESH_ALLOWED_PORTS` | `8080,11434` | no | `packages/router-worker/src/scheduler.ts::isSafeMeshTarget` | [REQ-RTR-004](../../sdd/spec/router-worker.md#req-rtr-004-mesh-destination-safety) |
| `AI_GATEWAY_ID` | `inference-mesh` | no | `packages/router-worker/src/router.ts::gatewaySettings` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `AI_GATEWAY_ROUTE_NAME` | `codeflare-mesh` | no | Declared in Wrangler but not consumed; the dynamic route name is pinned to the stable public model `codeflare-mesh` in `packages/router-worker/src/router.ts::gatewaySettings`. | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `AI_GATEWAY_PROVIDER_NAME` | `codeflare-inference-mesh` | no | `packages/router-worker/src/router.ts::gatewaySettings` | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `AI_GATEWAY_PUBLIC_MODEL` | `codeflare-mesh` | no | Declared in Wrangler but not consumed; the forwarded public model is pinned to the stable public model `codeflare-mesh` in `packages/router-worker/src/router.ts::gatewaySettings`. | [REQ-GWY-003](../../sdd/spec/gateway.md) |
| `WORKER_BASE_URL` | optional bootstrap origin override | no; custom-domain setup and installers use the request origin when unset or still a placeholder; Gateway sync only uses it to distinguish stored explicit overrides | `packages/router-worker/src/router.ts::handleCustomDomain`, `packages/router-worker/src/router.ts::handleGatewaySync`, `packages/router-worker/src/router.ts::handleInstaller` | [REQ-ADM-004](../../sdd/spec/setup-admin.md), [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-GWY-003](../../sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation), [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| `WORKER_NAME` | `codeflare-inference-mesh-router` (`codeflare-inference-mesh-router-integration` in integration) | no | `packages/router-worker/src/router.ts::handleCustomDomain`, `packages/router-worker/src/router.ts::handleSetupAccess` | [REQ-ADM-005](../../sdd/spec/setup-admin.md), [REQ-ADM-012](../../sdd/spec/setup-admin.md) |
| `AGENT_RELEASE_TAG` | `agent-release-tag-placeholder` | set by deploy for real installers | `packages/router-worker/src/router.ts::handleInstallScript` | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| `GITHUB_REPOSITORY` | `nikolanovoselec/codeflare-inference-mesh` | yes for installers and agent-version listing | `packages/router-worker/src/router.ts::handleInstaller`, `packages/router-worker/src/router.ts::handleInstallScript`, `packages/router-worker/src/agent-versions.ts::handleAgentVersionsList` | [REQ-ADM-004](../../sdd/spec/setup-admin.md), [REQ-REL-003](../../sdd/spec/release-ci.md), [REQ-ADM-008](../../sdd/spec/setup-admin.md) |

## Wrangler bindings

| Binding | Purpose | REQs |
| --- | --- | --- |
| `DB` | D1 database for durable router state. | [REQ-SCH-001](../../sdd/spec/state-scheduling.md) |
| `REGISTRY` | Durable Object namespace for mesh seed election; the MeshLLM inference request path is stateless and does not use it. | [REQ-RUN-008](../../sdd/spec/runtime-profiles.md) |
| `SESSION_AFFINITY` | Durable Object namespace for direct llama.cpp session-to-node pin decisions, backed by the D1 `direct_sessions` table. | [REQ-SCH-004](../../sdd/spec/state-scheduling.md#req-sch-004-direct-session-affinity) |
| `MESH` | Workers VPC Network binding using `network_id = "cf1:network"` and `remote = true` for the Worker-to-private-node `fetch()` path. | [REQ-RTR-002](../../sdd/spec/router-worker.md), [REQ-RTR-004](../../sdd/spec/router-worker.md) |
| `RL_INFERENCE` | Rate limit for credentialed `/v1` inference (the AI Gateway path), keyed by a hash of the provider token; 100000 per location per 60s. | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting) |
| `RL_HEARTBEAT` | Rate limit for `/node/heartbeat`, keyed by a hash of the node token; 120 per location per 60s. | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting) |
| `RL_ENROLL` | Rate limit for node enrollment (`/node/claim`, `/node/unregister`), keyed by client IP; 60 per location per 60s. | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting) |
| `RL_AUTH` | Rate limit for admin authentication (`/admin/login`, `/admin/setup`, recovery, setup-tokens), keyed by client IP; 30 per location per 60s. | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting) |
| `RL_PUBLIC` | Rate limit for token-less `/v1` and all other public routes, keyed by client IP; 600 per location per 60s. | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting) |

The `MESH` binding ships commented out in the committed `wrangler.toml` so CI dry-runs and forks without Workers VPC entitlement still pass. `.github/workflows/deploy.yml` uncomments and verifies it immediately before `wrangler deploy`. A local `wrangler dev` or manual deploy outside CI does not have this binding until the block is uncommented by hand.

Rate limits are per Cloudflare location per 60s (Cloudflare requires the period to be 10 or 60); the effective global limit is higher across locations. Because the AI Gateway forwards inference from a shared Cloudflare IP, credentialed `/v1` traffic is metered by provider token in `RL_INFERENCE` with a high ceiling sized for enterprise throughput, while token-less `/v1` hits and other anonymous callers fall to the low IP-keyed `RL_PUBLIC`. Retune by editing the `limit` values in `wrangler.toml`; no code change is needed. Integration uses distinct rate-limit namespaces so its counters never mix with production. ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting))

## Wrangler environments

| Environment | Worker | D1 database | Deploy path | REQs |
| --- | --- | --- | --- | --- |
| Production | `codeflare-inference-mesh-router` | `codeflare-inference-mesh` | Automatic after green `main` gates or manual from `main`. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Integration | `codeflare-inference-mesh-router-integration` | `codeflare-inference-mesh-integration` | Manual deploy from any branch. | [REQ-REL-002](../../sdd/spec/release-ci.md) |

## Cloudflare One prerequisite

Each inference node must run Cloudflare One Client / WARP enrolled into the same account network as the Worker VPC binding. The node agent detects the WARP adapter by name (`CloudflareWARP`) and by the WARP CGNAT range `100.96.0.0/12`, so a headless `warp-cli` enrollment on a server is detected the same way as desktop WARP, and it advertises that WARP IP plus its Mesh-facing inference port. The router stores that `IP:PORT` and calls it through `env.MESH.fetch(...)`; it does not call public node URLs. ([REQ-NODE-001](../../sdd/spec/node-agent.md)) ([REQ-NODE-008](../../sdd/spec/node-agent.md)) ([REQ-RTR-004](../../sdd/spec/router-worker.md))

The agent provisions the inbound mesh firewall rule itself at startup, once WARP is up: on Linux it runs `ufw allow in on <WARP-interface> to any port <inferencePort> proto tcp` (only when ufw is present), and on Windows it creates an idempotent inbound `New-NetFirewallRule` for the port. This is best-effort and never blocks startup. On a Linux host without ufw, or when the WARP interface cannot be named, the agent logs that the rule was not provisioned; on macOS it is a silent no-op (the application firewall is app-scoped, not port-scoped). In any of those cases, allow inbound TCP on the mesh port over the WARP interface by hand. ([REQ-NODE-010](../../sdd/spec/node-agent.md))

Two Zero Trust settings are also mandatory for mesh reachability: the network policy must permit WARP-to-WARP reachability (the *Allow all Cloudflare One traffic to reach enrolled devices* toggle), and any split-tunnel Exclude list must not exclude the WARP CGNAT range `100.96.0.0/12`. ([REQ-NODE-008](../../sdd/spec/node-agent.md)) ([REQ-NODE-010](../../sdd/spec/node-agent.md))

## Node agent config

| Variable | Default | Required | Consumed by | Implements |
| --- | --- | --- | --- | --- |
| `routerUrl` | n/a | yes | `packages/node-agent/internal/agent/config.go::Config` | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `setupToken` | n/a | yes until claim | `packages/node-agent/internal/agent/client.go::Claim` | [REQ-ADM-003](../../sdd/spec/setup-admin.md), [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `nodeId` | assigned by claim | yes after claim | `packages/node-agent/internal/agent/client.go::Heartbeat` | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `nodeToken` | assigned by claim | yes after claim | `packages/node-agent/internal/agent/client.go::Heartbeat` | [REQ-NODE-002](../../sdd/spec/node-agent.md) |
| `upstreamToken` | assigned by claim | yes after claim | `packages/node-agent/internal/agent/proxy.go::ProxyHandler` | [REQ-NODE-003](../../sdd/spec/node-agent.md) |
| `displayName` | hostname-derived | no | `packages/node-agent/internal/agent/config.go::DefaultConfig` | [REQ-NODE-004](../../sdd/spec/node-agent.md) |
| `meshIp` | auto-detected from the WARP adapter (name + `100.96.0.0/12`) before claim | yes when detection is ambiguous | `packages/node-agent/internal/agent/config.go::DetectWARPMeshIP`, `packages/node-agent/internal/agent/config.go::DetectMeshIP`, `packages/node-agent/internal/agent/config.go::ApplyDetectedMeshIP`, `packages/node-agent/internal/agent/config.go::ListenerAddress` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-NODE-008](../../sdd/spec/node-agent.md) |
| `listenAddress` | derived | no | `packages/node-agent/cmd/inference-mesh-agent/main.go` | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `inferencePort` | `8080` | no | `packages/node-agent/internal/agent/config.go::ListenerAddress` | [REQ-NODE-001](../../sdd/spec/node-agent.md) |
| `dashboardAddress` | `127.0.0.1:17777` | no | `packages/node-agent/internal/agent/dashboard.go::DashboardHandler` | [REQ-NODE-004](../../sdd/spec/node-agent.md) |
| `dashboardToken` | generated on config load | yes for dashboard controls | `packages/node-agent/internal/agent/dashboard.go::dashboardControlAllowed` | [REQ-NODE-004](../../sdd/spec/node-agent.md), [REQ-SEC-008](../../sdd/spec/security.md), [REQ-SEC-005](../../sdd/spec/security.md) |
| `meshllmApiPort` | `9337` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs`, `packages/node-agent/cmd/inference-mesh-agent/main.go` | [REQ-NODE-003](../../sdd/spec/node-agent.md), [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `meshllmConsolePort` | `3131` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs`, `packages/node-agent/internal/agent/meshllm_manager.go::PollStatus` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md), [REQ-RUN-005](../../sdd/spec/runtime-profiles.md) |
| `meshllmFlavor` | auto-detected on `nvidia-smi` hosts by CUDA runtime major (`cuda-13` on Linux with CUDA 13 libraries, else `cuda-12`), `metal` on darwin/arm64, else `cpu`; override with any of `cpu`, `cuda-12`, `cuda-13`, `metal` | no | `packages/node-agent/internal/agent/meshllm_install.go::DetectMeshLLMFlavor`, `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` | [REQ-NODE-006](../../sdd/spec/node-agent.md) |
| `meshllmAllowUnpinned` | `false` | no | `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` | [REQ-NODE-006](../../sdd/spec/node-agent.md) |
| `llamaCppBinaryPath` | empty (managed upstream release asset) | no | `packages/node-agent/cmd/inference-mesh-agent/main.go::llamaCppBinaryPath`, `packages/node-agent/internal/agent/llamacpp_manager.go::LlamaCppManager` | [REQ-NODE-013](../../sdd/spec/node-agent.md#req-node-013-runtime-binary-bootstrap) |
| `INFERENCE_MESH_LLAMA_CPP_BACKEND` | auto-detected (`metal` on macOS; `rocm`, `nvidia`, `vulkan`, else `cpu`) | no | `packages/node-agent/internal/agent/llamacpp_install.go::detectLlamaCppBackend` | [REQ-NODE-013](../../sdd/spec/node-agent.md#req-node-013-runtime-binary-bootstrap) |
| `nostrRelays` | empty (mesh-llm's built-in public relay defaults) | no | `packages/node-agent/internal/agent/config.go::Config`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs` | [REQ-SEC-004](../../sdd/spec/security.md) |
| `runtimeModel` | `unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/metrics.go::RuntimeMetrics` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `publicModels` | `["codeflare-mesh"]` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/client.go::HeartbeatFromConfig` | [REQ-RUN-001](../../sdd/spec/runtime-profiles.md) |
| `activeProfileIds` | `["mesh-default-qwen36-35b"]` | no | `packages/node-agent/internal/agent/config.go::DefaultConfig`, `packages/node-agent/internal/agent/client.go::HeartbeatFromConfig` | [REQ-RUN-004](../../sdd/spec/runtime-profiles.md) |
| `profiles` | claim/heartbeat response | no | `packages/node-agent/internal/agent/client.go::ApplyDesiredProfiles`, `packages/node-agent/internal/agent/runtime.go::SelectedProfile`, `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs`, `packages/node-agent/internal/agent/llamacpp_manager.go::LlamaCppManager` | [REQ-NODE-002](../../sdd/spec/node-agent.md), [REQ-RUN-002](../../sdd/spec/runtime-profiles.md), [REQ-RUN-003](../../sdd/spec/runtime-profiles.md), [REQ-RUN-010](../../sdd/spec/runtime-profiles.md), [REQ-RUN-011](../../sdd/spec/runtime-profiles.md#req-run-011-custom-model-onboarding) |
| `HF_TOKEN` | node service environment | no, only for gated Hugging Face models pulled by `mesh-llm` | `packages/node-agent/internal/agent/meshllm_render.go::MeshLLMEnv` | [REQ-RUN-010](../../sdd/spec/runtime-profiles.md) |
| `capacity` | `1` | no | `packages/node-agent/internal/agent/client.go::HeartbeatFromConfig` | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| `dataDir` | `.inference-mesh` (installers set a system dir: Linux `/var/lib/inference-mesh`, macOS `/usr/local/var/inference-mesh`, Windows `%ProgramData%\InferenceMesh`) | no | `packages/node-agent/cmd/inference-mesh-agent/main.go::defaultDataDir` | [REQ-RUN-003](../../sdd/spec/runtime-profiles.md) |
| `allowAllInterfaces` | `false` | no | `packages/node-agent/internal/agent/config.go::ListenerAddress` | [REQ-NODE-001](../../sdd/spec/node-agent.md), [REQ-SEC-004](../../sdd/spec/security.md) |

For direct llama.cpp, the agent first tries a matching host-installed `llama-server` on PATH and in common install locations before downloading a managed upstream asset for the detected backend. `INFERENCE_MESH_LLAMA_CPP_BACKEND` can force the managed fallback selector (`cpu`, `vulkan`, `rocm`, `sycl`, or `nvidia`) when auto-detection is wrong. `llamaCppBinaryPath` is the escape hatch when the service account cannot see the known-good CUDA-enabled install. Set it to the absolute path of the fast `llama-server` binary already validated on that machine; the agent skips the managed asset and runs that binary with the same profile flags (`--gpu-layers`, `--flash-attn`, batch settings, and cache settings). `nostrRelays` sets the Nostr rendezvous relays `mesh-llm` uses to discover peers over the WARP overlay; leaving it empty uses `mesh-llm`'s built-in public relay defaults, and it is the hook for pointing the fleet at a private relay. Relays exchange peer identity and WARP Mesh IP only, never inference; the encrypted iroh data transport stays pinned to the WARP overlay ([security.md](security.md)). `capacity` is reported on every heartbeat but is advisory only: entry-node selection applies no capacity gate, since `mesh-llm` owns concurrency across the mesh. ([REQ-SEC-004](../../sdd/spec/security.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))

Legacy config loads persist a generated `dashboardToken` before dashboard controls are served. ([REQ-SEC-005](../../sdd/spec/security.md)) <!-- @impl: packages/node-agent/internal/agent/config.go::LoadConfig -->

Before first claim, config startup persists `meshIp` from the detected WARP address, preferring the WARP-range address when a LAN address coexists; a host with no WARP adapter falls back to a single unambiguous private address, and a host that resolves neither must set `meshIp` explicitly or the agent fails with an actionable error before claim. ([REQ-NODE-008](../../sdd/spec/node-agent.md)) <!-- @impl: packages/node-agent/internal/agent/config.go::ApplyDetectedMeshIP --> <!-- @impl: packages/node-agent/internal/agent/config.go::RequireMeshIP -->

The `INFERENCE_MESH_CONFIG` environment variable overrides the config path for both the `install` and `run` commands. Each installer sets it (and passes `--config`) to a system state directory and points the service at it: the Linux installer uses `/var/lib/inference-mesh/config.json` via the systemd unit's `Environment` and `WorkingDirectory`, the macOS installer uses `/usr/local/var/inference-mesh/config.json` via the launchd plist, and the Windows installer uses `%ProgramData%\InferenceMesh\config.json` via the scheduled task. The running service therefore resolves the exact config the install step wrote regardless of the invoking user's home directory. ([REQ-NODE-001](../../sdd/spec/node-agent.md)) ([REQ-ADM-004](../../sdd/spec/setup-admin.md)) <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigPath --> <!-- @impl: packages/router-worker/src/installers.ts::INSTALLER_ANCHORS -->

The router calls `seedDefaultProfiles(DEFAULT_MODEL_PROFILES)` at request entry, so D1 deployments receive and refresh shipped defaults before setup/status/provider/admin reads. `seedDefaultProfiles` refreshes changed managed defaults and retires only legacy active rows at version `<= 1` that still own a shipped public alias but are no longer current defaults. A custom or direct llama.cpp profile is not swept solely because its runtime is not `meshllm`; if it has already claimed the shipped alias, the seeded default is inserted inactive. ([REQ-RUN-002](../../sdd/spec/runtime-profiles.md)) ([REQ-RUN-009](../../sdd/spec/runtime-profiles.md)) <!-- @impl: packages/router-worker/src/router.ts::createRouter --> <!-- @impl: packages/router-worker/src/store.ts::seedDefaultProfiles -->

`HF_TOKEN` is not stored in router profiles. When a gated Hugging Face model is used, provide `HF_TOKEN` in the node service environment; `MeshLLMEnv` passes the inherited service environment through to the supervised `mesh-llm` process (adding only `MESH_LLM_NO_SELF_UPDATE=1`) so `mesh-llm` can pull the model from Hugging Face without the Worker returning secrets to nodes. ([REQ-RUN-010](../../sdd/spec/runtime-profiles.md)) <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::MeshLLMEnv -->

## Model runtime tunables

Each model carries runtime-specific tunables, edited from the model's Manage drawer (Advanced runtime) or over `POST /admin/profiles/config` / `POST /api/v1/models/{id}`. MeshLLM values are rendered into the node's per-profile `meshllm-<profileId>.toml` under their MeshLLM subtables; a value left blank (Auto / unset) is omitted so MeshLLM auto-plans it. Direct llama.cpp values are rendered into `llama-server` flags and require a pinned context window for cache-local coding sessions. ([REQ-RUN-015](../../sdd/spec/runtime-profiles.md#req-run-015-direct-llamacpp-launch-rendering)) Runtime binary versions are selected separately from Settings or `PUT /api/v1/runtime-versions`; the router stores desired MeshLLM and llama.cpp versions and nodes download/install those releases on heartbeat. New custom models are created with the defaults below. ([REQ-RUN-002](../../sdd/spec/runtime-profiles.md#req-run-002-default-model-profiles), [REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-meshllm-runtime), [REQ-RUN-011](../../sdd/spec/runtime-profiles.md#req-run-011-custom-model-onboarding), [REQ-ADM-021](../../sdd/spec/setup-admin.md#req-adm-021-model-serving-configuration), [REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility))

| Setting | MeshLLM config key | Default | What it is / does |
| --- | --- | --- | --- |
| Context window | `model_fit.ctx_size` | Auto | Max tokens kept in context. Auto lets MeshLLM size it to the GPU and model. Pin a number (for example `262144`) to fix it; larger uses more GPU memory and can leave room for fewer lanes. |
| Parallel lanes | `throughput.parallel` | `4` | Concurrent request slots. `2` or more is required for the shared input cache; `4` is the custom-model default. |
| KV cache type (keys) | `model_fit.cache_type_k` | `q8_0` | Precision of the cached keys. `q8_0` halves memory versus `f16` with negligible quality loss; `q4_0` quarters it to fit very large contexts. |
| KV cache type (values) | `model_fit.cache_type_v` | `q8_0` | Precision of the cached values; same trade-off as the keys. |
| Prefill batch | `model_fit.batch` | `2048` | Tokens processed per prefill step. Higher (for example `8192`) speeds long-prompt ingestion but uses more memory. |
| Micro-batch | `model_fit.ubatch` | `512` | Physical sub-batch of the prefill batch. Higher (for example `4096`) speeds ingestion at higher memory. |
| Flash attention | `model_fit.flash_attention` | On (`enabled`) | Memory-efficient attention; also required for quantized KV. Leave on unless a model is incompatible. |
| Max output tokens | `request_defaults.max_tokens` | `8192` | Cap on tokens generated per response, including reasoning tokens. Bounds runaway generations. Must stay above the reasoning budget so the model has room to answer. |
| Reasoning | `request_defaults.reasoning_*` | On, `deepseek`, budget `4096` | Enables model thinking and caps its token budget. Applies only to reasoning-capable models. |
| Input (prefix) cache | `model_fit.prefix_cache.*` (`enabled`, `payload_mode`, `max_entries`, `shared_stride_tokens`, `shared_record_limit`) | On; family-aware payload mode; `16` entries | Reuses the KV of a shared prompt prefix so follow-up turns prefill only new tokens. |

Parallel lanes are explicit. An omitted value does not auto-plan to four lanes, so MeshLLM may pick a single busy lane and queue long prefills until callers see `Model execution failed`. Lanes share one KV pool, so more lanes cost little extra memory.

Reasoning budget counts against max output tokens; keep it below that cap. Prefix-cache `payload_mode` is load-bearing: recurrent-hybrid families (`qwen35`, `qwen3.6`, `qwen3-next`, `falcon-h1`, `mamba`, `rwkv`) need `kv-recurrent`, while dense families use `resident-kv`. New custom models auto-set it from the model reference; correct an override if the architecture is misdetected. Prefix cache also needs `parallel >= 2` to run, and `max_entries` stays capped at `128` to avoid KV-cell exhaustion.

Context window defaults to Auto so MeshLLM sizes it to the GPU; pinning a small context on a large model collapses the lane count. Parallel lanes and the input cache default on (not Auto): an omitted parallel lets MeshLLM pick a single lane, and an omitted cache defers to family auto-detection that leaves it off for uncertified families, which together is why input caching never engaged. Direct llama.cpp defaults target high-throughput, cache-local coding sessions: context window `262144`, parallel slots `4`, KV cache types `q4_0`, prefill batch `8192`, micro-batch `2048`, flash attention on, prompt cache on, cache reuse `256`, generation cap `16384`, and reasoning on / `deepseek` / `8192`. Raising context, parallelism, batch, or micro-batch can improve capacity or prompt-loading speed, but it also increases memory pressure; lower those values if requests fail under load.

Direct llama.cpp profiles use these settings:

| Setting | llama-server flag | Default | What it is / does |
| --- | --- | --- | --- |
| Context window | `--ctx-size` | `262144` | Direct profiles require a pinned context window (`>= 4096`) so coding-session KV reuse has a stable cache budget. |
| Parallel slots | `--parallel` | `4` | Number of concurrent llama.cpp slots for the node-local runtime. More slots can serve more overlapping requests but reserve more KV memory. |
| GPU layers | `-ngl` / `--gpu-layers` / `--n-gpu-layers` | `99` | Max layers stored in VRAM. Higher values usually improve generation speed; `0` is CPU-only; `all` and `auto` follow llama.cpp's documented values. |
| KV cache type (keys) | `--cache-type-k` | `q4_0` | Precision of cached keys. Lower precision uses less KV memory and can fit larger contexts; higher precision uses more memory. |
| KV cache type (values) | `--cache-type-v` | `q4_0` | Precision of cached values. Match the key type unless testing a specific memory/quality tradeoff. |
| Prefill batch | `--batch-size` | `8192` | Logical prefill batch. Higher values can speed prompt ingestion but use more memory during prefill. |
| Micro-batch | `--ubatch-size` | `2048` | Physical prefill sub-batch. Higher values can improve prompt-loading speed but increase peak memory; lower it if requests fail under load. |
| Flash attention | `--flash-attn` | On | Fast/memory-efficient attention for large-context direct serving. |
| Generation cap | `-n` / `--predict` / `--n-predict` | `16384` | Server-side default/max tokens to predict. Requests may still pass `max_tokens`; keep this above the reasoning budget so answers are not cut off. |
| Prompt cache | `--cache-prompt` | On | Keeps prompt/KV reuse enabled; leave on for cache-local coding sessions. |
| Cache reuse | `--cache-reuse` | `256` | llama.cpp reuse window for prompt/KV cache matching. |
| Reasoning | `--reasoning`, `--reasoning-format`, `--reasoning-budget` | On, `deepseek`, budget `8192` | Thinking-mode controls for reasoning-capable chat templates. The reasoning budget is part of the generation cap; higher budgets can delay the final answer. |
| Bind port | `--port` | derived per profile | The node-local llama.cpp API port; reserved mesh/proxy ports are rejected. |

## GitHub secrets

The GitHub Actions secret inventory is maintained in the private operations repository:

https://github.com/nikolanovoselec/codeflare-inference-mesh-private

When required secrets, optional secrets, consumers, or REQ backlinks change, update the private README as the source of truth. This public configuration lane intentionally does not duplicate the operational secret matrix.

## GitHub variables

The GitHub Actions variable inventory is maintained in the private operations repository:

https://github.com/nikolanovoselec/codeflare-inference-mesh-private

When deploy variables, defaults, consumers, or REQ backlinks change, update the private README as the source of truth. This public configuration lane intentionally does not duplicate the operational variable matrix.

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
