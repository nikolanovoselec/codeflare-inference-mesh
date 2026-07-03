# Deployment

## Contents

- [Delivery model](#delivery-model)
- [PR checks](#pr-checks)
- [Deploy workflow](#deploy-workflow)
- [Node prerequisites](#node-prerequisites)
- [Greenfield bootstrap](#greenfield-bootstrap)
- [Mesh integration runbook](#mesh-integration-runbook)
- [Release channels](#release-channels)
- [Agent self-update](#agent-self-update)
- [Rollback](#rollback)
- [CI verification policy](#ci-verification-policy)
- [Source anchors and specification backlinks](#source-anchors-and-specification-backlinks)

## Delivery model

Production deployment is automatic after a merged `main` push has green PR Checks, Security, and Fuzz gates. Integration deployment is manual and can run from any branch without changing the production Worker or D1 database. ([REQ-REL-001](../../sdd/spec/release-ci.md)) ([REQ-REL-002](../../sdd/spec/release-ci.md)) ([REQ-REL-004](../../sdd/spec/release-ci.md))

## PR checks

| Check group | Required behavior | REQs |
| --- | --- | --- |
| Router | Install, lint, behavioral tests, type-check, Wrangler types, dry-run deploy. | [REQ-REL-001](../../sdd/spec/release-ci.md) |
| Agent | Go tests, vet, race tests, and command build. | [REQ-REL-001](../../sdd/spec/release-ci.md) |
| Packaging | Build one archive, generate checksums, verify hash, run staged version command. | [REQ-REL-001](../../sdd/spec/release-ci.md) |
| Security | npm audit, Go vulnerability check, dependency review where available. | [REQ-REL-001](../../sdd/spec/release-ci.md), [REQ-REL-004](../../sdd/spec/release-ci.md) |
| Fuzz | Bounded router and agent fuzz targets run for pull requests and post-merge `main` pushes. | [REQ-REL-004](../../sdd/spec/release-ci.md) |

## Deploy workflow

| Step | Outcome | REQs |
| --- | --- | --- |
| Resolve target | Production comes from the green `main` merge SHA; integration uses the manually selected branch. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Check gates | Production waits for exact-head Security and Fuzz success after PR Checks succeeds. | [REQ-REL-002](../../sdd/spec/release-ci.md), [REQ-REL-004](../../sdd/spec/release-ci.md) |
| Repeat checks | Critical router and agent checks pass before state changes. | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| Prepare D1 | The production or integration database is created or resolved and migrations are applied. | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |
| Set mesh state key | `MESH_STATE_KEY` is validated with the other deploy secrets and pushed to the Worker via `wrangler secret put`; the workflow fails closed when the secret is absent. | [REQ-SEC-006](../../sdd/spec/security.md) |
| Build artifacts | Agent archives for linux/amd64, linux/arm64, windows/amd64, and darwin/arm64 (darwin/amd64 is not built) embed the release tag via `-X main.version`; checksums, signature, and manifest exist; raw binaries are removed before release upload. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Publish release | GitHub Release contains all installer/update assets. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Deploy Worker | Wrangler deploy publishes the production or integration router with `AGENT_RELEASE_TAG`; a bootstrap `WORKER_BASE_URL` is optional and validated only when explicitly supplied. | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety), [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Summarize | Workflow summary lists ref, Worker, release tag, environment, and artifacts. | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |

## Node prerequisites

Every node runs the Cloudflare One Client (WARP) enrolled into the same account as the Worker VPC binding. Device split-tunnel configuration must keep `100.96.0.0/12` routed through WARP: mesh peers dial each other's WARP CGNAT addresses directly, and excluding that range breaks peer connectivity. Nodes must also reach each other over UDP on the active profile's `bindPort` (shipped defaults: 4300 single-node, 4310 split, 4320 smoke). ([REQ-NODE-001](../../sdd/spec/node-agent.md)) ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-meshllm-runtime))

Outbound HTTPS egress is required to `github.com` (agent self-update and pinned `mesh-llm` release downloads) and `huggingface.co` (model downloads performed by `mesh-llm`); installs add no other egress. ([REQ-NODE-006](../../sdd/spec/node-agent.md))

No separate inference runtime or CUDA toolchain install is required: the agent provisions the pinned `mesh-llm` v0.72.2 build itself. It downloads the per-platform release archive, verifies it against the embedded SHA-256 map, extracts the `mesh-llm` binary from the bundle, and installs it by atomic rename. The build flavor is auto-detected — `cuda-12` when `nvidia-smi` is present, `metal` on darwin/arm64, `cpu` otherwise — and the agent's `cuda-12` vocabulary maps to upstream's `--llama-flavor cuda`; a `mesh-llm` already on PATH is used only when its version matches the pin. Install failure reports `dependency-missing`, keeping the node up but never eligible for scheduling. The supervised process runs with `MESH_LLM_NO_SELF_UPDATE=1`, so runtime versions move only with agent releases. ([REQ-NODE-006](../../sdd/spec/node-agent.md)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))

A profile reports ready only after the node's own `mesh-llm` `/v1/models` lists the profile's model, so scheduling sees only ready runtimes. ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting))

Optional custom-domain provisioning uses the runtime Cloudflare token after deploy; give that token DNS and Worker route permissions for the target zone before asking the Admin UI to provision a hostname. ([REQ-ADM-005](../../sdd/spec/setup-admin.md))

## Greenfield bootstrap

There is no fleet migration. The first deploy seeds the shipped MeshLLM profiles, deactivates every active profile row whose runtime is not `meshllm` regardless of version, and `/v1/models` lists only active aliases — that sweep is the entire cutover. ([REQ-RUN-002](../../sdd/spec/runtime-profiles.md)) ([REQ-RUN-009](../../sdd/spec/runtime-profiles.md))

1. Configure the `MESH_STATE_KEY` GitHub Actions secret, then deploy the Worker (integration first); the workflow fails closed without the secret. ([REQ-SEC-006](../../sdd/spec/security.md))
2. Complete first-run setup and mint a single-use enrollment token per node. ([REQ-ADM-003](../../sdd/spec/setup-admin.md))
3. Install the agent fresh on each WARP-enrolled node with the one-line installer; the agent installs `mesh-llm` and claims against the router. ([REQ-ADM-004](../../sdd/spec/setup-admin.md))
4. Verify mesh health in admin status: seed and coordinator assigned, all nodes listed as peers, and the active profile's model in `readyModels`. ([REQ-OBS-007](../../sdd/spec/observability.md))
5. Confirm an end-to-end chat completion through the AI Gateway dynamic route. ([REQ-GWY-003](../../sdd/spec/gateway.md))

## Mesh integration runbook

Manual verification for a new environment using two WARP-enrolled nodes. Expected signals below are the mesh health entries of admin status; admin output reports token counts only, never token values. ([REQ-OBS-007](../../sdd/spec/observability.md))

1. **One-node mesh.** Install the agent on node A only. Expect the active profile's mesh entry to converge to `seedNodeId` and `coordinatorNodeId` naming node A, `rotation` 0, `tokenCount` 1, and the profile's model in `readyModels`.
2. **Second node joins.** Install the agent on node B. The router distributes join tokens through heartbeat mesh bootstrap — no manual token handling. Expect `peerNodeIds` to list both nodes and `tokenCount` 2.
3. **Split readiness.** Activate the split profile from the Admin UI. Both nodes restart `mesh-llm` in split mode; nodes are not ready while reloading. Expect `readyModels` to repopulate with the split profile's model once layer distribution completes.
4. **Failover and rejoin.** Stop the agent service on node B. Expect node B to appear in `failedNodeIds` while node A keeps serving; after restart, node B rejoins from distributed tokens and `failedNodeIds` clears.
5. **Rotation test.** Rotate the mesh token from the Admin UI. Expect `rotation` to increment, mesh state to reset, `tokenCount` to recover as heartbeats store fresh tokens, and the mesh to reform within two minutes under idle or short-stream load. ([CON-SEC-003](../../sdd/spec/constraints.md#con-sec-003-mesh-secret-custody-and-rotation)) ([REQ-SEC-006](../../sdd/spec/security.md))
   - Model readiness restoration additionally waits on model reload.
   - A node holding only a pre-rotation token must not rejoin until it receives a fresh one. ([REQ-SEC-007](../../sdd/spec/security.md))
6. **Gateway chat.** Send a chat completion for the public alias through the AI Gateway dynamic route and confirm a mesh-served response. ([REQ-GWY-003](../../sdd/spec/gateway.md))

## Release channels

Production releases use stable semantic tags such as `v0.1.0`. Integration releases use prerelease tags such as `v0.1.0-dev.<run_number>`. The deployed Worker stores the selected tag in `AGENT_RELEASE_TAG`, so install scripts download from `/releases/download/<tag>/` and integration installs use prerelease artifacts instead of GitHub `latest`. After install, node agents converge to the operator-selected release tag exactly, stable or prerelease (see [Agent self-update](#agent-self-update)). ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Agent self-update

Node binaries need no manual redeploy after first install. Operators select a release tag from the Admin UI agent-version dropdown; every heartbeat response carries that desired version, and a node whose running version differs — newer or older — downloads the tagged release binary with `checksums.txt`, verifies the SHA-256, stages it, applies it by atomic swap, and exits so the service manager restarts it (systemd `Restart=always`, launchd `KeepAlive`, Windows `sc.exe` failure actions). A failure at any step reports the node's last error and leaves the current version running; the node retries only when the desired version changes or after one hour. ([REQ-ADM-008](../../sdd/spec/setup-admin.md)) ([REQ-NODE-005](../../sdd/spec/node-agent.md)) ([REQ-NODE-009](../../sdd/spec/node-agent.md))

## Rollback

**When:** The latest Worker deployment or release artifact is bad and the safe code has been restored onto the deployment branch.

**Command:**

```bash
gh workflow run Deploy --ref main -f environment=production -f version_tag=<new-rollback-tag>
```

For integration rollback, restore the safe code onto the selected integration branch and run `gh workflow run Deploy --ref develop -f environment=integration -f version_tag=<new-rollback-tag>`. `.github/workflows/deploy.yml` publishes artifacts for the selected ref and tag; it does not redeploy an existing release tag.

**Verifies:** After the workflow succeeds, call `GET /health` on the target Worker and confirm installer scripts reference the new rollback release tag.

**Rollback:** If the rollback workflow fails before Worker deploy, the existing Worker remains active. If it fails after publishing a release but before deploy, delete the unused rollback GitHub Release tag and rerun from the restored safe ref with a fresh tag.

Model profile rollback switches the public alias back to a previously ready profile. Node update rollback selects the previous verified release tag from the agent-version dropdown; nodes converge to it automatically through the same checksum-verified self-update flow (downgrade is version inequality, not ordering). ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md)) ([REQ-NODE-005](../../sdd/spec/node-agent.md)) ([REQ-NODE-009](../../sdd/spec/node-agent.md)) ([REQ-ADM-008](../../sdd/spec/setup-admin.md))

## CI verification policy

GitHub Actions is authoritative for full suites, builds, lint, type-checks, deploy dry-runs, and release packaging. Avoid expensive full local runs in the constrained container; when the operator explicitly accepts the risk, use only targeted touched-package checks to catch syntax or contract failures before pushing. ([REQ-REL-001](../../sdd/spec/release-ci.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| PR checks | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/ci.yml::REL001PullRequestChecks` <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> |
| Production deploy gate | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/deploy.yml::REL002AutoProductionDeploy` <!-- @impl: .github/workflows/deploy.yml::REL002AutoProductionDeploy --> |
| Manual integration deploy | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/deploy.yml::REL002ManualIntegrationDeploy` <!-- @impl: .github/workflows/deploy.yml::REL002ManualIntegrationDeploy --> |
| Release artifacts | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/deploy.yml::REL003ReleaseArtifacts` <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> |
| Bounded fuzz | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/fuzz.yml::REL004FuzzWorkflows` <!-- @impl: .github/workflows/fuzz.yml::REL004FuzzWorkflows --> |
| Workflow contract tests | [release-ci.md](../../sdd/spec/release-ci.md) | `packages/router-worker/src/workflows.test.ts::workflow` <!-- @impl: packages/router-worker/src/workflows.test.ts::workflow --> |
| Service install | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/service.go::ServiceInstallPlan` <!-- @impl: packages/node-agent/internal/agent/service.go::ServiceInstallPlan --> |
| Runtime command | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs` <!-- @impl: packages/node-agent/internal/agent/meshllm_render.go::RenderMeshLLMArgs --> |
| MeshLLM install | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM` <!-- @impl: packages/node-agent/internal/agent/meshllm_install.go::EnsureMeshLLM --> |
| Agent self-update | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/selfupdate.go::NewSelfUpdater` <!-- @impl: packages/node-agent/internal/agent/selfupdate.go::NewSelfUpdater --> |
| Mesh state key deploy | [security.md](../../sdd/spec/security.md) | `.github/workflows/deploy.yml::MESH_STATE_KEY` <!-- @impl: .github/workflows/deploy.yml::MESH_STATE_KEY --> |
