# Inference Mesh Research

## Goal

Build a private local inference mesh where many personal machines can run local
LLM servers and expose them as one OpenAI-compatible provider behind
Cloudflare AI Gateway.

Target shape:

```text
Coding agent / app
  -> Cloudflare AI Gateway
  -> AI Gateway Custom Provider
  -> inference-mesh Cloudflare Worker
  -> Durable Object registry and scheduler
  -> Workers VPC binding to Cloudflare Mesh
  -> WARP-enrolled Windows/macOS/Linux node
  -> local node agent
  -> llama.cpp / Ollama / LM Studio / vLLM
```

The user-facing result should look like one provider/model endpoint, even if
the actual request is served by one of five machines.

## Short Answer On The "Custom Model Key"

For the AI Gateway to consume the Worker as a custom provider, the minimum
credential between AI Gateway and the Worker can be one bearer token.

Recommended:

```text
AI Gateway stored custom provider key
  -> Authorization: Bearer <router_provider_key>
  -> Cloudflare Worker
```

That token is the "provider key" for the Worker-backed custom provider. The
Worker verifies it before accepting `/v1/chat/completions`.

However, that is only the AI Gateway -> Worker credential. A production design
needs separate credentials for each trust boundary:

```text
Client/app -> AI Gateway
  Gateway authentication token, if the AI Gateway is protected.

AI Gateway -> Worker router
  One custom provider key / bearer token stored in AI Gateway.

Node agent -> Worker router
  Per-node registration token or HMAC key.

Worker router -> node agent
  Internal node API bearer token, or per-node shared secret.
```

So the answer is:

```text
Yes, AI Gateway only needs one custom provider bearer key to call the Worker.
No, that one key should not also be reused for node registration or node access.
```

If Cloudflare AI Gateway BYOK is used, clients should not need to know the
router provider key. The key is stored in Cloudflare and injected when AI
Gateway calls the custom provider. The client only calls AI Gateway.

Relevant Cloudflare docs:

- AI Gateway Custom Providers:
  <https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/>
- AI Gateway Bring Your Own Keys:
  <https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/>
- Workers VPC:
  <https://developers.cloudflare.com/workers-vpc/>
- Workers VPC to Cloudflare Mesh example:
  <https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/>
- Cloudflare Mesh:
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh/>
- Cloudflare One Client downloads:
  <https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/>
- Durable Objects:
  <https://developers.cloudflare.com/durable-objects/>
- Workers Streams:
  <https://developers.cloudflare.com/workers/runtime-apis/streams/>

## Core Cloudflare Primitives

### AI Gateway Custom Provider

AI Gateway sees the router Worker as a normal HTTPS model provider.

Example provider:

```json
{
  "name": "Inference Mesh",
  "slug": "inference-mesh",
  "base_url": "https://inference-mesh-router.novoselec.ch",
  "enable": true
}
```

Call path:

```text
https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/custom-inference-mesh/v1/chat/completions
```

AI Gateway forwards:

```text
POST /v1/chat/completions
Authorization: Bearer <router_provider_key>
Content-Type: application/json
```

The Worker must behave like an OpenAI-compatible upstream provider.

### Cloudflare Worker

The Worker is the public HTTPS endpoint and request router.

Responsibilities:

- Verify AI Gateway provider token.
- Accept OpenAI-compatible requests.
- Parse requested model.
- Ask a Durable Object which node should serve the request.
- Forward the request to that node through Workers VPC / Cloudflare Mesh.
- Stream the response back to AI Gateway.
- Record success/failure/latency.
- Release in-flight reservations when the stream ends or is cancelled.
- Serve the admin UI, install scripts, and setup-token claim endpoints.
- Generate one-line node install commands for admins.

### Durable Object

Use one Durable Object as the registry and scheduler.

Why Durable Objects:

- Strongly consistent state for node leases.
- Single-threaded request handling prevents race conditions on in-flight counts.
- Durable storage for nodes, sessions, and failure penalties.
- Good fit for "pick one node and reserve capacity".

The Worker should stay mostly stateless. The Durable Object owns routing state.

### Workers VPC + Cloudflare Mesh

The Worker needs to reach private WARP-enrolled machines. The current
Cloudflare design for that is Workers VPC bound to Cloudflare Mesh:

```jsonc
{
  "vpc_networks": [
    {
      "binding": "MESH",
      "network_id": "cf1:network",
      "remote": true
    }
  ]
}
```

Then:

```ts
const response = await env.MESH.fetch(
  "http://100.96.12.34:11434/v1/chat/completions",
  requestInit
);
```

Important:

- The endpoint must be a Cloudflare One / Zero Trust enrolled WARP device.
- Consumer WARP is not enough.
- Device/Mesh IPs must be enabled.
- Routing is IP-based, so the node registers its Mesh IP.
- The local service must listen on an address reachable through WARP/Mesh.
- The local firewall must allow inbound traffic from the Mesh interface/range.
- Workers VPC is still a newer/beta Cloudflare feature, so test with one node
  before committing the whole product to it.

### WARP Client Nodes

Each machine is a normal Windows/macOS/Linux device running Cloudflare One
Client. It does not need to expose a public hostname.

Each node gets a private Cloudflare Mesh/device IP, typically in Cloudflare's
device IP range such as `100.96.0.0/12`.

The node agent registers:

```json
{
  "nodeId": "win3090-office",
  "meshIp": "100.96.12.34",
  "port": 11434,
  "engine": "llama.cpp",
  "models": [
    {
      "name": "qwen3.5:27b",
      "upstreamModel": "unsloth/Qwen3.5-27B-GGUF",
      "context": 200000,
      "loaded": true
    }
  ],
  "capacity": {
    "maxConcurrent": 1,
    "vramGb": 24
  },
  "metrics": {
    "busy": false,
    "gpuUtil": 12,
    "gpuTemp": 58,
    "freeVramMb": 1800
  }
}
```

## End-To-End Flow

### Registration Flow

