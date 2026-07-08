package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestREQNODE001ServiceSkeletonAndListenerPolicy(t *testing.T) {
	t.Run("REQ-NODE-001", func(t *testing.T) {
		addr := &net.IPNet{IP: net.ParseIP("100.64.1.10"), Mask: net.CIDRMask(32, 32)}
		meshIP, ok := DetectMeshIP([]net.Addr{addr})
		if !ok || meshIP != "100.64.1.10" {
			t.Fatalf("expected CGNAT Mesh IP, got %q ok=%v", meshIP, ok)
		}
		lan := &net.IPNet{IP: net.ParseIP("192.168.1.10"), Mask: net.CIDRMask(32, 32)}
		if ambiguousIP, ok := DetectMeshIP([]net.Addr{addr, lan}); ok || ambiguousIP != "" {
			t.Fatalf("ambiguous private Mesh IP detection should fail closed, got %q ok=%v", ambiguousIP, ok)
		}
		if got := ListenerAddress(meshIP, 8080, false); got != "100.64.1.10:8080" {
			t.Fatalf("expected mesh listener, got %s", got)
		}
		plan := ServiceInstallPlan("/opt/inference-mesh-agent", "/etc/inference-mesh/config.json", "linux")
		if plan.UnitName != "inference-mesh-agent.service" || plan.Command == "" {
			t.Fatalf("invalid service plan: %#v", plan)
		}
	})
}

func TestREQNODE002ClaimStoresCredentialsAndHeartbeatPayload(t *testing.T) {
	t.Run("REQ-NODE-002", func(t *testing.T) {
		var claimed ClaimRequest
		var heartbeat HeartbeatRequest
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/node/claim" {
				if r.Header.Get("authorization") != "Bearer setup-token" {
					t.Fatalf("missing setup token")
				}
				_ = json.NewDecoder(r.Body).Decode(&claimed)
				_ = json.NewEncoder(w).Encode(ClaimResponse{NodeID: "node-a", NodeToken: "node-token", UpstreamToken: "upstream-token"})
				return
			}
			if r.URL.Path == "/node/heartbeat" {
				if r.Header.Get("authorization") != "Bearer node-token" {
					t.Fatalf("missing node token")
				}
				_ = json.NewDecoder(r.Body).Decode(&heartbeat)
				_ = json.NewEncoder(w).Encode(HeartbeatResponse{OK: true})
				return
			}
			http.NotFound(w, r)
		}))
		defer server.Close()
		client := Client{RouterURL: server.URL, HTTPClient: server.Client()}
		claim, err := client.Claim(context.Background(), "setup-token", ClaimRequest{DisplayName: "Node A", MeshIP: "100.64.1.10", InferencePort: 8080, PublicModels: []string{"codeflare-mesh"}, ActiveProfileIDs: []string{"mesh-default-qwen36-35b"}, Capacity: 2})
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "config.json")
		cfg, err := ApplyClaim(DefaultConfig(t.TempDir()), claim, path)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.NodeToken != "node-token" || cfg.UpstreamToken != "upstream-token" || cfg.SetupToken != "" {
			t.Fatalf("claim not applied: %#v", cfg)
		}
		loaded, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		if loaded.NodeID != "node-a" {
			t.Fatalf("config was not saved")
		}
		_, err = client.Heartbeat(context.Background(), cfg.NodeToken, HeartbeatFromConfig(cfg, RuntimeMetrics("ready", "codeflare-mesh", 0), 0, HeartbeatIdentity{AgentVersion: "v-test"}))
		if err != nil {
			t.Fatal(err)
		}
		if claimed.MeshIP != "100.64.1.10" || claimed.Capacity != 2 {
			t.Fatalf("claim payload mismatch: %#v", claimed)
		}
		if heartbeat.Runtime != "meshllm" {
			t.Fatalf("heartbeat runtime = %q, want meshllm", heartbeat.Runtime)
		}
		if heartbeat.AgentVersion != "v-test" {
			t.Fatalf("heartbeat should carry the agent version, got %q", heartbeat.AgentVersion)
		}
	})
}

func TestREQNODE008DetectsUnambiguousMeshIP(t *testing.T) {
	t.Run("REQ-NODE-008", func(t *testing.T) {
		meshAddr := &net.IPNet{IP: net.ParseIP("100.64.1.10"), Mask: net.CIDRMask(32, 32)}
		lanAddr := &net.IPNet{IP: net.ParseIP("192.168.1.10"), Mask: net.CIDRMask(32, 32)}
		publicAddr := &net.IPNet{IP: net.ParseIP("8.8.8.8"), Mask: net.CIDRMask(32, 32)}

		if meshIP, ok := DetectMeshIP([]net.Addr{meshAddr}); !ok || meshIP != "100.64.1.10" {
			t.Fatalf("expected one unambiguous private Mesh IP, got %q ok=%v", meshIP, ok)
		}
		if meshIP, ok := DetectMeshIP([]net.Addr{publicAddr}); ok || meshIP != "" {
			t.Fatalf("public-only interfaces should not be detected, got %q ok=%v", meshIP, ok)
		}
		if meshIP, ok := DetectMeshIP([]net.Addr{meshAddr, lanAddr}); ok || meshIP != "" {
			t.Fatalf("multiple private candidates should fail closed, got %q ok=%v", meshIP, ok)
		}
	})
}

