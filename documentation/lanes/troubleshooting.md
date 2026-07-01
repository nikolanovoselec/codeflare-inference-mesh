# Troubleshooting

## Contents

- [AI Gateway returns authentication errors](#ai-gateway-returns-authentication-errors)
- [Worker cannot reach node](#worker-cannot-reach-node)
- [Requests return busy](#requests-return-busy)
- [Session latency suddenly increases](#session-latency-suddenly-increases)
- [Installer cannot verify artifact](#installer-cannot-verify-artifact)
- [Node update is staged but not applied](#node-update-is-staged-but-not-applied)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## AI Gateway returns authentication errors

**Symptom:** Gateway calls reach the Worker but `/v1/*` responds with an auth error.

**Cause:** The provider key/BYOK value does not match the router provider token verifier, or Gateway sends the credential in a different header than expected.

**Fix:** Run the header validation path during initial setup, confirm header names only, rotate the provider token if needed, and update the Gateway provider key. ([REQ-GWY-002](../../sdd/spec/gateway.md)) ([REQ-GWY-004](../../sdd/spec/gateway.md))

## Worker cannot reach node

**Symptom:** Router returns service-unavailable errors when a node appears registered.

**Cause:** Mesh IP, allowed CIDR, listener binding, firewall, WARP enrollment, or Workers VPC binding is wrong.

**Fix:** Verify WARP/Mesh enrollment, validate the Mesh IP in admin status, confirm the listener port, and check `env.MESH.fetch` against the node health endpoint. ([REQ-RTR-004](../../sdd/spec/router-worker.md)) ([REQ-NODE-002](../../sdd/spec/node-agent.md))

## Requests return busy

**Symptom:** Client receives `429` with `no-node` plus a request ID.

**Cause:** No eligible node has capacity for the requested public model and session policy.

**Fix:** Use the request ID to inspect admin status, free an in-flight request, start another compatible node, or switch the public alias to a ready fallback profile. ([REQ-SCH-003](../../sdd/spec/state-scheduling.md)) ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

## Session latency suddenly increases

**Symptom:** A coding session that was fast starts spending time on long prefill.

**Cause:** The session moved nodes, a lease expired, or the runtime cache was cleared during restart/profile switch.

**Fix:** Check admin session mapping, node leases, recent failures, and runtime restarts; prefer returning busy for hot sticky sessions. ([REQ-SCH-004](../../sdd/spec/state-scheduling.md)) ([REQ-OBS-004](../../sdd/spec/observability.md))

## Installer cannot verify artifact

**Symptom:** Install script downloads an archive but refuses to install it.

**Cause:** The archive hash does not match `checksums.txt`, the checksum signature is missing when required, or the release manifest does not match the platform.

**Fix:** Re-run the deploy workflow, verify uploaded artifacts and checksums, and confirm the installer selected the correct OS/architecture asset. ([REQ-ADM-004](../../sdd/spec/setup-admin.md)) ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Node update is staged but not applied

**Symptom:** The dashboard shows an update ready but the service version does not change.

**Cause:** Updates require explicit operator approval and service restart.

**Fix:** Use the dashboard update-and-restart action after checksum/signature verification succeeds; confirm the service reports the new version on heartbeat. ([REQ-NODE-005](../../sdd/spec/node-agent.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Busy responses | [state-scheduling.md](../../sdd/spec/state-scheduling.md) | `packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS` <!-- @impl: packages/router-worker/src/scheduler.ts::SCHEDULER_ANCHORS --> |
| Failure reporting | [observability.md](../../sdd/spec/observability.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Self-update recovery | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/update.go::UpdateAnchors` <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors --> |
