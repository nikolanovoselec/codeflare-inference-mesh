# Documentation

This documentation explains how the planned system fits together. Requirements live in [../sdd/README.md](../sdd/README.md); this folder documents architecture, APIs, config, deploy, security, observability, troubleshooting, and decisions.

## Jump TOC

| Lane | File | Owns |
| --- | --- | --- |
| Architecture | [architecture.md](lanes/architecture.md) | Component layout, request lifecycles, data flow, package roles. |
| API Reference | [api-reference.md](lanes/api-reference.md) | Provider, node, installer, and health HTTP routes. |
| Admin API Reference | [api-reference-admin.md](lanes/api-reference-admin.md) | Setup and admin HTTP routes. |
| Configuration | [configuration.md](lanes/configuration.md) | Environment variables, Wrangler bindings, local agent config. |
| Deployment | [deployment.md](lanes/deployment.md) | GitHub Actions, Worker deploy, agent releases, rollback. |
| Security | [security.md](lanes/security.md) | Credential classes, route authorization, header filtering. |
| Observability | [observability.md](lanes/observability.md) | Status, metrics, response headers, audit events. |
| Troubleshooting | [troubleshooting.md](lanes/troubleshooting.md) | Symptom, cause, and fix recipes. |
| Decisions | [README.md](decisions/README.md) | ADR ledger for binding technical choices. |

## Lane ownership

- Specs define what must be true.
- Documentation explains how operators and implementers use the design.
- Decisions record alternatives and tradeoffs.

## Public/private documentation boundary

Public documentation owns product behavior, architecture, REQ backlinks, bindings, runtime configuration, and node environment behavior. Exact GitHub deployment secrets and variables, Cloudflare token scopes, and release-environment values live in [private operations](https://github.com/nikolanovoselec/codeflare-inference-mesh-private).

When those deployment values or their workflow consumers change, update the private README in the same work. Public docs should link there rather than duplicate the credential matrix.

## REQ backlinks

Each lane references the REQs it implements or explains. If implementation changes a public route, env var, workflow, token class, or architectural shape, update the matching lane in the same change.

## Synonym glossary

| Term | Also seen as |
| --- | --- |
| Router Worker | Worker router, provider endpoint, custom provider origin |
| Node Agent | local agent, node service, mesh-facing proxy |
| Public Model Alias | stable model, Gateway model, router alias |
| Model Profile | runtime profile, internal profile, model definition |
| Provider Token | router provider token, Gateway provider key, BYOK value |
| Upstream Token | Worker-to-node token, node local API token |

## Reading order

1. [Architecture](lanes/architecture.md)
2. [Security](lanes/security.md)
3. [API Reference](lanes/api-reference.md)
4. [Configuration](lanes/configuration.md)
5. [Deployment](lanes/deployment.md)
6. [Decisions](decisions/README.md)

## Related

- Product spec: [../sdd/README.md](../sdd/README.md)
