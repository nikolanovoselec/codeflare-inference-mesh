# Cloudflare Inference Mesh

Cloudflare Inference Mesh lets you use private local LLM machines through one stable OpenAI-compatible Cloudflare AI Gateway route.

The public surface is a Cloudflare Worker. Local nodes stay private on Cloudflare One / WARP / Mesh. The Worker receives AI Gateway requests, chooses an eligible node, forwards the request through Workers VPC, and streams the local `llama-server` response back to the client.

## What this project is for

Use this when you want:

- one stable AI Gateway model name such as `mesh-default`;
- local GPUs hidden behind Cloudflare instead of public node URLs;
- session affinity for coding agents and long-context work;
- node registration, heartbeat, capacity, and runtime status;
- a Go node agent that proxies OpenAI-compatible requests to local `llama-server`;
- CI-verified Worker, agent, release, security, and deploy workflows.

## Repository layout

```text
packages/router-worker   Cloudflare Worker, Durable Object scheduler, D1 migrations, router tests
packages/node-agent      Go service, local dashboard, runtime proxy, service/update helpers
.github/workflows        CI, deploy, fuzz, and security workflows
sdd/                     requirements, source anchors, and SDD config
documentation/           architecture, API, config, deploy, security, observability lanes
```

## Current status

The first implementation slice covers all 38 SDD requirements with source anchors and behavioral tests. CI is authoritative for full verification.

- Product contract: [sdd/](sdd/)
- Operational documentation: [documentation/](documentation/)
- Architecture plan: [PLAN.md](PLAN.md)
- Implementation plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Task tracking: [pending.md](pending.md)

## GitHub repository secrets

Add these secrets under **GitHub → Repository → Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Required | Used by | Value |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | deploy workflow and Worker runtime setup | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | Yes | GitHub Actions deploy workflow | Cloudflare token for Workers + D1 deploy |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Yes | deployed Worker admin setup route | Cloudflare token for AI Gateway provider and route automation |
| `COSIGN_PRIVATE_KEY` | Optional | release artifact signing | Cosign private key contents |
| `COSIGN_PASSWORD` | Optional | release artifact signing | Password for `COSIGN_PRIVATE_KEY` |

Do **not** add app-generated provider, admin, setup, node, or upstream tokens as GitHub secrets. The setup flow generates and stores those.

## Cloudflare API token scopes

Create scoped Cloudflare API tokens, not a global API key.

### `CLOUDFLARE_API_TOKEN_DEPLOY`

Minimum account-level permissions:

- `Workers Scripts: Edit`
- `D1: Edit`
- `Account Settings: Read`

Resource scope:

- Account resources: this Cloudflare account only.
- Zone resources: none for workers.dev deployment.

Only add zone permissions later if custom-domain automation needs them.

### `CLOUDFLARE_API_TOKEN_RUNTIME`

Minimum account-level permissions:

- `AI Gateway: Edit`
- `Account Settings: Read`

Resource scope:

- Account resources: this Cloudflare account only.
- Zone resources: none for current setup.

AI Gateway permissions are account-scoped, not per-gateway.

## Cloudflare configuration

The Worker config lives in [`packages/router-worker/wrangler.toml`](packages/router-worker/wrangler.toml).

Important bindings and values:

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | Durable router state: config, tokens, nodes, profiles, sessions, reservations, audit events |
| `REGISTRY` | Durable Object | Serialized scheduler decisions and reservation release handling |
| `MESH` | service / Mesh binding placeholder | Worker-to-private-node fetch path |
| `MAX_REQUEST_BYTES` | Worker var | Maximum chat request body size |
| `HEARTBEAT_TTL_SECONDS` | Worker var | Node heartbeat freshness window |
| `AI_GATEWAY_ID` | Worker var | Gateway ID used by setup automation |
| `WORKER_BASE_URL` | Worker var | Public Worker origin used for custom provider setup |
| `CLOUDFLARE_ACCOUNT_ID` | Worker secret | Runtime account ID for setup automation |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Worker secret | Runtime token for AI Gateway automation |

The deploy workflow creates or resolves the D1 database, applies migrations, writes runtime secrets, deploys the Worker, builds agent artifacts, creates checksums, optionally signs them, and publishes a GitHub Release.

## Deploy

1. Add the three required GitHub secrets:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN_DEPLOY`
   - `CLOUDFLARE_API_TOKEN_RUNTIME`
2. Open **GitHub → Actions → Deploy → Run workflow**.
3. Choose:
   - `environment`: `production` or `integration`
   - `version_tag`: `v0.1.0` for production, or `v0.1.0-dev.1` for integration
4. Run the workflow.

Production tags must match `vX.Y.Z`. Integration tags must match `vX.Y.Z-dev.N`.

## After deploy

1. Open the deployed Worker admin setup route.
2. Run first setup to generate:
   - admin token;
   - provider token;
   - setup token;
   - upstream token.
3. Paste the generated provider token into the AI Gateway custom provider key / BYOK field.
4. Use the setup flow to sync the AI Gateway custom provider and dynamic route.
5. Install a node agent with the generated one-line installer command.

## Verification

GitHub Actions runs:

- router lint, behavioral tests, type-check, Wrangler type generation, Worker dry-run;
- Go tests, vet, race tests, and agent command build;
- package archive/checksum/version checks;
- dependency review, npm audit, Go vulnerability checks;
- bounded router and agent fuzz workflows;
- CodeQL and Scorecard security scans.

Avoid full expensive local suites in constrained containers. If you intentionally accept the risk, use only targeted checks for touched packages.