func TestREQNODE008AppliesDetectedMeshIPBeforeClaim(t *testing.T) {
	t.Run("REQ-NODE-008", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		cfg := DefaultConfig(t.TempDir())
		cfg.MeshIP = ""

		next, changed, err := ApplyDetectedMeshIP(cfg, path, func() (string, bool) { return "100.64.1.10", true })
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}

		if !changed || next.MeshIP != "100.64.1.10" || loaded.MeshIP != next.MeshIP {
			t.Fatalf("detected mesh IP was not applied and persisted: changed=%v next=%#v loaded=%#v", changed, next, loaded)
		}
		unchanged, changedAgain, err := ApplyDetectedMeshIP(next, path, func() (string, bool) { return "100.64.1.11", true })
		if err != nil {
			t.Fatal(err)
		}
		if changedAgain || unchanged.MeshIP != next.MeshIP {
			t.Fatalf("existing mesh IP should not be overwritten: changed=%v next=%#v", changedAgain, unchanged)
		}
	})
}

func TestREQNODE008DetectsWARPAdapterAndIP(t *testing.T) {
	t.Run("REQ-NODE-008", func(t *testing.T) {
		warpAddr := &net.IPNet{IP: net.ParseIP("100.96.0.26"), Mask: net.CIDRMask(32, 32)}
		lanAddr := &net.IPNet{IP: net.ParseIP("192.168.1.108"), Mask: net.CIDRMask(32, 32)}

		// A named WARP adapter is authoritative even alongside a LAN interface.
		named := []NamedInterface{
			{Name: "CloudflareWARP", Addrs: []net.Addr{warpAddr}},
			{Name: "eth0", Addrs: []net.Addr{lanAddr}},
		}
		if ip, ok := DetectWARPMeshIP(named); !ok || ip != "100.96.0.26" {
			t.Fatalf("named WARP adapter must win, got %q ok=%v", ip, ok)
		}

		// macOS presents an unnamed utun; the WARP CGNAT range still detects it.
		utun := []NamedInterface{
			{Name: "utun4", Addrs: []net.Addr{warpAddr}},
			{Name: "en0", Addrs: []net.Addr{lanAddr}},
		}
		if ip, ok := DetectWARPMeshIP(utun); !ok || ip != "100.96.0.26" {
			t.Fatalf("WARP CGNAT range must be detected on unnamed adapters, got %q ok=%v", ip, ok)
		}

		// No WARP interface present yields no WARP IP.
		if ip, ok := DetectWARPMeshIP([]NamedInterface{{Name: "en0", Addrs: []net.Addr{lanAddr}}}); ok || ip != "" {
			t.Fatalf("absent WARP adapter must yield no WARP IP, got %q ok=%v", ip, ok)
		}

		// Address-only fallback prefers the WARP-range address over LAN.
		if ip, ok := DetectMeshIP([]net.Addr{lanAddr, warpAddr}); !ok || ip != "100.96.0.26" {
			t.Fatalf("WARP-range address must win over LAN, got %q ok=%v", ip, ok)
		}
		// A LAN-only host without WARP uses its single private address.
		if ip, ok := DetectMeshIP([]net.Addr{lanAddr}); !ok || ip != "192.168.1.108" {
			t.Fatalf("LAN-only host should use its single private IP, got %q ok=%v", ip, ok)
		}
		// Two WARP-range addresses are ambiguous and fail closed.
		warpTwo := &net.IPNet{IP: net.ParseIP("100.96.0.27"), Mask: net.CIDRMask(32, 32)}
		if ip, ok := DetectMeshIP([]net.Addr{warpAddr, warpTwo}); ok || ip != "" {
			t.Fatalf("ambiguous WARP addresses must fail closed, got %q ok=%v", ip, ok)
		}
	})
}

func TestConfigPathHonorsExplicitConfigEnv(t *testing.T) {
	t.Run("REQ-NODE-001", func(t *testing.T) {
		explicit := filepath.Join(t.TempDir(), "explicit-config.json")
		t.Setenv("INFERENCE_MESH_CONFIG", explicit)
		if got := ConfigPath(); got != explicit {
			t.Fatalf("explicit config override ignored: got %q want %q", got, explicit)
		}
		t.Setenv("INFERENCE_MESH_CONFIG", "")
		if got := ConfigPath(); got == explicit || got == "" {
			t.Fatalf("cleared override should fall back to the default path, got %q", got)
		}
	})
}

func TestRequireMeshIPFailsClosedWhenUnresolved(t *testing.T) {
	t.Run("REQ-NODE-008", func(t *testing.T) {
		if err := RequireMeshIP(Config{MeshIP: ""}); err == nil {
			t.Fatal("empty mesh IP must fail before claim")
		}
		if err := RequireMeshIP(Config{MeshIP: "100.96.0.26"}); err != nil {
			t.Fatalf("resolved mesh IP must pass, got %v", err)
		}
	})
}

func TestREQNODE007HeartbeatResendsMeshIdentityEveryTick(t *testing.T) {
	t.Run("REQ-NODE-007 REQ-RUN-006", func(t *testing.T) {
		cfg := DefaultConfig(t.TempDir())
		identity := HeartbeatIdentity{MeshID: "mesh-1", MeshToken: "tok-1", AgentVersion: "v2.0.0"}

		first := HeartbeatFromConfig(cfg, RuntimeMetrics("ready", "model-a", 0), 0, identity)
		second := HeartbeatFromConfig(cfg, RuntimeMetrics("starting", "", 1), 1, identity)

		for index, request := range []HeartbeatRequest{first, second} {
			if request.MeshID != "mesh-1" || request.MeshToken != "tok-1" || request.AgentVersion != "v2.0.0" {
				t.Fatalf("tick %d must resend mesh identity, got meshId=%q meshToken=%q agentVersion=%q", index, request.MeshID, request.MeshToken, request.AgentVersion)
			}
		}
		encoded, err := json.Marshal(second)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err := json.Unmarshal(encoded, &wire); err != nil {
			t.Fatal(err)
		}
		if wire["meshId"] != "mesh-1" || wire["meshToken"] != "tok-1" || wire["agentVersion"] != "v2.0.0" {
			t.Fatalf("wire payload must carry meshId/meshToken/agentVersion on every tick, got %v", wire)
		}
	})
}

