# Deployment

## Contents

- [Delivery model](#delivery-model)
- [PR checks](#pr-checks)
- [Deploy workflow](#deploy-workflow)
- [Node runtime prerequisite](#node-runtime-prerequisite)
- [Release channels](#release-channels)
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
| Build artifacts | Platform agent archives, checksums, signature, and manifest exist; raw binaries are removed before release upload. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Publish release | GitHub Release contains all installer/update assets. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Deploy Worker | Wrangler deploy publishes the production or integration router with `AGENT_RELEASE_TAG` and a validated HTTPS origin-only `WORKER_BASE_URL` set before deploy. | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety), [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Summarize | Workflow summary lists ref, Worker, release tag, environment, and artifacts. | [REQ-REL-005](../../sdd/spec/release-ci.md#req-rel-005-deploy-execution-safety) |

## Node runtime prerequisite

The first managed-runtime version expects each node operator to install a CUDA-capable `llama-server` before starting the service. If the executable is missing from the service user's PATH, the node reports `dependency-missing` and remains ineligible for scheduling instead of failing the router. When a runtime starts, the agent waits for the local `/v1/models` readiness endpoint before reporting the profile as loaded, so scheduling sees only ready runtimes. ([REQ-RUN-003](../../sdd/spec/runtime-profiles.md#req-run-003-managed-llamacpp-runtime)) ([REQ-RUN-005](../../sdd/spec/runtime-profiles.md#req-run-005-runtime-readiness-and-status-reporting)) ([REQ-SCH-003](../../sdd/spec/state-scheduling.md))

Optional custom-domain provisioning uses the runtime Cloudflare token after deploy; give that token DNS and Worker route permissions for the target zone before asking the Admin UI to provision a hostname. ([REQ-ADM-005](../../sdd/spec/setup-admin.md))

## Release channels

Production releases use stable semantic tags such as `v0.1.0`. Integration releases use prerelease tags such as `v0.1.0-dev.<run_number>`. The deployed Worker stores the selected tag in `AGENT_RELEASE_TAG`, so install scripts download from `/releases/download/<tag>/` and integration installs use prerelease artifacts instead of GitHub `latest`. Node agents on stable ignore prerelease releases. ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Rollback

**When:** The latest Worker deployment or release artifact is bad and the safe code has been restored onto the deployment branch.

**Command:**

```bash
gh workflow run Deploy --ref main -f environment=production -f version_tag=<new-rollback-tag>
```

For integration rollback, restore the safe code onto the selected integration branch and run `gh workflow run Deploy --ref develop -f environment=integration -f version_tag=<new-rollback-tag>`. `.github/workflows/deploy.yml` publishes artifacts for the selected ref and tag; it does not redeploy an existing release tag.

**Verifies:** After the workflow succeeds, call `GET /health` on the target Worker and confirm installer scripts reference the new rollback release tag.

**Rollback:** If the rollback workflow fails before Worker deploy, the existing Worker remains active. If it fails after publishing a release but before deploy, delete the unused rollback GitHub Release tag and rerun from the restored safe ref with a fresh tag.

Model profile rollback switches the public alias back to a previously ready profile. Node update rollback is not automatic in this version; operators should reinstall the previous verified release artifact if an update candidate is bad. ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md)) ([REQ-NODE-005](../../sdd/spec/node-agent.md))

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
| Runtime command | [runtime-profiles.md](../../sdd/spec/runtime-profiles.md) | `packages/node-agent/internal/agent/runtime.go::LlamaCommand` <!-- @impl: packages/node-agent/internal/agent/runtime.go::LlamaCommand --> |
