// Applying desired profiles and mesh identity to the runtime.
package agent

import (
	"context"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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

// REQ-RUN-014: selected-profile launch input changes request restart.
func TestREQRUN014DesiredProfileContentChangeRestartsRuntime(t *testing.T) {
	// Runtime-launch inputs such as maxVramGb live inside the selected profile. A change to those
	// fields must restart mesh-llm even when the profile ID/version are unchanged; otherwise Force
	// Reload and ordinary heartbeats keep relaunching stale --max-vram values. REQ-RUN-003.
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := DefaultConfig(t.TempDir())
	cfg.Profiles = []ModelProfile{{
		ID:             "split-profile",
		PublicAliases:  []string{"codeflare-mesh"},
		UpstreamModel:  "meshllm/model-layers",
		SourceMode:     "meshllm-ref",
		ContextWindow:  131072,
		Runtime:        "meshllm",
		MeshLLM:        MeshLLMSettings{ModelRef: "meshllm/model-layers", Split: true, BindPort: 4420, MaxVramGb: 12},
		Version:        7,
		RolloutPercent: 100,
		Active:         true,
	}}
	cfg.ActiveProfileIDs = []string{"split-profile"}
	desired := []ModelProfile{{
		ID:             "split-profile",
		PublicAliases:  []string{"codeflare-mesh"},
		UpstreamModel:  "meshllm/model-layers",
		SourceMode:     "meshllm-ref",
		ContextWindow:  131072,
		Runtime:        "meshllm",
		MeshLLM:        MeshLLMSettings{ModelRef: "meshllm/model-layers", Split: true, BindPort: 4420, MaxVramGb: 16},
		Version:        7,
		RolloutPercent: 100,
		Active:         true,
	}}

	next, changed, restart, err := ApplyDesiredProfiles(cfg, desired, path)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || !restart {
		t.Fatalf("selected profile content change must require restart, changed=%v restart=%v", changed, restart)
	}
	if got := next.Profiles[0].MeshLLM.MaxVramGb; got != 16 {
		t.Fatalf("expected updated maxVramGb persisted in selected profile, got %v", got)
	}
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
		// A split profile always writes a config file (the WARP staged-transport
		// table), and a written config owns the [[models]] entry: --model moves off
		// argv so the config-owned entry drives the load (REQ-RUN-003).
		if models := flagValues(args, "--model"); len(models) != 0 {
			t.Fatalf("a config-owned split relaunch must not render --model, got %v", models)
		}
		configPaths := flagValues(args, "--config")
		if len(configPaths) != 1 {
			t.Fatalf("a split relaunch must render its config file, got %v", args)
		}
		written, err := os.ReadFile(configPaths[0])
		if err != nil {
			t.Fatalf("read relaunch config: %v", err)
		}
		if !strings.Contains(string(written), "model = \"hf://meshllm/layers@rev2\"") {
			t.Fatalf("relaunch config must carry the new profile's model ref, got:\n%s", written)
		}
		if !argvContains(args, "--split") {
			t.Fatalf("relaunch of a split profile must render --split, got %v", args)
		}
		if ports := flagValues(args, "--bind-port"); !equalStrings(ports, []string{"4310"}) {
			t.Fatalf("relaunch must render the new profile's bind port, got %v", ports)
		}
	})
}
