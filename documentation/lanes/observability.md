# Observability

## Contents

- [Response metadata](#response-metadata)
- [Admin status](#admin-status)
- [Node metrics](#node-metrics)
- [Mesh health](#mesh-health)
- [Audit events](#audit-events)
- [Failure states](#failure-states)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Response metadata

Provider responses include request ID and selected node identity when policy permits. Error responses include request ID so operators can correlate failures with audit and node logs. ([REQ-OBS-001](../../sdd/spec/observability.md))

## Admin status

| Field group | Contents | REQs |
| --- | --- | --- |
| Nodes | Node status, public models, active profiles, runtime readiness, token throughput, GPU memory, capacity, in-flight count, and last seen. | [REQ-OBS-002](../../sdd/spec/observability.md) |
| Profiles | Public aliases, upstream model, source mode, version, rollout percent, active flag, runtime tunables used by the model drawer, and ready/downloading/failed node counts. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-RUN-001](../../sdd/spec/runtime-profiles.md), [REQ-RUN-004](../../sdd/spec/runtime-profiles.md) |
| Mesh health | One entry per MeshLLM profile: coordinator, peers, ready models, failed nodes, deactivated nodes, the profile's active state, rotation counter, and secret presence/age (see [Mesh health](#mesh-health)). | [REQ-OBS-007](../../sdd/spec/observability.md) |
| Audit | Recent setup, claim, unregister, revoke, admin recovery reset, route provisioning, profile switch, profile activation, agent version selection, and mesh lifecycle events. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-OBS-006](../../sdd/spec/observability.md) |
| Metadata | Status generation timestamp and the caller's resolved console role (`viewerRole`). | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-ADM-017](../../sdd/spec/setup-admin.md) |

## Live dashboard surface

The console renders `GET /admin/status` as a live operations surface: a stats strip (nodes serving, aggregate mesh VRAM, the latest Speed Test prompt/generation throughput when present, custom-domain status, and the fleet's desired agent version), runtime binary install status (desired version, installed version, installing/installed/failed state, and error), model-loading state from heartbeat `nodeState`, a hub-and-spoke mesh topology with node and model detail drawers, and a sortable nodes table. Runtime binary installation and model loading are separate signals: installing `llama-server` or MeshLLM is a runtime-install chip, while switching/downloading/loading a model is node state. It re-fetches on a five-second poll that pauses when the tab is hidden and resumes on focus, and a LIVE badge reflects poll freshness. ([REQ-OBS-010](../../sdd/spec/observability.md)) ([REQ-ADM-015](../../sdd/spec/setup-admin.md)) ([REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility))

Live tokens-per-second are drawn as a rolling-window trace when runtimes report an aggregate throughput signal: each poll appends the aggregate throughput as a bar and the client linearly smooths between successive samples, capping the series at the configured window. The headline performance number uses the persisted latest Speed Test summary instead, so prompt ingestion and generation speed stay separate. All values derive from the status contract — nothing is fabricated between polls. ([REQ-OBS-010](../../sdd/spec/observability.md)) The Models section lists active profiles before standby ones, preserving source order within each group, so the serving set is visible without scrolling. ([REQ-ADM-018](../../sdd/spec/setup-admin.md#req-adm-018-models-section-ordering))

Under the read-only user role the surface narrows to the overview and the playground; configuration sections are hidden client-side and refused server-side. ([REQ-ADM-017](../../sdd/spec/setup-admin.md))

## Node metrics

Heartbeats report runtime state, loaded model, active profile ID/version, in-flight count, last runtime error, and Mesh IP, plus the MeshLLM mesh view: mesh ID, mesh role (`coordinator` when the node owns stage 0, else `serving-peer` or `api-client`), peer count, ready models, split flag and stage count, API and console readiness, and the MeshLLM version. Direct llama.cpp metrics also carry the selected/installed `llama-server` version, cache settings, slot state, and latest cached-token count; runtime bootstrap failures are reported as `dependency-missing` with the install error so the router can display the failure and keep the node ineligible. Runtime metrics are decoded from the MeshLLM console status through a tolerant parser that reads only the needed subset and ignores unknown fields. ([REQ-OBS-003](../../sdd/spec/observability.md)) ([REQ-OBS-008](../../sdd/spec/observability.md)) ([REQ-NODE-013](../../sdd/spec/node-agent.md#req-node-013-runtime-binary-bootstrap))

Heartbeats also carry `runtimeDetail` — the most recent error-looking line the agent captured from mesh-llm's own stderr (an OOM, a CUDA error, a lane that never came up) — and `nodeState`. For MeshLLM, `nodeState` is the console's raw node state string; during a profile/model restart, the agent sets `nodeState` to the model being loaded so the control plane can distinguish model acquisition from runtime-binary installation. Together they make the reason a runtime is wedged legible from the control plane instead of only the host journal; the agent tees mesh-llm's stderr through a bounded ring that keeps the latest error line, and a zero value never overwrites a present one on merge. The console nodes table carries node state as a status-detail contract value, and the node Manage drawer renders these diagnostics as read-only rows: the runtime error as a highlighted row when present, alongside reported node state, mesh role, peer and stage counts, API/console reachability, and runtime version. If a heartbeat omits a field, the drawer leaves the row out or says `not reported`; omitted direct llama.cpp console, slot, cache, or throughput fields are not treated as `down`, `0`, or `on`. ([REQ-OBS-011](../../sdd/spec/observability.md))

Token throughput (`tokensPerSecond`) is read from the console status `tok_per_sec` value when the console exposes it. GPU memory is read from MeshLLM's structured per-GPU rated and used VRAM, falling back to a host GPU tool (nvidia-smi on Linux and Windows, system_profiler on macOS) when the console omits it. Metrics the upstream surface does not provide stay absent from heartbeats and admin status rather than fabricated or zero-filled: prompt-versus-generation throughput splits stay absent because the console reports a single throughput value, and GPU metrics stay absent only when both the console and the host probe are unavailable. ([REQ-OBS-009](../../sdd/spec/observability.md))

Runtime state maps from the console `node_state`:

| Console observation | Reported runtime state |
| --- | --- |
| `loading` | `downloading` |
| `serving` with the selected profile's upstream model routable in the node's own model list | `ready` |
| `serving` without that model, `standby`, `client`, or any unknown state | `starting` |
| Console unreachable or runtime process exited | `failed` |

## Mesh health

Admin status carries one mesh health entry per MeshLLM profile so operators can confirm the mesh formed, identify its coordinator, and diagnose failing members. Entries expose secret presence, age, and count only — never token or secret values. ([REQ-OBS-007](../../sdd/spec/observability.md)) ([REQ-SEC-007](../../sdd/spec/security.md))

| Field | Meaning |
| --- | --- |
| `profileId` | Profile whose mesh the entry describes. |
| `meshId` | Formed mesh identity; absent until the seed node reports one. |
| `rotation` | Mesh rotation counter; increments on each admin mesh rotation. |
| `seedNodeId` | Node elected to create the mesh; absent before election. |
| `coordinatorNodeId` | Current coordinator (stage-0 owner); absent until a member reports it. |
| `peerNodeIds` | Member nodes currently joined. |
| `readyModels` | Models the mesh currently serves. |
| `failedNodeIds` | Member nodes reporting a failed runtime. |
| `deactivatedNodeIds` | Member nodes tainted deactivated (enrolled and heartbeating but running no model). |
| `active` | The profile's own active state; the console renders an inactive model as "deactivated" in a neutral tone rather than a green "ready", however much stale mesh state it still carries. |
| `tokenCount` | Count of stored invite tokens; entries are pruned when their node is revoked or offline for more than 24 hours. |
| `secretAgeMs` | Age of the stored mesh secret; absent when no secret is stored. |
| `lastError` | Most recent MeshLLM error reported by a member node; `mesh_state_key_missing` when the `MESH_STATE_KEY` Worker secret is unset. |

## Audit events

Audit history records setup completion, provider route provisioning, setup-token creation and claim, admin recovery reset, node unregister, node revoke, and profile switch actions. A failed Gateway sync appends its own `gateway_sync_failed` event carrying the raw Cloudflare rejection reason, distinct from the generic `router_error` catch-all. Mesh lifecycle and rollout actions append `mesh_state_stored`, `mesh_token_rotated`, `mesh_token_removed`, `mesh_state_cleared`, `profile_activated`, and `agent_version_selected` events. Audit payloads carry node and mesh identifiers and redact token material and credential values. ([REQ-OBS-006](../../sdd/spec/observability.md)) ([REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances)) ([REQ-SEC-002](../../sdd/spec/security.md))

## Failure states

| Failure | Expected state change | REQs |
| --- | --- | --- |
| Missed heartbeat | Lease expires and node becomes ineligible. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Unsafe Mesh target | Node is ineligible for scheduler selection. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Scheduler miss | Router returns `503 no_healthy_node` when no eligible node is ready, `404 no-profile` when the model has no profile, and `502 node_unreachable` when the node transport fails; nodes with non-ready runtimes, stale loaded models, or an operator deactivation are ineligible. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md), [REQ-SCH-005](../../sdd/spec/state-scheduling.md) |
| Mid-stream crash | The streamed response ends; the router holds no reservation state to release, and mesh-llm owns failure back-off across the mesh. | [REQ-RTR-003](../../sdd/spec/router-worker.md), [REQ-OBS-004](../../sdd/spec/observability.md) |
| Invalid Mesh data | Node record is rejected or ineligible. | [REQ-RTR-004](../../sdd/spec/router-worker.md) |

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider metadata | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node metrics | [observability.md](../../sdd/spec/observability.md) | `packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeMetrics`, `packages/node-agent/internal/agent/metrics.go::RuntimeMetricsWithError`, `packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus` <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeMetrics --> <!-- @impl: packages/node-agent/internal/agent/metrics.go::RuntimeMetricsWithError --> <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus --> |
| Runtime state mapping | [observability.md](../../sdd/spec/observability.md) | `packages/node-agent/internal/agent/meshllm_status.go::MapMeshLLMState`, `packages/node-agent/internal/agent/meshllm_status.go::DeriveMeshRole` <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::MapMeshLLMState --> <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::DeriveMeshRole --> |
| Mesh health | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::handleAdminStatus`, `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::handleAdminStatus --> <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> |
| Mesh and rollout audit events | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS`, `packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS` <!-- @impl: packages/router-worker/src/mesh-state.ts::MESH_STATE_ANCHORS --> <!-- @impl: packages/router-worker/src/agent-versions.ts::AGENT_VERSIONS_ANCHORS --> |
