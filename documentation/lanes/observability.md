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
| Sessions | Session ID, node ID, public model, profile ID, upstream model. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-SCH-004](../../sdd/spec/state-scheduling.md) |
| Scheduler | Lease expiration, failure penalty, recent failures, busy state. | [REQ-OBS-002](../../sdd/spec/observability.md), [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| Routes | Gateway, provider, dynamic route, version, deployment identifiers. | [REQ-GWY-003](../../sdd/spec/gateway.md) |

## Node metrics

Heartbeats report runtime state, active profile, in-flight count, last request duration, prompt throughput, generation throughput, WARP status, and Mesh IP. GPU metrics start as best-effort platform probes and stay absent when unsupported. ([REQ-OBS-003](../../sdd/spec/observability.md))

## Audit events

Audit history records setup completion, provider route provisioning, setup-token creation and claim, node unregister, node revoke, and profile switch actions. Audit records redact token material and credential values. ([REQ-OBS-004](../../sdd/spec/observability.md)) ([REQ-OBS-005](../../sdd/spec/observability.md)) ([REQ-SEC-002](../../sdd/spec/security.md))

## Failure states

| Failure | Expected state change | REQs |
| --- | --- | --- |
| Missed heartbeat | Lease expires and node becomes ineligible. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| WARP disconnect | Node is ineligible until healthy heartbeat returns. | [REQ-OBS-004](../../sdd/spec/observability.md) |
| Node busy | Router returns 429 with the scheduler reason and request ID. | [REQ-SCH-003](../../sdd/spec/state-scheduling.md) |
| Mid-stream crash | Reservation releases and failure score increases. | [REQ-RTR-003](../../sdd/spec/router-worker.md), [REQ-OBS-004](../../sdd/spec/observability.md) |
| Invalid Mesh data | Node record is rejected or ineligible. | [REQ-RTR-004](../../sdd/spec/router-worker.md) |

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider metadata | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node metrics | [observability.md](../../sdd/spec/observability.md) | `packages/node-agent/internal/agent/metrics.go::MetricsAnchors` <!-- @impl: packages/node-agent/internal/agent/metrics.go::MetricsAnchors --> |
