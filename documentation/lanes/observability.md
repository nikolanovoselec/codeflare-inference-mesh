# Observability

## Contents

- [Response metadata](#response-metadata)
- [Admin status](#admin-status)
- [Live dashboard surface](#live-dashboard-surface)
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
| Nodes | Node status plus the derived `displayStatus` operator vocabulary (`Serving`/`Preparing`/`Disconnected`/`Offline`/`Error` + lifecycle labels), mesh membership (`meshId`), public models, active profiles, runtime readiness, token throughput, GPU memory, capacity, in-flight count, runtime-binary install status, and last seen. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface), [REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership) |
| Profiles | Public aliases, upstream model, source mode, version, rollout percent, active flag, mesh membership (`meshId`), runtime tunables used by the model drawer, and ready/downloading/failed node counts (counting only same-mesh nodes). | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-RUN-001](../../sdd/spec/runtime-profiles.md), [REQ-RUN-004](../../sdd/spec/runtime-profiles.md), [REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership) |
| Meshes | One entry per machine group, visible to both console roles: `{ id, name, alias, machineCount, modelCount }`, where `alias` is the mesh's stable route (`codeflare-mesh` for the default mesh, `codeflare-mesh-<id>` otherwise). | [REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership), [REQ-RUN-001](../../sdd/spec/runtime-profiles.md) |
| Mesh health | One entry per MeshLLM profile: coordinator, peers, ready models, failed nodes, deactivated nodes, the profile's active state, rotation counter, and secret presence/age (see [Mesh health](#mesh-health)). | [REQ-OBS-007](../../sdd/spec/observability.md) |
| Audit | Recent setup, claim, unregister, revoke, admin recovery reset, route provisioning, profile switch, profile activation, agent version selection, mesh lifecycle, and mesh registry/membership events. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-OBS-006](../../sdd/spec/observability.md) |
| Metadata | Status generation timestamp and the caller's resolved console role (`viewerRole`). | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-ADM-017](../../sdd/spec/setup-admin.md) |

## Live dashboard surface

The console renders `GET /admin/status` as a live Codeflare operator surface: a reduced-motion-safe Codeflare wordmark, a hero status strip (available machines, known VRAM in GiB, the latest Speed Test prompt/generation throughput when present, custom-domain status, and the fleet's desired agent version), runtime binary install status, derived work state, a hub-and-spoke mesh topology with a mesh selector that filters the canvas to one machine group plus node and model detail drawers, and a sortable nodes table. The Overview's "Mesh status" panel renders one row per machine group — the mesh name with its right-aligned callable route, the active model's display name (or a no-model note), machine and serving counts, live aggregate tok/s while serving, and a green/amber/neutral status word — and the Overview carries no activity feed: the activity log renders in Settings only. ([REQ-OBS-010](../../sdd/spec/observability.md#req-obs-010-live-throughput-surface)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface)) ([REQ-ADM-015](../../sdd/spec/setup-admin.md#req-adm-015-mesh-visualization)) ([REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility)) ([REQ-ADM-036](../../sdd/spec/setup-admin.md#req-adm-036-operator-dashboard-visual-identity))

Split MeshLLM nodes count as available when they report a ready model/API path or live stage ownership, and the UI translates raw MeshLLM states into operator labels such as Stage owner, Serving split stage, or No stage assigned. Node rows and drawers show trusted GPU telemetry as the same used/total VRAM display for MeshLLM and direct llama.cpp when both values are reported; on Apple Silicon the agent derives the total from unified memory at Metal's ~75% working-set convention and the consumption from the IORegistry accelerator in-use counter, and split-readiness planner capacity is never rendered as GPU VRAM. ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface)) ([REQ-OBS-009](../../sdd/spec/observability.md#req-obs-009-hardware-and-throughput-metrics)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface))

Node and model drawers show split stage ownership as layer ranges (for example `L0-26 → battlestation · Ready`) instead of a bare count when `stageAssignments` are present, inferring `Ready` from the owning node when MeshLLM omits state on a topology row. Runtime binary installation, operator deactivation, and model loading are separate signals: installing `llama-server` or MeshLLM is a runtime-install chip, a deactivated node shows a separate `Deactivated` status while the runtime chip remains version-only when installed or paused when no version is known, and switching/downloading/loading a model is work state. ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface)) ([REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility))

