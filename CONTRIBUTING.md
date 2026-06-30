# Contributing to Codeflare Inference Mesh

Thank you for your interest in contributing to Codeflare Inference Mesh. This guide covers what you need to know before opening a pull request.

## License

Codeflare Inference Mesh is licensed under [PolyForm Noncommercial 1.0.0](LICENSE). By submitting a contribution, you agree that your work will be distributed under the same license. Commercial use, resale, or paid hosted offerings require a separate written license from the maintainer.

## Getting Started

1. **Fork** this repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/codeflare-inference-mesh.git
   cd codeflare-inference-mesh
   ```
3. **Install dependencies** for the Worker package:
   ```bash
   npm install
   ```
4. **Use the Go toolchain** declared by `packages/node-agent/go.mod` for node-agent work.

## Project Structure

| Directory | Purpose | Technology |
|-----------|---------|------------|
| `packages/router-worker/` | Cloudflare Worker router, Durable Object scheduler, D1 migrations, and router tests | TypeScript, Workers APIs, Vitest |
| `packages/node-agent/` | Cross-platform node agent, Mesh-facing proxy, runtime manager, local dashboard, updater | Go |
| `.github/workflows/` | CI, security, fuzz, and manual deploy workflows | GitHub Actions |
| `sdd/` | Requirements, acceptance criteria, source anchors, and SDD config | Markdown/YAML |
| `documentation/` | Architecture, API, configuration, deployment, security, and troubleshooting lanes | Markdown |

For the product contract, start with [sdd/README.md](sdd/README.md). For operational details, see [documentation/README.md](documentation/README.md).

## Development

This project is Cloudflare-first:

- Router code must run in the Cloudflare Workers runtime and use web-standard APIs.
- Node-only APIs belong in `packages/node-agent/`.
- Nodes require Cloudflare One Client / WARP and advertise the Cloudflare One interface `IP:PORT`.
- The Worker reaches nodes through Workers VPC / Cloudflare Mesh, not public node URLs.

## Testing and Verification

GitHub Actions is the authoritative verification surface for this repository. The development container is resource-constrained, so avoid running full local test, build, lint, type-check, or dev-server suites unless you intentionally accept that risk.

CI verifies:

- Worker lint, behavioral tests, type-check, Wrangler type generation, and Worker dry-run;
- Go tests, vet, race tests, and node-agent build;
- release archive/checksum/version behavior;
- dependency, vulnerability, workflow-safety, fuzz, and security checks.

When adding behavior, write or update behavioral tests that assert state, status codes, route contracts, payload shapes, headers, and durable records. Do not add tests that only match UI copy or prose.

## SDD and Documentation

This repository uses specification-driven development.

- Every implementation change must trace to a `REQ-*` in `sdd/spec/`.
- Requirements marked `Implemented` must have automated behavioral verification.
- Source anchors must point to real implementation symbols.
- If you change a public route, environment variable, workflow, architecture decision, or deployment behavior, update the matching documentation lane in `documentation/`.
- Architecture decisions live in [documentation/decisions/README.md](documentation/decisions/README.md).

## Code Style

- Keep changes focused. One logical change per pull request.
- Prefer small, composable functions and components over broad rewrites.
- Validate external input at boundaries; trust typed internal calls.
- Use immutable updates for TypeScript objects and Go values where practical.
- Store secrets as environment variables or generated credentials, never hardcode them.
- Preserve the accepted first-run setup decision: first-run `/admin/setup` stays open until completed, then admin auth protects setup/admin routes. Do not add an `INITIAL_SETUP_TOKEN` or equivalent pre-admin setup-token gate.

## Branches and Pull Requests

Use descriptive branch names with a prefix:

- `feat/` -- new features
- `fix/` -- bug fixes
- `refactor/` -- code restructuring
- `test/` -- test additions or fixes
- `docs/` -- documentation changes

Example: `fix/mesh-reservation-release`

Pull request process:

1. Create a feature branch from `develop`.
2. Make the smallest change that solves the issue.
3. Add behavioral tests for new behavior or bug fixes.
4. Update SDD and documentation when the public contract changes.
5. Open a pull request against `develop` for feature work, or from `develop` to `main` for release review.
6. Wait for CI to pass before merging.

## Security

If you discover a security vulnerability, do not open a public issue. Use GitHub private vulnerability reporting for this repository:

<https://github.com/nikolanovoselec/codeflare-inference-mesh/security/advisories/new>

See [SECURITY.md](SECURITY.md) for scope, supported versions, and disclosure process.

For changes touching auth, tokens, request routing, Cloudflare API integration, install scripts, or runtime exposure, include the verification path in the pull request.

## Questions

Open an issue for questions about the codebase, architecture, setup flow, or contribution process.

**Related Documentation:**

- [README.md](README.md) - Product overview and setup
- [sdd/README.md](sdd/README.md) - Requirement index
- [documentation/README.md](documentation/README.md) - Operational documentation
- [documentation/decisions/README.md](documentation/decisions/README.md) - Architecture decision ledger
