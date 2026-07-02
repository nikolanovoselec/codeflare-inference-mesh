# Implementation Plan

> **Superseded.** This document describes the original llama.cpp-era
> build phases. The inference backend is now MeshLLM; see
> [AD-012: MeshLLM-only private inference backend](documentation/decisions/README.md#ad-012-meshllm-only-private-inference-backend)
> and the current operational docs in [documentation/lanes/](documentation/lanes/).
> It is kept for historical context and is not updated.

Source of truth: [`PLAN.md`](PLAN.md), [`sdd/README.md`](sdd/README.md), and the requirement files under [`sdd/spec/`](sdd/spec/).

No Graphify action is planned because the user selected no graph action and no repo graph exists.

Local builds, tests, lint, type-checks, and dev servers are not run in this container. Verification runs in GitHub Actions.

## Dependency-ordered implementation phases

1. **Repository and CI foundation**
   - Create `packages/router-worker` and `packages/node-agent`.
   - Add root workspace metadata, Wrangler config, D1 migrations, and GitHub Actions.
   - Backlinks: [`REQ-REL-001`](sdd/spec/release-ci.md#req-rel-001-pull-request-checks), [`REQ-SCH-001`](sdd/spec/state-scheduling.md#req-sch-001-durable-router-state).

2. **Router auth, Gateway contract, and route families**
   - Implement provider, node, setup, admin, and upstream credential classes.
   - Implement `/health`, `/v1/models`, `/v1/chat/completions`, `/node/claim`, `/node/heartbeat`, `/admin/*`, and installer routes.
   - Backlinks: [`REQ-GWY-001`](sdd/spec/gateway.md#req-gwy-001-gateway-custom-provider-contract), [`REQ-GWY-002`](sdd/spec/gateway.md#req-gwy-002-provider-token-contract), [`REQ-GWY-004`](sdd/spec/gateway.md#req-gwy-004-gateway-header-validation), [`REQ-RTR-001`](sdd/spec/router-worker.md#req-rtr-001-route-family-separation), [`REQ-SEC-001`](sdd/spec/security.md#req-sec-001-credential-boundaries).

3. **Durable state and scheduling**
   - Implement D1 repositories, schema migrations, Durable Object reservation serialization, session affinity, node eligibility, and busy responses.
   - Backlinks: [`REQ-SCH-001`](sdd/spec/state-scheduling.md#req-sch-001-durable-router-state), [`REQ-SCH-002`](sdd/spec/state-scheduling.md#req-sch-002-node-reservations), [`REQ-SCH-003`](sdd/spec/state-scheduling.md#req-sch-003-node-eligibility-and-scheduler-miss-responses), [`REQ-SCH-004`](sdd/spec/state-scheduling.md#req-sch-004-session-affinity).

4. **Model aliases and runtime profiles**
   - Seed `mesh-default`, Qwen3.6, Gemma 4, and smoke-test profiles.
   - Add profile validation, rollout metadata, and managed llama.cpp runtime instructions.
   - Backlinks: [`REQ-RUN-001`](sdd/spec/runtime-profiles.md#req-run-001-public-model-aliases), [`REQ-RUN-002`](sdd/spec/runtime-profiles.md#req-run-002-default-model-profiles), [`REQ-RUN-003`](sdd/spec/runtime-profiles.md#req-run-003-managed-llamacpp-runtime), [`REQ-RUN-004`](sdd/spec/runtime-profiles.md#req-run-004-profile-rollout).

5. **Inference forwarding and observability**
   - Implement request validation, model rewrite, Mesh-only destination construction, streaming pass-through, reservation release, response metadata, status JSON, metrics, and failure reporting.
   - Backlinks: [`REQ-RTR-002`](sdd/spec/router-worker.md#req-rtr-002-chat-completion-forwarding), [`REQ-RTR-003`](sdd/spec/router-worker.md#req-rtr-003-streaming-pass-through), [`REQ-RTR-004`](sdd/spec/router-worker.md#req-rtr-004-mesh-destination-safety), [`REQ-OBS-001`](sdd/spec/observability.md#req-obs-001-provider-response-metadata), [`REQ-OBS-002`](sdd/spec/observability.md#req-obs-002-admin-status-surface), [`REQ-OBS-004`](sdd/spec/observability.md#req-obs-004-failure-reporting).

6. **Setup and Cloudflare automation**
   - Implement first-run setup, admin auth, setup-token lifecycle, provider/dynamic-route sync, one-line installers, and optional custom-domain validation.
   - Backlinks: [`REQ-ADM-001`](sdd/spec/setup-admin.md#req-adm-001-first-run-setup), [`REQ-ADM-002`](sdd/spec/setup-admin.md#req-adm-002-mvp-admin-auth), [`REQ-ADM-003`](sdd/spec/setup-admin.md#req-adm-003-setup-token-lifecycle), [`REQ-ADM-004`](sdd/spec/setup-admin.md#req-adm-004-one-line-installers), [`REQ-ADM-005`](sdd/spec/setup-admin.md#req-adm-005-optional-custom-domain), [`REQ-GWY-003`](sdd/spec/gateway.md#req-gwy-003-dynamic-route-automation).

7. **Node agent**
   - Implement Go claim, heartbeat, local credential persistence, upstream bearer proxy, local dashboard, runtime manager, service install helpers, metrics, and self-update.
   - Backlinks: [`REQ-NODE-001`](sdd/spec/node-agent.md#req-node-001-cross-platform-service-skeleton), [`REQ-NODE-002`](sdd/spec/node-agent.md#req-node-002-node-claim-and-heartbeat), [`REQ-NODE-003`](sdd/spec/node-agent.md#req-node-003-upstream-proxy), [`REQ-NODE-004`](sdd/spec/node-agent.md#req-node-004-local-dashboard), [`REQ-NODE-005`](sdd/spec/node-agent.md#req-node-005-agent-self-update), [`REQ-OBS-003`](sdd/spec/observability.md#req-obs-003-node-metrics), [`REQ-SEC-004`](sdd/spec/security.md#req-sec-004-runtime-api-exposure).

8. **Release and deployment**
   - Implement PR checks, manual deploy workflow, release artifacts, checksums, vulnerability checks, and deployment summary.
   - Backlinks: [`REQ-REL-001`](sdd/spec/release-ci.md#req-rel-001-pull-request-checks), [`REQ-REL-002`](sdd/spec/release-ci.md#req-rel-002-manual-deploy-workflow), [`REQ-REL-003`](sdd/spec/release-ci.md#req-rel-003-node-agent-release-artifacts), [`REQ-REL-004`](sdd/spec/release-ci.md#req-rel-004-security-workflows).

9. **SDD closure**
   - Add `@impl` anchors to every implemented AC and documentation claim.
   - Keep documentation-to-spec and spec-to-documentation backlinks working.
   - Move every satisfied REQ from `Planned` to `Implemented`; leave nothing `Partial`.

## RED/GREEN/VERIFY task list

For each phase:

1. **RED:** add failing behavioral tests with REQ IDs in test names.
2. **GREEN:** implement the smallest code needed to satisfy those tests.
3. **ANCHOR:** add `@impl` anchors in specs and docs pointing to real source symbols.
4. **BACKLINK:** ensure docs link to REQs and REQs link back to docs.
5. **VERIFY:** push and let GitHub Actions run tests, type checks, Go checks, packaging, and deployment dry runs.

## GitHub repository secrets needed

Add these repository secrets before running the manual Cloudflare deploy workflow:

| Secret | Required for | Value |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Worker deploy and AI Gateway API calls | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | GitHub Actions deploy workflow | Scoped Cloudflare token for Workers deploy, D1, and AI Gateway setup |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Worker runtime AI Gateway automation | Scoped Cloudflare token used by the deployed Worker admin setup route |

Recommended deploy-token permissions: Account Settings Read, Workers Scripts Edit, Workers Routes Edit if using a custom domain, D1 Edit, Workers KV Storage Edit only if added later, AI Gateway Edit, and Workers Tail Read if deployment summaries include logs.

Do not put provider tokens, admin tokens, node tokens, setup tokens, or upstream tokens in GitHub secrets. The app generates and stores those during first-run setup.

## Success criteria & verification

- **No overengineering:** only implement behavior required by the 38 REQs; no extra providers, dashboards, databases, or deployment modes beyond the plan.
- **Behavioral tests only:** tests assert route families, status codes, JSON shapes, D1/repository state, token boundaries, scheduler decisions, stream forwarding, workflow contract values, checksums, and service config behavior. No UI-copy or prose matching.
- **Reusable, composable components:** shared auth, token, profile, repository, scheduler, Cloudflare API, installer, runtime, and service helpers own repeated behavior; profile defaults and credential classes have one source of truth; validation happens at HTTP, storage, filesystem, and external API boundaries.
- **SDD + TDD enforced:** failing tests are written before implementation in each slice; implemented ACs receive real `@impl` anchors; tests include REQ IDs; docs and specs backlink each other; no REQ remains `Partial` at completion.
