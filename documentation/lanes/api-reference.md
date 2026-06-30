# API Reference

## Conventions

All API responses that represent errors use an OpenAI-style `error` object when they are visible to AI Gateway or OpenAI-compatible clients. Provider routes require the provider token; node routes require setup or node credentials; installer routes contain no permanent secrets. ([REQ-RTR-001](../../sdd/spec/router-worker.md)) ([REQ-SEC-001](../../sdd/spec/security.md))

## GET /health ([REQ-RTR-001](../../sdd/spec/router-worker.md))

**Purpose:** Report that the Worker is reachable.

**Auth:** None.

**Success:** `200` with a small JSON health body.

**Failure:** Worker platform failures surface as Cloudflare errors.

## GET /v1/models ([REQ-GWY-001](../../sdd/spec/gateway.md)) ([REQ-RUN-001](../../sdd/spec/runtime-profiles.md))

**Purpose:** Return public model aliases exposed by the router.

**Auth:** Provider bearer token.

**Success:** `200` with OpenAI-compatible model list.

**Contract:** The response lists aliases such as `mesh-default`, not internal runtime names.

## POST /v1/chat/completions ([REQ-RTR-002](../../sdd/spec/router-worker.md)) ([REQ-RTR-003](../../sdd/spec/router-worker.md))

**Purpose:** Accept OpenAI-compatible chat completions from AI Gateway.

**Auth:** Provider bearer token.

**Request:** JSON chat completion body with a public model alias.

**Success:** Streams or returns the selected node response.

**Busy:** `429` with `Retry-After` and error type `inference_mesh_busy`.

**Failure:** Upstream connection failures return a gateway-style error and release reservations.

## POST /node/claim ([REQ-ADM-003](../../sdd/spec/setup-admin.md)) ([REQ-NODE-002](../../sdd/spec/node-agent.md))

**Purpose:** Exchange a one-time setup token for permanent node credentials.

**Auth:** One-time setup token.

**Success:** Returns node token, upstream token, node ID, router URL, and initial profile state.

**Failure:** Expired, claimed, or invalid setup tokens are rejected.

## POST /node/heartbeat ([REQ-NODE-002](../../sdd/spec/node-agent.md)) ([REQ-OBS-003](../../sdd/spec/observability.md))

**Purpose:** Refresh node lease and report readiness, Mesh IP, profiles, and metrics.

**Auth:** Node token.

**Success:** Returns desired profile actions and active alias state.

**Failure:** Invalid node token rejects the heartbeat without updating live state.

## POST /node/unregister ([REQ-OBS-004](../../sdd/spec/observability.md))

**Purpose:** Let a node voluntarily remove itself from eligible scheduling.

**Auth:** Node token.

**Success:** Marks the node draining or offline and clears live eligibility.

**Failure:** Invalid node token is rejected.

## GET /install.sh ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

**Purpose:** Serve Unix installer script.

**Auth:** None.

**Contract:** Script accepts setup token through environment or command context and embeds no permanent credential.

## GET /install.ps1 ([REQ-ADM-004](../../sdd/spec/setup-admin.md))

**Purpose:** Serve Windows PowerShell installer script.

**Auth:** None.

**Contract:** Script accepts setup token through environment or command context and embeds no permanent credential.

## Source anchors and specification backlinks

| Surface | Specification | Source |
|---|---|---|
| Provider routes | [gateway.md](../../sdd/spec/gateway.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Forwarding routes | [router-worker.md](../../sdd/spec/router-worker.md) | `packages/router-worker/src/router.ts::ROUTER_ANCHORS` <!-- @impl: packages/router-worker/src/router.ts::ROUTER_ANCHORS --> |
| Node proxy | [node-agent.md](../../sdd/spec/node-agent.md) | `packages/node-agent/internal/agent/proxy.go::ProxyAnchors` <!-- @impl: packages/node-agent/internal/agent/proxy.go::ProxyAnchors --> |
