# Node Agent

This domain covers the local cross-platform service that registers nodes, proxies inference, exposes a localhost UI, installs and supervises the MeshLLM runtime, and participates in release updates.

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
6. The agent resolves its config path from the `INFERENCE_MESH_CONFIG` override when set, so the installed service and the install step agree on one config path independent of the invoking user's home directory. <!-- @impl: packages/node-agent/internal/agent/config.go::ConfigPath --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestConfigPathHonorsExplicitConfigEnv) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-002: Node claim and heartbeat

**Intent:** A newly installed node must exchange a short-lived setup token for durable node credentials, then keep the router informed about reachability and runtime readiness through authenticated heartbeats.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent claims a setup token once and receives permanent node, upstream, and profile configuration. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
2. A claimed node stores credentials in the platform-specific service data directory. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
3. Heartbeats include node identity, detected Mesh IP, listener port, runtime status, ready profiles, metrics, and agent version. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->
4. The Worker persists heartbeat state to D1 and refreshes the scheduler's live lease. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-ADM-003](setup-admin.md#req-adm-003-setup-token-lifecycle)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-007: Heartbeat mesh-state reporting

**Intent:** Heartbeats are the only channel between a node and the router, so they must carry the node's mesh identity and mesh metrics idempotently and bring back the router's profile, version, and mesh directives.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. Once captured, the node's mesh id and its own mesh join token are resent in every heartbeat request, so token delivery is idempotent. <!-- @impl: packages/node-agent/internal/agent/client.go::HeartbeatFromConfig --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE007HeartbeatResendsMeshIdentityEveryTick) -->
2. Heartbeat metrics report mesh id, mesh role, peer count, ready model ids from the node's own MeshLLM `/v1/models`, split state, stage count, API and console readiness, and MeshLLM version. <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE007HeartbeatMetricsCarryMeshState) -->
3. The node reports mesh role `coordinator` exactly when it owns stage 0 of its mesh. <!-- @impl: packages/node-agent/internal/agent/meshllm_status.go::ParseMeshLLMStatus --> <!-- @test: packages/node-agent/internal/agent/meshllm_status_test.go (TestREQRUN007DerivesCoordinatorFromStageZeroOwnership) -->
4. Claim and heartbeat responses may include desired profile actions, the desired agent version, and a mesh bootstrap directive (`create`, `join`, or `wait`) carrying rotation and, for joins, mesh id and join tokens. <!-- @impl: packages/node-agent/internal/agent/client.go::ClientAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE007ResponsesCarryMeshBootstrapAndDesiredVersion) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-008: Mesh IP detection

**Intent:** Mesh transport and invite tokens embed the node's WARP overlay address, so the agent must reliably detect the Cloudflare WARP adapter and its IP across platforms, persist it before first claim, and refuse to claim when it cannot.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent detects the WARP overlay IPv4 by matching the Cloudflare WARP adapter by name and by the WARP CGNAT range `100.96.0.0/12`, so detection works on Linux, Windows, and macOS `utun` adapters. <!-- @impl: packages/node-agent/internal/agent/config.go::DetectWARPMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE008DetectsWARPAdapterAndIP) -->
2. A WARP-range address is preferred over coexisting LAN addresses. <!-- @impl: packages/node-agent/internal/agent/config.go::DetectMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE008DetectsWARPAdapterAndIP) -->
3. A host without a WARP adapter falls back to a single unambiguous private IPv4. <!-- @impl: packages/node-agent/internal/agent/config.go::DetectMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE008DetectsWARPAdapterAndIP) -->
4. Detection fails closed when the chosen candidate tier is ambiguous. <!-- @impl: packages/node-agent/internal/agent/config.go::DetectMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE008DetectsUnambiguousMeshIP) -->
5. Before first claim, the agent persists an unambiguous detected Mesh IP into config. <!-- @impl: packages/node-agent/internal/agent/config.go::ApplyDetectedMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE008AppliesDetectedMeshIPBeforeClaim) -->
6. The agent fails with a clear, actionable error before claim when the Mesh IP is unresolved. <!-- @impl: packages/node-agent/internal/agent/config.go::RequireMeshIP --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestRequireMeshIPFailsClosedWhenUnresolved) -->

