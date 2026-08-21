// What the agent does with what the router tells it: reload, deactivate, versions.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func TestREQNODE010ProfileRestartProvisionsMeshPeerFirewall(t *testing.T) {
	// Switching to a profile re-provisions the iroh UDP bind-port rule, because the bind-port
	// moves with the selected model and a default-deny host would drop the mesh-peer handshake
	// on the new port. REQ-NODE-010.
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	profile := agent.ModelProfile{ID: "p1", UpstreamModel: "u1", Version: 1, MeshLLM: agent.MeshLLMSettings{BindPort: 4430}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"p1"}, Profiles: []agent.ModelProfile{profile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)

	var mu sync.Mutex
	allow := ""
	loop.cmdRunner = func(_ context.Context, name string, args ...string) ([]byte, error) {
		joined := strings.Join(append([]string{name}, args...), " ")
		mu.Lock()
		if strings.Contains(joined, "allow") {
			allow = joined
		}
		mu.Unlock()
		return nil, nil
	}
	loop.goos = "linux"
	loop.warpIface = "CloudflareWARP"

	loop.finishProfileRestart(context.Background(), cfg, "starting")

	mu.Lock()
	got := allow
	mu.Unlock()
	if got != "ufw allow in on CloudflareWARP to any port 4430 proto udp" {
		t.Fatalf("expected udp bind-port rule for the profile, got %q", got)
	}
}

func TestREQNODE012ForceReloadRestartsOncePerNonce(t *testing.T) {
	// A Force Reload directive (a new ReloadNonce in the heartbeat response) drains and restarts
	// the current runtime exactly once per nonce, records the applied nonce so it is echoed back
	// for the router to retire, and never re-fires the same nonce. REQ-NODE-012.
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	profile := agent.ModelProfile{ID: "p1", UpstreamModel: "u1", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "u1", MaxVramGb: 16}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"p1"}, Profiles: []agent.ModelProfile{profile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	// Mark the profile already loaded so a profile-change restart does not fire: the reload branch
	// must be what triggers the restart.
	loop.loadState.Set(profile)

	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, ReloadNonce: "n1"})
	select {
	case <-manager.restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("reload nonce n1 did not restart the runtime")
	}
	if loop.lastReloadNonce != "n1" {
		t.Fatalf("expected applied nonce n1 recorded for ack, got %q", loop.lastReloadNonce)
	}
	if len(manager.restartInputs) != 1 || manager.restartInputs[0].MaxVramGb != 16 {
		t.Fatalf("Force Reload must restart from current selected profile config, got inputs %#v", manager.restartInputs)
	}

	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, ReloadNonce: "n1"})
	select {
	case <-manager.restarted:
		t.Fatal("the same reload nonce must not restart the runtime again")
	case <-time.After(300 * time.Millisecond):
	}

	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, ReloadNonce: "n2"})
	select {
	case <-manager.restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("a new reload nonce must restart the runtime")
	}
}

func TestREQNODE016LlamaCppMetricsCarryResolvedBackend(t *testing.T) {
	// An NVIDIA Linux box runs the Vulkan build, not CUDA: the heartbeat must
	// carry the backend the release archive actually installs so the console
	// can show it next to the version. REQ-NODE-016.
	profile := agent.ModelProfile{ID: "p", UpstreamModel: "m", Version: 2}
	cfg := agent.Config{RuntimeModel: "m", ActiveProfileIDs: []string{"p"}, Profiles: []agent.ModelProfile{profile}}
	manager := agent.NewLlamaCppManager(agent.LlamaCppInput{ProfileID: "p", UpstreamModel: "m", BinaryPath: "llama-server", Backend: "vulkan"})
	manager.SetState("ready")
	loadState := &runtimeLoadState{}
	loadState.Set(profile)

	metrics := runtimeMetrics(manager, loadState, cfg, 0, "")
	if metrics.LlamaCppBackend != "vulkan" {
		t.Fatalf("llamacpp metrics backend = %q, want selected backend", metrics.LlamaCppBackend)
	}
}

// --- REQ-NODE-002 / REQ-OBS-003 mesh status metrics --------------------------

