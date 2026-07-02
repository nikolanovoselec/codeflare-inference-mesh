# Troubleshooting

## Contents

- [AI Gateway returns authentication errors](#ai-gateway-returns-authentication-errors)
- [Worker cannot reach node](#worker-cannot-reach-node)
- [Requests return no-node](#requests-return-no-node)
- [Session latency suddenly increases](#session-latency-suddenly-increases)
- [Installer cannot verify artifact](#installer-cannot-verify-artifact)
- [Node reports dependency-missing](#node-reports-dependency-missing)
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

**Fix:** Use the request ID to inspect admin status, free an in-flight request, start another compatible node, or switch the public alias to a ready fallback profile. ([REQ-SCH-003](../../sdd/spec/state-scheduling.md)) ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

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

**Cause:** The agent now manages the runtime process but the first version expects `llama-server` to already be installed on the node PATH.

**Fix:** Install a CUDA-capable llama.cpp build for the node OS, confirm `llama-server` is on PATH for the service user, then restart the agent service. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-llamacpp-runtime)) ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))

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
