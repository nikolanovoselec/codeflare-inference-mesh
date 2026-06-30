# Troubleshooting

## AI Gateway returns authentication errors

**Symptom:** Gateway calls reach the Worker but `/v1/*` responds with an auth error.

**Cause:** The provider key/BYOK value does not match the router provider token verifier, or Gateway sends the credential in a different header than expected.

**Fix:** Run the header validation path during initial setup, confirm header names only, rotate the provider token if needed, and update the Gateway provider key. (REQ-GWY-002) (REQ-GWY-004)

## Worker cannot reach node

**Symptom:** Router returns service-unavailable errors when a node appears registered.

**Cause:** Mesh IP, allowed CIDR, listener binding, firewall, WARP enrollment, or Workers VPC binding is wrong.

**Fix:** Verify WARP/Mesh enrollment, validate the Mesh IP in admin status, confirm the listener port, and check `env.MESH.fetch` against the node health endpoint. (REQ-RTR-004) (REQ-NODE-002)

## Requests return busy

**Symptom:** Client receives `429` with `inference_mesh_busy`.

**Cause:** No eligible node has capacity for the requested public model and session policy.

**Fix:** Wait for `Retry-After`, free an in-flight request, start another compatible node, or switch the public alias to a ready fallback profile. (REQ-SCH-003) (REQ-RUN-004)

## Session latency suddenly increases

**Symptom:** A coding session that was fast starts spending time on long prefill.

**Cause:** The session moved nodes, a lease expired, or the runtime cache was cleared during restart/profile switch.

**Fix:** Check admin session mapping, node leases, recent failures, and runtime restarts; prefer returning busy for hot sticky sessions. (REQ-SCH-004) (REQ-OBS-004)

## Installer cannot verify artifact

**Symptom:** Install script downloads an archive but refuses to install it.

**Cause:** The archive hash does not match `checksums.txt`, the checksum signature is missing when required, or the release manifest does not match the platform.

**Fix:** Re-run the deploy workflow, verify uploaded artifacts and checksums, and confirm the installer selected the correct OS/architecture asset. (REQ-ADM-004) (REQ-REL-003)

## Node update is staged but not applied

**Symptom:** The dashboard shows an update ready but the service version does not change.

**Cause:** Updates require explicit operator approval and service restart.

**Fix:** Use the dashboard update-and-restart action after checksum/signature verification succeeds; confirm the service reports the new version on heartbeat. (REQ-NODE-005)