func TestREQLLAMACPPHeartbeatReportsSelectedDirectRuntime(t *testing.T) {
	t.Run("REQ-SCH-004 REQ-OBS-003", func(t *testing.T) {
		cfg := DefaultConfig(t.TempDir())
		cfg.ActiveProfileIDs = []string{"direct-profile"}
		cfg.Profiles = []ModelProfile{{
			ID:             "direct-profile",
			PublicAliases:  []string{"codeflare-mesh"},
			UpstreamModel:  "unsloth/Code-Model-GGUF:Q4_K_M",
			SourceMode:     "llamacpp-hf",
			ContextWindow:  262144,
			Runtime:        "llamacpp",
			LlamaCpp:       LlamaCppSettings{ModelRef: "unsloth/Code-Model-GGUF:Q4_K_M", HFRepo: "unsloth/Code-Model-GGUF", Quant: "Q4_K_M", BindPort: 4300, ContextWindow: 262144, Parallel: 1, CachePrompt: true, CacheReuse: 256, Alias: "unsloth/Code-Model-GGUF:Q4_K_M"},
			Version:        3,
			RolloutPercent: 100,
			Active:         true,
		}}

		request := HeartbeatFromConfig(cfg, RuntimeMetrics("ready", "unsloth/Code-Model-GGUF:Q4_K_M", 0), 0, HeartbeatIdentity{})

		if request.Runtime != "llamacpp" {
			t.Fatalf("heartbeat runtime = %q, want llamacpp", request.Runtime)
		}
		if request.RuntimeModel != "unsloth/Code-Model-GGUF:Q4_K_M" {
			t.Fatalf("heartbeat runtime model mismatch: %q", request.RuntimeModel)
		}
	})
}

func TestREQNODE007ResponsesCarryMeshBootstrapAndDesiredVersion(t *testing.T) {
	t.Run("REQ-NODE-007", func(t *testing.T) {
		var claim ClaimResponse
		if err := json.Unmarshal([]byte(`{"nodeId":"n","nodeToken":"t","upstreamToken":"u","profiles":[],"meshBootstrap":{"action":"wait","rotation":3},"desiredAgentVersion":"v1.2.3"}`), &claim); err != nil {
			t.Fatal(err)
		}
		if claim.MeshBootstrap == nil || claim.MeshBootstrap.Action != "wait" || claim.MeshBootstrap.Rotation != 3 {
			t.Fatalf("claim response must decode the mesh bootstrap directive, got %#v", claim.MeshBootstrap)
		}
		if claim.DesiredAgentVersion != "v1.2.3" {
			t.Fatalf("claim response must decode desiredAgentVersion, got %q", claim.DesiredAgentVersion)
		}

		var heartbeat HeartbeatResponse
		if err := json.Unmarshal([]byte(`{"ok":true,"desiredProfiles":[],"meshBootstrap":{"action":"join","rotation":4,"meshId":"mesh-9","joinTokens":["tokA","tokB"]},"desiredAgentVersion":"v9.9.9"}`), &heartbeat); err != nil {
			t.Fatal(err)
		}
		bootstrap := heartbeat.MeshBootstrap
		if bootstrap == nil || bootstrap.Action != "join" || bootstrap.Rotation != 4 || bootstrap.MeshID != "mesh-9" {
			t.Fatalf("heartbeat response must decode the join bootstrap, got %#v", bootstrap)
		}
		if !equalStrings(bootstrap.JoinTokens, []string{"tokA", "tokB"}) {
			t.Fatalf("join tokens = %v, want [tokA tokB]", bootstrap.JoinTokens)
		}
		if heartbeat.DesiredAgentVersion != "v9.9.9" {
			t.Fatalf("heartbeat response must decode desiredAgentVersion, got %q", heartbeat.DesiredAgentVersion)
		}
	})
}

func TestREQRUN006HeartbeatCarriesMeshTokenAndMeshId(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("serving", "mesh-xyz", "tok-abc")}
		consoleServer := httptest.NewServer(console)
		defer consoleServer.Close()
		models := &modelsFixture{ids: []string{"target-model"}}
		modelsServer := httptest.NewServer(models)
		defer modelsServer.Close()

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
		}, 0)
		if _, reachable := fixture.manager.PollStatus(context.Background()); !reachable {
			t.Fatal("console fixture should be reachable")
		}

		request := HeartbeatFromConfig(DefaultConfig(t.TempDir()), RuntimeMetrics("ready", "target-model", 0), 0, HeartbeatIdentity{
			MeshID:       fixture.manager.CurrentMeshID(),
			MeshToken:    fixture.manager.CurrentToken(),
			AgentVersion: "v1.0.0",
		})

		if request.MeshID != "mesh-xyz" || request.MeshToken != "tok-abc" {
			t.Fatalf("heartbeat must carry the console-captured mesh identity, got meshId=%q meshToken=%q", request.MeshID, request.MeshToken)
		}
		if request.Runtime != "meshllm" {
			t.Fatalf("heartbeat runtime = %q, want meshllm", request.Runtime)
		}
	})
}

