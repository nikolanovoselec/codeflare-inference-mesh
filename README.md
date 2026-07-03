# Codeflare Inference Mesh

Most enterprises already own thousands of Windows, macOS, and Linux devices that sit idle for much of the day while people write email, read wikis, join meetings, or wait between tasks. Codeflare Inference Mesh turns those machines into a pooled inference fabric for employees, operators, analysts, developers, and autonomous agents.

Instead of buying dedicated inference racks or sending every request to third-party AI providers, the mesh uses existing endpoint capacity first. It still leaves room for automatic failover and routing to external providers such as OpenAI, Anthropic, Microsoft, or other frontier-model services when local capacity is insufficient or a task needs a stronger model.

Technically, Codeflare Inference Mesh is a set of private local LLM nodes behind one stable OpenAI-compatible Cloudflare AI Gateway route. A Cloudflare Worker receives Gateway traffic, selects a ready node, and forwards the request over Workers VPC / Cloudflare Mesh. Each node runs the Go agent, which installs and supervises a pinned `mesh-llm` runtime, reports runtime health, and proxies requests to it. Nodes that serve the same profile form a private mesh over Cloudflare WARP for single-node or split serving.

## Use it for

- One public model alias, for example `mesh-default`.
- Local GPUs without public node URLs.
- Cloudflare One / WARP private node reachability.
- Session affinity for long-context coding agents.
- Profile-driven `mesh-llm` runtimes and readiness checks.
- Single-node serving by default, with a split-serving profile toggled from Admin.
- Router-driven agent updates: the admin selects a release, nodes update themselves.
- Admin setup, node enrollment, Gateway sync, custom domains, and installer commands from the browser UI.

## Repository layout

```text
packages/router-worker   Worker router, Durable Object scheduler, D1 state, router tests
packages/node-agent      Go node agent, local dashboard, runtime proxy, update helpers
.github/workflows        CI, deploy, fuzz, and security workflows
sdd/                     product requirements and source/test anchors
documentation/           detailed operational docs
```

## Status

The product contract lives in [sdd/](sdd/). Operational detail lives in [documentation/](documentation/). GitHub Actions is the full verification surface.

## Deploy

1. Add the required GitHub secrets in **Settings → Secrets and variables → Actions**:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN_DEPLOY`
   - `CLOUDFLARE_API_TOKEN_RUNTIME`
   - `MESH_STATE_KEY`
2. Open **Actions → Deploy → Run workflow**.
3. Choose `integration` or `production`.
4. Use `vX.Y.Z-dev.N` tags for integration and `vX.Y.Z` tags for production.
5. Run the workflow.

Before routing real traffic, enroll each node in Cloudflare One / WARP. No separate inference server is needed: the agent downloads a pinned, checksum-verified `mesh-llm` binary on its own. Nodes need GPU drivers where applicable and outbound HTTPS to `github.com` and `huggingface.co`.

## After deploy

1. Open the deployed Worker root or `/admin`.
2. Run first setup and save the one-time tokens.
3. Provision the custom domain from Admin; the initial workers.dev URL is only for setup/bootstrap.
4. Sync the AI Gateway route from Admin so Gateway targets the custom domain.
5. Paste the provider token into the AI Gateway custom provider key / BYOK field.
6. Install node agents with the generated one-line command.

<details>
<summary>Configuration reference: API tokens, scopes, variables, and secrets</summary>

### GitHub Actions secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Cloudflare account used by deploy and runtime setup. |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | Yes | Deploys Workers and manages D1. |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Yes | Lets the deployed Worker sync AI Gateway and optional custom domains. |
| `MESH_STATE_KEY` | Yes | Encryption key for stored private-mesh state; deploy sets it as a Worker secret and refuses to run without it. |
| `ADMIN_RECOVERY_TOKEN` | Optional | Emergency token for replacing a lost admin token. |
| `COSIGN_PRIVATE_KEY` | Optional | Signs release checksums. |
| `COSIGN_PASSWORD` | Optional | Password for `COSIGN_PRIVATE_KEY`. |

Do not store generated provider, admin, setup, node, or upstream tokens as GitHub secrets. First setup generates them.

### Cloudflare token scopes

Use scoped API tokens, not a global API key.

| Token | Minimum scopes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | `Workers Scripts: Edit`, `D1: Edit`, `Account Settings: Read` |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | `AI Gateway: Edit`, `Account Settings: Read`; add `Workers Routes: Edit` and target-zone DNS permissions when using custom-domain provisioning |

### Worker bindings, vars, and secrets

The Worker config is in [`packages/router-worker/wrangler.toml`](packages/router-worker/wrangler.toml).

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | Durable router state. |
| `REGISTRY` | Durable Object | Serialized scheduling and reservation release. |
| `MESH` | Workers VPC Network | Worker-to-private-node `fetch()` path; ships commented in `wrangler.toml` and is enabled by the deploy workflow — see [configuration.md](documentation/lanes/configuration.md). |
| `MAX_REQUEST_BYTES` | Var | Chat request size limit. |
| `HEARTBEAT_TTL_SECONDS` | Var | Node freshness window. |
| `AI_GATEWAY_ID` | Var | Default Gateway ID. |
| `AI_GATEWAY_ROUTE_NAME` | Var | Default dynamic route name. |
| `AI_GATEWAY_PROVIDER_NAME` | Var | Default custom provider name. |
| `AI_GATEWAY_PUBLIC_MODEL` | Var | Default public model alias. |
| `WORKER_NAME` | Var | Worker script name for custom-domain routes. |
| `WORKER_BASE_URL` | Var | Optional bootstrap origin override; installers and custom-domain setup use the request origin when this is unset or still a placeholder. |
| `AGENT_RELEASE_TAG` | Var | Release tag used by install scripts. |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Runtime Cloudflare account ID. |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Secret | Runtime Cloudflare API token. |
| `MESH_STATE_KEY` | Secret | Mesh state encryption key; mesh bootstrap and rotation refuse to run without it. |
| `ADMIN_RECOVERY_TOKEN` | Secret | Optional admin-token recovery secret. |

### Node environment

| Name | Required | Purpose |
| --- | --- | --- |
| `HF_TOKEN` | Only for gated Hugging Face profiles | Passed through the node service environment to `mesh-llm`. |

</details>

## Verification

CI runs router tests, Go tests, type checks, release packaging, security checks, fuzzing, and workflow safety. Avoid full local suites in constrained containers; use CI for authoritative results.

## More

- [Operational docs](documentation/)
- [Product requirements](sdd/)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)
