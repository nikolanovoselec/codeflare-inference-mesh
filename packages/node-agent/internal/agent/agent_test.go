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
			_ = json.NewEncoder(w).Encode(HeartbeatResponse{OK: true})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	client := Client{RouterURL: server.URL, HTTPClient: server.Client()}
	claim, err := client.Claim(context.Background(), "setup-token", ClaimRequest{DisplayName: "Node A", MeshIP: "100.64.1.10", InferencePort: 8080, PublicModels: []string{"mesh-default"}, ActiveProfileIDs: []string{"qwen36-35b-a3b-262k-mm-3090"}, Capacity: 2})
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
	_, err = client.Heartbeat(context.Background(), cfg.NodeToken, HeartbeatFromConfig(cfg, RuntimeMetrics("ready", "mesh-default", 0), 0))
	if err != nil {
		t.Fatal(err)
	}
	if claimed.MeshIP != "100.64.1.10" || claimed.Capacity != 2 {
		t.Fatalf("claim payload mismatch: %#v", claimed)
	}
	})
}

func TestREQNODE002DetectsUnambiguousMeshIP(t *testing.T) {
	t.Run("REQ-NODE-002", func(t *testing.T) {
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

func TestREQNODE002AppliesDetectedMeshIPBeforeClaim(t *testing.T) {
	t.Run("REQ-NODE-002", func(t *testing.T) {
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

func TestREQRUN003HeartbeatDesiredProfilesUpdateConfig(t *testing.T) {
	t.Run("REQ-RUN-003 REQ-RUN-004", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		cfg := DefaultConfig(t.TempDir())
		cfg.Profiles = []ModelProfile{{
			ID:                  "old-profile",
			PublicAliases:       []string{"mesh-default"},
			UpstreamModel:       "old-upstream",
			LocalFilename:       "old.gguf",
			LlamaServerModelArg: "old.gguf",
			ContextWindow:       32768,
			Runtime:             "llama.cpp",
			Version:             1,
			RolloutPercent:      100,
			Active:              true,
		}}
		cfg.ActiveProfileIDs = []string{"old-profile"}
		cfg.PublicModels = []string{"mesh-default"}
		cfg.RuntimeModel = "old-upstream"
		desired := []ModelProfile{{
			ID:                  "new-profile",
			PublicAliases:       []string{"mesh-default", "mesh-next"},
			UpstreamModel:       "new-upstream",
			LocalFilename:       "new.gguf",
			LlamaServerModelArg: "new.gguf",
			ContextWindow:       32768,
			Runtime:             "llama.cpp",
			Version:             2,
			RolloutPercent:      100,
			Active:              true,
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
		if len(next.PublicModels) != 2 || next.PublicModels[0] != "mesh-default" || next.PublicModels[1] != "mesh-next" {
			t.Fatalf("public aliases were not updated: %#v", next.PublicModels)
		}
		payload := HeartbeatFromConfig(next, RuntimeMetrics("ready", "old-upstream", 0), 0)
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
			return DashboardStatus{Config: Config{MeshIP: "100.64.1.10", InferencePort: 8080, DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token", RuntimeURL: "http://127.0.0.1:8081", RuntimeModel: "mesh-default"}, Metrics: RuntimeMetrics("ready", "mesh-default", 0), RuntimeState: "ready", Version: "test"}
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

func TestREQNODE004DashboardRedactsCredentials(t *testing.T) {
	t.Run("REQ-NODE-004", func(t *testing.T) {
	handler := DashboardHandler(func() DashboardStatus {
		return DashboardStatus{Config: Config{NodeToken: "node-token", UpstreamToken: "upstream-token", DashboardToken: "dashboard-token", DisplayName: "Node A"}, Metrics: RuntimeMetrics("ready", "mesh-default", 0), RuntimeState: "ready", Version: "test"}
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
		return DashboardStatus{Config: Config{DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token"}, Metrics: RuntimeMetrics("ready", "mesh-default", 0), RuntimeState: "ready", Version: "test"}
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
			return DashboardStatus{Config: Config{DashboardAddress: "127.0.0.1:17777", DashboardToken: "dashboard-token"}, Metrics: RuntimeMetrics("external", "mesh-default", 0), RuntimeState: "external", Version: "test"}
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

func TestREQRUN003RuntimeEnvironmentInheritsServiceEnv(t *testing.T) {
	t.Run("REQ-RUN-003", func(t *testing.T) {
		t.Setenv("HF_TOKEN", "hf-node-token")

		env := runtimeEnvironment(map[string]string{"EXTRA_RUNTIME_FLAG": "1"})

		if !containsEnv(env, "HF_TOKEN=hf-node-token") {
			t.Fatalf("runtime environment should inherit HF_TOKEN from the node service environment")
		}
		if !containsEnv(env, "EXTRA_RUNTIME_FLAG=1") {
			t.Fatalf("runtime environment should include profile command env")
		}
	})
}

func TestREQRUN003RuntimeCommandUsesProfileTemplate(t *testing.T) {
	t.Run("REQ-RUN-003", func(t *testing.T) {
		dataDir := t.TempDir()
		modelDir := filepath.Join(dataDir, "models")
		profile := ModelProfile{
			ID:            "profile-a",
			LocalFilename: "model.gguf",
			Runtime:       "llama.cpp",
			RuntimeCommand: RuntimeCommand{
				Executable: "llama-server",
				Args:       []string{"-hf", "unsloth/model:Q4", "--model", "{{MODEL_PATH}}", "--host", "{{HOST}}", "--port", "{{PORT}}", "--cache", "{{MODEL_DIR}}"},
				Env:        map[string]string{"LLAMA_CACHE": "{{DATA_DIR}}/llama.cpp-cache", "CUDA_VISIBLE_DEVICES": "0"},
			},
		}

		cmd := LlamaCommand(profile, modelDir, "100.64.1.10:8080")

		expectedModelPath := filepath.Join(modelDir, "model.gguf")
		if cmd.Executable != "llama-server" {
			t.Fatalf("runtime executable changed: %#v", cmd)
		}
		if got := cmd.Args; !sameStrings(got, []string{"-hf", "unsloth/model:Q4", "--model", expectedModelPath, "--host", "100.64.1.10", "--port", "8080", "--cache", modelDir}) {
			t.Fatalf("runtime args were not rendered from profile template: %#v", got)
		}
		if cmd.Env["LLAMA_CACHE"] != filepath.Join(dataDir, "llama.cpp-cache") || cmd.Env["CUDA_VISIBLE_DEVICES"] != "0" {
			t.Fatalf("runtime env was not rendered from profile template: %#v", cmd.Env)
		}
	})
}

func TestREQRUN003SourceModesAndChecksum(t *testing.T) {
	t.Run("REQ-RUN-003", func(t *testing.T) {
		data := []byte("model")
		sum := sha256.Sum256(data)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write(data)
		}))
		defer server.Close()

		direct := ModelProfile{ID: "direct", SourceMode: "direct-gguf", DownloadURL: server.URL + "/model.gguf", LocalFilename: "model.gguf", SHA256: hex.EncodeToString(sum[:]), Runtime: "llama.cpp"}
		path, err := EnsureModel(context.Background(), direct, t.TempDir(), nil)
		if err != nil {
			t.Fatal(err)
		}
		ok, err := VerifyFileSHA256(path, hex.EncodeToString(sum[:]))
		if err != nil || !ok {
			t.Fatalf("checksum failed ok=%v err=%v", ok, err)
		}

		hf := ModelProfile{ID: "hf", SourceMode: "llama-hf", HFSpecifier: "unsloth/model:Q4", Runtime: "llama.cpp"}
		if path, err := EnsureModel(context.Background(), hf, t.TempDir(), nil); err != nil || path != "" {
			t.Fatalf("llama-hf profiles should not pre-download model files, path=%q err=%v", path, err)
		}
	})
}

func TestREQRUN003RuntimeReadinessProbeWaitsForModelEndpoint(t *testing.T) {
	t.Run("REQ-RUN-003", func(t *testing.T) {
		attempts := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			attempts++
			if attempts < 2 {
				http.Error(w, "loading", http.StatusServiceUnavailable)
				return
			}
			_, _ = io.WriteString(w, `{"data":[]}`)
		}))
		defer server.Close()

		if err := waitForRuntimeReady(context.Background(), server.URL, server.Client()); err != nil {
			t.Fatal(err)
		}
		if attempts < 2 {
			t.Fatalf("readiness probe should wait until the endpoint succeeds")
		}
	})
}

func TestREQRUN003RuntimeDependencyMissingState(t *testing.T) {
	t.Run("REQ-RUN-003 REQ-OBS-003", func(t *testing.T) {
		missingExecutable := filepath.Join(t.TempDir(), "missing-llama-server")
		manager := NewRuntimeManager(RuntimeCommand{Executable: missingExecutable})

		err := manager.Start(context.Background())
		metrics := RuntimeMetricsWithError(manager.State(), "qwen36-35b-a3b-262k-mm-3090", 0, manager.LastError())

		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("expected dependency-missing error, got %v", err)
		}
		if manager.State() != "dependency-missing" || manager.LastError() == "" {
			t.Fatalf("runtime manager did not store dependency-missing state: state=%s last=%q", manager.State(), manager.LastError())
		}
		if metrics.RuntimeState != "dependency-missing" || metrics.LastError == "" {
			t.Fatalf("dependency-missing metrics were not surfaced: %#v", metrics)
		}
	})
}

func TestREQRUN003RuntimeManagerUsesProcessLifetimeContext(t *testing.T) {
	t.Run("REQ-RUN-003 REQ-NODE-004", func(t *testing.T) {
	if os.Getenv("INFERENCE_MESH_HELPER_PROCESS") == "1" {
		time.Sleep(10 * time.Second)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	manager := NewRuntimeManager(RuntimeCommand{Executable: os.Args[0], Args: []string{"-test.run=TestREQRUN003RuntimeManagerUsesProcessLifetimeContext"}, Env: map[string]string{"INFERENCE_MESH_HELPER_PROCESS": "1"}})
	if err := manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	if manager.State() != "ready" {
		t.Fatalf("runtime should survive caller context cancellation, got %s", manager.State())
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer stopCancel()
	if err := manager.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	if manager.State() != "stopped" {
		t.Fatalf("runtime should stop after explicit stop, got %s", manager.State())
	}
	})
}

func TestREQOBS003ParsesLlamaTokenMetrics(t *testing.T) {
	t.Run("REQ-OBS-003", func(t *testing.T) {
		metrics := ParseLlamaMetrics("llamacpp:tokens_prompt_total 250\nllamacpp:prompt_seconds_total 10\nllamacpp:tokens_predicted_total 900\nllamacpp:predicted_seconds_total 30\n")

		if metrics.PromptTokensPerSecond != 25 || metrics.GenerationTokensPerSecond != 30 || metrics.TokensPerSecond != 55 {
			t.Fatalf("unexpected token metrics: %#v", metrics)
		}
	})
}

func TestREQOBS003BestEffortHardwareMetrics(t *testing.T) {
	t.Run("REQ-OBS-003", func(t *testing.T) {
	metrics := ParseNvidiaSMI("RTX 3090, 12000, 24576")
	if metrics.GPUName != "RTX 3090" || metrics.GPUMemoryUsedMiB != 12000 || metrics.GPUMemoryTotalMiB != 24576 {
		t.Fatalf("unexpected metrics: %#v", metrics)
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

func sameStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
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
