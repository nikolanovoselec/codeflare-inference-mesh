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
| Runtime | Local OpenAI-compatible inference server such as `llama-server`, Ollama, LM Studio, or vLLM. |
| Model Profile | Router-owned definition of a concrete model source, runtime arguments, context limit, and allowed hardware class. |
| Public Model Alias | Stable external model name, such as `mesh-default`, that the Worker rewrites to an internal profile. |
| Reservation | Scheduler record that assigns one request to one node until the request completes or expires. |
| Session Affinity | Routing preference that keeps one coding session on the same node to preserve context-cache reuse. |
| Setup Token | Short-lived, single-use token that lets one node claim permanent credentials. |
| Provider Token | Bearer token stored in AI Gateway BYOK/provider-key settings and sent to the router for `/v1/*` calls. |
| Node Token | Per-node credential used for heartbeat and unregister calls. |
| Dashboard Token | Local node-agent credential required for localhost runtime-control POSTs. |
| Upstream Token | Credential sent by the Worker to a node agent before it proxies to the local runtime. |
| Agent Release | Signed node-agent artifact set published from the deploy workflow for self-update and installers. |