The Mesh & Models section carries the Meshes management card — the machine groups listed with a right-aligned route chip and machine/model counts, a "+ Mesh" header disclosure revealing the letters-only name input, and per-mesh delete that succeeds only when the mesh is empty — and the nodes table shows each machine's mesh in a Mesh column, and every models-list row carries a fixed pill vocabulary — provider (`llama.cpp` red / `meshllm` green), serving mode (`singular model` blue / `sharded model` orange), and the purple mesh pill resolving the group name — with the same pill row leading the model Manage drawer above its status, alias, and machines-serving fields. The node and model Manage drawers each expose a Mesh select that is sent only when the operator changes it (a node move posts through the node-config endpoint; a model move posts through the profile-config endpoint and arrives switched off in the new mesh). The add-model form sits behind a "+ Model" disclosure at the right end of the Models list header and includes a "Where to find models" sources panel: the `repo:quant` reference-format example plus Unsloth GGUF, mesh-llm layer packages, and prepare-your-own rows, contextual to the selected serving mode. The model drawer also offers a Duplicate control for any model — it clones the profile into a switched-off same-mesh copy (`<name> (copy)`, derived call name) through the profile-duplicate endpoint. ([REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership)) ([REQ-ADM-023](../../sdd/spec/setup-admin.md#req-adm-023-per-node-settings)) ([REQ-ADM-021](../../sdd/spec/setup-admin.md#req-adm-021-model-serving-configuration)) ([REQ-ADM-025](../../sdd/spec/setup-admin.md#req-adm-025-add-a-model-console-control)) ([REQ-RUN-017](../../sdd/spec/runtime-profiles.md#req-run-017-profile-duplication))

