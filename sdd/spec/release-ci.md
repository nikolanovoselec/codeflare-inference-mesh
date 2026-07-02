# Release And CI

This domain covers GitHub Actions checks, deploy gating, release packaging, artifact signing, and installer/update compatibility.

---

### REQ-REL-001: Pull request checks

**Intent:** Pull requests and pushes to protected integration branches must verify router, agent, packaging, and security behavior before merge or deploy.

**Applies To:** Admin

**Acceptance Criteria:**

1. PR Checks run on pull requests to `main` and `develop`, pushes to `main`, and manual dispatch. <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks) -->
2. Router checks install dependencies, lint, run behavioral tests, type-check, generate Wrangler types, and perform a Worker dry-run deploy. <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks) -->
3. Agent checks run Go tests, Go vet, race tests, and build the agent command. <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks) -->
4. Packaging checks build at least one agent archive, generate checksums, verify the archive hash, and run the staged binary version command. <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks) -->
5. Security checks include npm audit, Go vulnerability checks, and dependency review where the event supports it. <!-- @impl: .github/workflows/ci.yml::REL001PullRequestChecks --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks) -->

**Constraints:** [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface), [CON-SDD-001](constraints.md#con-sdd-001-sdd-and-tdd-stay-coupled)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-REL-002: Deploy workflow gating

**Intent:** Deploying the Worker and publishing node-agent artifacts changes live state, so production must follow a green main merge while integration remains manually deployable from any branch.

**Applies To:** Admin

**Acceptance Criteria:**

1. Production deploy starts automatically only from a successful `PR Checks` workflow run on a same-repository push to `main`. <!-- @impl: .github/workflows/deploy.yml::REL002AutoProductionDeploy --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch) -->
2. Production deploy waits for exact-head `Security` and `Fuzz` workflows to complete successfully before changing Cloudflare state. <!-- @impl: .github/workflows/deploy.yml::REL002AutoProductionDeploy --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch) -->
3. Manual production deploy refuses to run unless the selected ref is `main`. <!-- @impl: packages/router-worker/scripts/resolve-deploy-settings.mjs::DEPLOY_SETTINGS_ANCHORS --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch) -->
4. Manual integration deploy can run from any branch and targets the integration Worker and D1 database. <!-- @impl: packages/router-worker/scripts/resolve-deploy-settings.mjs::DEPLOY_SETTINGS_ANCHORS --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch) -->
5. Deploy repeats critical router and agent checks before changing Cloudflare state. <!-- @impl: .github/workflows/deploy.yml::REL002ManualIntegrationDeploy --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch) -->
6. Deploy creates or resolves the target D1 database and applies D1 migrations before Worker deployment. <!-- @impl: .github/workflows/deploy.yml::REL002ManualIntegrationDeploy --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 extracts Wrangler D1 create IDs and fails closed when the ID is absent) -->
7. Deploy writes a non-placeholder Worker base URL into Wrangler vars before Worker deployment. <!-- @impl: packages/router-worker/scripts/resolve-deploy-settings.mjs::DEPLOY_SETTINGS_ANCHORS --> <!-- @impl: .github/workflows/deploy.yml::REL002ManualIntegrationDeploy --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch) -->

**Constraints:** [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface), [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane)

**Priority:** P1

**Dependencies:** [REQ-REL-001](#req-rel-001-pull-request-checks), [REQ-SCH-001](state-scheduling.md#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-REL-003: Node-agent release artifacts

**Intent:** The node-agent installer and updater require trusted platform artifacts, so deploy must publish checksummed and signed release assets when fleet behavior changes.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. Deploy builds Windows, macOS, and Linux agent archives for amd64 and arm64 where supported. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->
2. Deploy uploads only archive files that are covered by the checksums file. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->
3. Deploy signs the checksums file when signing is configured. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->
4. Deploy uploads a release manifest containing version, channel, commit, publish time, and artifact metadata. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->
5. Stable production releases use a semantic version tag. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->
6. Prerelease integration releases use a prerelease tag that update clients ignore unless configured for that channel. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->
7. Deploy injects the selected release tag into the Worker so installer scripts download agent archives from that exact release instead of GitHub `latest`. <!-- @impl: .github/workflows/deploy.yml::REL003ReleaseArtifacts --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release) -->

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface)

**Priority:** P1

**Dependencies:** [REQ-REL-002](#req-rel-002-deploy-workflow-gating)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-REL-004: Security workflows

**Intent:** Security analysis should be separate from deploy so scheduled and pull-request checks can run without production write credentials.

**Applies To:** Admin

**Acceptance Criteria:**

1. CodeQL is defined for JavaScript/TypeScript and Go and runs where GitHub code scanning is available. <!-- @impl: .github/workflows/security.yml::REL004SecurityWorkflows --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-004 enables Security and Fuzz gates with stable aggregate checks and explicit timeouts) -->
2. Fuzz workflows run bounded router and agent fuzz targets on pull requests, pushes to `main`, manual dispatch, and a weekly schedule. <!-- @impl: .github/workflows/fuzz.yml::REL004FuzzWorkflows --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-004 enables Security and Fuzz gates with stable aggregate checks and explicit timeouts) -->
3. Optional Scorecard runs with minimal permissions and no production write secrets on the default branch where SARIF upload is available. <!-- @impl: .github/workflows/security.yml::REL004SecurityWorkflows --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-004 enables Security and Fuzz gates with stable aggregate checks and explicit timeouts) -->
4. Workflow safety checks reject unsafe workflow-run checkout patterns, floating runner/action pins, floating reusable-workflow refs, and major-only core action pins. <!-- @impl: packages/router-worker/scripts/workflow-safety.mjs::validateWorkflowSafety --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-004 rejects unsafe workflow_run checkout, floating actions, reusable workflows, and floating runners) -->
5. Security workflows define explicit timeouts. <!-- @impl: .github/workflows/security.yml::REL004SecurityWorkflows --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-004 enables Security and Fuzz gates with stable aggregate checks and explicit timeouts) -->
6. Security workflows do not deploy or publish release artifacts. <!-- @impl: .github/workflows/security.yml::REL004SecurityWorkflows --> <!-- @test: packages/router-worker/src/workflows.test.ts (REQ-REL-004 enables Security and Fuzz gates with stable aggregate checks and explicit timeouts) -->

**Constraints:** [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P2

**Dependencies:** [REQ-REL-001](#req-rel-001-pull-request-checks)

**Verification:** Automated test

**Status:** Implemented

---

## Related documentation

- [documentation/lanes/deployment.md](../../documentation/lanes/deployment.md)
- [documentation/lanes/security.md](../../documentation/lanes/security.md)
- [documentation/lanes/troubleshooting.md](../../documentation/lanes/troubleshooting.md)