func TestREQRUN003ClaimAppliesDesiredProfilesBeforeRuntimeStart(t *testing.T) {
	t.Run("REQ-RUN-003 REQ-RUN-004", func(t *testing.T) {
		cfg := DefaultConfig(t.TempDir())
		cfg.SetupToken = "setup-token"
		profile := ModelProfile{
			ID:             "router-profile",
			PublicAliases:  []string{"mesh-router"},
			UpstreamModel:  "router-upstream",
			SourceMode:     "meshllm-ref",
			ContextWindow:  262144,
			Runtime:        "meshllm",
			MeshLLM:        MeshLLMSettings{ModelRef: "router-upstream", BindPort: 4300},
			Version:        2,
			RolloutPercent: 100,
			Active:         true,
		}

		next, err := ApplyClaim(cfg, ClaimResponse{
			NodeID:        "node-a",
			NodeToken:     "node-token",
			UpstreamToken: "upstream-token",
			Profiles:      []ModelProfile{profile},
		}, filepath.Join(t.TempDir(), "config.json"))
		if err != nil {
			t.Fatal(err)
		}

		if next.RuntimeModel != "router-upstream" || len(next.ActiveProfileIDs) != 1 || next.ActiveProfileIDs[0] != "router-profile" {
			t.Fatalf("claim did not select router profile before runtime start: %#v", next)
		}
		if len(next.PublicModels) != 1 || next.PublicModels[0] != "mesh-router" || next.SetupToken != "" {
			t.Fatalf("claim did not persist profile aliases and clear setup token: %#v", next)
		}
	})
}

func TestREQRUN003HeartbeatDesiredProfilesUpdateConfig(t *testing.T) {
	t.Run("REQ-RUN-003 REQ-RUN-004", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		cfg := DefaultConfig(t.TempDir())
		cfg.Profiles = []ModelProfile{{
			ID:             "old-profile",
			PublicAliases:  []string{"codeflare-mesh"},
			UpstreamModel:  "old-upstream",
			SourceMode:     "meshllm-ref",
			ContextWindow:  262144,
			Runtime:        "meshllm",
			MeshLLM:        MeshLLMSettings{ModelRef: "old-upstream", BindPort: 4300},
			Version:        1,
			RolloutPercent: 100,
			Active:         true,
		}}
		cfg.ActiveProfileIDs = []string{"old-profile"}
		cfg.PublicModels = []string{"codeflare-mesh"}
		cfg.RuntimeModel = "old-upstream"
		desired := []ModelProfile{{
			ID:             "new-profile",
			PublicAliases:  []string{"codeflare-mesh", "mesh-next"},
			UpstreamModel:  "new-upstream",
			SourceMode:     "meshllm-ref",
			ContextWindow:  262144,
			Runtime:        "meshllm",
			MeshLLM:        MeshLLMSettings{ModelRef: "new-upstream", BindPort: 4300},
			Version:        2,
			RolloutPercent: 100,
			Active:         true,
		}}

		next, changed, restart, err := ApplyDesiredProfiles(cfg, desired, path)
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		unchanged, changedAgain, restartAgain, err := ApplyDesiredProfiles(next, desired, path)
		if err != nil {
			t.Fatal(err)
		}

		if !changed || !restart {
			t.Fatalf("expected changed desired profile to require runtime restart, changed=%v restart=%v", changed, restart)
		}
		if next.RuntimeModel != "new-upstream" || loaded.RuntimeModel != next.RuntimeModel {
			t.Fatalf("runtime model was not updated and persisted: %#v loaded=%#v", next, loaded)
		}
		if len(next.ActiveProfileIDs) != 1 || next.ActiveProfileIDs[0] != "new-profile" {
			t.Fatalf("active profile IDs were not replaced: %#v", next.ActiveProfileIDs)
		}
		if len(next.PublicModels) != 2 || next.PublicModels[0] != "codeflare-mesh" || next.PublicModels[1] != "mesh-next" {
			t.Fatalf("public aliases were not updated: %#v", next.PublicModels)
		}
		payload := HeartbeatFromConfig(next, RuntimeMetrics("ready", "old-upstream", 0), 0, HeartbeatIdentity{})
		if payload.RuntimeModel != "old-upstream" {
			t.Fatalf("heartbeat should report the actually loaded runtime model, got %q", payload.RuntimeModel)
		}
		if changedAgain || restartAgain || unchanged.RuntimeModel != next.RuntimeModel {
			t.Fatalf("unchanged heartbeat response should not rewrite config or restart runtime")
		}
	})
}

func TestREQNODE003UpstreamProxyEnforcesBearerAndStreams(t *testing.T) {
	t.Run("REQ-NODE-003", func(t *testing.T) {
		counter := &ActiveCounter{}
		runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if counter.Value() != 1 {
				t.Fatalf("proxy did not count the active request")
			}
			if r.Header.Get("authorization") != "" || r.Header.Get("cf-access-client-secret") != "" {
				t.Fatalf("proxy leaked forbidden headers")
			}
			w.Header().Set("content-type", "text/event-stream")
			_, _ = io.WriteString(w, "data: one\n\n")
			_, _ = io.WriteString(w, "data: two\n\n")
		}))
		defer runtime.Close()
		proxy, err := ProxyHandler(runtime.URL, "upstream-token", counter)
		if err != nil {
			t.Fatal(err)
		}
		bad := httptest.NewRecorder()
		proxy.ServeHTTP(bad, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{}`)))
		if bad.Code != http.StatusUnauthorized {
			t.Fatalf("expected unauthorized, got %d", bad.Code)
		}
		good := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{}`))
		req.Header.Set("authorization", "Bearer upstream-token")
		req.Header.Set("cf-access-client-secret", "secret")
		proxy.ServeHTTP(good, req)
		if good.Code != http.StatusOK || good.Body.String() != "data: one\n\ndata: two\n\n" {
			t.Fatalf("unexpected proxy response %d %q", good.Code, good.Body.String())
		}
		if counter.Value() != 0 {
			t.Fatalf("proxy did not release the active request")
		}
	})
}

