# Troubleshooting

## Contents

- [AI Gateway returns authentication errors](#ai-gateway-returns-authentication-errors)
- [Worker cannot reach node](#worker-cannot-reach-node)
- [Node service crash-loops after install](#node-service-crash-loops-after-install)
- [Node cannot determine its Mesh IP](#node-cannot-determine-its-mesh-ip)
- [Requests return 503 no_healthy_node](#requests-return-503-no_healthy_node)
- [Node stays orange and serves nothing](#node-stays-orange-and-serves-nothing)
- [Session latency suddenly increases](#session-latency-suddenly-increases)
- [Prompt-prefix (input) caching is never reused and every request re-prefills](#prompt-prefix-input-caching-is-never-reused-and-every-request-re-prefills)
- [Installer cannot verify artifact](#installer-cannot-verify-artifact)
- [Node reports dependency-missing](#node-reports-dependency-missing)
- [Peer count stays at one](#peer-count-stays-at-one)
- [Model never appears in ready models](#model-never-appears-in-ready-models)
- [Requests fail briefly after mesh rotation](#requests-fail-briefly-after-mesh-rotation)
- [Admin status shows mesh_state_key_missing](#admin-status-shows-mesh_state_key_missing)
- [Dashboard shows "The router hit a temporary error"](#dashboard-shows-the-router-hit-a-temporary-error)
- [Setup step fails after a Cloudflare permission or API error](#setup-step-fails-after-a-cloudflare-permission-or-api-error)
- [AI Gateway sync fails with an actionable message](#ai-gateway-sync-fails-with-an-actionable-message)
- [Requests return 429 rate_limited](#requests-return-429-rate_limited)
- [Update staging checksum mismatch](#update-staging-checksum-mismatch)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## AI Gateway returns authentication errors

**Symptom:** Gateway calls reach the Worker but `/v1/*` responds with an auth error.

**Cause:** The provider key/BYOK value does not match the router provider token verifier, or Gateway sends the credential in a different header than expected.

**Fix:** Run the header validation path during initial setup, confirm header names only, rotate the provider token if needed, and update the Gateway provider key. ([REQ-GWY-002](../../sdd/spec/gateway.md)) ([REQ-GWY-004](../../sdd/spec/gateway.md))

## Worker cannot reach node

**Symptom:** Router returns service-unavailable errors, or requests to a registered node stall on a handshake timeout.

**Cause:** Mesh IP, allowed CIDR, listener binding, WARP enrollment, or the Workers VPC binding is wrong; a default-deny host firewall is dropping inbound WARP traffic; or the WARP-to-WARP network policy is off.

**Fix:** The agent auto-provisions the inbound mesh firewall rule at startup — if its log reports the rule was not provisioned, allow inbound TCP on the mesh port over the WARP interface by hand (`ufw allow in on <WARP-interface> to any port <inferencePort> proto tcp`). Confirm the *Allow all Cloudflare One traffic to reach enrolled devices* Zero Trust toggle is on, verify WARP/Mesh enrollment and the Mesh IP in admin status, confirm the listener port, and check `env.MESH.fetch` against the node health endpoint. ([REQ-NODE-010](../../sdd/spec/node-agent.md)) ([REQ-RTR-004](../../sdd/spec/router-worker.md)) ([REQ-NODE-002](../../sdd/spec/node-agent.md))

## Node service crash-loops after install

**Symptom:** The install command finishes but `inference-mesh-agent.service` restarts every few seconds and never enrolls; `journalctl -u inference-mesh-agent` shows a `read config: open ... no such file or directory` error and the setup token stays unconsumed.

**Cause:** The service resolved a config path that differs from where the install step wrote it — typically because the unit ran without an explicit config path and fell back to a home-relative or working-directory-relative location.

**Fix:** Use an installer that runs the agent with `--config` and sets `INFERENCE_MESH_CONFIG` to the system state path (`/var/lib/inference-mesh/config.json`) with a matching `WorkingDirectory`; confirm the file exists and re-run the install command to regenerate the unit. ([REQ-NODE-001](../../sdd/spec/node-agent.md)) ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

## Node cannot determine its Mesh IP

**Symptom:** The agent exits before claim with a message that the Mesh IP is unset and could not be auto-detected, or the claim is rejected for a missing `meshIp`.

**Cause:** No Cloudflare WARP adapter is connected, or more than one candidate address exists in the chosen tier so detection fails closed.

**Fix:** Connect WARP (desktop client or a headless `warp-cli` enrollment) so the node has a `100.96.0.0/12` address on the `CloudflareWARP` adapter, or set `meshIp` explicitly in the agent config to the node's WARP address. ([REQ-NODE-008](../../sdd/spec/node-agent.md))

## Requests return 503 no_healthy_node

**Symptom:** Client receives `503` with `no_healthy_node` plus a request ID. (A `502 node_unreachable` is different: a node was selected but its Mesh transport failed.)

**Cause:** No eligible node can currently serve the requested public model: every candidate is offline, still downloading or starting, reporting an unsafe Mesh target, or has been deactivated by an operator. The router holds no reservation state, so a healthy idle node is never wedged out of selection by a leaked reservation.

**Fix:** Use the request ID to inspect admin status, then start another compatible node, reactivate a deactivated one (see [Node stays orange and serves nothing](#node-stays-orange-and-serves-nothing)), or switch the public alias to a ready fallback profile. A `502 node_unreachable` instead points at WARP reachability; see [Worker cannot reach node](#worker-cannot-reach-node). ([REQ-SCH-005](../../sdd/spec/state-scheduling.md)) ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md)) ([REQ-SCH-002](../../sdd/spec/state-scheduling.md))

## Node stays orange and serves nothing

**Symptom:** A node shows online and heartbeats normally, but its status reads deactivated (orange/yellow), it runs no `mesh-llm` process, and it is never selected for inference.

**Cause:** An operator deactivated the node, using the node detail drawer's Deactivate control or `POST /api/v1/nodes/{id}/deactivate`. A deactivated node stays enrolled and keeps heartbeating so it can be reactivated instantly, but the router answers its heartbeats with an empty desired-profile set, the agent never launches the runtime, and the node is excluded from selection.

**Fix:** This is expected while deactivation is intentional. To bring the node back into service, activate it from the node detail drawer or `POST /api/v1/nodes/{id}/activate`; its next heartbeat carries the active profiles again and the agent relaunches `mesh-llm`. ([REQ-ADM-030](../../sdd/spec/setup-admin.md#req-adm-030-node-deactivation-and-activation)) ([REQ-NODE-011](../../sdd/spec/node-agent.md#req-node-011-deactivated-nodes-run-no-model))

## Session latency suddenly increases

**Symptom:** A coding session that was fast starts spending time on long prefill.

**Cause:** The cache-warm peer changed (a node drained, a lease expired, or the runtime cache was cleared during a restart or profile switch), so `mesh-llm`'s KV-aware routing had to rebuild the prefix cache on another peer.

**Fix:** Check node eligibility, recent failures, runtime restarts, and audit events; confirm enough eligible peers stay online for `mesh-llm` to keep the prefix cache warm. ([REQ-SCH-002](../../sdd/spec/state-scheduling.md)) ([REQ-OBS-004](../../sdd/spec/observability.md))

## Prompt-prefix (input) caching is never reused and every request re-prefills

**Symptom:** Every request re-processes the whole prompt (`usage.prompt_tokens_details.cached_tokens` stays `0` and prefill is slow), even for requests that share a large system/context prefix.

**Cause:** The model's parallel lanes resolved to a single lane, so `mesh-llm`'s resident prefix cache never engages (it needs a shared multi-lane KV pool). Pinning a small context window is the usual trigger: a small `ctx_size` on a large model, or leaving lanes at `1`, collapses the lane count.

**Fix:** In the model's Manage drawer (Advanced runtime), set **Parallel lanes** to `2` or more, and leave **Context window** on Auto (or pin the model's real limit with **KV cache type** `q4_0`/`q8_0` so the large context still fits GPU memory). See [Model runtime tunables](configuration.md#model-runtime-tunables) for the full table and a proven high-throughput profile. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-meshllm-runtime), [REQ-ADM-021](../../sdd/spec/setup-admin.md#req-adm-021-model-serving-configuration))

## Installer cannot verify artifact

**Symptom:** Install script downloads an archive but refuses to install it.

**Cause:** The archive hash does not match `checksums.txt`, the checksum signature is missing when required, or the release manifest does not match the platform.

**Fix:** Re-run the deploy workflow, verify uploaded artifacts and checksums, and confirm the installer selected the correct OS/architecture asset. ([REQ-ADM-004](../../sdd/spec/setup-admin.md)) ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Node reports dependency-missing

**Symptom:** Admin status shows a node with runtime state `dependency-missing`, and the node is not selected for requests.

**Cause:** The agent could not install or find the pinned `mesh-llm` release: the downloaded asset's SHA-256 did not match the embedded pin (the install is refused), no pinned asset exists for the detected OS/architecture/flavor, or egress to `github.com` release downloads is blocked.

**Fix:** Check the agent log for the `runtime dependency missing` cause, confirm the flavor configuration matches the node hardware, allow GitHub egress from the node, then restart the agent service. ([REQ-NODE-006](../../sdd/spec/node-agent.md#req-node-006-meshllm-binary-install-and-update)) ([REQ-RUN-010](../../sdd/spec/runtime-profiles.md#req-run-010-meshllm-process-lifecycle)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))

## Runtime exits with `libcudart.so.<N>: cannot open shared object file`

**Symptom:** A GPU node stays at runtime state `failed` with `runtime process exited before readiness`; the agent log or a manual `ldd` on `mesh-llm` shows a missing `libcudart.so.12` or `libcudart.so.13` (and companions `libcublas.so.<N>`, `libnccl.so.2`).

**Cause:** The downloaded CUDA build's flavor does not match the host's installed CUDA runtime major — the binary dlopens `libcudart.so.<major>` at startup, so a `cuda-12` build on a CUDA-13-only host (or vice versa) fails at library load before readiness. The agent now auto-selects `cuda-13` versus `cuda-12` from the host's resolvable `libcudart.so.<major>`, but a host whose CUDA libraries sit outside the loader cache and the scanned toolkit directories can still resolve the wrong flavor.

**Fix:** Confirm which runtime is installed (`ldconfig -p | grep libcudart`), then either add the CUDA library directory to the loader path (`ldconfig`) so detection can see it, or pin the matching build with the `meshllmFlavor` override (`cuda-12`, `cuda-13`, or `cpu`) in the node config and restart the agent service. ([REQ-NODE-006](../../sdd/spec/node-agent.md#req-node-006-meshllm-binary-install-and-update)) ([REQ-RUN-010](../../sdd/spec/runtime-profiles.md#req-run-010-meshllm-process-lifecycle))

## Peer count stays at one

**Symptom:** A split model node stays `starting`/`standby`, the node table says the mesh is waiting for peers, or a second node never joins the mesh: `peerCount` stays `0` or `1` and the mesh health entry never lists the joiner in `peerNodeIds`.

**Cause:** UDP is blocked on the profile's mesh bind port between the nodes' WARP IPs, the WARP split-tunnel configuration excludes `100.96.0.0/12` so mesh traffic bypasses the tunnel, the second node is not running the same active model/split profile, or the joining node is dialing with stale/missing join tokens.

**Fix:** Open the node's Manage drawer first: it shows the peer-discovery blocker with the bind port and next checks. The agent auto-provisions the inbound UDP rule for the profile's bind port on the WARP interface at startup and on every profile switch (ufw on Linux, `New-NetFirewallRule` on Windows; macOS's firewall is app-scoped and left manual), so a persistent block usually means ufw is absent, the WARP interface was not detected, or the host firewall is managed another way — add `ufw allow in on <WARP iface> to any port <bind port> proto udp` (or the platform equivalent) by hand. Also verify both nodes run the same active split profile/model, WARP routes include the mesh range on both nodes, and the split-tunnel does not exclude `100.96.0.0/12`. Check `tokenCount` and `rotation` in the `/admin/status` mesh health entry; rotate the mesh once to reissue tokens when they are stale. ([REQ-NODE-010](../../sdd/spec/node-agent.md#req-node-010-inbound-mesh-firewall-provisioning)) ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md#req-run-006-private-mesh-formation)) ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md#req-run-008-router-mesh-membership-authority)) ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface)) ([REQ-OBS-011](../../sdd/spec/observability.md#req-obs-011-runtime-error-surface))

## Model never appears in ready models

**Symptom:** Nodes join the mesh but the profile's model never shows up in mesh health `readyModels`, and member nodes stay `starting` or `downloading`.

**Cause:** A split profile's stages are incomplete — not every serving node needed for the layer split is online — or the model download is still in progress.

**Fix:** Compare `stageCount` in node metrics against the online serving nodes for the profile, and check the agent dashboard for `downloading` state; start the missing nodes or let the download finish. If a node is wedged in `starting` and will not converge (a stalled load or a split that never completes its stage handshake), restart its runtime with Force Reload from the node's Manage drawer or `POST /api/v1/nodes/{id}/reload` rather than SSHing in to kill `mesh-llm`. ([REQ-RUN-007](../../sdd/spec/runtime-profiles.md#req-run-007-split-serving-via-layer-packages)) ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting)) ([REQ-ADM-032](../../sdd/spec/setup-admin.md#req-adm-032-node-force-reload))

## Requests fail briefly after mesh rotation

**Symptom:** Right after an admin mesh rotation, member nodes restart and some requests fail over to other nodes or queue.

**Cause:** Rotation is a deliberate hard cut: the incremented rotation counter renders a new mesh name, and every member drains and restarts into the new mesh, which takes up to about two minutes to reconverge.

**Fix:** Treat up to two minutes of restarts and reconnects as expected, wait for the mesh health entry to show the new rotation with peers rejoined, and do not trigger rotations in quick succession. ([REQ-SEC-006](../../sdd/spec/security.md#req-sec-006-mesh-token-lifecycle))

## Admin status shows mesh_state_key_missing

**Symptom:** The admin UI shows a `mesh_state_key_missing` banner, mesh rotation returns an error, and no mesh bootstrap is issued, while claim, heartbeats, and scheduling of already-ready nodes keep working.

**Cause:** The `MESH_STATE_KEY` Worker secret is unset, so the Worker cannot encrypt or decrypt mesh state and the mesh endpoints fail closed.

**Fix:** Run the deploy workflow, which validates the secret and sets it on the Worker, then confirm the banner clears from admin status. ([REQ-SEC-006](../../sdd/spec/security.md#req-sec-006-mesh-token-lifecycle))

## Dashboard shows "The router hit a temporary error"

**Symptom:** An admin or read-only user action in the console shows a toast and result reading "The router hit a temporary error. Give it a moment and try again. (request <id>)" instead of completing.

**Cause:** The action's admin route threw an uncaught exception and hit the Worker's top-level catch-all, which appends a `router_error` audit event and returns `{ "error": "internal_error", "requestId": string }` at `500`. This is commonly a transient D1 cold-start or a read race during setup, but it can also mask a real defect. ([REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances))

**Fix:** Retry the action after a few seconds. If it persists, look up the `router_error` audit entry by the `requestId` shown in the toast (or in the Worker runtime logs) to find the underlying exception, and check D1 availability if the action touches profile or mesh state. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @impl: packages/router-worker/src/router.ts::createRouter -->

## Setup step fails after a Cloudflare permission or API error

**Symptom:** A setup or Routing action (Enable Access, Provision domain) shows "The router hit a temporary error", and the `router_error` audit entry reads `Cloudflare Access API failed: 403` or `Cloudflare API failed: 400`.

**Cause:** The Worker's `CLOUDFLARE_API_TOKEN_RUNTIME` reached Cloudflare but the call was rejected. A `403` means the token lacks a permission the step needs: Access provisioning needs `Access: Apps and Policies Edit` and `Access: Organizations, Identity Providers, and Groups Edit`; custom-domain provisioning needs `Workers Routes: Edit` and target-zone DNS edit (the README "Deploy secrets and token scopes" section lists the full set). A `400` means Cloudflare rejected the request payload. ([REQ-GWY-006](../../sdd/spec/gateway.md#req-gwy-006-cloudflare-api-error-surfacing)) ([REQ-ADM-012](../../sdd/spec/setup-admin.md#req-adm-012-domain-and-access-provisioning))

**Fix:** For a `403`, add the missing permission to the runtime token in the Cloudflare dashboard (editing a token's permissions keeps its value, so no redeploy is needed), then retry. For a `400`, read the Cloudflare error code and message that the `router_error` audit entry now includes to find the rejected field. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::formatCloudflareApiErrors --> <!-- @impl: packages/router-worker/src/router.ts::createRouter -->

## AI Gateway sync fails with an actionable message

**Symptom:** The Routing view's "Connect AI Gateway" / re-sync action shows "The AI Gateway sync could not be completed. Confirm the gateway exists and the router Cloudflare token has AI Gateway access, then re-sync." at `424` instead of a generic temporary-error toast.

**Cause:** Gateway sync catches Cloudflare rejections from `syncCustomProvider` (needs `AI Gateway: Edit`, a missing gateway, or a route conflict) locally rather than letting them fall through to the Worker's top-level catch-all; it records a `gateway_sync_failed` audit event with the raw cause and returns `424` with the actionable copy above instead of the generic `internal_error`/`500`. ([REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances))

**Fix:** Confirm the AI Gateway named in Routing settings still exists, and add `AI Gateway: Edit` to the runtime Cloudflare token if missing, then re-sync. For the exact Cloudflare rejection, look up the `gateway_sync_failed` audit entry's `reason` field by request ID. <!-- @impl: packages/router-worker/src/router.ts::handleGatewaySync -->

## Clients get "Model execution failed" from the dynamic route while the playground works

**Symptom:** An external OpenAI-compatible client (for example an agent SDK) calling the AI Gateway dynamic route `dynamic/<route>` fails with `400`/`500`/`503` and body `{"state":"Failed","error":"Model execution failed (Error)"}` or Cloudflare code `7003`, while the console playground or a direct custom-provider call against the same gateway and model succeeds. Gateway logs show the failed call at `request_type=run`, `path=/run`.

**Cause:** Two distinct issues collapse to this generic Gateway error. If Gateway logs show no provider step or `provider=unknown`, the caller token likely lacks `AI Gateway: Run`. If Gateway logs show `provider=custom-codeflare-inference-mesh`, `model=dynamic/codeflare-mesh`, and metadata such as `user`, the route reached the router but the direct llama.cpp profile needs a session identity. Gateway log metadata from the REST dynamic-route path is not forwarded to the custom provider, so the router version must include the provider-scoped fallback session for no-forwarded-metadata calls. ([REQ-SEC-012](../../sdd/spec/security.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md#req-sch-004-direct-session-affinity))

**Fix:** First confirm the client's Cloudflare token includes `AI Gateway: Run` and is used with `cf-aig-gateway-id`. Then ensure the Worker version includes metadata-to-affinity translation plus the provider-scoped fallback. If the client can send identity fields, prefer OpenAI `user: "user:<id>|session:<id>"` or body `metadata: { "user": "<id>", "session": "<optional-session>" }`; otherwise the fallback keeps the dynamic route usable with shared provider-level affinity. Confirm with a chat completion for `dynamic/codeflare-mesh` and inspect Gateway logs for `status_code=200`.

## Requests return 429 rate_limited

**Symptom:** A public endpoint returns `429` with body `{ "error": "rate_limited", "requestId": string }` and a `Retry-After` header.

**Cause:** The request exceeded its rate-limit bucket for the current Cloudflare location. Buckets are per route class: credentialed `/v1` inference (the AI Gateway, keyed by provider token) has a high ceiling, while token-less `/v1` and other public routes are keyed by client IP with low limits, and node heartbeat, enrollment, and admin authentication have their own limits. A scheduler miss is never a rate limit: when no eligible node is ready the router returns `503 no_healthy_node`, not `429`. ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-public-endpoint-rate-limiting))

**Fix:** Wait the `Retry-After` interval and retry. If legitimate traffic is being limited, raise the affected bucket's `limit` in `wrangler.toml` (values are per Cloudflare location per 60s) and redeploy. Confirm production inference flows through the AI Gateway so it uses the high provider-token bucket rather than the low anonymous one. <!-- @impl: packages/router-worker/src/rate-limit.ts::isRateLimited -->

## Update staging checksum mismatch

**Symptom:** Update staging refuses an agent archive.

**Cause:** The downloaded archive hash does not match the expected SHA-256.

**Fix:** Re-download the artifact and `checksums.txt` from the same release tag, then stage the update again. ([REQ-NODE-005](../../sdd/spec/node-agent.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Scheduler miss responses | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS`, `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding failure responses | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::runInference` <!-- @impl: packages/router-worker/src/router.ts::runInference --> |
| Update checksum staging | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/update.go::StageUpdate` <!-- @impl: packages/node-agent/internal/agent/update.go::StageUpdate --> |
| MeshLLM install failures | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM --> |
| Mesh state and rotation | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Runtime readiness states | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_status.go::MapMeshLLMState` <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::MapMeshLLMState --> |
