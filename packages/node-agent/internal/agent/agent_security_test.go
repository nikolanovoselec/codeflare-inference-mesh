// Credential handling, redaction, and best-effort telemetry.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
		// macOS parses system_profiler (VRAM (Total) in GB converts to MiB) and reads
		// live consumption from the IORegistry accelerator counter.
		mac := func(_ context.Context, name string, _ ...string) ([]byte, error) {
			switch name {
			case "system_profiler":
				return []byte("Graphics/Displays:\n    Apple M3 Max:\n      Chipset Model: Apple M3 Max\n      VRAM (Total): 48 GB\n"), nil
			case "ioreg":
				return []byte("    \"PerformanceStatistics\" = {\"In use system memory\" = 1073741824}\n"), nil
			default:
				t.Fatalf("darwin fallback must call system_profiler or ioreg, got %q", name)
				return nil, nil
			}
		}
		if got := GPUFallbackMetrics(ctx, "darwin", mac); got.GPUName != "Apple M3 Max" || got.GPUMemoryTotalMiB != 48*1024 || got.GPUMemoryUsedMiB != 1024 {
			t.Fatalf("darwin system_profiler fallback: %#v", got)
		}
		// A failed probe yields zero GPU fields (unknown), never an error.
		failing := func(_ context.Context, _ string, _ ...string) ([]byte, error) { return nil, errors.New("not found") }
		if got := GPUFallbackMetrics(ctx, "linux", failing); got.GPUMemoryTotalMiB != 0 || got.GPUName != "" {
			t.Fatalf("failed probe must yield zero VRAM, got %#v", got)
		}
		// MergeRuntimeMetrics carries GPU fields, and a zero extra never clears the base.
		merged := MergeRuntimeMetrics(NodeMetrics{RuntimeState: "ready"}, NodeMetrics{GPUName: "RTX 4090", GPUMemoryUsedMiB: 8000, GPUMemoryTotalMiB: 24576, Multimodal: true})
		if merged.GPUName != "RTX 4090" || merged.GPUMemoryUsedMiB != 8000 || merged.GPUMemoryTotalMiB != 24576 {
			t.Fatalf("merge must carry GPU fields: %#v", merged)
		}
		if !merged.Multimodal {
			t.Fatalf("merge must carry direct-runtime capability telemetry: %#v", merged)
		}
		cleared := MergeRuntimeMetrics(NodeMetrics{RuntimeKind: "llamacpp", Multimodal: true}, NodeMetrics{RuntimeKind: "llamacpp"})
		if cleared.Multimodal {
			t.Fatalf("a new direct lifecycle must clear stale multimodal telemetry: %#v", cleared)
		}
		if kept := MergeRuntimeMetrics(NodeMetrics{GPUMemoryTotalMiB: 24576}, NodeMetrics{}); kept.GPUMemoryTotalMiB != 24576 {
			t.Fatalf("zero extra must not clear base GPU total, got %#v", kept)
		}
	})
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