**Constraints:** [CON-STATE-001](constraints.md#con-state-001-d1-is-durable-truth), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P0

**Dependencies:** [REQ-NODE-001](#req-node-001-cross-platform-service)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-003: Upstream proxy

**Intent:** The node agent must protect the local MeshLLM API from arbitrary Mesh callers while preserving OpenAI-compatible request and stream behavior for the router.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. Mesh-facing inference requests are rejected without the configured upstream bearer token. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
2. Valid requests are forwarded to the local MeshLLM API on the configured localhost API port. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
3. Streaming runtime responses are streamed back to the Worker without full buffering. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
4. Runtime failures return an OpenAI-style error envelope and preserve an appropriate HTTP status. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->
5. The proxy does not expose node credentials, setup tokens, or admin tokens to the local runtime. <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE003UpstreamProxyEnforcesBearerAndStreams) -->

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes), [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P0

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-004: Local dashboard

**Intent:** Node operators need a localhost dashboard that shows whether the node is registered, reachable through Mesh, participating in its MeshLLM mesh, and ready for inference.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. The dashboard reports node ID, display name, OS, architecture, agent version, and uptime. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
2. The dashboard reports router URL, claim status, heartbeat age, heartbeat latency, and last heartbeat error. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
3. The dashboard reports WARP status, Mesh IP, listening address, listening port, and firewall warning state when detectable. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->
4. The dashboard runtime panel reports installed MeshLLM version, process run state, mesh id, peer count, and ready models. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardReportsMeshLLMRuntimePanel) -->
5. The dashboard runtime panel reports split state, stage count, API and console ports, the last runtime error, and tokens per second when MeshLLM exposes it. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardReportsMeshLLMRuntimePanel) -->
6. Dashboard controls can start, stop, and restart the managed MeshLLM process through the agent's runtime controller interface only after the node has a claimed profile. <!-- @impl: packages/node-agent/internal/agent/dashboard.go::DashboardAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE004DashboardRuntimeControlsUseController) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries), [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-meshllm-runtime)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-005: Agent update staging

**Intent:** The node agent must converge to the router's desired version automatically, and only a checksum-verified, staged binary may ever replace the running service.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. A heartbeat-delivered desired agent version that differs from the running version, newer or older, triggers the update flow. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/selfupdate_test.go (TestREQNODE005DesiredVersionMismatchTriggersUpdate) -->
2. The agent downloads the matching `inference-mesh-agent-<os>-<arch>[.exe]` artifact and `checksums.txt` from the GitHub release tagged with the desired version. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/selfupdate_test.go (TestREQNODE005DownloadsArtifactAndChecksumsFromReleaseTag) -->
3. The downloaded binary is verified against its `checksums.txt` SHA-256 entry and written into the protected staging directory. <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches) -->
4. A checksum mismatch fails staging and does not mark an update ready. <!-- @impl: packages/node-agent/internal/agent/update.go::UpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P2

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat), [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-009: Update application and retry

**Intent:** Applying a staged update must never leave a node dead: the binary swap is atomic, the service manager guarantees restart, and failures report and back off instead of looping.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. A staged update is applied by atomically swapping the service binary, after which the agent exits so the service manager restarts it. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/selfupdate_test.go (TestREQNODE009AppliesUpdateByAtomicSwapThenExits) -->
2. Service definitions installed by the agent guarantee automatic restart after an update exit on every supported platform. <!-- @impl: packages/node-agent/internal/agent/service.go::ServiceAnchors --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE009ServiceDefinitionsGuaranteeAutoRestart) -->
3. A failure at any update step is reported as the node's last error and leaves the current version running. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/selfupdate_test.go (TestREQNODE009FailureReportsLastErrorAndKeepsCurrentVersion) -->
4. After a failed update, the agent retries only when the desired version changes or after one hour. <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::SelfUpdateAnchors --> <!-- @test: packages/node-agent/internal/agent/selfupdate_test.go (TestREQNODE009RetriesOnlyOnVersionChangeOrAfterOneHour) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-SEC-002](constraints.md#con-sec-002-no-plaintext-durable-secrets)

**Priority:** P2

**Dependencies:** [REQ-NODE-005](#req-node-005-agent-update-staging)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-006: MeshLLM binary install and update

**Intent:** Every node must run the exact MeshLLM build the fleet was qualified against, provisioned by the agent itself, with node egress limited to GitHub releases for binaries and Hugging Face for MeshLLM's model pulls.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. The agent embeds a pinned MeshLLM release version and a per-platform, per-flavor artifact and SHA-256 checksum map at build time. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006PinnedVersionAndChecksumMapEmbedded) -->
2. On an `nvidia-smi` host MeshLLM flavor resolves to the CUDA build matching the host's CUDA runtime major (`cuda-13` on Linux with CUDA 13 libraries, else `cuda-12`), the Metal asset on darwin/arm64, and `cpu` otherwise, unless a flavor override is set. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006FlavorDetectionAndConfigOverride) -->
3. When no acceptable binary is present, the agent downloads the pinned artifact from GitHub releases into the agent data directory's `bin/`, verifies its SHA-256 against the embedded map, and installs it by atomic rename. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006DownloadVerifyAtomicInstall) -->
4. A `mesh-llm` binary found on PATH is used only when its `--version` output matches the pinned version, unless a configuration opt-out accepts unpinned binaries. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006PathBinaryAcceptedOnlyOnPinMatch) -->
5. A failed download, checksum mismatch, or rejected binary reports dependency-missing status, keeping the node up but never eligible. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006InstallFailureReportsDependencyMissing) -->
6. The agent supervises the MeshLLM process directly and never installs MeshLLM's upstream service units. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006NeverInstallsUpstreamServiceUnits) -->
7. MeshLLM binary downloads request only the pinned GitHub release URLs, adding no install-time egress beyond `github.com`. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::MeshLLMInstallAnchors --> <!-- @test: packages/node-agent/internal/agent/meshllm_install_test.go (TestREQNODE006DownloadsOnlyPinnedReleaseURLs) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P0

