# Troubleshooting

## Contents

- [AI Gateway returns authentication errors](#ai-gateway-returns-authentication-errors)
- [Worker cannot reach node](#worker-cannot-reach-node)
- [Requests return no-node](#requests-return-no-node)
- [Session latency suddenly increases](#session-latency-suddenly-increases)
- [Installer cannot verify artifact](#installer-cannot-verify-artifact)
- [Node reports dependency-missing](#node-reports-dependency-missing)
- [Peer count stays at one](#peer-count-stays-at-one)
- [Model never appears in ready models](#model-never-appears-in-ready-models)
- [Requests fail briefly after mesh rotation](#requests-fail-briefly-after-mesh-rotation)
- [Admin status shows mesh_state_key_missing](#admin-status-shows-mesh_state_key_missing)
- [Dashboard shows "The router hit a temporary error"](#dashboard-shows-the-router-hit-a-temporary-error)
- [Update staging checksum mismatch](#update-staging-checksum-mismatch)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## AI Gateway returns authentication errors

**Symptom:** Gateway calls reach the Worker but `/v1/*` responds with an auth error.

**Cause:** The provider key/BYOK value does not match the router provider token verifier, or Gateway sends the credential in a different header than expected.

**Fix:** Run the header validation path during initial setup, confirm header names only, rotate the provider token if needed, and update the Gateway provider key. ([REQ-GWY-002](../../sdd/spec/gateway.md)) ([REQ-GWY-004](../../sdd/spec/gateway.md))

## Worker cannot reach node

**Symptom:** Router returns service-unavailable errors when a node appears registered.

**Cause:** Mesh IP, allowed CIDR, listener binding, firewall, WARP enrollment, or Workers VPC binding is wrong.

**Fix:** Verify WARP/Mesh enrollment, validate the Mesh IP in admin status, confirm the listener port, and check `env.MESH.fetch` against the node health endpoint. ([REQ-RTR-004](../../sdd/spec/router-worker.md)) ([REQ-NODE-002](../../sdd/spec/node-agent.md))

## Requests return no-node

**Symptom:** Client receives `429` with `no-node` plus a request ID.

**Cause:** No eligible node can currently serve the requested public model.

**Fix:** Use the request ID to inspect admin status, free an in-flight request, start another compatible node, or switch the public alias to a ready fallback profile. ([REQ-SCH-005](../../sdd/spec/state-scheduling.md)) ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

## Session latency suddenly increases

**Symptom:** A coding session that was fast starts spending time on long prefill.

**Cause:** The session moved nodes, a lease expired, or the runtime cache was cleared during restart/profile switch.

**Fix:** Check node eligibility, recent failures, runtime restarts, and audit events; confirm another eligible node is available before moving the session. ([REQ-SCH-004](../../sdd/spec/state-scheduling.md)) ([REQ-OBS-004](../../sdd/spec/observability.md))

## Installer cannot verify artifact

**Symptom:** Install script downloads an archive but refuses to install it.

**Cause:** The archive hash does not match `checksums.txt`, the checksum signature is missing when required, or the release manifest does not match the platform.

**Fix:** Re-run the deploy workflow, verify uploaded artifacts and checksums, and confirm the installer selected the correct OS/architecture asset. ([REQ-ADM-004](../../sdd/spec/setup-admin.md)) ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Node reports dependency-missing

**Symptom:** Admin status shows a node with runtime state `dependency-missing`, and the node is not selected for requests.

**Cause:** The agent could not install or find the pinned `mesh-llm` release: the downloaded asset's SHA-256 did not match the embedded pin (the install is refused), no pinned asset exists for the detected OS/architecture/flavor, or egress to `github.com` release downloads is blocked.

**Fix:** Check the agent log for the `runtime dependency missing` cause, confirm the flavor configuration matches the node hardware, allow GitHub egress from the node, then restart the agent service. ([REQ-NODE-006](../../sdd/spec/node-agent.md#req-node-006-meshllm-binary-install-and-update)) ([REQ-RUN-010](../../sdd/spec/runtime-profiles.md#req-run-010-meshllm-process-lifecycle)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))

## Peer count stays at one

**Symptom:** The first node serves, but a second node never joins the mesh: `peerCount` stays `1` and the mesh health entry never lists the joiner in `peerNodeIds`.

**Cause:** UDP is blocked on the profile's mesh bind port between the nodes' WARP IPs, the WARP split-tunnel configuration excludes `100.96.0.0/12` so mesh traffic bypasses the tunnel, or the joining node is dialing with stale join tokens.

**Fix:** Verify WARP routes include the mesh range on both nodes, allow UDP on the configured bind port between the WARP IPs, and check `tokenCount` and `rotation` in the `/admin/status` mesh health entry; rotate the mesh once to reissue tokens when they are stale. ([REQ-RUN-006](../../sdd/spec/runtime-profiles.md#req-run-006-private-mesh-formation)) ([REQ-RUN-008](../../sdd/spec/runtime-profiles.md#req-run-008-router-mesh-membership-authority)) ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface))

## Model never appears in ready models

**Symptom:** Nodes join the mesh but the profile's model never shows up in mesh health `readyModels`, and member nodes stay `starting` or `downloading`.

**Cause:** A split profile's stages are incomplete — not every serving node needed for the layer split is online — or the model download is still in progress.

**Fix:** Compare `stageCount` in node metrics against the online serving nodes for the profile, and check the agent dashboard for `downloading` state; start the missing nodes or let the download finish. ([REQ-RUN-007](../../sdd/spec/runtime-profiles.md#req-run-007-split-serving-via-layer-packages)) ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting))

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

**Cause:** The action's admin route threw an uncaught exception and hit the Worker's top-level catch-all, which appends a `router_error` audit event and returns `{ "error": "internal_error", "requestId": string }` at `500`. This is commonly a transient D1 cold-start or a read race during setup, but it can also mask a real defect. ([REQ-ADM-007](../../sdd/spec/setup-admin.md#req-adm-007-operator-dashboard))

**Fix:** Retry the action after a few seconds. If it persists, look up the `router_error` audit entry by the `requestId` shown in the toast (or in the Worker runtime logs) to find the underlying exception, and check D1 availability if the action touches profile or mesh state. <!-- @impl: packages/router-worker/src/admin-ui-client.ts::ADMIN_UI_CLIENT_SCRIPT --> <!-- @impl: packages/router-worker/src/router.ts::createRouter -->

## Setup step fails after a Cloudflare permission or API error

**Symptom:** A setup or Routing action (Enable Access, Connect AI Gateway, Provision domain) shows "The router hit a temporary error", and the `router_error` audit entry reads `Cloudflare Access API failed: 403` or `Cloudflare API failed: 400`.

**Cause:** The Worker's `CLOUDFLARE_API_TOKEN_RUNTIME` reached Cloudflare but the call was rejected. A `403` means the token lacks a permission the step needs: Access provisioning needs `Access: Apps and Policies Edit` and `Access: Organizations, Identity Providers, and Groups Edit`; Gateway sync needs `AI Gateway: Edit`; custom-domain provisioning needs `Workers Routes: Edit` and target-zone DNS edit (the README "Deploy secrets and token scopes" section lists the full set). A `400` means Cloudflare rejected the request payload. ([REQ-GWY-003](../../sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation))

**Fix:** For a `403`, add the missing permission to the runtime token in the Cloudflare dashboard (editing a token's permissions keeps its value, so no redeploy is needed), then retry. For a `400`, read the Cloudflare error code and message that the `router_error` audit entry now includes to find the rejected field. <!-- @impl: packages/router-worker/src/cloudflare-api.ts::formatCloudflareApiErrors --> <!-- @impl: packages/router-worker/src/router.ts::createRouter -->

## Update staging checksum mismatch

**Symptom:** Update staging refuses an agent archive.

**Cause:** The downloaded archive hash does not match the expected SHA-256.

**Fix:** Re-download the artifact and `checksums.txt` from the same release tag, then stage the update again. ([REQ-NODE-005](../../sdd/spec/node-agent.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Scheduler miss responses | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS`, `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Failure reporting | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::releaseOnCompletion`, `packages/router-worker/src/scheduler.ts::recordFailure` <!-- @impl: packages/router-worker/src/router.ts::releaseOnCompletion --> <!-- @impl: packages/router-worker/src/scheduler.ts::recordFailure --> |
| Update checksum staging | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/update.go::StageUpdate` <!-- @impl: packages/node-agent/internal/agent/update.go::StageUpdate --> |
| MeshLLM install failures | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM --> |
| Mesh state and rotation | [security.md](../../sdd/spec/security.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Runtime readiness states | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_status.go::MapMeshLLMState` <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::MapMeshLLMState --> |
