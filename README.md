# Cloudflare Inference Mesh

Cloudflare Inference Mesh is a planned router for local LLM nodes connected
through Cloudflare WARP, Mesh, Workers VPC, Durable Objects, and AI Gateway.

The goal is to expose one AI Gateway custom provider while routing requests to
local machines that run llama.cpp or similar OpenAI-compatible inference
servers.

## Planned Components

- Cloudflare Worker router with Durable Object scheduling.
- WARP-enrolled node agent for Windows, macOS, and Linux.
- Local node dashboard for model, heartbeat, Mesh IP, and token/sec stats.
- One-line node installation from the Worker admin UI.
- GitHub Actions for Worker deploys and node-agent releases.

## Status

This repository currently contains the architecture and execution plan in
[PLAN.md](PLAN.md).
