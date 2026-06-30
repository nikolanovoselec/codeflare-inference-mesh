# Cloudflare Inference Mesh

Cloudflare Inference Mesh exposes private local LLM machines as one OpenAI-compatible provider behind Cloudflare AI Gateway. A Worker router receives Gateway traffic, selects an eligible WARP/Mesh-enrolled node, forwards the request through Workers VPC, and streams the local runtime response back to the client.

## Status

This repository is implementation-ready but has not started source implementation yet.

- Product contract: [sdd/](sdd/)
- Operational documentation: [documentation/](documentation/)
- Architecture plan: [PLAN.md](PLAN.md)
- Implementation tracking: [pending.md](pending.md)

All implementation work should start from the Planned REQs in `sdd/spec/` and follow test-first delivery. Source `@impl` anchors are added when a REQ moves from `Planned` to `Partial` or `Implemented`.

## Planned packages

```text
packages/router-worker   Cloudflare Worker, Durable Object scheduler, D1 migrations
packages/node-agent      Go service, local UI, runtime proxy, service installers
.github/workflows        PR checks, security checks, release and deploy workflows
```
