# Codeflare Inference Mesh

Codeflare Inference Mesh lets you use private local LLM machines through one stable OpenAI-compatible Cloudflare AI Gateway route.

The public surface is a Cloudflare Worker acting as an inference router. Local machines run node agents on Windows, macOS, or Linux. Each node agent registers with the router, advertises readiness, and reports the private Cloudflare One Client network-interface `IP:PORT` where it can receive inference requests.

The router serves one stable AI Gateway dynamic route, such as `mesh-default`. During setup, the router generates a bearer token for AI Gateway and the operator enters that token in AI Gateway as the custom provider key / BYOK value. Client applications keep calling AI Gateway; AI Gateway calls the Worker; the Worker selects a ready node and forwards the request through Workers VPC / Cloudflare Mesh to the node agent.

## What this project is for

Use this when you want:

- one stable AI Gateway model name such as `mesh-default`;
- local GPUs hidden behind Cloudflare instead of public node URLs;
- node agents that depend on Cloudflare One Client / WARP for private `IP:PORT` reachability;
- session affinity for coding agents and long-context work;
- node registration, heartbeat, capacity, profile readiness, and runtime status;
- profile-driven `llama-server` runtime commands for the proven Qwen3.6 35B A3B and smoke-test profiles;
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

The first implementation slice covers all 42 SDD requirements with source anchors and behavioral tests. CI is authoritative for full verification.

- Product contract: [sdd/](sdd/)
- Operational documentation: [documentation/](documentation/)
- Architecture plan: [PLAN.md](PLAN.md)
- Implementation plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security policy: [SECURITY.md](SECURITY.md)
- License: [PolyForm Noncommercial 1.0.0](LICENSE)
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
| `MESH` | Workers VPC Network binding | Required `cf1:network` binding used for Worker-to-private-node `fetch()` calls |
| `MAX_REQUEST_BYTES` | Worker var | Maximum chat request body size |
| `HEARTBEAT_TTL_SECONDS` | Worker var | Node heartbeat freshness window |
| `AI_GATEWAY_ID` | Worker var | Gateway ID used by setup automation |
| `WORKER_BASE_URL` | Worker var | Public Worker origin used for custom provider setup |
| `AGENT_RELEASE_TAG` | Worker var | GitHub Release tag used by install scripts for node-agent package downloads |
| `CLOUDFLARE_ACCOUNT_ID` | Worker secret | Runtime account ID for setup automation |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Worker secret | Runtime token for AI Gateway automation |

The deploy workflow creates or resolves the D1 database, applies migrations, uncomments the required `[[vpc_networks]]` / `network_id = "cf1:network"` binding, writes runtime secrets, injects the selected `AGENT_RELEASE_TAG`, builds agent artifacts, creates checksums, optionally signs them, publishes a GitHub Release, and then deploys the Worker.

## Cloudflare One / Mesh prerequisite

Before deploy can produce a working inference path:

1. Cloudflare One Client / WARP must be installed and enrolled on every node machine.
2. Those devices must be in the same Cloudflare account network that the Worker reaches through `network_id = "cf1:network"`.
3. The node agent must bind its inference listener to the Cloudflare One network-interface IP when possible.
4. The node agent advertises that private `IP:PORT` to the router in claim and heartbeat requests.
5. The local firewall must allow inbound traffic from the Cloudflare One / Mesh interface to that inference port.
6. A CUDA-capable `llama-server` must be installed on the node PATH before the managed runtime can report ready; otherwise the node reports `dependency-missing` and is not scheduled.

The deploy token does not create or enroll Cloudflare One devices. If you later want this project to automate Zero Trust device, connector, or route setup, that would require additional Cloudflare One / connector permissions beyond the current deploy and runtime tokens.

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

1. Open the deployed Worker root or `/admin` route in a browser.
2. Run first setup to generate:
   - admin token;
   - provider token;
   - setup token;
   - upstream token.
3. Paste the generated provider token into the AI Gateway custom provider key / BYOK field.
4. Use the setup flow to sync the AI Gateway custom provider and dynamic route.
5. Install a CUDA-capable `llama-server` on each node and expose `HF_TOKEN` in the service environment if a selected Hugging Face profile requires it.
6. Install a node agent with the generated one-line installer command.

## Verification

GitHub Actions runs on pull requests to `main` or `develop`, pushes to `main`, and manual dispatch where the workflow supports it:

- router lint, behavioral tests, type-check, Wrangler type generation, Worker dry-run;
- Go tests, vet, race tests, and agent command build;
- package archive/checksum/version checks;
- dependency review, npm audit, Go vulnerability checks;
- bounded router and agent fuzz workflows for pull requests plus scheduled/manual runs;
- workflow safety checks everywhere, CodeQL where GitHub code scanning is available, and Scorecard SARIF scans on the default branch.

Avoid full expensive local suites in constrained containers. If you intentionally accept the risk, use only targeted checks for touched packages.
