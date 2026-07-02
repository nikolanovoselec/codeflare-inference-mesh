# Constraints

## CON-CF-001: Cloudflare-first public control plane

The public service boundary is Cloudflare Workers plus AI Gateway. Local inference nodes remain private behind Cloudflare One, Mesh, Workers VPC, and app-level bearer tokens.

## CON-CF-002: Worker runtime compatibility

Router code must run in the Cloudflare Workers runtime and use web-standard APIs. Node-specific APIs belong only in the local node-agent package.

## CON-NET-001: Mesh destination validation

The router must build node URLs from validated Mesh IP and allowed port fields. Nodes must never register arbitrary upstream URLs.

## CON-SEC-001: Separate credential classes

Client, provider, setup, node, dashboard, upstream, admin, deploy, and runtime Cloudflare tokens are separate credentials with separate storage and rotation paths.

## CON-SEC-002: No plaintext durable secrets

Durable token records avoid plaintext unless a component must recover and present that credential across its trust boundary.

## CON-STATE-001: D1 is durable truth

D1 stores setup state, Cloudflare resource IDs, model profiles, aliases, nodes, sessions, reservations, and audit records. Durable Objects may cache hot state but must rebuild from D1.

## CON-SCHED-001: Serialized live reservations

A Durable Object owns scheduling decisions that modify in-flight counts, sticky session mappings, and node reservations.

## CON-RUNTIME-001: llama.cpp first runtime

The first managed runtime is `llama-server`. Ollama, LM Studio, and vLLM are adapter targets after the Mesh and llama.cpp path works.

## CON-MODEL-001: Stable Gateway aliases

AI Gateway and clients use stable public aliases. The router owns internal profile selection, rollout, fallback, and request rewriting.

## CON-REL-001: Release artifacts are verifiable

Node-agent installers download platform-specific archives with checksums, and update candidates must be checksum-verified in a protected staging directory before an operator replaces a service binary.

## CON-CI-001: CI is the verification surface

Implementation changes use behavioral tests first, then verify through GitHub Actions. Local test suites, builds, linters, and type-checks are not run in this resource-constrained container.

## CON-SDD-001: SDD and TDD stay coupled

Every implemented REQ must have behavioral tests that reference the REQ ID. Specs, documentation, tests, and source anchors move in the same change.