func TestREQNODE004DashboardRendersOperationalStatusUI(t *testing.T) {
	t.Run("REQ-NODE-004", func(t *testing.T) {
		handler := DashboardHandler(func() DashboardStatus {
			return DashboardStatus{Config: Config{MeshIP: "100.64.1.10", InferencePort: 8080, DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token", MeshLLMAPIPort: 9337, MeshLLMConsolePort: 3131, RuntimeModel: "codeflare-mesh"}, Metrics: RuntimeMetrics("ready", "codeflare-mesh", 0), RuntimeState: "ready", Version: "test"}
		})
		resp := httptest.NewRecorder()

		handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/", nil))
		body := resp.Body.String()

		if !strings.Contains(body, "data-dashboard-cards") || !strings.Contains(body, "/api/status") {
			t.Fatalf("dashboard UI should expose status cards and API polling: %s", body)
		}
		if count := strings.Count(body, "data-runtime=\""); count != 3 {
			t.Fatalf("dashboard UI should expose start, stop, and restart controls, got %d in %s", count, body)
		}
	})
}

func TestREQNODE004DashboardReportsMeshLLMRuntimePanel(t *testing.T) {
	t.Run("REQ-NODE-004", func(t *testing.T) {
		metrics := NodeMetrics{
			RuntimeState:    "ready",
			ActiveRequests:  0,
			MeshID:          "mesh-1",
			MeshRole:        "coordinator",
			PeerCount:       3,
			ReadyModels:     []string{"model-a", "model-b"},
			SplitEnabled:    true,
			StageCount:      2,
			APIReady:        true,
			ConsoleReady:    true,
			MeshLLMVersion:  "0.72.9-test",
			TokensPerSecond: 42.5,
			LastError:       "runtime exploded",
		}
		cfg := Config{MeshLLMAPIPort: 9337, MeshLLMConsolePort: 3131, DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token"}
		handler := DashboardHandler(func() DashboardStatus {
			return DashboardStatus{Config: cfg, Metrics: metrics, RuntimeState: metrics.RuntimeState, Version: "test"}
		})

		page := httptest.NewRecorder()
		handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
		body := page.Body.String()
		if !strings.Contains(body, "data-runtime-panel") {
			t.Fatalf("dashboard must render a MeshLLM runtime panel section")
		}
		for _, field := range []string{"meshllm-version", "runtime-state", "mesh-id", "peer-count", "ready-models", "split-enabled", "stage-count", "api-port", "console-port", "api-ready", "console-ready", "tokens-per-second", "last-error"} {
			if !strings.Contains(body, `data-field="`+field+`"`) {
				t.Fatalf("runtime panel is missing the %s field marker", field)
			}
		}
		for _, value := range []string{"0.72.9-test", "mesh-1", "model-a, model-b", "9337", "3131", "42.5", "runtime exploded"} {
			if !strings.Contains(body, value) {
				t.Fatalf("runtime panel is missing contract value %q", value)
			}
		}

		api := httptest.NewRecorder()
		handler.ServeHTTP(api, httptest.NewRequest(http.MethodGet, "/api/status", nil))
		var decoded DashboardStatus
		if err := json.NewDecoder(api.Body).Decode(&decoded); err != nil {
			t.Fatal(err)
		}
		got := decoded.Metrics
		if got.MeshID != "mesh-1" || got.MeshRole != "coordinator" || got.PeerCount != 3 || got.StageCount != 2 {
			t.Fatalf("status API mesh fields mismatch: %#v", got)
		}
		if !got.SplitEnabled || !got.APIReady || !got.ConsoleReady {
			t.Fatalf("status API readiness fields mismatch: %#v", got)
		}
		if !equalStrings(got.ReadyModels, []string{"model-a", "model-b"}) || got.MeshLLMVersion != "0.72.9-test" || got.TokensPerSecond != 42.5 || got.LastError != "runtime exploded" {
			t.Fatalf("status API runtime fields mismatch: %#v", got)
		}
		if decoded.Config.MeshLLMAPIPort != 9337 || decoded.Config.MeshLLMConsolePort != 3131 {
			t.Fatalf("status API must expose the MeshLLM ports, got %#v", decoded.Config)
		}
	})
}

func TestREQSEC008DashboardRedactsCredentials(t *testing.T) {
	t.Run("REQ-SEC-008 REQ-NODE-004", func(t *testing.T) {
		handler := DashboardHandler(func() DashboardStatus {
			return DashboardStatus{Config: Config{NodeToken: "node-token", UpstreamToken: "upstream-token", DashboardToken: "dashboard-token", DisplayName: "Node A"}, Metrics: RuntimeMetrics("ready", "codeflare-mesh", 0), RuntimeState: "ready", Version: "test"}
		})
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/status", nil))
		var body DashboardStatus
		if resp.Code != http.StatusOK {
			t.Fatalf("expected OK")
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Config.NodeToken != "[redacted]" || body.Config.UpstreamToken != "[redacted]" || body.Config.DashboardToken != "[redacted]" {
			t.Fatalf("dashboard did not redact credentials: %#v", body.Config)
		}
	})
}

func TestREQNODE004DashboardRuntimeControlsUseController(t *testing.T) {
	t.Run("REQ-NODE-004 REQ-SEC-004", func(t *testing.T) {
		controller := &fakeRuntimeController{}
		handler := DashboardHandler(func() DashboardStatus {
			return DashboardStatus{Config: Config{DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token"}, Metrics: RuntimeMetrics("ready", "codeflare-mesh", 0), RuntimeState: "ready", Version: "test"}
		}, controller)

		forbidden := httptest.NewRecorder()
		handler.ServeHTTP(forbidden, httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17777/api/runtime/start", nil))
		if forbidden.Code != http.StatusForbidden {
			t.Fatalf("expected missing token to be forbidden, got %d", forbidden.Code)
		}

		badOrigin := httptest.NewRecorder()
		badOriginRequest := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17777/api/runtime/start", nil)
		badOriginRequest.Header.Set("origin", "https://evil.example")
		badOriginRequest.Header.Set("x-inference-mesh-dashboard-token", "dashboard-token")
		handler.ServeHTTP(badOrigin, badOriginRequest)
		if badOrigin.Code != http.StatusForbidden {
			t.Fatalf("expected mismatched origin to be forbidden, got %d", badOrigin.Code)
		}
		if controller.starts != 0 || controller.stops != 0 || controller.restarts != 0 {
			t.Fatalf("forbidden runtime control reached controller: %#v", controller)
		}

		for _, path := range []string{"/api/runtime/start", "/api/runtime/stop", "/api/runtime/restart"} {
			resp := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17777"+path, nil)
			req.Header.Set("origin", "http://127.0.0.1:17777")
			req.Header.Set("x-inference-mesh-dashboard-token", "dashboard-token")
			handler.ServeHTTP(resp, req)
			if resp.Code != http.StatusOK {
				t.Fatalf("runtime control %s returned %d", path, resp.Code)
			}
		}
		if controller.starts != 1 || controller.stops != 1 || controller.restarts != 1 {
			t.Fatalf("runtime controls not routed: %#v", controller)
		}
	})
}

func TestREQNODE004DashboardRuntimeControlsReportUnavailableWithoutController(t *testing.T) {
	t.Run("REQ-NODE-004 REQ-SEC-004", func(t *testing.T) {
		handler := DashboardHandler(func() DashboardStatus {
			return DashboardStatus{Config: Config{DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token"}, Metrics: RuntimeMetrics("external", "codeflare-mesh", 0), RuntimeState: "external", Version: "test"}
		})
		resp := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17777/api/runtime/start", nil)
		req.Header.Set("origin", "http://127.0.0.1:17777")
		req.Header.Set("x-inference-mesh-dashboard-token", "dashboard-token")

		handler.ServeHTTP(resp, req)

		if resp.Code != http.StatusConflict {
			t.Fatalf("expected missing runtime controller to return conflict, got %d", resp.Code)
		}
	})
}

func TestREQRUN005RuntimeManagerUsesProcessLifetimeContext(t *testing.T) {
	t.Run("REQ-RUN-005 REQ-NODE-004", func(t *testing.T) {
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{}, 0)
		var processCtx context.Context
		inner := fixture.manager.launch
		fixture.manager.launch = func(ctx context.Context, binary string, args []string, env []string, stderr io.Writer) (meshProcess, error) {
			processCtx = ctx
			return inner(ctx, binary, args, env, stderr)
		}
		callerCtx, cancel := context.WithCancel(context.Background())
		if err := fixture.manager.Start(callerCtx); err != nil {
			t.Fatal(err)
		}
		cancel()
		if processCtx == nil {
			t.Fatal("launcher did not receive a process context")
		}
		if err := processCtx.Err(); err != nil {
			t.Fatalf("cancelling the caller context must not cancel the process-lifetime context, got %v", err)
		}
		if state := fixture.manager.State(); state == "failed" || state == "stopped" {
			t.Fatalf("runtime should survive caller context cancellation, got %s", state)
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer stopCancel()
		if err := fixture.manager.Stop(stopCtx); err != nil {
			t.Fatal(err)
		}
		if state := fixture.manager.State(); state != "stopped" {
			t.Fatalf("runtime should stop after explicit stop, got %s", state)
		}
	})
}

func TestREQRUN005RuntimeStartDoesNotUseDashboardRequestDeadline(t *testing.T) {
	t.Run("REQ-RUN-005 REQ-NODE-004", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("standby", "", "")}
		consoleServer := httptest.NewServer(console)
		defer consoleServer.Close()
		models := &modelsFixture{}
		modelsServer := httptest.NewServer(models)
		defer modelsServer.Close()

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
		}, 0)
		requestCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()

		if err := fixture.manager.Start(requestCtx); err != nil {
			t.Fatal(err)
		}
		time.Sleep(80 * time.Millisecond)
		if state := fixture.manager.State(); state != "starting" {
			t.Fatalf("readiness must continue past the request deadline without failing, got %s", state)
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer stopCancel()
		if err := fixture.manager.Stop(stopCtx); err != nil {
			t.Fatal(err)
		}
	})
}

func TestREQRUN005APIReadyFailsClosedWhenModelsUnreachable(t *testing.T) {
	t.Run("REQ-RUN-005 REQ-OBS-003", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("serving", "mesh-1", "tok-1")}
		consoleServer := httptest.NewServer(console)
		defer consoleServer.Close()
		models := &modelsFixture{ids: []string{"target-model"}}
		modelsServer := httptest.NewServer(models)

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
		}, 0)
		fixture.manager.PollStatus(context.Background())
		if !fixture.manager.APIReady() {
			t.Fatal("APIReady should be true after a successful /v1/models poll")
		}

		modelsServer.Close()
		fixture.manager.PollStatus(context.Background())
		if fixture.manager.APIReady() {
			t.Fatal("APIReady must fail closed when the models endpoint is unreachable")
		}
	})
}

func TestREQRUN007RestartWithInputRelaunchesWithNewProfileArgs(t *testing.T) {
	t.Run("REQ-RUN-007", func(t *testing.T) {
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ProfileID:   "prof",
			ModelRef:    "model-a",
			BindPort:    4300,
			MeshIP:      "100.64.1.10",
			APIPort:     9337,
			ConsolePort: 3131,
			Rotation:    1,
		}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}

		next := MeshLLMRenderInput{
			ProfileID:   "prof",
			ModelRef:    "hf://meshllm/layers@rev2",
			Split:       true,
			BindPort:    4310,
			MeshIP:      "100.64.1.10",
			APIPort:     9337,
			ConsolePort: 3131,
			Rotation:    1,
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := fixture.manager.RestartWithInput(ctx, next, 0); err != nil {
			t.Fatal(err)
		}

		if fixture.launch.count() != 2 {
			t.Fatalf("restart with new input should relaunch, got %d launches", fixture.launch.count())
		}
		args := fixture.launch.record(1).args
		if models := flagValues(args, "--model"); !equalStrings(models, []string{"hf://meshllm/layers@rev2"}) {
			t.Fatalf("relaunch must render the new profile's model ref, got %v", models)
		}
		if !argvContains(args, "--split") {
			t.Fatalf("relaunch of a split profile must render --split, got %v", args)
		}
		if ports := flagValues(args, "--bind-port"); !equalStrings(ports, []string{"4310"}) {
			t.Fatalf("relaunch must render the new profile's bind port, got %v", ports)
		}
	})
}

func TestREQOBS009ReportsLastRuntimeError(t *testing.T) {
	t.Run("REQ-OBS-009 REQ-RUN-003", func(t *testing.T) {
		manager := NewMeshLLMManager(MeshLLMRenderInput{ProfileID: "prof", ModelRef: "target-model", Rotation: 1}, 0, t.TempDir(), "definitely-missing-mesh-llm-for-test")

		err := manager.Start(context.Background())
		metrics := RuntimeMetricsWithError(manager.State(), "", 0, manager.LastError())

		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("expected dependency-missing error, got %v", err)
		}
		if metrics.RuntimeState != "dependency-missing" {
			t.Fatalf("dependency-missing state was not surfaced: %#v", metrics)
		}
		if !strings.Contains(metrics.LastError, "definitely-missing-mesh-llm-for-test") {
			t.Fatalf("heartbeat metrics must carry the runtime manager's last error, got %q", metrics.LastError)
		}
	})
}