**Dependencies:** [REQ-NODE-001](#req-node-001-cross-platform-service)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-010: Inbound mesh firewall provisioning

**Intent:** A node behind a default-deny host firewall must still accept both the router's inbound mesh requests (the TCP reverse-proxy data plane) and peer nodes' iroh mesh transport (the UDP `--bind-port`), so the agent provisions those inbound rules itself rather than leaving an operator to debug a silent handshake timeout or a split mesh that forms peers yet never serves.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. On Linux the agent adds a ufw rule allowing inbound on the given protocol and mesh port scoped to the WARP interface, acting only when ufw is present. <!-- @impl: packages/node-agent/internal/agent/firewall.go::EnsureInboundRule --> <!-- @test: packages/node-agent/internal/agent/firewall_test.go (TestREQNODE010EnsureInboundRule) -->
2. On Windows the agent creates the inbound allow rule only when an identically named rule is absent, so repeated starts do not duplicate it, and the TCP and UDP rules carry distinct names so neither idempotency probe hides the other. <!-- @impl: packages/node-agent/internal/agent/firewall.go::EnsureInboundRule --> <!-- @test: packages/node-agent/internal/agent/firewall_test.go (TestREQNODE010EnsureInboundRule) -->
3. Provisioning runs best-effort after WARP detection at startup and never fails startup: a missing tool, an unknown WARP interface, an invalid protocol, or a macOS host is logged or a no-op rather than fatal. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runService --> <!-- @impl: packages/node-agent/internal/agent/firewall.go::EnsureInboundRule --> <!-- @test: packages/node-agent/internal/agent/firewall_test.go (TestREQNODE010EnsureInboundRule) -->
4. Beyond the TCP data-plane port, the agent opens the active profile's iroh mesh-peer transport port (the `--bind-port`) for inbound UDP scoped to the WARP interface, at startup and again on every profile switch because the bind-port moves with the selected model, so a default-deny host cannot drop the QUIC stage handshake and strand a multi-node mesh at zero peers. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::provisionMeshPeerFirewall --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runService --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE010ProfileRestartProvisionsMeshPeerFirewall) -->

**Constraints:** [CON-NET-001](constraints.md#con-net-001-mesh-destination-validation), [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P1

**Dependencies:** [REQ-NODE-001](#req-node-001-cross-platform-service), [REQ-NODE-008](#req-node-008-mesh-ip-detection)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-011: Deactivated nodes run no model

**Intent:** An operator can deactivate a node to keep it enrolled in the fleet without running a model on it. A deactivated node keeps heartbeating and self-updating but never initializes mesh-llm, so it holds its place in the mesh while consuming no GPU; re-activation resumes normal launch.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. When the router's heartbeat response marks the node deactivated, the agent tears down a running mesh-llm runtime and does not relaunch it while the taint holds. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE011DeactivatedNodeStopsRuntimeAndReactivationRelaunches) -->
2. A deactivated node keeps heartbeating and applying router-driven self-updates; only mesh-llm launch is suppressed. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE011DeactivatedNodeStopsRuntimeAndReactivationRelaunches) -->
3. Clearing the taint relaunches the selected profile even when the desired profile set is unchanged. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE011DeactivatedNodeStopsRuntimeAndReactivationRelaunches) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-012: On-demand runtime reload

**Intent:** An operator can restart a node's mesh-llm runtime on demand from the control plane, so a wedged runtime is recoverable without SSHing into the host. The directive rides the heartbeat the node already polls and is one-shot: it applies exactly once and is then retired, never restarting the runtime on every tick nor re-firing a stale directive after an agent restart.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. When the heartbeat response carries a `reloadNonce` that differs from the nonce the node last applied, the agent drains in-flight requests and restarts mesh-llm exactly once, then records the applied nonce. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE012ForceReloadRestartsOncePerNonce) -->
2. A repeated (already-applied) nonce does not restart the runtime again. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE012ForceReloadRestartsOncePerNonce) -->
3. The node echoes the applied nonce back on its next heartbeat so the router can retire the one-shot directive. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::collect --> <!-- @impl: packages/node-agent/internal/agent/client.go::HeartbeatFromConfig --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE012ForceReloadRestartsOncePerNonce) -->