func TestREQNODE007HeartbeatMetricsCarryMeshState(t *testing.T) {
	t.Run("REQ-NODE-007 REQ-OBS-003", func(t *testing.T) {
		profile := agent.ModelProfile{ID: "p", UpstreamModel: "model-x", Version: 3, MeshLLM: agent.MeshLLMSettings{ModelRef: "model-x", Split: true, BindPort: 4300}}
		base := agent.NodeMetrics{RuntimeState: "ready", LoadedModel: "model-x", LoadedProfileID: "p", LoadedProfileVersion: 3, ActiveRequests: 1}
		status := agent.MeshLLMStatus{NodeID: "node-1", NodeState: "serving", MeshID: "mesh-1", Version: "0.72.2", PeerCount: 2, StageCount: 2, StageZeroNodeID: "node-9", Stages: []agent.MeshLLMStage{{StageID: "stage-0", StageIndex: 0, NodeID: "node-9", LayerStart: 0, LayerEnd: 15, State: "ready"}}, TokPerSec: 42.5}

		got := applyMeshStatusMetrics(base, profile, status, true, true, []string{"model-x", "other-model"})
		if got.RuntimeState != "ready" {
			t.Fatalf("model routable via own /v1/models must keep the runtime ready, got %q", got.RuntimeState)
		}
		if got.MeshID != "mesh-1" || got.MeshNodeID != "node-1" || got.MeshRole != "serving-peer" || got.PeerCount != 2 || got.StageCount != 2 {
			t.Fatalf("mesh fields not carried: %#v", got)
		}
		if !got.SplitEnabled || !got.APIReady || !got.ConsoleReady || got.MeshLLMVersion != "0.72.2" || got.TokensPerSecond != 42.5 {
			t.Fatalf("runtime status fields not carried: %#v", got)
		}
		if len(got.StageAssignments) != 1 || got.StageAssignments[0].LayerStart != 0 || got.StageAssignments[0].LayerEnd != 15 {
			t.Fatalf("stage assignments not carried: %#v", got.StageAssignments)
		}
		if len(got.ReadyModels) != 2 || got.ReadyModels[0] != "model-x" {
			t.Fatalf("ready models must come from the node's own /v1/models ids, got %v", got.ReadyModels)
		}

		staleStopped := applyMeshStatusMetrics(agent.NodeMetrics{RuntimeState: "stopped"}, profile, status, true, true, []string{"model-x"})
		if staleStopped.RuntimeState != "ready" || staleStopped.LoadedModel != "model-x" || staleStopped.LoadedProfileID != "p" || staleStopped.LoadedProfileVersion != 3 {
			t.Fatalf("live MeshLLM readiness must override stale stopped manager state, got %#v", staleStopped)
		}

		coordinator := status
		coordinator.StageZeroNodeID = "node-1"
		if role := applyMeshStatusMetrics(base, profile, coordinator, true, true, []string{"model-x"}).MeshRole; role != "coordinator" {
			t.Fatalf("stage-zero owner must report coordinator, got %q", role)
		}

		demoted := applyMeshStatusMetrics(base, profile, status, true, true, []string{"other-model"})
		if demoted.RuntimeState != "starting" || demoted.LoadedModel != "" || demoted.LoadedProfileID != "" || demoted.LoadedProfileVersion != 0 {
			t.Fatalf("serving without the selected model must demote readiness and clear loaded fields, got %#v", demoted)
		}

		unreachable := applyMeshStatusMetrics(base, profile, agent.MeshLLMStatus{}, false, false, nil)
		if unreachable.RuntimeState != "failed" || unreachable.ConsoleReady || unreachable.APIReady || unreachable.MeshRole != "" {
			t.Fatalf("unreachable console must fail closed without fabricating mesh fields, got %#v", unreachable)
		}
	})
}

func TestREQNODE013LlamaCppBinaryPathUsesHostInstalledOverride(t *testing.T) {
	cfg := agent.Config{DataDir: t.TempDir(), LlamaCppBinaryPath: " /opt/llama-cuda/bin/llama-server ", RuntimeVersions: agent.RuntimeBinaryVersions{LlamaCpp: "b9928"}}
	binaryPath, backend, installError := llamaCppBinaryPath(cfg)
	if binaryPath != "/opt/llama-cuda/bin/llama-server" {
		t.Fatalf("expected host-installed llama.cpp binary override, got %q", binaryPath)
	}
	if backend != "unknown" {
		t.Fatalf("unverified custom binary backend = %q, want unknown", backend)
	}
	if installError != "" {
		t.Fatalf("expected override to skip managed install, got %q", installError)
	}
}

