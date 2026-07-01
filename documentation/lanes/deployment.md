# Deployment

## Contents

- [Delivery model](#delivery-model)
- [PR checks](#pr-checks)
- [Deploy workflow](#deploy-workflow)
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
| Repeat checks | Critical router and agent checks pass before state changes. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Prepare D1 | The production or integration database is created or resolved and migrations are applied. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Build artifacts | Platform agent archives, checksums, signature, and manifest exist. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Publish release | GitHub Release contains all installer/update assets. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Deploy Worker | Wrangler deploy publishes the production or integration router with `AGENT_RELEASE_TAG` set to the selected release tag. | [REQ-REL-002](../../sdd/spec/release-ci.md), [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Summarize | Workflow summary lists ref, Worker, release tag, environment, and artifacts. | [REQ-REL-002](../../sdd/spec/release-ci.md) |

## Release channels

Production releases use stable semantic tags such as `v0.1.0`. Integration releases use prerelease tags such as `v0.1.0-dev.<run_number>`. The deployed Worker stores the selected tag in `AGENT_RELEASE_TAG`, so install scripts download from `/releases/download/<tag>/` and integration installs use prerelease artifacts instead of GitHub `latest`. Node agents on stable ignore prerelease releases. ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Rollback

**When:** The latest Worker deployment or release artifact is bad and a previous Git ref is known to be safe.

**Command:** Run the manual Deploy workflow with `environment=integration` or `environment=production`, `version_tag` set to the known-good tag, and the workflow ref set to the known-good branch or commit. Production rollback still requires the selected ref to be `main`.

**Verifies:** After the workflow succeeds, call `GET /health` on the target Worker and confirm installer scripts reference the known-good release tag.

**Rollback:** If the rollback workflow fails before Worker deploy, the existing Worker remains active. If it fails after publishing a release but before deploy, delete the unused GitHub Release tag and rerun with the last known-good tag.

Agent rollback uses the previous binary retained by the service update flow. Model profile rollback switches the public alias back to a previously ready profile. ([REQ-NODE-005](../../sdd/spec/node-agent.md)) ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

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
