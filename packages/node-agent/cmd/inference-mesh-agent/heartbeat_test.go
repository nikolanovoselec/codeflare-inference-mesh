// What the heartbeat reports and how config resolves.
package main

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func TestREQOBS011RuntimeDetailAndNodeStateRideHeartbeat(t *testing.T) {
	// The captured mesh-llm stderr error line and the console node_state must ride the per-tick
	// heartbeat metrics, so the console can show why a runtime is wedged without SSH. REQ-OBS-011.
	profile := agent.ModelProfile{ID: "p1", UpstreamModel: "u1", Version: 1, MeshLLM: agent.MeshLLMSettings{ModelRef: "u1", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"p1"}, Profiles: []agent.ModelProfile{profile}}
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	manager.status = agent.MeshLLMStatus{NodeState: "loading model", NodeID: "node-1"}
	manager.runtimeDetail = "cuda out of memory"
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)

	metrics, _ := loop.collect(context.Background(), cfg)
	if metrics.RuntimeDetail != "cuda out of memory" {
		t.Fatalf("captured runtime error must ride the heartbeat metrics, got %q", metrics.RuntimeDetail)
	}
	if metrics.NodeState != "loading model" {
		t.Fatalf("console node_state must ride the heartbeat metrics, got %q", metrics.NodeState)
	}
}

func TestREQOBS007CollectCarriesSplitReadinessAndLaunchedBudget(t *testing.T) {
	// Split planner blockers must ride heartbeat metrics so the control plane can say
	// "capacity shortfall" instead of only showing api-client/standby. REQ-OBS-007.
	profile := agent.ModelProfile{
		ID: "split-p", UpstreamModel: "meshllm/model-layers", Version: 1, Runtime: "meshllm",
		MeshLLM: agent.MeshLLMSettings{ModelRef: "meshllm/model-layers", Split: true, BindPort: 4420, MaxVramGb: 16},
	}
	cfg := agent.Config{RuntimeModel: profile.UpstreamModel, ActiveProfileIDs: []string{profile.ID}, Profiles: []agent.ModelProfile{profile}}
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	manager.maxVramGb = 16
	manager.status = agent.MeshLLMStatus{NodeState: "standby", NodeID: "node-1"}
	manager.splitReadinessOK = true
	manager.splitReadiness = agent.MeshLLMSplitReadiness{
		ModelRef: profile.MeshLLM.ModelRef,
		Verdict:  "insufficient_capacity",
		CapacityAdvice: &agent.MeshLLMSplitCapacityAdvice{State: "insufficient_capacity", Reason: "participant_split_capacity_insufficient", RequiredBytes: 18_000_000_000, AggregateCapacityBytes: 16_000_000_000, ShortfallBytes: 2_000_000_000, EligibleNodeCount: 2, SplitCapable: true},
		Blockers: []agent.MeshLLMSplitReadinessBlocker{{Reason: "split_capacity_shortfall", Recommendation: "Add capacity."}},
		Participants: []agent.MeshLLMSplitParticipant{{ShortNodeID: "mac", VRAMBytes: 4_000_000_000}, {ShortNodeID: "battle", VRAMBytes: 12_000_000_000}},
	}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)

	metrics, _ := loop.collect(context.Background(), cfg)
	if metrics.MeshMaxVramGb != 16 {
		t.Fatalf("launched mesh max-vram budget must ride heartbeat metrics, got %v", metrics.MeshMaxVramGb)
	}
	if metrics.SplitReadiness == nil || metrics.SplitReadiness.Blockers[0].Reason != "split_capacity_shortfall" {
		t.Fatalf("split readiness blocker missing from heartbeat metrics: %#v", metrics.SplitReadiness)
	}
}

func TestREQOBS009CollectFillsMeshLLMUsedVRAMFromHostTelemetry(t *testing.T) {
	// MeshLLM can report rated GPU capacity without used VRAM. The heartbeat/API must still carry
	// trusted used/total GPU telemetry when the host GPU tool can provide the missing used value.
	profile := agent.ModelProfile{
		ID: "split-p", UpstreamModel: "meshllm/model-layers", Version: 1, Runtime: "meshllm",
		MeshLLM: agent.MeshLLMSettings{ModelRef: "meshllm/model-layers", Split: true, BindPort: 4420},
	}
	cfg := agent.Config{
		RuntimeModel: profile.UpstreamModel,
		ActiveProfileIDs: []string{profile.ID},
		Profiles: []agent.ModelProfile{profile},
	}
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	manager.ready = []string{profile.UpstreamModel}
	manager.status = agent.MeshLLMStatus{
		NodeState: "serving",
		NodeID:    "node-1",
		GPUs:      []agent.GPUStatus{{Name: "NVIDIA GeForce RTX 3090", RatedVRAMGB: 24}},
	}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.goos = "linux"
	loop.cmdRunner = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "nvidia-smi" {
			return nil, errors.New("unexpected command " + name)
		}
		return []byte("NVIDIA GeForce RTX 3090, 18799, 24576\n"), nil
	}

	metrics, _ := loop.collect(context.Background(), cfg)
	if metrics.GPUMemoryTotalMiB != 24*1024 {
		t.Fatalf("MeshLLM-rated total VRAM should be preserved, got %d", metrics.GPUMemoryTotalMiB)
	}
	if metrics.GPUMemoryUsedMiB != 18799 {
		t.Fatalf("missing MeshLLM used VRAM should be filled from host telemetry, got %d", metrics.GPUMemoryUsedMiB)
	}
}

