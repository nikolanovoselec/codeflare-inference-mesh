# Observability

## Contents

- [Response metadata](#response-metadata)
- [Admin status](#admin-status)
- [Node metrics](#node-metrics)
- [Audit events](#audit-events)
- [Failure states](#failure-states)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Response metadata

Provider responses include request ID, session ID when present, and selected node identity when policy permits. Error responses include request ID so operators can correlate failures with audit and node logs. ([REQ-OBS-001](../../sdd/spec/observability.md))

## Admin status

| Field group | Contents | REQs |
| --- | --- | --- |
| Nodes | Node status, public models, active profiles, capacity, in-flight count, last seen. | [REQ-OBS-002](../../sdd/spec/observability.md) |
| Profiles | Public aliases, active profile IDs, rollout state, and fallback profile data. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-RUN-004](../../sdd/spec/runtime-profiles.md) |
| Audit | Recent setup, claim, unregister, revoke, route provisioning, and profile switch events. | [REQ-OBS-004](../../sdd/spec/observability.md), [REQ-OBS-005](../../sdd/spec/observability.md) |
| Metadata | Status generation timestamp. | [REQ-OBS-002](../../sdd/spec/observability.md) |

## Node metrics

Heartbeats report runtime state, active profile, in-flight count, last request duration, prompt throughput, generation throughput, WARP status, and Mesh IP. GPU metrics start as best-effort platform probes and stay absent when unsupported. ([REQ-OBS-003](../../sdd/spec/observability.md))

## Audit events

Audit history records setup completion, provider route provisioning, setup-token creation and claim, node unregister, node revoke, and profile switch actions. Audit records redact token material and credential values. ([REQ-OBS-004](../../sdd/spec/observability.md)) ([REQ-OBS-005](../../sdd/spec/observability.md)) ([REQ-SEC-002](../../sdd/spec/security.md))

## Failure states

| Failure | Expected state change | REQs |
| --- | --- | --- |
| Missed heartbeat | Lease expires and node becomes ineligible. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Unsafe Mesh target | Node is ineligible for scheduler selection. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Scheduler miss | Router returns `429` for `no-node` scheduler misses and `404` for `no-profile`; responses include request ID. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| Mid-stream crash | Reservation releases and failure score increases. | [REQ-RTR-003](../../sdd/spec/router-worker.md), [REQ-OBS-004](../../sdd/spec/observability.md) |
| Invalid Mesh data | Node record is rejected or ineligible. | [REQ-RTR-004](../../sdd/spec/router-worker.md) |

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider metadata | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node metrics | [observability.md](../../sdd/spec/observability.md) | `packages/node-agent/internal/agent/metrics.go::MetricsAnchors` <!-- @impl: packages/node-agent/internal/agent/metrics.go::MetricsAnchors --> |
