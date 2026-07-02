# Pending Implementation Task List

> **Superseded.** This task list tracks the original llama.cpp-era
> build. The inference backend is now MeshLLM; see
> [AD-012: MeshLLM-only private inference backend](documentation/decisions/README.md#ad-012-meshllm-only-private-inference-backend).
> It is kept for historical context and is not updated.

This task list is generated from [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md), [`PLAN.md`](PLAN.md), and [`sdd/README.md`](sdd/README.md).

## In progress

- [ ] Verify all 38 implemented REQs through CI-backed RED/GREEN/VERIFY loops.

## Task groups

### 1. Repository and CI foundation

- [ ] Create root workspace metadata and ignore rules.
- [ ] Create `packages/router-worker` with TypeScript, Wrangler, D1 migrations, tests, and Worker entry point.
- [ ] Create `packages/node-agent` with Go module, command entry point, internal packages, and tests.
- [ ] Create GitHub Actions for PR checks, deploy, release artifacts, and security checks.
- Specs: [`REQ-REL-001`](sdd/spec/release-ci.md#req-rel-001-pull-request-checks), [`REQ-SCH-001`](sdd/spec/state-scheduling.md#req-sch-001-durable-router-state).

### 2. Router Worker behavior

- [ ] Implement Gateway custom-provider contract and provider-token contract.
- [ ] Implement route family separation for health, provider, node, setup, admin, and installer routes.
- [ ] Implement chat completion validation, model rewrite, reservation, Mesh fetch, streaming pass-through, and reservation release.
- [ ] Implement Mesh destination safety, header validation, and header filtering.
- Specs: [`gateway.md`](sdd/spec/gateway.md), [`router-worker.md`](sdd/spec/router-worker.md), [`security.md`](sdd/spec/security.md).

### 3. Durable state and scheduling

- [ ] Implement D1 schema and repositories.
- [ ] Implement Durable Object scheduler reservation serialization.
- [ ] Implement node eligibility, busy responses, lease expiry, and session affinity.
- Specs: [`state-scheduling.md`](sdd/spec/state-scheduling.md).

### 4. Setup and admin

- [ ] Implement first-run setup.
- [ ] Implement admin token/session auth.
- [ ] Implement setup-token lifecycle.
- [ ] Implement Cloudflare AI Gateway custom provider, dynamic route, route version, and deployment automation.
- [ ] Implement one-line installer responses and custom-domain validation.
- Specs: [`setup-admin.md`](sdd/spec/setup-admin.md), [`gateway.md`](sdd/spec/gateway.md).

### 5. Runtime profiles

- [ ] Implement public model alias registry.
- [ ] Seed `mesh-default`, Qwen3.6 27B, Gemma 4 26B-A4B, and smoke-test profiles.
- [ ] Implement managed llama.cpp profile commands and rollout metadata.
- Specs: [`runtime-profiles.md`](sdd/spec/runtime-profiles.md).

### 6. Node agent

- [ ] Implement claim and heartbeat.
- [ ] Persist node and upstream credentials locally with restrictive file permissions.
- [ ] Implement upstream bearer proxy and streaming behavior.
- [ ] Implement local dashboard JSON and HTML shell.
- [ ] Implement metrics, service install helpers, runtime manager, and self-update staging.
- Specs: [`node-agent.md`](sdd/spec/node-agent.md), [`observability.md`](sdd/spec/observability.md), [`security.md`](sdd/spec/security.md).

### 7. Observability and failure reporting

- [ ] Add request/session/node metadata headers.
- [ ] Add admin status JSON.
- [ ] Add node metrics in heartbeat and local dashboard.
- [ ] Add safe error responses with request IDs and no secrets.
- Specs: [`observability.md`](sdd/spec/observability.md).

### 8. SDD/doc closure

- [ ] Add real `@impl` source anchors to every implemented AC.
- [ ] Add source anchors to load-bearing documentation claims.
- [ ] Ensure every documentation lane links to the relevant REQs.
- [ ] Ensure every spec file links back to relevant documentation lanes.
- [ ] Move all implemented REQs to `Implemented` and leave no REQ `Partial`.

### 9. CI verification

- [ ] Commit and push implementation.
- [ ] Start background CI monitoring for the exact pushed head.
- [ ] GitHub Actions is authoritative for full suites, builds, lint, type-checks, deployment dry-runs, and release packaging.
- [ ] Avoid expensive full local runs in the constrained container; if the operator explicitly accepts the risk, use only targeted touched-package checks to catch syntax or contract failures before pushing.
- [ ] Fix failures from targeted checks or GitHub Actions logs and repeat until CI reports success, unless blocked by missing Cloudflare repo secrets.

## Repo secrets the user must add

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN_DEPLOY`
- `CLOUDFLARE_API_TOKEN_RUNTIME`

Do not add app-generated admin, setup, node, provider, or upstream tokens as repo secrets.
