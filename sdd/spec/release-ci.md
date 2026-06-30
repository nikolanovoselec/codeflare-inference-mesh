# Release And CI

This domain covers GitHub Actions checks, deploy gating, release packaging, artifact signing, and installer/update compatibility.

---

### REQ-REL-001: Pull request checks

**Intent:** Pull requests and pushes to main must verify router, agent, packaging, and security behavior before merge or deploy.

**Applies To:** Admin

**Acceptance Criteria:**

1. PR checks run on pull requests to `main`, pushes to `main`, and manual dispatch.
2. Router checks install dependencies, lint, run behavioral tests, type-check, generate Wrangler types, and perform a Worker dry-run deploy.
3. Agent checks run Go tests, Go vet, race tests, and build the agent command.
4. Packaging checks build at least one agent archive, generate checksums, verify the archive hash, and run the staged binary version command.
5. Security checks include npm audit, Go vulnerability checks, and dependency review where the event supports it.

**Constraints:** [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface), [CON-SDD-001](constraints.md#con-sdd-001-sdd-and-tdd-stay-coupled)

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Planned

---

### REQ-REL-002: Manual deploy workflow

**Intent:** Deploying the Worker and publishing node-agent artifacts changes production state, so it must be explicit, repeat critical checks, and block production deploys from non-main refs.

**Applies To:** Admin

**Acceptance Criteria:**

1. Deploy runs only from manual workflow dispatch.
2. Production deploy refuses to run unless the selected ref is `main`.
3. Deploy repeats critical router and agent checks before changing Cloudflare state.
4. Deploy creates or resolves the D1 database and applies D1 migrations before Worker deployment.
5. Deploy writes a summary that includes Worker URL, release tag, environment, and artifact list.

**Constraints:** [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface), [CON-CF-001](constraints.md#con-cf-001-cloudflare-first-public-control-plane)

**Priority:** P1

**Dependencies:** [REQ-REL-001](#req-rel-001-pull-request-checks), [REQ-SCH-001](state-scheduling.md#req-sch-001-durable-router-state)

**Verification:** Automated test

**Status:** Planned

---

### REQ-REL-003: Node-agent release artifacts

**Intent:** The node-agent installer and updater require trusted platform artifacts, so deploy must publish checksummed and signed release assets when fleet behavior changes.

**Applies To:** Node Operator

**Acceptance Criteria:**

1. Deploy builds Windows, macOS, and Linux agent archives for amd64 and arm64 where supported.
2. Deploy creates a checksums file covering every uploaded archive.
3. Deploy signs the checksums file when signing is configured.
4. Deploy uploads a release manifest containing version, channel, commit, publish time, and artifact metadata.
5. Stable production releases require an explicit semantic version tag.
6. Prerelease integration releases use a prerelease tag that update clients ignore unless configured for that channel.

**Constraints:** [CON-REL-001](constraints.md#con-rel-001-release-artifacts-are-verifiable), [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface)

**Priority:** P1

**Dependencies:** [REQ-REL-002](#req-rel-002-manual-deploy-workflow)

**Verification:** Automated test

**Status:** Planned

---

### REQ-REL-004: Security workflows

**Intent:** Security analysis should be separate from deploy so scheduled and pull-request checks can run without production write credentials.

**Applies To:** Admin

**Acceptance Criteria:**

1. CodeQL runs for JavaScript/TypeScript and Go on pull requests, main pushes, manual dispatch, and a weekly schedule.
2. Fuzz workflows run bounded router and agent fuzz targets on pull requests, manual dispatch, and a weekly schedule.
3. Optional Scorecard runs with minimal permissions and no production write secrets.
4. Security workflows define explicit timeouts.
5. Security workflows do not deploy or publish release artifacts.

**Constraints:** [CON-CI-001](constraints.md#con-ci-001-ci-is-the-verification-surface), [CON-SEC-001](constraints.md#con-sec-001-separate-credential-classes)

**Priority:** P2

**Dependencies:** [REQ-REL-001](#req-rel-001-pull-request-checks)

**Verification:** Automated test

**Status:** Planned

---
