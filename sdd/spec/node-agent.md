# Node Agent

This domain covers the local cross-platform service that registers nodes, proxies inference, exposes a localhost UI, supervises runtime state, and participates in release updates.

---

### REQ-NODE-001: Cross-platform service

**Intent:** Each private machine should run one installable service that works on Windows, macOS, and Linux without requiring public inbound networking.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The node agent builds as one Go binary per supported OS and architecture. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE001ServiceSkeletonAndListenerPolicy) -->
2. The agent can install and start itself as a Windows service, Linux systemd unit, or macOS LaunchDaemon. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE001ServiceSkeletonAndListenerPolicy) -->
3. The local UI binds to `127.0.0.1` on the configured UI port. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE001ServiceSkeletonAndListenerPolicy) -->
4. The Mesh-facing inference listener prefers the detected Mesh IP and falls back to `0.0.0.0` only with strict upstream-token enforcement. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE001ServiceSkeletonAndListenerPolicy) -->
5. The service marks itself draining before intentional shutdown or update restart. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE001ServiceSkeletonAndListenerPolicy) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-llamacpp-first-runtime), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-002: Node claim and heartbeat

**Intent:** A newly installed node must exchange a short-lived setup token for durable node credentials, then keep the router informed about reachability and runtime readiness.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent claims a setup token once and receives permanent node, upstream, and profile configuration. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
2. A claimed node stores credentials in the platform-specific service data directory. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
3. Heartbeats include node identity, detected Mesh IP, listener port, runtime status, ready profiles, and metrics. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
4. The Worker persists heartbeat state to D1 and refreshes the scheduler's live lease. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
5. The heartbeat response may include desired profile actions for the node to prepare. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
6. Mesh IP detection succeeds only when exactly one private IPv4 candidate is present. <!-- @impl: packages/node-agent/internal/agent/config.go::DetectMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002AppliesDetectedMeshIPBeforeClaim) -->
7. Before first claim, the agent persists an unambiguous detected Mesh IP into config. <!-- @impl: packages/node-agent/internal/agent/config.go::ApplyDetectedMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002AppliesDetectedMeshIPBeforeClaim) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-003](setup-admin.md#req-adm-003-setup-token-lifecycle)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-003: Upstream proxy

**Intent:** The node agent must protect the local runtime from arbitrary Mesh callers while preserving OpenAI-compatible request and stream behavior for the router.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. Mesh-facing inference requests are rejected without the configured upstream bearer token. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
2. Valid requests are forwarded to the configured local OpenAI-compatible runtime. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
3. Streaming runtime responses are streamed back to the Worker without full buffering. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
4. Runtime failures return an OpenAI-style error envelope and preserve an appropriate HTTP status. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
5. The proxy does not expose node credentials, setup tokens, or admin tokens to the local runtime. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-RUNTIME-001](constraints.md#con-runtime-001-llamacpp-first-runtime)

**Priority:** P0

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-004: Local dashboard

**Intent:** Node operators need a localhost dashboard that shows whether the node is registered, reachable through Mesh, running a model, and ready for inference.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The dashboard reports node ID, display name, OS, architecture, agent version, and uptime. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
2. The dashboard reports router URL, claim status, heartbeat age, heartbeat latency, and last heartbeat error. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
3. The dashboard reports WARP status, Mesh IP, listening address, listening port, and firewall warning state when detectable. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
4. The dashboard reports runtime engine, process state, active model, context limit, in-flight requests, and recent throughput metrics. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
5. Dashboard controls can start, stop, and restart managed runtime only after the node has a claimed profile. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-llamacpp-first-runtime), [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-llamacpp-runtime)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-005: Agent update staging

**Intent:** Node-agent updates must be staged and checksum-verified before an operator replaces a running service binary.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The agent can write an update candidate into a protected staging directory. <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches) -->
2. The agent verifies the candidate checksum before returning the staged path. <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches) -->
3. A checksum mismatch fails staging and does not mark an update ready. <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P2

**Dependencies:** [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/observability.md](../../documentation/lanes/observability.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
