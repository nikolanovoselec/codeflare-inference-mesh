# Deployment

## Delivery model

Deployment is manual. Pull requests and main pushes verify behavior, but only the deploy workflow changes Cloudflare state or publishes node-agent artifacts. ([REQ-REL-001](../../sdd/spec/release-ci.md)) ([REQ-REL-002](../../sdd/spec/release-ci.md))

## PR checks

| Check group | Required behavior | REQs |
| --- | --- | --- |
| Router | Install, lint, behavioral tests, type-check, Wrangler types, dry-run deploy. | [REQ-REL-001](../../sdd/spec/release-ci.md) |
| Agent | Go tests, vet, race tests, and command build. | [REQ-REL-001](../../sdd/spec/release-ci.md) |
| Packaging | Build one archive, generate checksums, verify hash, run staged version command. | [REQ-REL-001](../../sdd/spec/release-ci.md) |
| Security | npm audit, Go vulnerability check, dependency review where available. | [REQ-REL-001](../../sdd/spec/release-ci.md), [REQ-REL-004](../../sdd/spec/release-ci.md) |

## Deploy workflow

| Step | Outcome | REQs |
| --- | --- | --- |
| Validate input | Production deploy requires `main` and explicit version. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Repeat checks | Critical router and agent checks pass before state changes. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Prepare D1 | Database is created or resolved and migrations are applied. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Build artifacts | Platform agent archives, checksums, signature, and manifest exist. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Publish release | GitHub Release contains all installer/update assets. | [REQ-REL-003](../../sdd/spec/release-ci.md) |
| Deploy Worker | Wrangler deploy publishes the router. | [REQ-REL-002](../../sdd/spec/release-ci.md) |
| Summarize | Workflow summary lists URL, release tag, environment, and artifacts. | [REQ-REL-002](../../sdd/spec/release-ci.md) |

## Release channels

Production releases use stable semantic tags such as `v0.1.0`. Integration releases use prerelease tags such as `v0.1.0-dev.<run_number>`. Node agents on stable ignore prerelease releases. ([REQ-REL-003](../../sdd/spec/release-ci.md))

## Rollback

Worker rollback uses the prior deployment or prior workflow ref. Agent rollback uses the previous binary retained by the service update flow. Model profile rollback switches the public alias back to a previously ready profile. ([REQ-NODE-005](../../sdd/spec/node-agent.md)) ([REQ-RUN-004](../../sdd/spec/runtime-profiles.md))

## CI verification policy

GitHub Actions is authoritative for full suites, builds, lint, type-checks, deploy dry-runs, and release packaging. Avoid expensive full local runs in the constrained container; when the operator explicitly accepts the risk, use only targeted touched-package checks to catch syntax or contract failures before pushing. ([REQ-REL-001](../../sdd/spec/release-ci.md))

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| PR checks | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/ci.yml::REL001PullRequestChecks` <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> |
| Manual deploy | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/deploy.yml::REL002ManualDeploy` <!-- @impl: .github/workflows/deploy.yml::REL002ManualDeploy --> |
| Release artifacts | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/deploy.yml::REL003ReleaseArtifacts` <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> |
| Bounded fuzz | [release-ci.md](../../sdd/spec/release-ci.md) | `.github/workflows/fuzz.yml::REL004FuzzWorkflows` <!-- @impl: .github/workflows/fuzz.yml::REL004FuzzWorkflows --> |
| Workflow contract tests | [release-ci.md](../../sdd/spec/release-ci.md) | `packages/router-worker/src/workflows.test.ts::workflow` <!-- @impl: packages/router-worker/src/workflows.test.ts::workflow --> |
| Service install | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/service.go::ServiceInstallPlan` <!-- @impl: packages/node-agent/internal/agent/service.go::ServiceInstallPlan --> |