func TestREQNODE016ManagedLlamaCppBackendFollowsSelectedBinary(t *testing.T) {
	dataDir := t.TempDir()
	managed := filepath.Join(dataDir, "bin", "llamacpp-vulkan", "llama-server")
	if got := managedLlamaCppBackend(dataDir, managed); got != "vulkan" {
		t.Fatalf("managed backend = %q, want vulkan", got)
	}
	if got := managedLlamaCppBackend(dataDir, "/opt/llama.cpp/bin/llama-server"); got != "unknown" {
		t.Fatalf("host binary backend = %q, want unknown", got)
	}
}

func TestREQNODE013RuntimeVersionChangeRestartsSelectedProfile(t *testing.T) {
	counter := &agent.ActiveCounter{}
	fake := newFakeMeshRuntime(counter)
	profile := agent.ModelProfile{ID: "mesh-prof", PublicAliases: []string{"codeflare-mesh"}, UpstreamModel: "hf://mesh", SourceMode: "meshllm-ref", Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "hf://mesh", BindPort: 4310}, Version: 1, RolloutPercent: 100, Active: true}
	cfg := agent.Config{DataDir: t.TempDir(), Profiles: []agent.ModelProfile{profile}, ActiveProfileIDs: []string{"mesh-prof"}, PublicModels: []string{"codeflare-mesh"}, RuntimeModel: profile.UpstreamModel, RuntimeVersions: agent.RuntimeBinaryVersions{MeshLLM: "v0.72.2"}}
	loop := newLoopForTest(t, cfg, counter, fake, nil, nil)
	loop.loadState.Set(profile)

	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, DesiredRuntimeVersions: agent.RuntimeBinaryVersions{MeshLLM: "v0.73.0", LlamaCpp: "b9912"}})

	select {
	case <-fake.restarted:
	case <-time.After(3 * time.Second):
		t.Fatal("runtime version change never restarted the already-selected profile")
	}
	if fake.restartCount() != 1 {
		t.Fatalf("expected exactly one restart for runtime version change, got %d", fake.restartCount())
	}
	current := loop.currentConfig()
	if current.RuntimeVersions.MeshLLM != "v0.73.0" || current.RuntimeVersions.LlamaCpp != "b9912" {
		t.Fatalf("runtime versions not persisted: %#v", current.RuntimeVersions)
	}
}

func TestREQNODE011DeactivatedNodeStopsRuntimeAndReactivationRelaunches(t *testing.T) {
	has := func(events []string, target string) bool {
		for _, event := range events {
			if event == target {
				return true
			}
		}
		return false
	}
	count := func(events []string, target string) int {
		n := 0
		for _, event := range events {
			if event == target {
				n++
			}
		}
		return n
	}
	counter := &agent.ActiveCounter{}
	fake := newFakeMeshRuntime(counter)
	profile := agent.ModelProfile{
		ID:             "smoke-prof",
		PublicAliases:  []string{"codeflare-mesh"},
		UpstreamModel:  "unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
		SourceMode:     "meshllm-ref",
		Runtime:        "meshllm",
		MeshLLM:        agent.MeshLLMSettings{ModelRef: "unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M", BindPort: 4300},
		Version:        1,
		RolloutPercent: 100,
		Active:         true,
	}
	cfg := agent.Config{
		NodeToken:          "node-token",
		MeshIP:             "100.64.1.10",
		MeshLLMAPIPort:     9337,
		MeshLLMConsolePort: 3131,
		Profiles:           []agent.ModelProfile{profile},
		ActiveProfileIDs:   []string{"smoke-prof"},
		PublicModels:       []string{"codeflare-mesh"},
		RuntimeModel:       profile.UpstreamModel,
		Capacity:           1,
	}
	loop := newLoopForTest(t, cfg, counter, fake, nil, nil)
	loop.loadState.Set(profile)

	// A deactivated heartbeat tears the running runtime down and holds it down (no relaunch).
	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, Deactivated: true})
	if !loop.deactivated {
		t.Fatal("a deactivated heartbeat must mark the loop deactivated")
	}
	events := fake.eventLog()
	if !has(events, "stop") || !has(events, "state:deactivated") {
		t.Fatalf("deactivation must stop the runtime and mark it deactivated, events=%v", events)
	}
	if fake.restartCount() != 0 {
		t.Fatalf("a deactivated node must never relaunch mesh-llm, restarts=%d", fake.restartCount())
	}

	// Repeat deactivated heartbeats are idempotent: the runtime is not stopped again.
	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, Deactivated: true})
	if stops := count(fake.eventLog(), "stop"); stops != 1 {
		t.Fatalf("a repeat deactivated heartbeat must not stop again, stops=%d", stops)
	}

	// Clearing the taint relaunches the selected profile even though the desired set is unchanged.
	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, DesiredProfiles: []agent.ModelProfile{profile}})
	if loop.deactivated {
		t.Fatal("clearing the taint must mark the loop active again")
	}
	select {
	case <-fake.restarted:
	case <-time.After(3 * time.Second):
		t.Fatal("reactivation never relaunched the runtime")
	}
}