**Constraints:** [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P2

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat), [REQ-RUN-010](runtime-profiles.md#req-run-010-meshllm-process-lifecycle), [REQ-ADM-032](setup-admin.md#req-adm-032-node-force-reload)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-NODE-013: Runtime binary bootstrap

**Intent:** A one-line node registration should install only the agent; the running agent then bootstraps and manages the operator-selected MeshLLM and llama.cpp runtime binaries from upstream releases without bundling either runtime into the agent artifact.

**Applies To:** Node Agent

**Acceptance Criteria:**

1. Claim and heartbeat responses may carry `desiredRuntimeVersions`, and the agent persists non-empty MeshLLM and llama.cpp selections in its config so the next runtime restart uses them; changing the selected runtime version restarts even when the selected model profile is unchanged. <!-- @impl: packages/node-agent/internal/agent/client.go::ApplyDesiredRuntimeVersions --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::handleResponse --> <!-- @test: packages/node-agent/internal/agent/agent_test.go (TestREQNODE013AppliesDesiredRuntimeVersions) --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE013RuntimeVersionChangeRestartsSelectedProfile) -->
2. MeshLLM startup resolves the selected version, downloads the per-platform archive into the agent data directory, verifies SHA-256 (embedded for the default pin, sidecar checksum for operator-selected versions), extracts `mesh-llm`, and never relies on an unverified bundled runtime. <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLMVersion --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQNODE013SelectedMeshLLMVersionDownloadsChecksumSidecar) -->
3. llama.cpp direct-runtime startup uses a `llamaCppBinaryPath` override when configured; otherwise it discovers a matching host-installed `llama-server` on PATH and in common install locations before resolving the best managed upstream release asset for the detected backend, verifying the GitHub release asset digest, extracting `llama-server` plus runtime shared libraries and chained shared-library link entries into the agent data directory, and launching the selected binary with its directory on the library path. <!-- @impl: packages/node-agent/internal/agent/config.go::Config --> <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::llamaCppBinaryPath --> <!-- @impl: packages/node-agent/internal/agent/llamacpp_install.go::EnsureLlamaCpp --> <!-- @impl: packages/node-agent/internal/agent/llamacpp_manager.go::llamaCppRuntimeEnv --> <!-- @test: packages/node-agent/cmd/inference-mesh-agent/main_test.go (TestREQNODE013LlamaCppBinaryPathUsesHostInstalledOverride) --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQNODE013EnsureLlamaCppDiscoversHostInstalledBinary) --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQNODE013LlamaCppAssetPrefersGpuBackendWhenAvailable) --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQNODE013EnsureLlamaCppInstallsManagedBinary) --> <!-- @test: packages/node-agent/internal/agent/llamacpp_manager_test.go (TestREQNODE013LlamaCppLaunchEnvIncludesRuntimeLibraryPath) --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQNODE013LlamaCppVersionQueryUsesRuntimeLibraryPath) -->
4. Checksum mismatch or missing compatible assets leave the node running but ineligible with `dependency-missing`, preserving the current fail-closed scheduling behavior and surfacing the install error in heartbeat metrics. <!-- @impl: packages/node-agent/cmd/inference-mesh-agent/main.go::runtimeMetrics --> <!-- @test: packages/node-agent/internal/agent/llamacpp_install_test.go (TestREQNODE013EnsureLlamaCppRejectsChecksumMismatch) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-RUNTIME-001](constraints.md#con-runtime-001-runtime-boundaries)

**Priority:** P1

**Dependencies:** [REQ-NODE-002](#req-node-002-node-claim-and-heartbeat), [REQ-RUN-003](runtime-profiles.md#req-run-003-managed-meshllm-runtime), [REQ-RUN-011](runtime-profiles.md#req-run-011-custom-model-onboarding)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/architecture.md](../../documentation/lanes/architecture.md)
- [documentation/lanes/api-reference.md](../../documentation/lanes/api-reference.md)
- [documentation/lanes/observability.md](../../documentation/lanes/observability.md)
- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