It re-fetches on a five-second poll that pauses when the tab is hidden and resumes on focus, and a LIVE badge reflects poll freshness. ([REQ-OBS-010](../../sdd/spec/observability.md)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface)) ([REQ-ADM-015](../../sdd/spec/setup-admin.md)) ([REQ-ADM-033](../../sdd/spec/setup-admin.md#req-adm-033-runtime-binary-version-and-install-visibility)) ([REQ-ADM-036](../../sdd/spec/setup-admin.md#req-adm-036-operator-dashboard-visual-identity))

Live tokens-per-second are drawn as a rolling-window trace when runtimes report an aggregate throughput signal: each poll appends the aggregate throughput as a bar and the client linearly smooths between successive samples, capping the series at the configured window. Because MeshLLM does not reliably expose per-node live throughput for client/standby roles, the Nodes table and node drawer omit per-node `tok/s` instead of filling the UI with `not reported`. ([REQ-OBS-009](../../sdd/spec/observability.md#req-obs-009-hardware-and-throughput-metrics)) ([REQ-OBS-010](../../sdd/spec/observability.md#req-obs-010-live-throughput-surface))

Split readiness is rendered as status, capacity, and participant rows; participant IDs are resolved to Codeflare machine names when the router can match MeshLLM node IDs to enrolled nodes. The dashboard shell follows the Codeflare product system: sans headings and UI prose, mono code/values, locked coral accents, section subtitles, and command rows with endpoint/auth/status chips for operator actions. ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface)) ([REQ-ADM-036](../../sdd/spec/setup-admin.md#req-adm-036-operator-dashboard-visual-identity))

The headline performance number uses the persisted latest Speed Test summary instead, so prompt ingestion and generation speed stay separate. All values derive from the status contract — nothing is fabricated between polls. ([REQ-OBS-010](../../sdd/spec/observability.md)) The Models section lists active profiles before standby ones, preserving source order within each group, so the serving set is visible without scrolling. ([REQ-ADM-018](../../sdd/spec/setup-admin.md#req-adm-018-models-section-ordering))

Under the read-only user role the surface narrows to the overview and the playground; configuration sections are hidden client-side and refused server-side. ([REQ-ADM-017](../../sdd/spec/setup-admin.md))

## Node metrics

Heartbeats report runtime state, loaded model, active profile ID/version, in-flight count, last runtime error, and Mesh IP, plus the MeshLLM mesh view: mesh ID, mesh role, peer count, ready models, split flag, stage count, stage/layer ownership, API and console readiness, the MeshLLM version, the effective launched `--max-vram` budget, and the split-readiness diagnostic report when MeshLLM exposes one. ([REQ-OBS-003](../../sdd/spec/observability.md#req-obs-003-node-metrics)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface))

The agent reads full split-stage topology from `/api/runtime/stages` when available, because `/api/status` can expose only a local stage view. If MeshLLM reports GPU capacity but omits used VRAM, the agent fills the missing `gpuMemoryUsedMiB` from host GPU telemetry before heartbeating, preserving MeshLLM's trusted total and never using split planner capacity as GPU memory. ([REQ-OBS-003](../../sdd/spec/observability.md#req-obs-003-node-metrics)) ([REQ-OBS-009](../../sdd/spec/observability.md#req-obs-009-hardware-and-throughput-metrics))

Direct llama.cpp metrics also carry the selected/installed `llama-server` version, cache settings, slot state, and latest cached-token count; runtime bootstrap failures are reported as `dependency-missing` with the install error so the router can display the failure and keep the node ineligible. Runtime metrics are decoded from the MeshLLM console status through a tolerant parser that reads only the needed subset and ignores unknown fields. ([REQ-OBS-003](../../sdd/spec/observability.md)) ([REQ-OBS-008](../../sdd/spec/observability.md)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface)) ([REQ-NODE-013](../../sdd/spec/node-agent.md#req-node-013-runtime-binary-bootstrap))

Heartbeats also carry `runtimeDetail` — the most recent error-looking line the agent captured from mesh-llm's own stderr (an OOM, a CUDA error, a lane that never came up) — and `nodeState`; warn/info/debug/trace-leveled tracing lines are ignored unless they carry a hard error token, so routine runtime chatter never masquerades as the failure cause. A failed install state derives only from the agent’s `dependency-missing` report — a starting runtime with stderr chatter stays `pending`. For MeshLLM, `nodeState` is the console's raw node state string; during a profile/model restart, the agent sets `nodeState` to the model being loaded so the control plane can distinguish model acquisition from runtime-binary installation. ([REQ-OBS-011](../../sdd/spec/observability.md#req-obs-011-runtime-error-surface)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface))

Together they make the reason a runtime is wedged legible from the control plane instead of only the host journal; the agent tees mesh-llm's stderr through a bounded ring that keeps the latest error line, and a zero value never overwrites a present one on merge. The console nodes table keeps raw node state as a status-detail contract value, while the visible UI derives work labels from stronger evidence: ready models, live stage ownership, API/console readiness, and split-readiness blockers. ([REQ-OBS-011](../../sdd/spec/observability.md#req-obs-011-runtime-error-surface)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface)) ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface))

The node Manage drawer renders these diagnostics as read-only rows: runtime error while the node is not ready/running, derived work state, mesh role, peer count, node-owned stage ownership with layer ranges when available, API/console reachability, and runtime version. Old non-fatal MeshLLM warnings and `model_size_unknown` diagnostics are suppressed from visible operator status, including reload/update transitions; they remain structured diagnostic data only. ([REQ-OBS-011](../../sdd/spec/observability.md#req-obs-011-runtime-error-surface)) ([REQ-OBS-012](../../sdd/spec/observability.md#req-obs-012-runtime-status-detail-surface)) ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface))

When a split profile is stuck with no peers/stages, the table calls out the actual blocker: peer discovery if there are no peers, or MeshLLM split-readiness blockers such as `split_capacity_shortfall` when peers exist but the planner cannot place the model. The node drawer shows reported used/total VRAM only when trusted GPU telemetry has it; split-readiness participant capacity is retained only as machine-readable diagnostics and is not rendered as visible GPU VRAM or RAM. ([REQ-OBS-007](../../sdd/spec/observability.md#req-obs-007-mesh-health-surface)) ([REQ-OBS-011](../../sdd/spec/observability.md#req-obs-011-runtime-error-surface)) ([REQ-OBS-009](../../sdd/spec/observability.md#req-obs-009-hardware-and-throughput-metrics))

The Mesh VRAM limit row shows desired profile/node limits separately from a stale running launch budget so an operator can spot a stored-vs-effective mismatch without SSH. If a heartbeat omits a field, the drawer leaves the row out or says `not reported`; omitted direct llama.cpp console, slot, cache, or throughput fields are not treated as `down`, `0`, or `on`. ([REQ-OBS-011](../../sdd/spec/observability.md))

Token throughput (`tokensPerSecond`) is read from the console status `tok_per_sec` value when the console exposes it. GPU memory is read from MeshLLM's structured per-GPU rated and used VRAM, falling back to a host GPU tool (nvidia-smi on Linux and Windows, system_profiler on macOS) when the console omits it. Metrics the upstream surface does not provide stay absent from heartbeats and admin status rather than fabricated or zero-filled: prompt-versus-generation throughput splits stay absent because the console reports a single throughput value, and GPU metrics stay absent only when both the console and the host probe are unavailable. ([REQ-OBS-009](../../sdd/spec/observability.md))

Heartbeat runtime state, dashboard status, dashboard runtime controls, the local proxy target, and shutdown all resolve the agent's current runtime manager rather than a startup capture, so after a runtime-mode switch (MeshLLM to direct llama.cpp or back) the reported `runtimeState` follows the runtime actually serving traffic instead of a stale `stopped`. ([REQ-OBS-003](../../sdd/spec/observability.md#req-obs-003-node-metrics)) ([REQ-NODE-004](../../sdd/spec/node-agent.md))

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
| `stageAssignments` | Layer ownership reported by MeshLLM (`stageIndex`, `nodeId`, `layerStart`, `layerEnd`, state, and reporter). |
| `splitReadiness` | MeshLLM planner diagnostic for split profiles, including capacity advice, participants, blockers, and recommendations when the planner cannot place the model. Aggregated status adds participant `routerNodeId`/`displayName` when the heartbeat `meshNodeId` maps the MeshLLM participant back to an enrolled machine. |
| `readyModels` | Models the mesh currently serves. |
| `failedNodeIds` | Member nodes reporting a failed runtime. |
| `deactivatedNodeIds` | Member nodes tainted deactivated (enrolled and heartbeating but running no model). |
| `active` | The profile's own active state; the console renders an inactive model as "deactivated" in a neutral tone rather than a green "ready", however much stale mesh state it still carries. |
| `tokenCount` | Count of stored invite tokens; entries are pruned when their node is revoked or offline for more than 24 hours. |
| `secretAgeMs` | Age of the stored mesh secret; absent when no secret is stored. |
| `lastError` | Most recent MeshLLM error reported by a member node; `mesh_state_key_missing` when the `MESH_STATE_KEY` Worker secret is unset. |

## Audit events

Audit history records setup completion, provider route provisioning, setup-token creation and claim, admin recovery reset, node unregister, node revoke, and profile switch actions. A failed Gateway sync appends its own `gateway_sync_failed` event carrying the raw Cloudflare rejection reason, distinct from the generic `router_error` catch-all. Mesh lifecycle and rollout actions append `mesh_state_stored`, `mesh_token_rotated`, `mesh_token_removed`, `mesh_state_cleared`, `profile_activated`, and `agent_version_selected` events. Mesh registry and membership changes append `mesh_created` (name and alias), `mesh_deleted` (the orphaned gateway `routeName`), `node_mesh_assigned`, and `model_mesh_assigned` (both with `{from, to}` group ids) events; duplicating a model appends `model_duplicated` targeting the copy with `{from}` naming the source. Audit payloads carry node and mesh identifiers and redact token material and credential values. ([REQ-OBS-006](../../sdd/spec/observability.md)) ([REQ-ADM-019](../../sdd/spec/setup-admin.md#req-adm-019-console-error-affordances)) ([REQ-SEC-002](../../sdd/spec/security.md))

## Failure states

| Failure | Expected state change | REQs |
| --- | --- | --- |
| Missed heartbeat | Lease expires and node becomes ineligible. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Unsafe Mesh target | Node is ineligible for scheduler selection. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Scheduler miss | Router returns `503 no_healthy_node` when no eligible node is ready, `404 no-profile` when the model has no profile, and `502 node_unreachable` when the node transport fails; nodes with non-ready runtimes, stale loaded models, an operator deactivation, or a mesh that differs from the profile's mesh are ineligible. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md), [REQ-SCH-005](../../sdd/spec/state-scheduling.md), [REQ-SCH-006](../../sdd/spec/state-scheduling.md#req-sch-006-mesh-registry-and-membership) |
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
| Mesh registry and membership | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/meshes.ts::MESHES_ANCHORS`, `packages/router-worker/src/router.ts::meshListCore` <!-- @impl: packages/router-worker/src/meshes.ts::MESHES_ANCHORS --> <!-- @impl: packages/router-worker/src/router.ts::meshListCore --> |
| Current runtime manager | [observability.md](../../sdd/spec/observability.md) | `packages/node-agent/cmd/inference-mesh-agent/main.go::setManager`, `packages/node-agent/cmd/inference-mesh-agent/main.go::dashboardStatus`, `packages/node-agent/cmd/inference-mesh-agent/main.go::currentRuntimeController` <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::setManager --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::dashboardStatus --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::currentRuntimeController --> |
