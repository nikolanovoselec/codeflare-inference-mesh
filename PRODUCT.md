# Product

## Register

product

## Users

Codeflare Inference Mesh is used by operators who need to connect private local inference nodes to a Cloudflare-hosted router without exposing those nodes publicly. They are usually in setup, recovery, or day-two operations: creating admin/provider/setup tokens, configuring AI Gateway, installing node agents, checking node health, and keeping the deployment private.

## Product Purpose

The product provides one Cloudflare Worker control plane for private local inference. Success means an operator can deploy the router, complete first-run setup, connect AI Gateway, install node agents, and verify node readiness without using raw API calls for normal configuration.

## Brand Personality

Precise, operational, calm. The interface should feel like infrastructure software made for people who are under pressure: direct controls, clear state, no marketing gloss, no hidden magic.

## Anti-references

Do not look like a generic SaaS landing page, a decorative dashboard, or a docs-only API console. Avoid empty hero copy, vanity metrics, glass cards, and interfaces that require curl for first-run configuration.

## Design Principles

1. Configuration starts in the browser: first-run setup and common admin actions must have visible controls.
2. Secrets are handled deliberately: tokens appear only when generated, with explicit copy/save affordances and no accidental redisplay.
3. State beats prose: show health, setup status, nodes, profiles, Gateway sync, and install paths as concrete operational state.
4. Private networking stays central: the UI should make clear that nodes are reached through Workers VPC / Mesh, not public URLs.
5. Failures must tell operators what to fix next.

## Accessibility & Inclusion

Target WCAG AA contrast, keyboard-operable controls, visible focus states, responsive layouts, and reduced-motion-safe transitions. Do not rely on color alone for status.