func TestREQOBS009MeshStatusGPUMetrics(t *testing.T) {
	t.Run("REQ-OBS-009", func(t *testing.T) {
		profile := agent.ModelProfile{ID: "p", UpstreamModel: "model-x", MeshLLM: agent.MeshLLMSettings{ModelRef: "model-x"}}
		base := agent.NodeMetrics{RuntimeState: "ready", LoadedModel: "model-x"}
		status := agent.MeshLLMStatus{NodeID: "node-1", GPUs: []agent.GPUStatus{{Name: "RTX 4090", RatedVRAMGB: 24, UsedVRAMGB: 8}}}

		got := applyMeshStatusMetrics(base, profile, status, true, true, []string{"model-x"})
		if got.GPUName != "RTX 4090" || got.GPUMemoryTotalMiB != 24*1024 || got.GPUMemoryUsedMiB != 8*1024 {
			t.Fatalf("gpus[] rated/used VRAM must populate GPU metrics, got %#v", got)
		}

		// Multiple GPUs sum: two 24 GB cards -> 48 GB total, used summed across both.
		multi := agent.MeshLLMStatus{NodeID: "node-1", GPUs: []agent.GPUStatus{{Name: "RTX 4090", RatedVRAMGB: 24, UsedVRAMGB: 8}, {Name: "RTX 4090", RatedVRAMGB: 24, UsedVRAMGB: 2}}}
		if summed := applyMeshStatusMetrics(base, profile, multi, true, true, []string{"model-x"}); summed.GPUMemoryTotalMiB != 48*1024 || summed.GPUMemoryUsedMiB != 10*1024 {
			t.Fatalf("multi-GPU VRAM must sum across cards, got %#v", summed)
		}

		// No gpus[] reported -> GPU fields stay zero so the collect() host fallback can fill them.
		none := applyMeshStatusMetrics(base, profile, agent.MeshLLMStatus{NodeID: "node-1"}, true, true, []string{"model-x"})
		if none.GPUMemoryTotalMiB != 0 || none.GPUMemoryUsedMiB != 0 || none.GPUName != "" {
			t.Fatalf("absent gpus[] must leave GPU metrics zero, got %#v", none)
		}
	})
}

// --- heartbeat loop wiring ---------------------------------------------------

func TestConfigFlagResolvesExplicitConfigPath(t *testing.T) {
	t.Run("REQ-NODE-001", func(t *testing.T) {
		if got := configPathFromArgs([]string{"--router", "https://r", "--config", "/var/lib/inference-mesh/config.json"}); got != "/var/lib/inference-mesh/config.json" {
			t.Fatalf("--config value not parsed, got %q", got)
		}
		if got := configPathFromArgs([]string{"--router", "https://r"}); got != "" {
			t.Fatalf("absent --config should yield empty, got %q", got)
		}
		// The parsed --config drives ConfigPath, so install and run agree on one path.
		explicit := filepath.Join(t.TempDir(), "explicit.json")
		t.Setenv("INFERENCE_MESH_CONFIG", "")
		if p := configPathFromArgs([]string{"--config", explicit}); p != "" {
			t.Setenv("INFERENCE_MESH_CONFIG", p)
		}
		if got := agent.ConfigPath(); got != explicit {
			t.Fatalf("run must resolve the explicit --config path, got %q want %q", got, explicit)
		}
	})
}

// --- REQ-RUN-010 mid-download profile-switch preemption ----------------------

// After a runtime-mode switch replaces serviceLoop.manager, the dashboard status and
// runtime controls must follow the CURRENT manager. The startup-captured manager
// previously kept reporting runtimeState=stopped while the live runtime served
// traffic (apiReady=true), an internally impossible status. REQ-OBS-008 / REQ-NODE-004.
func TestREQOBS008DashboardStatusAndControlsTrackCurrentManager(t *testing.T) {
	counter := &agent.ActiveCounter{}
	stale := newFakeMeshRuntime(counter)
	stale.SetState("stopped")
	live := newFakeMeshRuntime(counter)
	live.SetState("ready")
	var stateMu sync.RWMutex
	cfg := agent.Config{DisplayName: "node-a"}
	loop := &serviceLoop{
		stateMu:        &stateMu,
		cfg:            &cfg,
		manager:        stale,
		loadState:      &runtimeLoadState{},
		telemetry:      &runtimeTelemetry{},
		activeRequests: counter,
	}

	if got := loop.dashboardStatus("v-test").Metrics.RuntimeState; got != "stopped" {
		t.Fatalf("startup manager state = %q, want stopped", got)
	}

	loop.setManager(live, "")
	if got := loop.dashboardStatus("v-test").Metrics.RuntimeState; got != "ready" {
		t.Fatalf("dashboard must report the current manager after a runtime switch, got %q", got)
	}

	controller := &currentRuntimeController{loop: loop}
	if err := controller.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	if live.restartCount() != 1 || stale.restartCount() != 0 {
		t.Fatalf("runtime controls must dispatch to the current manager (live=%d stale=%d)", live.restartCount(), stale.restartCount())
	}
	if err := controller.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	liveEvents := live.eventLog()
	if len(liveEvents) == 0 || liveEvents[len(liveEvents)-1] != "stop" {
		t.Fatalf("shutdown-path Stop must reach the current manager, events=%v", liveEvents)
	}
}
