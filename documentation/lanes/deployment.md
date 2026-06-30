# Deployment

## Delivery model

Deployment is manual. Pull requests and main pushes verify behavior, but only the deploy workflow changes Cloudflare state or publishes node-agent artifacts. (REQ-REL-001) (REQ-REL-002)

## PR checks

| Check group | Required behavior | REQs |
| --- | --- | --- |
| Router | Install, lint, behavioral tests, type-check, Wrangler types, dry-run deploy. | REQ-REL-001 |
| Agent | Go tests, vet, race tests, and command build. | REQ-REL-001 |
| Packaging | Build one archive, generate checksums, verify hash, run staged version command. | REQ-REL-001 |
| Security | npm audit, Go vulnerability check, dependency review where available. | REQ-REL-001, REQ-REL-004 |

## Deploy workflow

| Step | Outcome | REQs |
| --- | --- | --- |
| Validate input | Production deploy requires `main` and explicit version. | REQ-REL-002 |
| Repeat checks | Critical router and agent checks pass before state changes. | REQ-REL-002 |
| Prepare D1 | Database is created or resolved and migrations are applied. | REQ-REL-002 |
| Build artifacts | Platform agent archives, checksums, signature, and manifest exist. | REQ-REL-003 |
| Publish release | GitHub Release contains all installer/update assets. | REQ-REL-003 |
| Deploy Worker | Wrangler deploy publishes the router. | REQ-REL-002 |
| Summarize | Workflow summary lists URL, release tag, environment, and artifacts. | REQ-REL-002 |

## Release channels

Production releases use stable semantic tags such as `v0.1.0`. Integration releases use prerelease tags such as `v0.1.0-dev.<run_number>`. Node agents on stable ignore prerelease releases. (REQ-REL-003)

## Rollback

Worker rollback uses the prior deployment or prior workflow ref. Agent rollback uses the previous binary retained by the service update flow. Model profile rollback switches the public alias back to a previously ready profile. (REQ-NODE-005) (REQ-RUN-004)

## CI verification policy

Do not run local test suites, builds, linters, or type-checkers in the constrained container. Implementation changes are pushed and verified through GitHub Actions. (REQ-REL-001)
