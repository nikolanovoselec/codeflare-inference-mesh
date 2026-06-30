# Cloudflare Inference Mesh

Cloudflare Inference Mesh exposes private local LLM machines as one OpenAI-compatible provider behind Cloudflare AI Gateway. A Worker router receives Gateway traffic, selects an eligible WARP/Mesh-enrolled node, forwards the request through Workers VPC, and streams the local runtime response back to the client.

## Status

The first implementation slice is in place for all 38 SDD requirements: router Worker, D1 schema, Durable Object scheduler, Go node agent, workflow contracts, behavioral tests, and source anchors.

- Product contract: [sdd/](sdd/)
- Operational documentation: [documentation/](documentation/)
- Architecture plan: [PLAN.md](PLAN.md)
- Implementation plan: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Implementation tracking: [pending.md](pending.md)

All requirement acceptance criteria now carry source `@impl` anchors. Verification runs in GitHub Actions because this container must not run local test suites or builds.

## Packages

```text
packages/router-worker   Cloudflare Worker, Durable Object scheduler, D1 migrations
packages/node-agent      Go service, local UI, runtime proxy, service installers
.github/workflows        PR checks, security checks, release and deploy workflows
```