func TestREQOBS009BestEffortHardwareMetrics(t *testing.T) {
	t.Run("REQ-OBS-009", func(t *testing.T) {
		metrics := ParseNvidiaSMI("RTX 3090, 12000, 24576")
		if metrics.GPUName != "RTX 3090" || metrics.GPUMemoryUsedMiB != 12000 || metrics.GPUMemoryTotalMiB != 24576 {
			t.Fatalf("unexpected metrics: %#v", metrics)
		}
		// nvidia-smi emits one row per GPU; used and total sum across rows, name from the first.
		multi := ParseNvidiaSMI("RTX 4090, 8000, 24576\nRTX 4090, 2000, 24576")
		if multi.GPUName != "RTX 4090" || multi.GPUMemoryUsedMiB != 10000 || multi.GPUMemoryTotalMiB != 49152 {
			t.Fatalf("multi-GPU nvidia-smi rows must sum, got %#v", multi)
		}
	})
}

func TestREQOBS009GPUFallbackPerOSAndMerge(t *testing.T) {
	t.Run("REQ-OBS-009", func(t *testing.T) {
		ctx := context.Background()
		// Linux and Windows probe nvidia-smi (with the .exe suffix on Windows).
		linux := func(_ context.Context, name string, _ ...string) ([]byte, error) {
			if name != "nvidia-smi" {
				t.Fatalf("linux fallback must call nvidia-smi, got %q", name)
			}
			return []byte("RTX 4090, 8000, 24576"), nil
		}
		if got := GPUFallbackMetrics(ctx, "linux", linux); got.GPUName != "RTX 4090" || got.GPUMemoryUsedMiB != 8000 || got.GPUMemoryTotalMiB != 24576 {
			t.Fatalf("linux nvidia-smi fallback: %#v", got)
		}
		windows := func(_ context.Context, name string, _ ...string) ([]byte, error) {
			if name != "nvidia-smi.exe" {
				t.Fatalf("windows fallback must call nvidia-smi.exe, got %q", name)
			}
			return []byte("RTX 4080, 1000, 16384"), nil
		}
		if got := GPUFallbackMetrics(ctx, "windows", windows); got.GPUMemoryTotalMiB != 16384 {
			t.Fatalf("windows nvidia-smi.exe fallback: %#v", got)
		}
		// macOS parses system_profiler; VRAM (Total) in GB converts to MiB.
		mac := func(_ context.Context, name string, _ ...string) ([]byte, error) {
			if name != "system_profiler" {
				t.Fatalf("darwin fallback must call system_profiler, got %q", name)
			}
			return []byte("Graphics/Displays:\n    Apple M3 Max:\n      Chipset Model: Apple M3 Max\n      VRAM (Total): 48 GB\n"), nil
		}
		if got := GPUFallbackMetrics(ctx, "darwin", mac); got.GPUName != "Apple M3 Max" || got.GPUMemoryTotalMiB != 48*1024 {
			t.Fatalf("darwin system_profiler fallback: %#v", got)
		}
		// A failed probe yields zero GPU fields (unknown), never an error.
		failing := func(_ context.Context, _ string, _ ...string) ([]byte, error) { return nil, errors.New("not found") }
		if got := GPUFallbackMetrics(ctx, "linux", failing); got.GPUMemoryTotalMiB != 0 || got.GPUName != "" {
			t.Fatalf("failed probe must yield zero VRAM, got %#v", got)
		}
		// MergeRuntimeMetrics carries GPU fields, and a zero extra never clears the base.
		merged := MergeRuntimeMetrics(NodeMetrics{RuntimeState: "ready"}, NodeMetrics{GPUName: "RTX 4090", GPUMemoryUsedMiB: 8000, GPUMemoryTotalMiB: 24576})
		if merged.GPUName != "RTX 4090" || merged.GPUMemoryUsedMiB != 8000 || merged.GPUMemoryTotalMiB != 24576 {
			t.Fatalf("merge must carry GPU fields: %#v", merged)
		}
		if kept := MergeRuntimeMetrics(NodeMetrics{GPUMemoryTotalMiB: 24576}, NodeMetrics{}); kept.GPUMemoryTotalMiB != 24576 {
			t.Fatalf("zero extra must not clear base GPU total, got %#v", kept)
		}
	})
}

