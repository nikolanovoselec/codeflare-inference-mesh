package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"html"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type DashboardStatus struct {
	Config       Config      `json:"config"`
	Metrics      NodeMetrics `json:"metrics"`
	RuntimeState string      `json:"runtimeState"`
	Version      string      `json:"version"`
}

func DashboardHandler(status func() DashboardStatus, controllers ...RuntimeController) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("content-type", "application/json")
		safe := status()
		safe.Config = RedactedConfig(safe.Config)
		_ = json.NewEncoder(w).Encode(safe)
	})
	mux.HandleFunc("/api/runtime/start", runtimeAction(status, controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Start(ctx) }))
	mux.HandleFunc("/api/runtime/stop", runtimeAction(status, controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Stop(ctx) }))
	mux.HandleFunc("/api/runtime/restart", runtimeAction(status, controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Restart(ctx) }))
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(dashboardHTML(status())))
	})
	return mux
}

func dashboardHTML(status DashboardStatus) string {
	cfg := status.Config
	metrics := status.Metrics
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="` + html.EscapeString(cfg.DashboardToken) + `"><title>Inference Mesh Agent</title><style>
	:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#09090b;color:#f4f4f5}body{margin:0;padding:24px}.shell{max-width:1120px;margin:0 auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{border:1px solid #2d2d35;border-radius:14px;background:#141419;padding:14px}.card span{display:block;color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.card strong,.card code{display:block;margin-top:6px;color:#fff;word-break:break-word}.panel{margin-top:16px;border:1px solid #2d2d35;border-radius:14px;background:#101014;padding:14px}button{min-height:40px;border:1px solid #3f3f46;border-radius:10px;background:#1f1f27;color:#fff;padding:0 14px;margin-right:8px}pre{white-space:pre-wrap;word-break:break-word;color:#d4d4d8}.error{color:#ff9a7f}</style></head><body><main class="shell"><h1>Inference Mesh Agent</h1><p>Local runtime, Mesh, heartbeat, GPU, and profile status.</p><section class="grid" data-dashboard-cards>
	` + dashboardCard("Mesh IP", cfg.MeshIP) + dashboardCard("Listener", ListenerAddress(cfg.MeshIP, cfg.InferencePort, cfg.AllowAllInterfaces)) + dashboardCard("Dashboard", cfg.DashboardAddress) + `
	</section><section class="panel" data-runtime-panel><h2>MeshLLM runtime</h2><section class="grid" data-runtime-cards>
	` + dashboardRuntimeCard("meshllm-version", "MeshLLM version", metrics.MeshLLMVersion) +
		dashboardRuntimeCard("runtime-state", "Run state", status.RuntimeState) +
		dashboardRuntimeCard("mesh-id", "Mesh ID", metrics.MeshID) +
		dashboardRuntimeCard("peer-count", "Peer count", strconv.Itoa(metrics.PeerCount)) +
		dashboardRuntimeCard("ready-models", "Ready models", strings.Join(metrics.ReadyModels, ", ")) +
		dashboardRuntimeCard("split-enabled", "Split", strconv.FormatBool(metrics.SplitEnabled)) +
		dashboardRuntimeCard("stage-count", "Stage count", strconv.Itoa(metrics.StageCount)) +
		dashboardRuntimeCard("api-port", "API port", strconv.Itoa(cfg.MeshLLMAPIPort)) +
		dashboardRuntimeCard("console-port", "Console port", strconv.Itoa(cfg.MeshLLMConsolePort)) +
		dashboardRuntimeCard("api-ready", "API ready", strconv.FormatBool(metrics.APIReady)) +
		dashboardRuntimeCard("console-ready", "Console ready", strconv.FormatBool(metrics.ConsoleReady)) +
		dashboardRuntimeCard("tokens-per-second", "Tokens/sec", strconv.FormatFloat(metrics.TokensPerSecond, 'f', -1, 64)) +
		dashboardRuntimeCard("last-error", "Last runtime error", metrics.LastError) + `
	</section></section><section class="panel"><h2>Runtime controls</h2><button data-runtime="start">Start</button><button data-runtime="stop">Stop</button><button data-runtime="restart">Restart</button><pre id="runtime-feedback"></pre></section><section class="panel"><h2>Status</h2><pre id="status">Loading…</pre></section></main><script>
	const token=document.querySelector('meta[name="csrf-token"]').content; const statusEl=document.getElementById('status'); const feedback=document.getElementById('runtime-feedback');
	function card(label,value){return '<div class="card"><span>'+label+'</span><code>'+String(value||'—').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</code></div>'}
	function setField(field,value){const el=document.querySelector('[data-field="'+field+'"] code');if(el){el.textContent=(value===undefined||value===null||value==='')?'—':String(value)}}
	async function refresh(){try{const r=await fetch('/api/status'); const s=await r.json(); const m=s.metrics||{}; document.querySelector('[data-dashboard-cards]').innerHTML=[card('Mesh IP',s.config.meshIp),card('Listener',s.config.meshIp+':'+s.config.inferencePort),card('Heartbeat model',s.config.runtimeModel),card('Loaded model',m.loadedModel),card('Loaded profile',(m.loadedProfileId||'')+(m.loadedProfileVersion?' v'+m.loadedProfileVersion:'')),card('Active requests',m.activeRequests),card('GPU',m.gpuName),card('GPU memory',m.gpuMemoryUsedMiB&&m.gpuMemoryTotalMiB?m.gpuMemoryUsedMiB+'/'+m.gpuMemoryTotalMiB+' MiB':'—')].join('');
	setField('meshllm-version',m.meshllmVersion);setField('runtime-state',s.runtimeState||m.runtimeState);setField('mesh-id',m.meshId);setField('peer-count',m.peerCount);setField('ready-models',(m.readyModels||[]).join(', '));setField('split-enabled',!!m.splitEnabled);setField('stage-count',m.stageCount);setField('api-port',s.config.meshllmApiPort);setField('console-port',s.config.meshllmConsolePort);setField('api-ready',!!m.apiReady);setField('console-ready',!!m.consoleReady);setField('tokens-per-second',m.tokensPerSecond);setField('last-error',m.lastError);
	statusEl.textContent=JSON.stringify(s,null,2)}catch(e){statusEl.textContent=e.message;statusEl.className='error'}}
	document.addEventListener('click',async e=>{const action=e.target.dataset.runtime;if(!action)return;feedback.textContent='Working…';try{const r=await fetch('/api/runtime/'+action,{method:'POST',headers:{'x-inference-mesh-dashboard-token':token}});feedback.textContent=await r.text();await refresh()}catch(err){feedback.textContent=err.message;feedback.className='error'}}); refresh(); setInterval(refresh,5000);
	</script></body></html>`
}

func dashboardCard(label string, value string) string {
	return `<div class="card"><span>` + html.EscapeString(label) + `</span><code>` + html.EscapeString(value) + `</code></div>`
}

// dashboardRuntimeCard renders one MeshLLM runtime panel value with a stable
// data-field marker; the refresh script updates the marked value in place.
func dashboardRuntimeCard(field string, label string, value string) string {
	if value == "" {
		value = "—"
	}
	return `<div class="card" data-field="` + html.EscapeString(field) + `"><span>` + html.EscapeString(label) + `</span><code>` + html.EscapeString(value) + `</code></div>`
}

func runtimeAction(status func() DashboardStatus, controllers []RuntimeController, action func(context.Context, RuntimeController) error) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			http.NotFound(w, req)
			return
		}
		cfg := status().Config
		if !dashboardControlAllowed(req, cfg) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if len(controllers) == 0 || controllers[0] == nil {
			http.Error(w, "runtime controller unavailable", http.StatusConflict)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), 30*time.Second)
		defer cancel()
		if err := action(ctx, controllers[0]); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

func dashboardControlAllowed(req *http.Request, cfg Config) bool {
	if cfg.DashboardToken == "" || subtle.ConstantTimeCompare([]byte(req.Header.Get("x-inference-mesh-dashboard-token")), []byte(cfg.DashboardToken)) != 1 {
		return false
	}
	if !isLoopbackAddress(cfg.DashboardAddress) || !isLoopbackHost(req.Host) {
		return false
	}
	origin := req.Header.Get("origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	return sameHost(parsed.Host, req.Host) && isLoopbackHost(parsed.Host)
}

func sameHost(left string, right string) bool {
	return strings.EqualFold(left, right)
}

func isLoopbackAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	return isLoopbackHost(host)
}

func isLoopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

const DashboardAnchors = "REQ-NODE-004 REQ-SEC-001 REQ-SEC-004"
