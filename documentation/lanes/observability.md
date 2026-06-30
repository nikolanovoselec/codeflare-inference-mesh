# Observability

## Response metadata

Provider responses include request ID, session ID when present, and selected node identity when policy permits. Error responses include request ID so operators can correlate failures with audit and node logs. (REQ-OBS-001)

## Admin status

| Field group | Contents | REQs |
| --- | --- | --- |
| Nodes | Node status, public models, active profiles, capacity, in-flight count, last seen. | REQ-OBS-002 |
| Sessions | Session ID, node ID, public model, profile ID, upstream model. | REQ-OBS-002, REQ-SCH-004 |
| Scheduler | Lease expiration, failure penalty, recent failures, busy state. | REQ-OBS-002, REQ-SCH-003 |
| Routes | Gateway, provider, dynamic route, version, deployment identifiers. | REQ-GWY-003 |

## Node metrics

Heartbeats report runtime state, active profile, in-flight count, last request duration, prompt throughput, generation throughput, WARP status, and Mesh IP. GPU metrics start as best-effort platform probes and stay absent when unsupported. (REQ-OBS-003)

## Audit events

Audit history records setup completion, provider route provisioning, setup-token creation and claim, node revoke, profile switch, deployment, and update actions. Audit records redact token material and credential values. (REQ-OBS-004) (REQ-SEC-002)

## Failure states

| Failure | Expected state change | REQs |
| --- | --- | --- |
| Missed heartbeat | Lease expires and node becomes ineligible. | REQ-OBS-004 |
| WARP disconnect | Node is ineligible until healthy heartbeat returns. | REQ-OBS-004 |
| Node busy | Router returns 429 with retry guidance. | REQ-SCH-003 |
| Mid-stream crash | Reservation releases and failure score increases. | REQ-RTR-003, REQ-OBS-004 |
| Invalid Mesh data | Node record is rejected or ineligible. | REQ-RTR-004 |
