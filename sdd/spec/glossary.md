# Glossary

| Term | Definition |
| --- | --- |
| AI Gateway | Cloudflare service that receives client model requests and routes them to configured providers. |
| Custom Provider | AI Gateway provider entry whose upstream is the router Worker. |
| Dynamic Route | Named AI Gateway route, used as `dynamic/<name>`, that selects provider/model nodes from a versioned routing flow. |
| Router Worker | Public Cloudflare Worker that verifies Gateway traffic, schedules nodes, forwards inference requests, and serves setup/admin endpoints. |
| Workers VPC | Cloudflare Worker binding that lets the router call private Mesh destinations by IP. |
| Cloudflare Mesh | Cloudflare One private networking surface used to reach WARP-enrolled devices and private routes. |
| Node Agent | Local cross-platform service that claims setup tokens, heartbeats to the router, proxies inference, and supervises the runtime. |
| Runtime | Supervised `mesh-llm` process on the node that exposes the local OpenAI-compatible inference API. |
| MeshLLM | Rust inference runtime (`mesh-llm`) that embeds llama.cpp, serves an OpenAI-compatible API, and links nodes into a private inference mesh. |
| MeshLLM Mesh | Private mesh of MeshLLM processes, also called the inference mesh, that shares models and routes inference between member nodes; distinct from Cloudflare Mesh, the Cloudflare One network layer this traffic crosses. |
| Mesh Invite Token | MeshLLM credential that embeds a member node's dialable address and admits its holder into that private mesh; the router stores it encrypted and distributes it only in heartbeat responses. |
| Mesh Coordinator | MeshLLM node that owns stage 0 of a split model and becomes the model's routable entry once every stage reports ready. |
| Ready Models | Model identifiers a node's MeshLLM API reports in `/v1/models` — the mesh-wide union of routable models that scheduling eligibility checks against. |
| Split Serving / Layer Package (Skippy) | MeshLLM mode that serves one model across several mesh nodes, each loading a contiguous layer range from a layer package — an immutable Hugging Face repository of per-stage model fragments. |
| Console API | MeshLLM management endpoint, separate from the inference API, that reports node state, mesh id, peers, and the invite token; it binds to localhost and is never proxied or exposed. |
| Rotation Counter | Router-owned counter in per-profile mesh state, baked into the rendered mesh name, that one-click rotation increments so all nodes reform onto a fresh mesh identity. |
| Model Profile | Router-owned definition of a concrete model source, runtime arguments, context limit, and allowed hardware class. |
| Stable Public Model | The single Gateway-facing model id (`codeflare-mesh`), carried as a shared alias by every model profile so the single active model always owns it, that always resolves to the currently active serving model so switching models never changes the Gateway route or public model id. |
| Public Model Alias | Per-profile external model name, such as `qwen3.6-coder`, that the Worker rewrites to that profile's upstream model; distinct from the Stable Public Model the Gateway targets. |
| Reservation | Scheduler record that assigns one request to one node until the request completes or expires. |
| Session Affinity | Routing preference that keeps one coding session on the same node to preserve context-cache reuse. |
| Scheduler Miss | Router outcome when a requested alias has no profile or no eligible node can currently serve it. |
| Setup Token | Short-lived, single-use token that lets one node claim permanent credentials. |
| Provider Token | Bearer token stored in AI Gateway BYOK/provider-key settings and sent to the router for `/v1/*` calls. |
| Node Token | Per-node credential used for heartbeat and unregister calls. |
| Dashboard Token | Local node-agent credential required for localhost runtime-control POSTs. |
| Upstream Token | Credential sent by the Worker to a node agent before it proxies to the local runtime. |
| Agent Release | Signed node-agent artifact set published from the deploy workflow for installers and update staging. |
| Bootstrap Origin | The `workers.dev` hostname a fresh deployment serves; hosts first-run setup until handoff, then only the locked page and break-glass recovery. |
| Handoff | Setup transition after Access provisioning where the wizard, dashboard, and machine traffic move permanently to the custom domain. |
| Access Application | Cloudflare Access app the wizard provisions on the custom domain: an allow policy for admin emails plus bypass coverage for machine paths. |
| Access JWT | Cloudflare-issued identity assertion (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie) the Worker verifies for every human admin request after handoff. |
| Break-Glass Recovery | Reopening the bootstrap origin's admin surface by setting the reopen secret via wrangler, for operators locked out of the custom domain. |