```text
Node agent starts
  -> verifies WARP is connected
  -> discovers Mesh IP
  -> starts local inference engine
  -> verifies model is loaded
  -> POST /node/heartbeat to Worker
  -> Worker validates node token
  -> Worker forwards state to Durable Object
  -> Durable Object stores lease
```

Heartbeat interval:

```text
30 seconds recommended
60 seconds acceptable
90 second expiry recommended
```

If a node misses heartbeats, it is removed from routing automatically.

### Inference Flow

```text
Client sends request to AI Gateway
  -> AI Gateway calls custom provider Worker
  -> Worker validates router bearer token
  -> Worker reads model and optional session id
  -> Worker asks Durable Object for a reservation
  -> Durable Object selects node and increments inFlight
  -> Worker calls env.MESH.fetch("http://<mesh-ip>:<port>/v1/chat/completions")
  -> node agent proxies to local llama engine
  -> response streams back to Worker
  -> Worker streams response back to AI Gateway
  -> Worker releases reservation
```

## API Surface

### AI Gateway/Public Provider API

The Worker must expose at least:

```text
GET  /v1/models
POST /v1/chat/completions
GET  /health
```

Optional later:

```text
POST /v1/completions
POST /v1/embeddings
POST /v1/responses
```

For first implementation, only `/v1/chat/completions` is required.

### Node Control API

Node agents call:

```text
POST /node/claim
POST /node/heartbeat
POST /node/register
POST /node/unregister
```

Admin/debug endpoints:

```text
GET /admin
GET /admin/status
GET /admin/nodes
GET /admin/sessions
POST /admin/setup-tokens
POST /admin/nodes/:nodeId/revoke
```

Admin endpoints must require a separate admin token. They should not use the
AI Gateway provider token.

Installer endpoints:

```text
GET /install.sh
GET /install.ps1
```

These can be public because possession of a valid one-time setup token is what
authorizes node enrollment. The install scripts should not contain permanent
secrets.

## Authentication Design

### Token Classes

Use separate token classes:

```text
ROUTER_PROVIDER_TOKEN
  Stored in AI Gateway as the custom provider key.
  Used only for AI Gateway -> Worker.

ADMIN_TOKEN
  Used by humans/scripts to query router status.

NODE_REGISTRATION_TOKEN or per-node token
  Used by node agents to register/heartbeat.

NODE_UPSTREAM_TOKEN
  Used by Worker to call node agent local API.

ONE_TIME_SETUP_TOKEN
  Short-lived token generated from the admin UI.
  Used once by the installer/agent to claim a permanent node token.
```

### Why Separate Tokens

If one node is compromised, it should not be able to impersonate AI Gateway or
register arbitrary nodes. If the AI Gateway provider token leaks, it should not
grant node admin access.

### Provider Token Verification

Worker ingress:

```ts
function requireProviderAuth(request: Request, env: Env): void {
  const expected = `Bearer ${env.ROUTER_PROVIDER_TOKEN}`;
  const actual = request.headers.get("authorization") || "";
  if (!timingSafeEqual(actual, expected)) {
    throw new Response("Unauthorized", { status: 401 });
  }
}
```

Use constant-time comparison. Do not log token values.

### Node Registration Token

Preferred:

```text
one token per node
token hash stored in Durable Object or Worker secret config
token binds to nodeId
```

Heartbeat request:

```http
POST /node/heartbeat
Authorization: Bearer <node_token>
Content-Type: application/json
```

The Worker verifies:

- token is valid
- token is allowed to claim `nodeId`
- `meshIp` is in allowed Mesh ranges
- port is in an allowlist
- models are in an allowlist
- endpoint is not an arbitrary URL

Do not let a node register `https://example.com` as an endpoint. The scheduler
should store only `meshIp` and `port`, then build the URL itself.

### Cloudflare Access Policy

Use Cloudflare Access for humans, not as the primary node identity system.

Recommended route protection:

```text
/admin/*
  Cloudflare Access human login.
  Optional extra `ADMIN_TOKEN` for mutation APIs.

/install.sh
/install.ps1
  Public read is acceptable.
  The script carries no permanent secret.

/node/claim
  Public route.
  Requires one-time setup token.

/node/heartbeat
/node/unregister
  Public route.
  Requires per-node bearer token.

/v1/*
  Public route from Cloudflare's perspective.
  Requires `ROUTER_PROVIDER_TOKEN` bearer token supplied by AI Gateway.
```

Do not protect the entire Worker hostname with Cloudflare Access unless AI
Gateway and node agents are also configured to send Access credentials. That
adds operational friction and still does not replace app-level node identity.

If path-based Access policies become awkward, use two hostnames:

```text
mesh-admin.novoselec.ch
  Access protected.
  Serves `/admin/*`.

inference-mesh-router.novoselec.ch
  No Cloudflare Access.
  Worker enforces bearer tokens for `/v1/*` and `/node/*`.
```

### Setup Token Flow

The admin UI should generate one-line install commands.

Linux/macOS:

```bash
curl -fsSL https://inference-mesh-router.novoselec.ch/install.sh | sudo IM_SETUP_TOKEN=abc123 sh
```

Windows PowerShell:

```powershell
$env:IM_SETUP_TOKEN="abc123"; irm https://inference-mesh-router.novoselec.ch/install.ps1 | iex
```

The setup token is short-lived and single-use:

```text
admin creates setup token
  -> UI prints one-line install command
  -> installer passes setup token to local agent
  -> agent calls POST /node/claim
  -> Worker validates setup token
  -> Worker returns permanent node token and default profile
  -> setup token is invalidated
```

Claim request:

```http
POST /node/claim
Authorization: Bearer <one_time_setup_token>
Content-Type: application/json
```

Claim response:

```json
{
  "routerUrl": "https://inference-mesh-router.novoselec.ch",
  "nodeId": "win3090-office",
  "nodeToken": "node_live_...",
  "profile": "qwen35-27b-200k",
  "nodeUpstreamToken": "node_upstream_..."
}
```

The permanent node token is then used for heartbeat:

```http
POST /node/heartbeat
Authorization: Bearer node_live_...
```

Setup tokens should include:

```text
id
tokenHash
createdAt
expiresAt
claimedAt
allowedProfileIds
optional intendedNodeName
optional createdBy identity from Access JWT
```

Expiry should be short, for example 15 minutes.

## Durable Object Data Model

### Node Record

```ts
type NodeRecord = {
  nodeId: string;
  meshIp: string;
  port: number;
  engine: "llama.cpp" | "ollama" | "lmstudio" | "vllm";
  status: "starting" | "ready" | "busy" | "draining" | "error";
  models: ModelRecord[];
  capacity: {
    maxConcurrent: number;
    weight?: number;
    vramGb?: number;
  };
  metrics: {
    busy?: boolean;
    gpuUtil?: number;
    gpuTemp?: number;
    freeVramMb?: number;
    slotPromptTokens?: number;
    tokensPerSecond?: number;
  };
  inFlight: number;
  lastSeenAt: number;
  expiresAt: number;
  failurePenaltyUntil?: number;
  recentFailures: number;
};
```

### Model Record

```ts
type ModelRecord = {
  name: string;
  aliases?: string[];
  upstreamModel: string;
  context: number;
  loaded: boolean;
  quant?: string;
};
```

### Session Record

```ts
type SessionRecord = {
  sessionId: string;
  nodeId: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
};
```

### Reservation Record

```ts
type ReservationRecord = {
  reservationId: string;
  nodeId: string;
  model: string;
  sessionId?: string;
  createdAt: number;
  expiresAt: number;
};
```

Reservations prevent two Workers isolates from picking the same `maxConcurrent:
1` node at the same time.

## Scheduling Rules

### Eligibility

A node is eligible if:

```text
now < expiresAt
status == ready
requested model is supported
model is loaded
inFlight < maxConcurrent
not under failure penalty
```

### Scoring

Recommended scoring:

```text
score =
  configured weight
  - inFlight * 100
  - gpuUtil penalty
  - gpuTemp penalty
  - recent failure penalty
  + session affinity bonus
```

For local coding agents with huge context, session affinity should dominate.

### Session Affinity

This is critical. A coding agent sends repeated large prompts. If requests move
between machines, every machine loses cache locality and must prefill again.

Use an explicit session header if possible:

```http
X-Inference-Mesh-Session: codex-pi-main
```

If the client cannot send that header, accept a value from metadata:

```http
cf-aig-metadata: {"session":"codex-pi-main"}
```

If neither exists, derive a weak session key from:

```text
provider token hash + model + user-agent + first system message hash
```

Explicit is better.

### Busy Behavior

If no node is available:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 5
Content-Type: application/json
```

Body:

```json
{
  "error": {
    "message": "No available inference node for model qwen3.5:27b",
    "type": "inference_mesh_busy"
  }
}
```

Do not return generic 500 for normal capacity exhaustion.

## Worker Implementation Sketch

### wrangler.jsonc

```jsonc
{
  "name": "inference-mesh-router",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-30",
  "durable_objects": {
    "bindings": [
      {
        "name": "REGISTRY",
        "class_name": "RegistryDO"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["RegistryDO"]
    }
  ],
  "vpc_networks": [
    {
      "binding": "MESH",
      "network_id": "cf1:network",
      "remote": true
    }
  ],
  "vars": {
    "NODE_LEASE_SECONDS": "90"
  }
}
```

Secrets:

```bash
wrangler secret put ROUTER_PROVIDER_TOKEN
wrangler secret put ADMIN_TOKEN
wrangler secret put NODE_UPSTREAM_TOKEN
```

### Request Router

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/node/heartbeat" && request.method === "POST") {
      return handleHeartbeat(request, env);
    }

    if (url.pathname.startsWith("/admin/")) {
      requireAdminAuth(request, env);
      return handleAdmin(request, env);
    }

    requireProviderAuth(request, env);

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return handleModels(env);
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handleChatCompletions(request, env, ctx);
    }

    return Response.json(
      { error: { message: "Not found", type: "not_found" } },
      { status: 404 }
    );
  }
};
```

### Chat Completion Handler

```ts
async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
) {
  const body = await request.json();
  const model = normalizeModel(body.model);
  const sessionId = getSessionId(request, body);

  const registry = registryStub(env);
  const reservation = await registry.fetch("https://registry/reserve", {
    method: "POST",
    body: JSON.stringify({ model, sessionId })
  }).then(r => r.json<Reservation>());

  if (!reservation.ok) {
    return Response.json(reservation.body, {
      status: reservation.status,
      headers: reservation.headers
    });
  }

  const upstreamUrl =
    `http://${reservation.node.meshIp}:${reservation.node.port}/v1/chat/completions`;

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("content-type", "application/json");
  upstreamHeaders.set("authorization", `Bearer ${env.NODE_UPSTREAM_TOKEN}`);
  upstreamHeaders.set("x-inference-mesh-request-id", reservation.requestId);

  let upstream: Response;
  try {
    upstream = await env.MESH.fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({
        ...body,
        model: reservation.nodeModelName
      })
    });
  } catch (error) {
    ctx.waitUntil(releaseReservation(env, reservation, "connect_error"));
    return Response.json(
      {
        error: {
          message: "Inference node connection failed",
          type: "inference_mesh_upstream_error"
        }
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("x-inference-mesh-node", reservation.node.nodeId);
  responseHeaders.set("x-inference-mesh-request-id", reservation.requestId);

  const bodyStream = upstream.body;
  if (!bodyStream) {
    ctx.waitUntil(releaseReservation(env, reservation, String(upstream.status)));
    return new Response(null, {
      status: upstream.status,
      headers: responseHeaders
    });
  }

  const wrapped = bodyStream.pipeThrough(
    releaseOnCloseTransform(() =>
      ctx.waitUntil(releaseReservation(env, reservation, String(upstream.status)))
    )
  );

  return new Response(wrapped, {
    status: upstream.status,
    headers: responseHeaders
  });
}
```

The actual implementation can be cleaner, but the important parts are:

- Reserve before upstream fetch.
- Forward through `env.MESH.fetch`.
- Stream upstream body back.
- Release reservation when stream ends or errors.
- Add response headers for debugging.

## Node Agent Design

### Language

Recommended implementation language: Go.

Reasons:

- Single static binaries are practical.
- Easy Windows service support.
- Easy Linux systemd support.
- Easy macOS launchd support.
- Good HTTP, process, filesystem, and JSON support.
- Cross-platform packaging is straightforward.

Rust is also valid, but Go is likely faster to ship.

### One Codebase And UI Strategy

Use one codebase for the node agent:

```text
Go service binary
  -> background daemon/service
  -> local HTTP API
  -> embedded web UI assets
  -> engine process supervisor
  -> model downloader
```

Do not start with Tauri, Wails, or Electron. The node is primarily a service,
not a desktop app. A local web UI served by the agent is simpler and works the
same on Windows, macOS, and Linux:

```text
http://127.0.0.1:17777
```

This keeps packaging simple:

- one service binary per OS/architecture
- no separate desktop runtime
- UI assets embedded into the binary
- headless Linux still works
- Windows/macOS users still get a browser-based dashboard

The frontend can be React, Svelte, or plain TypeScript. The important design
constraint is that the UI is built into static files and embedded into the Go
binary at release time.

### Agent Responsibilities

The node agent should:

- Run as a background service.
- Detect Cloudflare WARP/Mesh connectivity.
- Discover the local Mesh/device IP.
- Download configured model files.
- Verify model checksums.
- Start/stop the local inference engine.
- Expose an OpenAI-compatible local API.
- Enforce local bearer-token auth.
- Register/heartbeat with the Worker.
- Report health and metrics.
- Drain before shutdown if possible.
- Serve a local setup and observability UI.
- Provide one-click start/stop for the inference engine.
- Apply opinionated defaults from the router model profile.
- Store node credentials securely enough for a local service.

### Engine Strategy

Primary engine:

```text
llama.cpp llama-server
```

Why:

- Works on Windows, macOS, Linux.
- Supports CUDA, Metal, Vulkan, ROCm, CPU depending on build.
- Exposes OpenAI-compatible endpoints.
- Allows fine-grained flags needed for long-context tuning:
  - context size
  - flash attention
  - KV cache quantization
  - GPU layers
  - aliases
  - reasoning settings when supported

Optional adapters:

```text
Ollama
  Easier model management, less control over long-context/performance tuning.

LM Studio
  Good user-facing GUI, less ideal for headless fleet service.

vLLM
  Strong Linux/NVIDIA server option, not a clean cross-platform default.
```

### Opinionated First-Run Experience

The node agent should configure itself as much as possible.

The installer should start the agent service and then print/open:

```text
http://127.0.0.1:17777/setup
```

The setup wizard should require only:

```text
Router URL
  Usually prefilled by installer.

Setup token
  Usually provided by `IM_SETUP_TOKEN`.

Optional node name
  Default from hostname.
```

The node should not ask for:

- Cloudflare account ID
- Worker name
- Durable Object name
- AI Gateway ID
- Cloudflare API token

Those belong to the router/admin side, not the local node.

First-run wizard:

```text
1. Connect router
   - Router URL
   - Setup token
   - Test connection

2. Claim node
   - POST /node/claim
   - receive nodeId, nodeToken, upstream token, default model profile

3. Check WARP/Mesh
   - detect Cloudflare One Client/WARP
   - detect Mesh IP
   - show exact error if missing

4. Prepare model
   - show selected model profile
   - download model
   - verify checksum

5. Start runtime
   - start llama-server
   - verify `/v1/models`
   - verify local auth

6. Register
   - start heartbeat loop
   - show node as online in dashboard
```

Normal operation should have one primary button:

```text
Start / Stop
```

Start means:

```text
verify WARP
verify model exists
start inference engine
verify health
start heartbeat as ready
```

Stop means:

```text
mark node draining/unavailable
stop routing new requests
stop inference engine
keep agent service and UI running
```

Stopping the model should not stop the agent service. The UI must remain
available so the user can start it again.

### Local Dashboard

The node UI should expose observability for the person sitting at the machine.

Recommended dashboard fields:

```text
Node
  Node ID
  Display name
  OS/architecture
  Agent version
  Service uptime

Router
  Router URL
  Registration status
  Last heartbeat
  Heartbeat latency
  Last heartbeat error

Network
  WARP status
  Mesh IP
  Listening address
  Listening port
  Firewall status if detectable

Model
  Active model
  Model profile
  Model file path
  Download status
  Loaded/unloaded
  Context length
  Quantization

Runtime
  Engine type
  Engine process PID
  Engine state
  Current request state
  In-flight requests
  Prompt tokens/sec
  Output tokens/sec
  Current prompt tokens
  Last request duration

Hardware
  GPU name
  GPU utilization
  GPU temperature
  VRAM used/free
  CPU utilization
  System memory used/free
```

The local HTTP API should include:

```text
GET  /api/status
GET  /api/logs/recent
GET  /api/config
POST /api/setup/claim
POST /api/model/download
POST /api/runtime/start
POST /api/runtime/stop
POST /api/runtime/restart
```

Only bind this UI to `127.0.0.1` by default. Do not expose the setup UI on the
Mesh interface.

### Model Profiles From Router

The router should own opinionated defaults. The agent should consume profiles
instead of hardcoding one model forever.

Example profile:

```json
{
  "id": "qwen35-27b-200k-3090",
  "label": "Qwen 3.5 27B, 200K context, RTX 3090",
  "engine": "llama.cpp",
  "model": {
    "name": "qwen3.5:27b",
    "repo": "unsloth/Qwen3.5-27B-GGUF",
    "file": "Q4_K_M.gguf",
    "sha256": "optional-pinned-checksum"
  },
  "runtime": {
    "context": 200000,
    "maxConcurrent": 1,
    "args": [
      "-ngl", "99",
      "-c", "200000",
      "-fa", "on",
      "--cache-type-k", "q4_0",
      "--cache-type-v", "q4_0",
      "--no-mmproj"
    ]
  }
}
```

This allows the router admin UI to change defaults for future installs without
rebuilding the agent.

### Agent Config

Example `agent.yaml`:

```yaml
node:
  id: win3090-office
  name: Office RTX 3090

router:
  url: https://inference-mesh-router.novoselec.ch
  heartbeat_interval_seconds: 30

auth:
  node_token_file: C:\ProgramData\InferenceMesh\node.token
  upstream_token_file: C:\ProgramData\InferenceMesh\upstream.token

network:
  listen_host: auto-warp
  listen_port: 11434
  allowed_mesh_cidrs:
    - 100.96.0.0/12

engine:
  type: llama.cpp
  binary: C:\Program Files\InferenceMesh\llama-server.exe
  model_dir: D:\InferenceMesh\models
  default_model: qwen3.5:27b
  args:
    - -ngl
    - "99"
    - -c
    - "200000"
    - -fa
    - "on"
    - --cache-type-k
    - q4_0
    - --cache-type-v
    - q4_0
    - --no-mmproj

models:
  - name: qwen3.5:27b
    aliases:
      - freestyler
    source:
      type: huggingface
      repo: unsloth/Qwen3.5-27B-GGUF
      file: Q4_K_M.gguf
    context: 200000
    max_concurrent: 1
```

### Detecting WARP/Mesh IP

Windows:

- Inspect network interfaces with Go `net.Interfaces()`.
- Prefer adapter names containing `CloudflareWARP`.
- Pick an IPv4 in allowed Mesh ranges.
- Fallback to `ipconfig` parsing only for diagnostics.

macOS:

- Inspect interfaces with Go.
- Pick IPv4 in allowed Mesh ranges.
- Optionally call `warp-cli status` for diagnostics.

Linux:

- Inspect interfaces with Go.
- Pick IPv4 in allowed Mesh ranges.
- Optionally call `warp-cli status` for diagnostics.

The agent should register only after it has a valid Mesh IP.

### Local Listener

Best:

```text
listen on Mesh IP only
```

Fallback:

```text
listen on 0.0.0.0
enforce bearer token
restrict OS firewall to CloudflareWARP adapter / Mesh CIDR
```

The local server should reject requests without:

```http
Authorization: Bearer <NODE_UPSTREAM_TOKEN>
```

### Model Downloading

For llama.cpp/GGUF:

- Download to a stable model cache directory.
- Use resumable downloads where possible.
- Verify SHA256 or Hugging Face ETag/metadata.
- Write `.partial` files during download.
- Rename atomically after verification.

Do not auto-upgrade models unless configured. Pin model file names and hashes.

### Service Installation

Windows:

```text
InferenceMeshAgent.exe install
InferenceMeshAgent.exe start
```

Installs a Windows Service running as LocalSystem or a dedicated service user.

macOS:

```text
inference-mesh-agent install
launchctl bootstrap system /Library/LaunchDaemons/com.novoselec.inference-mesh.plist
```

Linux:

```text
inference-mesh-agent install
systemctl enable --now inference-mesh-agent
```

## One-Line Installation

The admin UI should generate copy-paste installation commands.

Linux/macOS:

```bash
curl -fsSL https://inference-mesh-router.novoselec.ch/install.sh | sudo IM_SETUP_TOKEN=abc123 sh
```

Windows PowerShell:

```powershell
$env:IM_SETUP_TOKEN="abc123"; irm https://inference-mesh-router.novoselec.ch/install.ps1 | iex
```

The install scripts should:

1. Detect OS and architecture.
2. Resolve latest compatible release.
3. Download the signed/checksummed node-agent binary.
4. Install the service.
5. Write minimal bootstrap config.
6. Pass the setup token to the agent.
7. Start the agent.
8. Print the local UI URL.

Example install result:

```text
Inference Mesh Agent installed.

Node setup: claimed
Router: https://inference-mesh-router.novoselec.ch
Dashboard: http://127.0.0.1:17777
State: downloading qwen3.5:27b
```

The installer should not ask for model flags, Cloudflare account details, or
Worker configuration. Those should be supplied by the router profile after the
setup token is claimed.

### Public Installer With Private Repo

The repository can stay private, but anonymous one-line installation needs a
public place to fetch install scripts and release artifacts.

Options:

1. Serve install scripts from the Worker and release binaries from public
   GitHub Releases.
2. Serve install scripts from the Worker and release binaries from Cloudflare
   R2.
3. Require GitHub authentication for installs, which is simpler but not a nice
   public `curl | sh` experience.

Best product UX:

```text
Worker serves `/install.sh` and `/install.ps1`
GitHub Actions publishes signed release artifacts
Artifacts are mirrored to R2 or attached to a public release
Installer verifies checksums before installing
```

If the repo remains private and releases are private, the Worker can act as an
authenticated download broker. The Worker would use a server-side GitHub token
or R2 binding to serve the correct binary. This keeps the user's install command
simple while keeping the source repository private.

### Simpler Installer Alternatives

Package-manager style distribution can be added later:

```text
Homebrew tap
  brew install inference-mesh

Scoop bucket
  scoop install inference-mesh

WinGet
  winget install InferenceMesh.Agent

deb/rpm packages
  apt/yum install style installs

npm wrapper
  npx @inference-mesh/install
```

The simplest first version is still direct install scripts generated by the
admin UI. npm is possible, but it adds a Node.js dependency and is awkward for
service installation, firewall rules, and system permissions.

## Repository And GitHub Actions

Use one repository and build/deploy everything through GitHub Actions.

Recommended layout:

```text
inference-mesh/
  packages/
    router-worker/
      src/
      wrangler.jsonc
      package.json

    node-agent/
      cmd/inference-mesh-agent/
      internal/
      web/
      go.mod

    docs/
      research.md

  .github/
    workflows/
      ci.yml
      release-node-agent.yml
      deploy-worker.yml
```

The node-agent build should produce:

```text
Windows amd64
Windows arm64
macOS amd64
macOS arm64
Linux amd64
Linux arm64
```

GitHub-hosted runners support Ubuntu, Windows, and macOS. Use GoReleaser for
multi-platform release artifacts and checksums. Use Cloudflare's Wrangler
GitHub Action or `wrangler deploy` in Actions for Worker deployment.

### CI Workflow

`ci.yml` should run on pull requests and pushes:

```text
router-worker
  npm ci
  npm test
  npm run typecheck
  wrangler deploy --dry-run

node-agent
  go test ./...
  go vet ./...
  build embedded UI
  go build
```

### Node Agent Release Workflow

`release-node-agent.yml` should run on tags:

```text
on:
  push:
    tags:
      - "v*"
```

It should:

1. Build frontend assets.
2. Embed assets into Go binary.
3. Build cross-platform binaries.
4. Produce archives.
5. Generate SHA256 checksums.
6. Create GitHub Release.
7. Upload binaries and checksums.
8. Optionally mirror artifacts to Cloudflare R2.

Release artifacts should include:

```text
inference-mesh-agent_windows_amd64.zip
inference-mesh-agent_windows_arm64.zip
inference-mesh-agent_darwin_amd64.tar.gz
inference-mesh-agent_darwin_arm64.tar.gz
inference-mesh-agent_linux_amd64.tar.gz
inference-mesh-agent_linux_arm64.tar.gz
checksums.txt
```

### Worker Deploy Workflow

`deploy-worker.yml` should run on pushes to `main` and deploy only the Worker:

```text
checkout
setup node
npm ci
npm test
wrangler deploy
```

Required GitHub secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Worker runtime secrets are set separately through Wrangler or a protected
manual workflow:

```text
ROUTER_PROVIDER_TOKEN
ADMIN_TOKEN
NODE_UPSTREAM_TOKEN
```

Do not print secret values in GitHub Actions logs.

## Cloudflare API Token Scopes

The user must add Cloudflare credentials to GitHub secrets so GitHub Actions can
deploy the Worker and so the deployed Worker can configure Cloudflare resources
during first-run setup.

Use scoped API tokens, not the global API key.

Cloudflare references:

- API token permissions:
  <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
- Workers Custom Domains:
  <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
- AI Gateway Custom Providers:
  <https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/>
- AI Gateway Dynamic Routing:
  <https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/>
- AI Gateway BYOK:
  <https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/>
- Secrets Store access control:
  <https://developers.cloudflare.com/secrets-store/access-control/>

### GitHub Secrets

Required GitHub repository secrets:

```text
CLOUDFLARE_ACCOUNT_ID
  Cloudflare account ID.

CLOUDFLARE_API_TOKEN_DEPLOY
  Used by GitHub Actions to run Wrangler deploy and set Worker secrets.

CLOUDFLARE_API_TOKEN_RUNTIME
  Stored into the Worker as a secret.
  Used by the Worker setup UI to call Cloudflare APIs at runtime.
```

Optional:

```text
INFERENCE_MESH_INIT_TOKEN
  First-run admin/setup token.
  If omitted, the deploy workflow can generate one and print it in the Actions
  summary once.

CLOUDFLARE_ZONE_ID
  Optional default zone for custom domain setup.
  If omitted, the Worker can list/select zones if the runtime token has enough
  read access.
```

For MVP, `CLOUDFLARE_API_TOKEN_DEPLOY` and
`CLOUDFLARE_API_TOKEN_RUNTIME` may be the same Cloudflare token. For production,
split them.

### Deploy Token

`CLOUDFLARE_API_TOKEN_DEPLOY` is used only by GitHub Actions.

Minimum permissions:

```text
Account permissions:
  Workers Scripts Edit
```

Resource scope:

```text
Account:
  target Cloudflare account only
```

This lets GitHub Actions deploy the Worker, Durable Object class/migrations,
Workers VPC binding configuration, and Worker secrets through Wrangler.

Optional deploy permissions:

```text
Account permissions:
  Workers Tail Read
```

Only add `Workers Tail Read` if CI needs to run `wrangler tail` or collect
live Worker logs.

If the deploy workflow binds account-level Secrets Store secrets directly to
the Worker, also add:

```text
Account permissions:
  Secrets Store Edit
```

Do not add zone DNS permissions to the deploy token unless the deploy workflow
itself creates routes/custom domains. The planned bootstrap deploy only needs
the Worker on `workers.dev`; custom domain provisioning happens later from the
Worker setup UI.

### Runtime Token

`CLOUDFLARE_API_TOKEN_RUNTIME` is stored as a Worker secret and used by the
Worker after deployment.

The Worker needs it to:

- list zones for custom domain setup
- attach a custom domain to itself
- create or update the AI Gateway custom provider
- list gateways for the setup dropdown
- create, version, and deploy an AI Gateway dynamic route

Minimum permissions:

```text
Account permissions:
  AI Gateway Read
  AI Gateway Edit
  Workers Scripts Read
  Workers Scripts Edit

Zone permissions for the selected zone:
  Zone Read
  DNS Read
  DNS Write
  Workers Routes Read
  Workers Routes Edit
```

Resource scope:

```text
Account:
  target Cloudflare account only

Zone:
  selected zone only, for example novoselec.ch
```

Why each permission is needed:

```text
AI Gateway Read
  List available AI Gateways for the setup dropdown.

AI Gateway Edit
  Create/update custom provider, dynamic route, route version, and deployment.

Workers Scripts Read/Edit
  Inspect the deployed Worker and attach a Workers Custom Domain to it.

Zone Read
  Resolve and validate the selected custom-domain zone.

DNS Read/Write
  Allow Cloudflare to create or validate DNS records for the Worker Custom
  Domain, and allow the setup UI to detect conflicts.

Workers Routes Read/Edit
  Allow the Worker Custom Domain / route association for the selected zone.
```

If the Worker later automates BYOK instead of telling the user to add the
provider key manually, also add:

```text
Account permissions:
  Secrets Store Edit
```

`Secrets Store Edit` is required for creating/editing secrets and for
associating a secret with AI Gateway. Until BYOK is automated, do not grant it.

### First-Run Setup Output

After setup, the Worker should show:

```text
Custom domain:
  https://inference-mesh.example.com

AI Gateway:
  <selected gateway>

Custom provider:
  custom-inference-mesh

Dynamic route:
  dynamic/<user-route-name>

Provider bearer token:
  <router_provider_token>

Next step:
  Add the provider bearer token as the BYOK/provider key for
  custom-inference-mesh in the selected AI Gateway.

Node install command:
  curl -fsSL https://inference-mesh.example.com/install.sh | sudo IM_SETUP_TOKEN=<token> sh
```

The Worker should only show the provider bearer token once. Store only a hash
or encrypted copy if possible. The token can be rotated later from the setup UI.

## AI Gateway Setup

### Custom Provider

Create provider:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Inference Mesh",
    "slug": "inference-mesh",
    "base_url": "https://inference-mesh-router.novoselec.ch",
    "description": "Worker router for WARP/Mesh local inference nodes",
    "enable": true
  }'
```

Provider endpoint:

```text
https://gateway.ai.cloudflare.com/v1/$ACCOUNT_ID/$GATEWAY_ID/custom-inference-mesh/v1/chat/completions
```

### Provider Key

Store:

```text
ROUTER_PROVIDER_TOKEN
```

as the custom provider key/BYOK value in AI Gateway.

The Worker expects:

```http
Authorization: Bearer <ROUTER_PROVIDER_TOKEN>
```

If AI Gateway cannot inject that key for the custom provider in the desired
route mode, fallback options are:

1. Client sends `Authorization: Bearer <ROUTER_PROVIDER_TOKEN>` to AI Gateway
   and AI Gateway forwards it to the custom provider.
2. Use a tiny AI Gateway Worker shim that injects the router token.
3. Keep the provider key in a dynamic route/provider config if Cloudflare
   exposes it for the selected route type.

The first implementation should explicitly test which header arrives at the
Worker from AI Gateway. Add a temporary debug endpoint that logs header names,
not values.

### Dynamic Route

Once the provider works:

```text
dynamic route: freestyler
provider: custom-inference-mesh
model: qwen3.5:27b
timeout: 60000 or higher
retries: 0 or 1
```

Avoid 3 AI Gateway retries for long local inference. Duplicated retries can
create multiple long-running generations and saturate the mesh.

## Worker-To-Node Request

The Worker should transform only what is necessary.

Inbound body:

```json
{
  "model": "freestyler",
  "messages": [],
  "stream": true
}
```

Outbound body to selected node:

```json
{
  "model": "qwen3.5:27b",
  "messages": [],
  "stream": true
}
```

Headers:

```http
Authorization: Bearer <NODE_UPSTREAM_TOKEN>
Content-Type: application/json
X-Inference-Mesh-Request-Id: <request_id>
X-Inference-Mesh-Session: <session_id>
```

Do not forward:

- AI Gateway auth token
- Cloudflare API token
- Admin token
- Node registration token

## Streaming And Timeouts

OpenAI-style streaming should pass through unchanged:

```text
node SSE stream -> Worker Response body -> AI Gateway -> client
```

For huge prompts, the model may spend many seconds in prefill before emitting
the first token. That can trigger upstream timeout behavior.

Mitigations:

- Prefer `stream: true` for coding agents.
- Keep AI Gateway request timeout high enough.
- Reduce AI Gateway retries.
- Preserve session affinity.
- Consider sending SSE comments as keepalives only if the client and AI Gateway
  tolerate them:

```text
: inference-mesh selected win3090-office

```

Do not add keepalive bytes to non-stream JSON responses.

## Security Risks And Controls

### SSRF

Risk:

```text
malicious node registers 169.254.169.254 or internal Cloudflare endpoint
```

Controls:

- Node registers only `meshIp` and `port`, not arbitrary URL.
- Worker validates IP is in allowed Mesh CIDR.
- Worker validates port allowlist, usually `11434`.
- Worker builds URL itself.
- Per-node tokens bind to node IDs.

### Token Leakage

Controls:

- Separate token classes.
- Never log auth header values.
- Store secrets in Worker secrets.
- Rotate node tokens independently.

### Unbounded Generation

Controls:

- Enforce `max_tokens` ceiling in Worker if needed.
- Enforce request body size.
- Enforce per-node concurrency.
- Return 429 when busy.

### Model Abuse

Controls:

- Model allowlist.
- Alias map controlled by Worker/DO, not by clients.
- Reject unknown models.

### Local Network Exposure

Controls:

- Bind node service to Mesh IP if possible.
- Require bearer token locally.
- Configure OS firewall.
- Do not expose node agent admin API publicly.

## Observability

Add response headers:

```http
X-Inference-Mesh-Node: win3090-office
X-Inference-Mesh-Request-Id: req_...
X-Inference-Mesh-Session: codex-pi-main
```

Durable Object should track:

- live nodes
- models per node
- in-flight requests
- session mappings
- last heartbeat
- last error
- recent latency
- prompt tokens if reported by node
- output tokens if reported by node

`GET /admin/status` should return:

```json
{
  "nodes": [
    {
      "nodeId": "win3090-office",
      "status": "ready",
      "models": ["qwen3.5:27b"],
      "inFlight": 1,
      "maxConcurrent": 1,
      "lastSeenSecondsAgo": 8,
      "metrics": {
        "gpuUtil": 97,
        "gpuTemp": 73
      }
    }
  ],
  "sessions": [
    {
      "sessionId": "codex-pi-main",
      "nodeId": "win3090-office",
      "model": "qwen3.5:27b"
    }
  ]
}
```

## Failure Modes

### Node Stops Heartbeating

Action:

- Stop routing after lease expiry.
- Keep session mapping only if node returns soon.
- Otherwise reroute next request and mark session as moved.

### Node Is Busy

Action:

- Route another compatible node if session affinity is not required.
- If session affinity is required and same node is busy, return 429.

### Node Crashes Mid-Stream

Action:

- Release reservation.
- Increment recent failures.
- Return upstream 502 or stream error.
- Do not auto-retry long generation unless request is explicitly idempotent.

### WARP Disconnects

Action:

- Node heartbeat fails.
- Lease expires.
- Router stops selecting node.

### AI Gateway Retries

Risk:

AI Gateway retrying a long request can create duplicate generations.

Action:

- Configure AI Gateway retries to 0 or 1 for this route.
- Let Worker perform safe retries only before generation starts.

### Context Cache Thrash

Risk:

Requests for one coding session bounce between nodes.

Action:

- Session affinity.
- Sticky node until session TTL expires.
- Prefer returning busy over moving a hot coding session.

## Implementation Plan

### Phase 1: Prove Worker-To-One-WARP-Client

Goal:

```text
AI Gateway -> Worker -> one WARP client by Mesh IP -> existing local llama
```

Steps:

1. Enable Cloudflare Mesh/device IPs.
2. Install Cloudflare One Client on one test machine.
3. Start local llama server on Mesh-reachable address.
4. Add OS firewall allow rule.
5. Create Worker with `MESH` VPC binding.
6. Hardcode one Mesh IP and port.
7. Test `/v1/chat/completions` through Worker.
8. Put Worker behind AI Gateway custom provider.
9. Verify provider bearer token arrives correctly.

### Phase 2: Durable Object Registry

Goal:

```text
node heartbeat -> DO registry -> route to registered node
```

Steps:

1. Add `RegistryDO`.
2. Implement `/node/heartbeat`.
3. Store node lease.
4. Implement `/admin/status`.
5. Route to registered node instead of hardcoded node.

### Phase 3: Node Agent MVP

Goal:

```text
installable agent with local UI registers existing llama server
```

Steps:

1. Build Go agent.
2. Detect Mesh IP.
3. Read config.
4. Heartbeat to Worker.
5. Proxy local `/v1/chat/completions`.
6. Serve local UI at `http://127.0.0.1:17777`.
7. Show Mesh IP, router status, model, last heartbeat, and runtime state.
8. Package as systemd service and Windows service.

### Phase 4: Engine Management

Goal:

```text
agent downloads model and starts llama-server itself
```

Steps:

1. Add model manifest.
2. Add downloader with checksum verification.
3. Add llama.cpp binary management.
4. Start/stop engine process.
5. Collect engine health.
6. Add one-click Start/Stop in the local UI.
7. Add token/sec, prompt-token, and GPU metrics to the UI.

### Phase 5: Multi-Node Routing

Goal:

```text
5 machines register and serve one provider endpoint
```

Steps:

1. Add node allowlist.
2. Add model aliases.
3. Add session affinity.
4. Add in-flight reservations.
5. Add failure penalties.
6. Add `429` busy behavior.

### Phase 6: One-Line Install And Admin UI

Goal:

```text
admin opens Worker UI and copies a one-line install command
```

Steps:

1. Protect `/admin/*` with Cloudflare Access.
2. Add admin UI for node setup tokens.
3. Generate one-line Linux/macOS install command.
4. Generate one-line Windows PowerShell install command.
5. Implement `/node/claim`.
6. Invalidate setup tokens after claim.
7. Add `/install.sh` and `/install.ps1`.
8. Add agent first-run setup wizard.

### Phase 7: GitHub Actions Release And Deploy

Goal:

```text
all builds, releases, and Worker deploys happen from GitHub Actions
```

Steps:

1. Add `ci.yml`.
2. Add `release-node-agent.yml`.
3. Add `deploy-worker.yml`.
4. Build all node-agent platforms.
5. Publish release artifacts and checksums.
6. Deploy Worker from `main`.
7. Optionally mirror release assets to Cloudflare R2.

### Phase 8: Production Hardening

Steps:

1. Per-node tokens.
2. Token rotation.
3. Request body size limit.
4. Admin auth.
5. Better status page.
6. Structured logs.
7. Installer packages.
8. Artifact signing.
9. Auto-update policy.

## First Validation Checklist

Before building the full agent, validate the Cloudflare path:

```text
[ ] WARP-enrolled Windows/macOS/Linux client has Mesh IP.
[ ] Local service listens on Mesh-reachable address.
[ ] Worker VPC `cf1:network` can fetch `http://<mesh-ip>:11434/health`.
[ ] Worker can stream `/v1/chat/completions`.
[ ] AI Gateway custom provider can call Worker.
[ ] AI Gateway provider key appears as expected at Worker.
[ ] Long prefill does not time out when stream=true.
[ ] Session affinity header can be passed by target coding agent.
[ ] Admin UI can generate a setup token and install command.
[ ] Agent can claim setup token and store permanent node token.
[ ] Local UI shows Mesh IP, model, heartbeat, and tokens/sec.
[ ] GitHub Actions can build node-agent artifacts.
[ ] GitHub Actions can deploy the Worker.
```

If any of these fail, fallback transport is per-node Cloudflare Tunnel public
hostnames protected by Cloudflare Access service tokens.

## Final Recommendation

Build this as:

```text
packages/router-worker
  Cloudflare Worker + Durable Object scheduler + admin UI/install scripts

packages/node-agent
  Go daemon for Windows/macOS/Linux + embedded local web UI

packages/docs
  research, setup, and operational documentation

.github/workflows
  CI, node-agent release, Worker deploy
```

Use Workers VPC + Cloudflare Mesh as the primary private transport. Use
per-node Cloudflare Tunnel hostnames only as fallback.

Start with a hardcoded one-node Worker test. Then build the agent as a local
service with embedded web UI, setup-token claim, and manual Start/Stop. Do not
spend time on native desktop packaging until the Worker can successfully fetch
a WARP client Mesh IP from AI Gateway traffic.

Final product experience:

```text
Admin logs into Access-protected Worker admin UI.
Admin clicks "Create node".
Worker prints one-line install command.
User pastes command into Windows/macOS/Linux terminal.
Agent installs as a service.
Agent claims setup token.
Agent downloads default model.
Agent exposes local dashboard.
Agent starts/stops model from one button.
Agent heartbeats to Worker.
AI Gateway routes through Worker to the node.
```