func TestREQNODE005HeartbeatDesiredVersionDrivesSelfUpdate(t *testing.T) {
	t.Run("REQ-NODE-005", func(t *testing.T) {
		t.Run("applied update stops the runtime and exits for service restart", func(t *testing.T) {
			counter := &agent.ActiveCounter{}
			fake := newFakeMeshRuntime(counter)
			updater := &fakeUpdater{applied: true}
			exited := make(chan struct{}, 1)
			router := newRouterFixture(t, agent.HeartbeatResponse{OK: true, DesiredAgentVersion: "v9.9.9"})
			cfg := agent.Config{RouterURL: router.server.URL, NodeToken: "node-token", Capacity: 1}
			loop := newLoopForTest(t, cfg, counter, fake, updater, func() {
				fake.record("exit")
				exited <- struct{}{}
			})

			loop.tick(context.Background())

			select {
			case <-exited:
			case <-time.After(3 * time.Second):
				t.Fatal("applied update must invoke the exit seam")
			}
			if desired := updater.desired(); len(desired) != 1 || desired[0] != "v9.9.9" {
				t.Fatalf("updater must receive the heartbeat-delivered desired version, got %v", desired)
			}
			events := fake.eventLog()
			stopIndex, exitIndex := -1, -1
			for index, event := range events {
				if event == "stop" && stopIndex == -1 {
					stopIndex = index
				}
				if event == "exit" {
					exitIndex = index
				}
			}
			if stopIndex == -1 || exitIndex == -1 || stopIndex > exitIndex {
				t.Fatalf("runtime must be stopped before the update exit, got events %v", events)
			}
		})
		t.Run("update failure reports the node's last error and keeps running", func(t *testing.T) {
			counter := &agent.ActiveCounter{}
			fake := newFakeMeshRuntime(counter)
			updater := &fakeUpdater{err: errors.New("checksum mismatch for inference-mesh-agent-linux-amd64.tar.gz")}
			router := newRouterFixture(t, agent.HeartbeatResponse{OK: true, DesiredAgentVersion: "v9.9.9"})
			cfg := agent.Config{RouterURL: router.server.URL, NodeToken: "node-token", Capacity: 1}
			exitCalled := false
			loop := newLoopForTest(t, cfg, counter, fake, updater, func() { exitCalled = true })

			loop.tick(context.Background())
			loop.tick(context.Background())

			if exitCalled {
				t.Fatal("a failed update must not exit the agent")
			}
			if router.requestCount() != 2 {
				t.Fatalf("expected two heartbeats, got %d", router.requestCount())
			}
			if lastError := router.request(1).Metrics.LastError; !strings.Contains(lastError, "checksum mismatch") {
				t.Fatalf("update failure must ride heartbeat metrics as the node's last error, got %q", lastError)
			}
			for _, event := range fake.eventLog() {
				if event == "stop" {
					t.Fatal("a failed update must leave the runtime running")
				}
			}
		})
	})
}