func TestREQNODE005StagesSelfUpdateOnlyWhenChecksumMatches(t *testing.T) {
	t.Run("REQ-NODE-005", func(t *testing.T) {
		data := []byte("agent-binary")
		sum := sha256.Sum256(data)
		path, err := StageUpdate(bytes.NewReader(data), hex.EncodeToString(sum[:]), t.TempDir(), "agent")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("staged file missing: %v", err)
		}
		if _, err := StageUpdate(bytes.NewReader(data), "bad", t.TempDir(), "agent"); err == nil {
			t.Fatalf("expected checksum mismatch")
		}
	})
}

func TestREQNODE009ServiceDefinitionsGuaranteeAutoRestart(t *testing.T) {
	t.Run("REQ-NODE-009", func(t *testing.T) {
		cases := []struct {
			platform   string
			directives []string
		}{
			{platform: "linux", directives: []string{"Restart=always"}},
			{platform: "darwin", directives: []string{"KeepAlive=true"}},
			{platform: "windows", directives: []string{"sc.exe failure InferenceMeshAgent", "actions= restart", "sc.exe failureflag InferenceMeshAgent 1"}},
		}
		for _, testCase := range cases {
			plan := ServiceInstallPlan("/opt/inference-mesh-agent", "/etc/inference-mesh/config.json", testCase.platform)
			for _, directive := range testCase.directives {
				if !strings.Contains(plan.Config, directive) {
					t.Fatalf("%s service definition must guarantee restart after an update exit, missing %q in %q", testCase.platform, directive, plan.Config)
				}
			}
		}
	})
}

