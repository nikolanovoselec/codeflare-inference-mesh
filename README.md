# Codeflare Inference Mesh

<p align="center">
  <img src="assets/og.png" alt="Codeflare Inference Mesh: private LLM inference on hardware you already own." width="100%">
</p>

[![CI](https://github.com/nikolanovoselec/codeflare-inference-mesh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nikolanovoselec/codeflare-inference-mesh/actions/workflows/ci.yml)
[![Security](https://github.com/nikolanovoselec/codeflare-inference-mesh/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/nikolanovoselec/codeflare-inference-mesh/actions/workflows/security.yml)
[![Fuzz](https://github.com/nikolanovoselec/codeflare-inference-mesh/actions/workflows/fuzz.yml/badge.svg?branch=main)](https://github.com/nikolanovoselec/codeflare-inference-mesh/actions/workflows/fuzz.yml)
[![Codeflare](https://img.shields.io/badge/part_of-Codeflare-ff5c3c)](https://github.com/nikolanovoselec/codeflare)
[![Runtime](https://img.shields.io/badge/runtime-mesh--llm-1f6feb)](https://github.com/Mesh-LLM/mesh-llm)
[![Engine](https://img.shields.io/badge/engine-llama.cpp-8250df)](https://github.com/ggml-org/llama.cpp)

**Turn the idle machines you already own into a private inference fabric for open LLMs.**

Codeflare Inference Mesh is the self-hosted inference layer of the **[Codeflare](https://codeflare.ch)** family ([GitHub](https://github.com/nikolanovoselec/codeflare)), the enterprise agentic coding engine. It pools the idle GPUs and CPUs already sitting in your fleet into one private fabric and serves open models on it, sharding a model too large for any single machine across several nodes and serving it as one. It is the inference engine behind your agentic coding and operations agents, autonomous execution agents, internal chatbots, and anything else in the organization that needs inference. Powered by [mesh-llm](https://github.com/Mesh-LLM/mesh-llm) and [llama.cpp](https://github.com/ggml-org/llama.cpp).

---

## Why it exists

Most enterprises already own thousands of Windows, macOS, and Linux devices. They sit idle for most of the working day: someone reads a wiki, sits in a meeting, or waits between tasks while a capable GPU does nothing. Buying dedicated inference racks to sit next to that idle capacity is the expensive way to solve the problem.

The fabric pools the capacity you have. A request lands on one stable Gateway route, the router picks a ready node, and the node serves the model locally. When local capacity runs short or a task needs a stronger model, you can extend the same route with a native AI Gateway fallback chain to a hosted provider you configure directly in AI Gateway; the router itself does not automate that fallback. No node exposes a public URL, and no prompt leaves your network unless you route it out on purpose.

## How it works

```mermaid
flowchart LR
    client["OpenAI-compatible<br/>client"]
    subgraph edge["Cloudflare edge (public)"]
        gateway["AI Gateway<br/>one stable alias"]
        router["Worker router<br/>D1 · stateless forward"]
    end
    subgraph priv["Your private network (WARP)"]
        node["Ready node"]
        llm["mesh-llm<br/>local GPU"]
    end
    provider["External provider<br/>OpenAI · Anthropic · ..."]

    client --> gateway --> router --> node --> llm
    gateway -.->|optional AI Gateway fallback you configure| provider
```

- Clients call one private model alias called `codeflare-mesh`, and the Gateway route stays fixed as nodes come and go.
- The Worker is the only public surface. It takes Gateway traffic, picks the least-loaded ready node from D1, and forwards over Workers VPC to nodes that stay private on Cloudflare WARP.
- Each node runs one Go agent. It installs and supervises a pinned, checksum-verified `mesh-llm` binary, reports health on every heartbeat, and proxies requests to it, so there is no separate inference server to babysit.
- Nodes serving the same profile form a private mesh. The router elects a seed and hands out join tokens through heartbeats; the mesh then serves a model on one node or splits it across several. Mesh secrets are encrypted at rest and rotate on one click.

## What it runs

The fabric serves open models, not a fixed menu. Every node runs [mesh-llm](https://github.com/Mesh-LLM/mesh-llm), a supervised runtime built on [llama.cpp](https://github.com/ggml-org/llama.cpp), so it runs the broad open-model ecosystem those projects support, from a 1.5B coder that fits on a laptop to large mixture-of-experts models. Operators publish a model under a stable alias `codeflare-mesh`; the fabric places it on ready nodes, splitting a model across several when one machine is not enough.

## Quickstart

1. Fork this repository and add the four deploy secrets in GitHub Actions.
2. Run the Deploy workflow, `integration` first, then `production`.
3. Enroll your nodes in Cloudflare One / WARP. The agent pulls its own `mesh-llm`, so there is no separate server to stand up.
4. Open the deployed origin and follow the setup wizard through custom domain, Access, Gateway, and your first node.

The steps below expand into exact secrets, token scopes, bindings, and the node runbook.

<details>
<summary><strong>Fork &amp; prerequisites</strong></summary>

You need a Cloudflare account and a GitHub repository. Everything builds and deploys in GitHub Actions; nothing runs on your laptop.

- A Cloudflare account with Workers, D1, and AI Gateway available.
- A zone in that account if you want a custom domain (recommended; the console requires one for Access).
- Cloudflare One / WARP for private node reachability.
- Each node: a GPU with current drivers where applicable, and outbound HTTPS to `github.com` and `huggingface.co`.

</details>

<details>
<summary><strong>Deploy secrets &amp; token scopes</strong></summary>

Set these in **Settings → Secrets and variables → Actions**. Use scoped API tokens, never a global key.

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Cloudflare account used by deploy and runtime setup. |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | Yes | Deploys Workers and manages D1. |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | Yes | Lets the deployed Worker sync AI Gateway and provision custom domains and Access. |
| `MESH_STATE_KEY` | Yes | Encrypts stored private-mesh state; the deploy fails closed without it. |
| `ADMIN_RECOVERY_TOKEN` | Optional | Emergency recovery for a lost admin session. |
| `COSIGN_PRIVATE_KEY` / `COSIGN_PASSWORD` | Optional | Signs release checksums. |

**Token scopes**

| Token | Minimum scopes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | `Workers Scripts: Edit`, `D1: Edit`, `Account Settings: Read` |
| `CLOUDFLARE_API_TOKEN_RUNTIME` | `AI Gateway: Edit`, `AI Gateway: Run`, `Access: Apps and Policies Edit`, `Access: Organizations, Identity Providers, and Groups Edit`, `Account Settings: Read`; add `Workers Routes: Edit` and target-zone DNS permissions for custom-domain provisioning. `AI Gateway: Run` lets the Worker execute the console playground through the authenticated gateway (it presents this token as `cf-aig-authorization`); `Edit` alone syncs the gateway but cannot run inference through it. |

Do not store the provider, admin, setup, node, or upstream tokens as GitHub secrets. First-run setup mints those, and each surfaces only where it is used. **Consumer clients** that call the mesh through the dynamic route present their own AI Gateway token carrying the `AI Gateway: Run` scope in `cf-aig-authorization` (a client credential, not a deploy secret); see [security.md](documentation/lanes/security.md) and [troubleshooting.md](documentation/lanes/troubleshooting.md).

Deploy tags: `vX.Y.Z-dev.N` for integration, `vX.Y.Z` for production.

</details>

<details>
<summary><strong>Worker bindings, vars &amp; runtime secrets</strong></summary>

The Worker configuration lives in [`packages/router-worker/wrangler.toml`](packages/router-worker/wrangler.toml).

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | Durable router state. |
| `REGISTRY` | Durable Object | Serializes mesh seed election only; the inference request path is stateless and does not use it. |
| `MESH` | Workers VPC Network | Worker-to-private-node `fetch()` path; ships commented and is enabled by the deploy workflow (see [configuration.md](documentation/lanes/configuration.md)). |
| `MAX_REQUEST_BYTES` | Var | Chat request size limit. |
| `HEARTBEAT_TTL_SECONDS` | Var | Declared for the node freshness window but not consumed; the live TTL is hard-coded to 45s (see [configuration.md](documentation/lanes/configuration.md)). |
| `AI_GATEWAY_ID` / `AI_GATEWAY_ROUTE_NAME` / `AI_GATEWAY_PROVIDER_NAME` / `AI_GATEWAY_PUBLIC_MODEL` | Var | Gateway defaults for the setup wizard. |
| `WORKER_NAME` | Var | Worker script name for custom-domain routes and managed Access groups. |
| `WORKER_BASE_URL` | Var | Optional bootstrap-origin override; setup uses the request origin when unset. |
| `AGENT_RELEASE_TAG` | Var | Release tag the installers pull. |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN_RUNTIME` | Secret | Runtime Cloudflare account and token. |
| `MESH_STATE_KEY` | Secret | Mesh state encryption key; bootstrap and rotation refuse to run without it. |
| `ADMIN_RECOVERY_TOKEN` | Secret | Optional admin-recovery secret. |
| `SETUP_REOPEN` | Secret | Optional break-glass secret to reopen setup on a locked bootstrap origin. |

**Node environment**

| Name | Required | Purpose |
| --- | --- | --- |
| `HF_TOKEN` | Only for gated Hugging Face profiles | Passed through the node service environment to `mesh-llm`. |

</details>

<details>
<summary><strong>Node enrollment, mesh formation &amp; self-update</strong></summary>

1. Enroll each node in Cloudflare One / WARP so the Worker can reach it privately.
2. From the console, mint a single-use enrollment token and copy the generated one-line installer.
3. Run it on the node. The agent installs `mesh-llm`, claims against the router, and starts heartbeating.
4. The first node for a profile becomes the mesh seed; later nodes receive join tokens through heartbeats and join automatically, so you never handle a token by hand.
5. Watch mesh health in the console: seed and coordinator assigned, every node listed as a peer, and the active model in `readyModels`.

Self-update works the same way. Pick a release tag from the console's agent-version dropdown, and every node converges to it, newer or older, by downloading the tagged binary, verifying its SHA-256, swapping atomically, and letting the service manager restart it. A failed update leaves the running version in place and reports the error.

The full two-node runbook, rotation and failover tests, and rollback live in [deployment.md](documentation/lanes/deployment.md).

</details>

## Documentation

- [Product requirements](sdd/): the source-of-truth spec, with source and test anchors on every behavior.
- [Operational docs](documentation/): architecture, configuration, security, deployment, and troubleshooting.
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)
