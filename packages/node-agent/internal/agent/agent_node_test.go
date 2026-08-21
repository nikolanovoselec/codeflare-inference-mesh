// Claim, heartbeat, config and the listener policy.
package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestREQNODE014RepositoryFollowsRouterExactly(t *testing.T) {
	current := RuntimeBinaryVersions{MeshLLM: "v1", LlamaCpp: "b1", MeshLLMRepository: "nikolanovoselec/mesh-llm"}
	adopted := mergeRuntimeVersions(current, RuntimeBinaryVersions{MeshLLMRepository: "other/fork"})
	if adopted.MeshLLMRepository != "other/fork" {
		t.Fatalf("a present repository must be adopted, got %q", adopted.MeshLLMRepository)
	}
	reset := mergeRuntimeVersions(current, RuntimeBinaryVersions{MeshLLM: "v2"})
	if reset.MeshLLMRepository != "" {
		t.Fatalf("an absent repository must reset to upstream, got %q", reset.MeshLLMRepository)
	}
	if reset.MeshLLM != "v2" || reset.LlamaCpp != "b1" {
		t.Fatalf("version merge semantics must be unchanged, got %+v", reset)
	}
}

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
				_ = json.NewEncoder(w).Encode(ClaimResponse{NodeID: "node-a", NodeToken: "node-token", UpstreamToken: "upstream-token", DesiredRuntimeVersions: RuntimeBinaryVersions{MeshLLM: "v0.73.0", LlamaCpp: "b9912"}})
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
		if cfg.RuntimeVersions.MeshLLM != "v0.73.0" || cfg.RuntimeVersions.LlamaCpp != "b9912" {
			t.Fatalf("claim not applied: %#v", cfg)
		}
		loaded, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		if loaded.NodeID != "node-a" || loaded.RuntimeVersions.MeshLLM != "v0.73.0" || loaded.RuntimeVersions.LlamaCpp != "b9912" {
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

func TestREQNODE013AppliesDesiredRuntimeVersions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := DefaultConfig(t.TempDir())
	cfg.RuntimeVersions = RuntimeBinaryVersions{MeshLLM: "v0.72.2"}

	next, changed, err := ApplyDesiredRuntimeVersions(cfg, RuntimeBinaryVersions{MeshLLM: "v0.73.0", LlamaCpp: "b9912"}, path)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatalf("desired runtime versions should change config")
	}
	if next.RuntimeVersions.MeshLLM != "v0.73.0" || next.RuntimeVersions.LlamaCpp != "b9912" {
		t.Fatalf("runtime versions not applied: %#v", next.RuntimeVersions)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RuntimeVersions != next.RuntimeVersions {
		t.Fatalf("runtime versions not saved: %#v", loaded.RuntimeVersions)
	}

	_, changed, err = ApplyDesiredRuntimeVersions(next, RuntimeBinaryVersions{}, path)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatalf("empty desired versions should not rewrite config")
	}
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

func TestREQNODE015RuntimeGenerationIsolatesRequestAccounting(t *testing.T) {
	counter := &ActiveCounter{}
	finishOld := counter.Begin()
	if got := counter.Value(); got != 1 {
		t.Fatalf("old runtime request count = %d, want 1", got)
	}

	counter.Reset()
	finishNew := counter.Begin()
	finishOld()
	if got := counter.Value(); got != 1 {
		t.Fatalf("old runtime completion changed the new generation count to %d", got)
	}
	finishNew()
	if got := counter.Value(); got != 0 {
		t.Fatalf("new runtime request count = %d after completion, want 0", got)
	}
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
		for _, field := range []string{"meshllm-version", "vllm-version", "runtime-state", "mesh-id", "peer-count", "ready-models", "split-enabled", "stage-count", "api-port", "console-port", "api-ready", "console-ready", "tokens-per-second", "last-error"} {
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