func TestREQNODE002HeartbeatFailuresSurfaceAndClear(t *testing.T) {
	// A rejected heartbeat is the node's lifeline going dark: the failure must reach the
	// operator (stderr once per state change, local dashboard until recovery) instead of
	// being silently swallowed forever. REQ-NODE-002.
	var status atomic.Int64
	status.Store(401)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code := int(status.Load())
		if code != 200 {
			w.WriteHeader(code)
			return
		}
		_ = json.NewEncoder(w).Encode(agent.HeartbeatResponse{})
	}))
	t.Cleanup(server.Close)
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	cfg := agent.Config{RouterURL: server.URL, NodeToken: "node-secret", ActiveProfileIDs: []string{"p1"}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	logBuffer := &bytes.Buffer{}
	loop.errLog = logBuffer

	loop.tick(context.Background())
	loop.tick(context.Background())
	if got := loop.dashboardStatus("v").LastHeartbeatError; !strings.Contains(got, "401") {
		t.Fatalf("dashboard must carry the heartbeat rejection, got %q", got)
	}
	if count := strings.Count(logBuffer.String(), "heartbeat failed"); count != 1 {
		t.Fatalf("an unchanged failure must be logged exactly once, got %d in %q", count, logBuffer.String())
	}

	status.Store(200)
	loop.tick(context.Background())
	if got := loop.dashboardStatus("v").LastHeartbeatError; got != "" {
		t.Fatalf("a successful heartbeat must clear the error, got %q", got)
	}
	if !strings.Contains(logBuffer.String(), "heartbeat recovered") {
		t.Fatalf("recovery must be logged once, got %q", logBuffer.String())
	}
}

func TestREQNODE002StartupHeartbeatsDoNotWaitOnRuntimeStart(t *testing.T) {
	// The initial runtime start (binary download, mesh-llm launch) must never block the
	// heartbeat loop: launchInitialRuntime returns immediately and the manager lands
	// through setManager once the start completes. REQ-NODE-002 / REQ-OBS-008.
	counter := &agent.ActiveCounter{}
	loop := newLoopForTest(t, agent.Config{}, counter, nil, &fakeUpdater{}, nil)
	release := make(chan struct{})
	started := newFakeMeshRuntime(counter)
	launchInitialRuntime(context.Background(), loop, agent.Config{}, agent.ModelProfile{ID: "p1"}, nil, func(context.Context, agent.Config, agent.ModelProfile, *agent.MeshBootstrap) (agent.RuntimeManager, string, error) {
		<-release
		return started, "install-detail", nil
	})
	if loop.currentManager() != nil {
		t.Fatal("launchInitialRuntime must return before the runtime start completes")
	}

	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for loop.currentManager() == nil {
		if time.Now().After(deadline) {
			t.Fatal("the started manager must land through setManager")
		}
		time.Sleep(10 * time.Millisecond)
	}
	manager, installError := loop.managerSnapshot()
	if manager != agent.RuntimeManager(started) {
		t.Fatal("the CURRENT manager must be the started runtime")
	}
	if installError != "install-detail" {
		t.Fatalf("the start's install detail must land with the manager, got %q", installError)
	}
}

func TestREQNODE002HeartbeatTelemetryProbeIsBounded(t *testing.T) {
	// A hanging host GPU probe (macOS system_profiler can stall for minutes under Metal
	// churn during a model switch) must never freeze the heartbeat loop: the probe runs
	// under its own deadline inside collect. REQ-NODE-002.
	profile := agent.ModelProfile{ID: "p1", UpstreamModel: "u1", Version: 1, MeshLLM: agent.MeshLLMSettings{ModelRef: "u1", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"p1"}, Profiles: []agent.ModelProfile{profile}}
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.goos = "darwin"
	loop.gpuProbeTimeout = 50 * time.Millisecond
	loop.cmdRunner = func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	done := make(chan struct{})
	go func() {
		loop.collect(context.Background(), cfg)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("collect must return under the telemetry probe bound, not hang with the GPU probe")
	}
}

func TestREQNODE015RuntimeSwapIsolatesInFlightGenerations(t *testing.T) {
	counter := &agent.ActiveCounter{}
	finishOld := counter.Begin()
	loop := newLoopForTest(t, agent.Config{}, counter, newFakeMeshRuntime(counter), &fakeUpdater{}, nil)

	loop.setManager(newFakeMeshRuntime(counter), "")
	finishNew := counter.Begin()
	finishOld()
	if got := counter.Value(); got != 1 {
		t.Fatalf("old runtime completion changed the new runtime count to %d", got)
	}
	finishNew()
	if got := counter.Value(); got != 0 {
		t.Fatalf("new runtime request count = %d after completion, want 0", got)
	}
}