func argvContains(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

func containsEnv(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

type fakeRuntimeController struct {
	starts   int
	stops    int
	restarts int
}

func (f *fakeRuntimeController) Start(context.Context) error {
	f.starts++
	return nil
}

func (f *fakeRuntimeController) Stop(context.Context) error {
	f.stops++
	return nil
}

func (f *fakeRuntimeController) Restart(context.Context) error {
	f.restarts++
	return nil
}

func TestREQSEC005LegacyConfigBackfillsDashboardToken(t *testing.T) {
	t.Run("REQ-SEC-005", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		legacy := DefaultConfig(t.TempDir())
		if legacy.DashboardToken == "" {
			t.Fatalf("default config did not generate a dashboard token")
		}
		legacy.DashboardToken = ""
		data, err := json.Marshal(legacy)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}

		loaded, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		persisted, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		if loaded.DashboardToken == "" || persisted.DashboardToken != loaded.DashboardToken {
			t.Fatalf("dashboard token was not backfilled and persisted")
		}
	})
}

func TestREQSEC004RuntimeExposureUsesLocalDashboardAndUpstreamToken(t *testing.T) {
	t.Run("REQ-SEC-004", func(t *testing.T) {
		cfg := DefaultConfig(t.TempDir())
		cfg.MeshIP = ""
		cfg.AllowAllInterfaces = false
		if cfg.DashboardAddress != "127.0.0.1:17777" {
			t.Fatalf("dashboard must bind localhost")
		}
		if got := ListenerAddress(cfg.MeshIP, cfg.InferencePort, cfg.AllowAllInterfaces); got != "127.0.0.1:8080" {
			t.Fatalf("unexpected fallback listener %s", got)
		}
		if got := ListenerAddress(cfg.MeshIP, cfg.InferencePort, true); got != "0.0.0.0:8080" {
			t.Fatalf("explicit all-interface fallback missing")
		}
	})
}
