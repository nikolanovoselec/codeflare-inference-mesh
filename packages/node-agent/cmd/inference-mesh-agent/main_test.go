package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

// --- seams -----------------------------------------------------------------

type fakeMeshRuntime struct {
	mu             sync.Mutex
	state          string
	lastError      string
	status         agent.MeshLLMStatus
	consoleOK      bool
	apiOK          bool
	ready          []string
	token          string
	meshID         string
	needsRestart   bool
	bootstraps     []agent.MeshBootstrap
	restartInputs  []agent.MeshLLMRenderInput
	restartDrained []int
	restarts       int
	events         []string
	counter        *agent.ActiveCounter
	restarted      chan struct{}
}

func newFakeMeshRuntime(counter *agent.ActiveCounter) *fakeMeshRuntime {
	return &fakeMeshRuntime{state: "ready", consoleOK: true, apiOK: true, counter: counter, restarted: make(chan struct{}, 8)}
}

func (f *fakeMeshRuntime) record(event string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, event)
}

func (f *fakeMeshRuntime) eventLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}

func (f *fakeMeshRuntime) recordRestart(input *agent.MeshLLMRenderInput) {
	f.mu.Lock()
	f.restarts++
	f.restartDrained = append(f.restartDrained, f.counter.Value())
	if input != nil {
		f.restartInputs = append(f.restartInputs, *input)
	}
	f.mu.Unlock()
	f.record("restart")
	f.restarted <- struct{}{}
}

func (f *fakeMeshRuntime) restartCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.restarts
}

func (f *fakeMeshRuntime) Start(context.Context) error { f.record("start"); return nil }

func (f *fakeMeshRuntime) Stop(context.Context) error { f.record("stop"); return nil }

func (f *fakeMeshRuntime) Restart(context.Context) error {
	f.recordRestart(nil)
	return nil
}

func (f *fakeMeshRuntime) RestartWithInput(_ context.Context, in agent.MeshLLMRenderInput, _ int) error {
	f.recordRestart(&in)
	return nil
}

func (f *fakeMeshRuntime) PollStatus(context.Context) (agent.MeshLLMStatus, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status, f.consoleOK
}

func (f *fakeMeshRuntime) ApplyBootstrap(bootstrap *agent.MeshBootstrap) {
	if bootstrap == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bootstraps = append(f.bootstraps, *bootstrap)
}

func (f *fakeMeshRuntime) NeedsRestart(*agent.MeshBootstrap) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.needsRestart
}

func (f *fakeMeshRuntime) CurrentToken() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.token
}

func (f *fakeMeshRuntime) CurrentMeshID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.meshID
}

func (f *fakeMeshRuntime) ReadyModels() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ready...)
}

func (f *fakeMeshRuntime) APIReady() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.apiOK
}

func (f *fakeMeshRuntime) State() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakeMeshRuntime) LastError() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastError
}

func (f *fakeMeshRuntime) SetState(state string) {
	f.mu.Lock()
	f.state = state
	f.mu.Unlock()
	f.record("state:" + state)
}

func (f *fakeMeshRuntime) SetFailure(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = "failed"
	f.lastError = err.Error()
}

type fakeUpdater struct {
	mu      sync.Mutex
	applied bool
	err     error
	calls   []string
}

func (f *fakeUpdater) Maybe(desired string, _ time.Time) (bool, error) {
	if desired == "" {
		return false, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, desired)
	if f.err != nil {
		return false, f.err
	}
	return f.applied, nil
}

func (f *fakeUpdater) desired() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

type routerFixture struct {
	mu       sync.Mutex
	requests []agent.HeartbeatRequest
	response agent.HeartbeatResponse
	server   *httptest.Server
}

func newRouterFixture(t *testing.T, response agent.HeartbeatResponse) *routerFixture {
	t.Helper()
	fixture := &routerFixture{response: response}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/node/heartbeat" {
			http.NotFound(w, r)
			return
		}
		var request agent.HeartbeatRequest
		_ = json.NewDecoder(r.Body).Decode(&request)
		fixture.mu.Lock()
		fixture.requests = append(fixture.requests, request)
		reply := fixture.response
		fixture.mu.Unlock()
		_ = json.NewEncoder(w).Encode(reply)
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *routerFixture) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *routerFixture) request(index int) agent.HeartbeatRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[index]
}

func newLoopForTest(t *testing.T, cfg agent.Config, counter *agent.ActiveCounter, manager meshRuntime, updater agentUpdater, exit func()) *serviceLoop {
	t.Helper()
	cfgCopy := cfg
	if exit == nil {
		exit = func() {}
	}
	return &serviceLoop{
		configPath:     filepath.Join(t.TempDir(), "config.json"),
		stateMu:        &sync.RWMutex{},
		cfg:            &cfgCopy,
		manager:        manager,
		loadState:      &runtimeLoadState{},
		telemetry:      &runtimeTelemetry{},
		activeRequests: counter,
		updater:        updater,
		exit:           exit,
		agentVersion:   "v1.2.3",
		drainTimeout:   5 * time.Second,
	}
}

func missingBinaryMeshManager(t *testing.T) *agent.MeshLLMManager {
	t.Helper()
	return agent.NewMeshLLMManager(agent.MeshLLMRenderInput{ProfileID: "test-prof", ModelRef: "test-model", Rotation: 1}, 0, t.TempDir(), "definitely-missing-mesh-llm-for-test")
}

// --- REQ-RUN-005 runtime metrics bookkeeping --------------------------------

func TestREQRUN005RuntimeMetricsMarksLaunchedProfileLoaded(t *testing.T) {
	launched := agent.ModelProfile{ID: "launched-profile", UpstreamModel: "launched-upstream", Version: 2}
	desired := agent.ModelProfile{ID: "desired-profile", UpstreamModel: "desired-upstream", Version: 3}
	cfg := agent.Config{RuntimeModel: "desired-upstream", ActiveProfileIDs: []string{"desired-profile"}, Profiles: []agent.ModelProfile{desired}}
	manager := missingBinaryMeshManager(t)
	manager.SetState("ready")
	loadState := &runtimeLoadState{}
	loadState.SetStarting(launched)

	metrics := runtimeMetrics(manager, loadState, cfg, 0, "")

	if metrics.LoadedModel != "launched-upstream" || metrics.LoadedProfileID != "launched-profile" || metrics.LoadedProfileVersion != 2 {
		t.Fatalf("ready runtime should report the launched profile until restart, got %#v", metrics)
	}
}

func TestREQRUN005RuntimeRestartMarksPendingProfileNotReady(t *testing.T) {
	loaded := agent.ModelProfile{ID: "loaded-profile", UpstreamModel: "loaded-upstream", Version: 2}
	pending := agent.ModelProfile{ID: "pending-profile", UpstreamModel: "pending-upstream", Version: 4}
	cfg := agent.Config{RuntimeModel: "pending-upstream", ActiveProfileIDs: []string{"pending-profile"}, Profiles: []agent.ModelProfile{pending}}
	manager := missingBinaryMeshManager(t)
	manager.SetState("ready")
	loadState := &runtimeLoadState{}
	loadState.Set(loaded)
	restartMu := &sync.Mutex{}
	restartPending := false

	_, started := beginRuntimeProfileRestart(cfg, manager, loadState, restartMu, &restartPending)
	metrics := runtimeMetrics(manager, loadState, cfg, 0, "")

	if !started || manager.State() != "downloading" || !restartPending {
		t.Fatalf("expected restart initiation to mark runtime downloading and pending, started=%v state=%q pending=%v", started, manager.State(), restartPending)
	}
	if metrics.LoadedModel != "" || metrics.LoadedProfileID != "" || metrics.LoadedProfileVersion != 0 {
		t.Fatalf("downloading restart should not report the pending profile as loaded, got %#v", metrics)
	}
}

func TestREQRUN005RuntimeMetricsMarksReadySelectedProfileLoaded(t *testing.T) {
	profile := agent.ModelProfile{ID: "selected-profile", UpstreamModel: "selected-upstream", Version: 3}
	cfg := agent.Config{RuntimeModel: "selected-upstream", ActiveProfileIDs: []string{"selected-profile"}, Profiles: []agent.ModelProfile{profile}}
	manager := missingBinaryMeshManager(t)
	manager.SetState("ready")
	loadState := &runtimeLoadState{}
	loadState.SetStarting(profile)

	metrics := runtimeMetrics(manager, loadState, cfg, 0, "")

	if metrics.LoadedModel != "selected-upstream" || metrics.LoadedProfileID != "selected-profile" || metrics.LoadedProfileVersion != 3 {
		t.Fatalf("ready runtime should report the selected loaded profile, got %#v", metrics)
	}
}

func TestREQRUN005RuntimeMetricsReportsActualLoadedProfile(t *testing.T) {
	loaded := agent.ModelProfile{ID: "loaded-profile", UpstreamModel: "loaded-upstream", Version: 2}
	loadState := &runtimeLoadState{}
	loadState.Set(loaded)
	cfg := agent.Config{RuntimeModel: "desired-upstream"}

	manager := missingBinaryMeshManager(t)
	_ = manager.Start(context.Background())
	metrics := runtimeMetrics(manager, loadState, cfg, 0, "")

	if metrics.LoadedModel != "loaded-upstream" {
		t.Fatalf("expected loaded model from actual runtime state, got %q", metrics.LoadedModel)
	}
	if metrics.LoadedProfileID != "loaded-profile" || metrics.LoadedProfileVersion != 2 {
		t.Fatalf("expected loaded profile metadata from actual runtime state, got %q v%d", metrics.LoadedProfileID, metrics.LoadedProfileVersion)
	}
	if !strings.Contains(metrics.LastError, "definitely-missing-mesh-llm-for-test") {
		t.Fatalf("expected runtime manager last error to be reported, got %q", metrics.LastError)
	}

	detailed := runtimeMetrics(manager, loadState, cfg, 0, "download mesh-llm-asset: checksum mismatch")
	if detailed.RuntimeState != "dependency-missing" || detailed.LastError != "download mesh-llm-asset: checksum mismatch" {
		t.Fatalf("dependency-missing metrics should carry the install error detail, got %#v", detailed)
	}
}

// --- REQ-NODE-002 / REQ-OBS-003 mesh status metrics --------------------------

func TestREQNODE007HeartbeatMetricsCarryMeshState(t *testing.T) {
	t.Run("REQ-NODE-007 REQ-OBS-003", func(t *testing.T) {
		profile := agent.ModelProfile{ID: "p", UpstreamModel: "model-x", MeshLLM: agent.MeshLLMSettings{ModelRef: "model-x", Split: true, BindPort: 4300}}
		base := agent.NodeMetrics{RuntimeState: "ready", LoadedModel: "model-x", LoadedProfileID: "p", LoadedProfileVersion: 3, ActiveRequests: 1}
		status := agent.MeshLLMStatus{NodeID: "node-1", NodeState: "serving", MeshID: "mesh-1", Version: "0.72.2", PeerCount: 2, StageCount: 2, StageZeroNodeID: "node-9", TokPerSec: 42.5}

		got := applyMeshStatusMetrics(base, profile, status, true, true, []string{"model-x", "other-model"})
		if got.RuntimeState != "ready" {
			t.Fatalf("model routable via own /v1/models must keep the runtime ready, got %q", got.RuntimeState)
		}
		if got.MeshID != "mesh-1" || got.MeshRole != "serving-peer" || got.PeerCount != 2 || got.StageCount != 2 {
			t.Fatalf("mesh fields not carried: %#v", got)
		}
		if !got.SplitEnabled || !got.APIReady || !got.ConsoleReady || got.MeshLLMVersion != "0.72.2" || got.TokensPerSecond != 42.5 {
			t.Fatalf("runtime status fields not carried: %#v", got)
		}
		if len(got.ReadyModels) != 2 || got.ReadyModels[0] != "model-x" {
			t.Fatalf("ready models must come from the node's own /v1/models ids, got %v", got.ReadyModels)
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

func TestREQRUN006HeartbeatLoopSendsMeshIdentityEveryTick(t *testing.T) {
	t.Run("REQ-RUN-006 REQ-NODE-002", func(t *testing.T) {
		counter := &agent.ActiveCounter{}
		fake := newFakeMeshRuntime(counter)
		fake.token = "tok-live"
		fake.meshID = "mesh-live"
		router := newRouterFixture(t, agent.HeartbeatResponse{OK: true})
		cfg := agent.Config{RouterURL: router.server.URL, NodeToken: "node-token", MeshIP: "100.64.1.10", Capacity: 1}
		loop := newLoopForTest(t, cfg, counter, fake, nil, nil)

		loop.tick(context.Background())
		loop.tick(context.Background())

		if router.requestCount() != 2 {
			t.Fatalf("expected two heartbeats, got %d", router.requestCount())
		}
		for index := 0; index < 2; index++ {
			request := router.request(index)
			if request.MeshID != "mesh-live" || request.MeshToken != "tok-live" {
				t.Fatalf("tick %d must carry the captured mesh identity, got meshId=%q meshToken=%q", index, request.MeshID, request.MeshToken)
			}
			if request.AgentVersion != "v1.2.3" {
				t.Fatalf("tick %d must carry the agent version, got %q", index, request.AgentVersion)
			}
			if request.Runtime != "meshllm" {
				t.Fatalf("tick %d runtime = %q, want meshllm", index, request.Runtime)
			}
		}
	})
}

func TestREQRUN006BootstrapRestartDrainsBeforeRelaunch(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		counter := &agent.ActiveCounter{}
		fake := newFakeMeshRuntime(counter)
		fake.needsRestart = true
		bootstrap := &agent.MeshBootstrap{Action: "join", Rotation: 2, MeshID: "mesh-2", JoinTokens: []string{"tokX", "tokY"}}
		router := newRouterFixture(t, agent.HeartbeatResponse{OK: true, MeshBootstrap: bootstrap})
		cfg := agent.Config{RouterURL: router.server.URL, NodeToken: "node-token", Capacity: 1}
		loop := newLoopForTest(t, cfg, counter, fake, nil, nil)

		loop.tick(context.Background())

		select {
		case <-fake.restarted:
		case <-time.After(3 * time.Second):
			t.Fatal("bootstrap restart never happened")
		}
		fake.mu.Lock()
		bootstraps := append([]agent.MeshBootstrap(nil), fake.bootstraps...)
		drained := append([]int(nil), fake.restartDrained...)
		fake.mu.Unlock()
		if len(bootstraps) != 1 || bootstraps[0].Action != "join" || bootstraps[0].Rotation != 2 || bootstraps[0].MeshID != "mesh-2" {
			t.Fatalf("manager must receive the response bootstrap, got %#v", bootstraps)
		}
		if len(bootstraps[0].JoinTokens) != 2 || bootstraps[0].JoinTokens[0] != "tokX" || bootstraps[0].JoinTokens[1] != "tokY" {
			t.Fatalf("bootstrap join tokens not applied, got %v", bootstraps[0].JoinTokens)
		}
		if len(drained) == 0 || drained[0] != 0 {
			t.Fatalf("restart must run only after in-flight requests drain, got drained=%v", drained)
		}
	})
}

func TestREQRUN006DrainWaitsForMeshLLMConsoleInflight(t *testing.T) {
	t.Run("blocks while the console reports inflight even with the proxy counter at zero", func(t *testing.T) {
		counter := &agent.ActiveCounter{}
		fake := newFakeMeshRuntime(counter)
		fake.status = agent.MeshLLMStatus{InflightRequests: 1}
		if err := waitForDrain(context.Background(), counter, fake, 30*time.Millisecond); err == nil {
			t.Fatal("drain must not complete while MeshLLM console reports inflight_requests > 0")
		}
	})
	t.Run("completes once both the proxy counter and console inflight reach zero", func(t *testing.T) {
		counter := &agent.ActiveCounter{}
		fake := newFakeMeshRuntime(counter)
		fake.status = agent.MeshLLMStatus{InflightRequests: 0}
		if err := waitForDrain(context.Background(), counter, fake, time.Second); err != nil {
			t.Fatalf("drain must complete when nothing is in flight, got %v", err)
		}
	})
	t.Run("an unreachable console contributes no backpressure", func(t *testing.T) {
		counter := &agent.ActiveCounter{}
		fake := newFakeMeshRuntime(counter)
		fake.status = agent.MeshLLMStatus{InflightRequests: 5}
		fake.consoleOK = false
		if err := waitForDrain(context.Background(), counter, fake, time.Second); err != nil {
			t.Fatalf("drain must not block on an unobservable console, got %v", err)
		}
	})
}

func TestREQRUN007VersionBumpRestartsEverySplitServingNode(t *testing.T) {
	t.Run("REQ-RUN-007", func(t *testing.T) {
		counter := &agent.ActiveCounter{}
		fake := newFakeMeshRuntime(counter)
		currentProfile := agent.ModelProfile{
			ID:             "split-prof",
			PublicAliases:  []string{"codeflare-mesh"},
			UpstreamModel:  "hf://meshllm/layers@rev1",
			SourceMode:     "meshllm-ref",
			Runtime:        "meshllm",
			MeshLLM:        agent.MeshLLMSettings{ModelRef: "hf://meshllm/layers@rev1", Split: true, BindPort: 4310},
			Version:        1,
			RolloutPercent: 100,
			Active:         true,
		}
		bumped := currentProfile
		bumped.Version = 2
		bumped.UpstreamModel = "hf://meshllm/layers@rev2"
		bumped.MeshLLM.ModelRef = "hf://meshllm/layers@rev2"
		router := newRouterFixture(t, agent.HeartbeatResponse{OK: true, DesiredProfiles: []agent.ModelProfile{bumped}})
		cfg := agent.Config{
			RouterURL:          router.server.URL,
			NodeToken:          "node-token",
			MeshIP:             "100.64.1.10",
			MeshLLMAPIPort:     9337,
			MeshLLMConsolePort: 3131,
			Profiles:           []agent.ModelProfile{currentProfile},
			ActiveProfileIDs:   []string{"split-prof"},
			PublicModels:       []string{"codeflare-mesh"},
			RuntimeModel:       currentProfile.UpstreamModel,
			Capacity:           1,
		}
		loop := newLoopForTest(t, cfg, counter, fake, nil, nil)
		loop.loadState.Set(currentProfile)

		counter.Inc()
		loop.tick(context.Background())
		time.Sleep(150 * time.Millisecond)
		if fake.restartCount() != 0 {
			t.Fatal("split version bump must drain before restarting the runtime")
		}
		counter.Dec()

		select {
		case <-fake.restarted:
		case <-time.After(3 * time.Second):
			t.Fatal("version bump never restarted the runtime")
		}
		fake.mu.Lock()
		inputs := append([]agent.MeshLLMRenderInput(nil), fake.restartInputs...)
		drained := append([]int(nil), fake.restartDrained...)
		fake.mu.Unlock()
		if len(inputs) != 1 {
			t.Fatalf("expected one restart with input, got %d", len(inputs))
		}
		if !inputs[0].Split || inputs[0].ModelRef != "hf://meshllm/layers@rev2" || inputs[0].BindPort != 4310 {
			t.Fatalf("restart must render the bumped split profile, got %#v", inputs[0])
		}
		if drained[0] != 0 {
			t.Fatalf("restart must observe a drained node, got %d in flight", drained[0])
		}
		if selected, ok := agent.SelectedProfile(loop.currentConfig()); !ok || selected.Version != 2 {
			t.Fatalf("desired profile version bump was not persisted, got %#v ok=%v", selected, ok)
		}
	})
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

func TestREQRUN010PreemptsDeselectedInflightDownload(t *testing.T) {
	t.Run("REQ-RUN-010", func(t *testing.T) {
		profileA := agent.ModelProfile{ID: "profile-a", UpstreamModel: "upstream-a", Version: 1}
		profileB := agent.ModelProfile{ID: "profile-b", UpstreamModel: "upstream-b", Version: 1}

		// A switch to a different profile preempts an in-flight download for the now-deselected
		// one instead of waiting for the stale download (minutes for a large GGUF) to finish.
		t.Run("switch to a different profile preempts the in-flight download", func(t *testing.T) {
			manager := missingBinaryMeshManager(t)
			manager.SetState("downloading")
			loadState := &runtimeLoadState{}
			loadState.SetStarting(profileA)
			cfg := agent.Config{RuntimeModel: profileB.UpstreamModel, ActiveProfileIDs: []string{profileB.ID}, Profiles: []agent.ModelProfile{profileB}}
			restartMu := &sync.Mutex{}
			restartPending := false

			if _, started := beginRuntimeProfileRestart(cfg, manager, loadState, restartMu, &restartPending); !started {
				t.Fatal("a switch to a different profile must preempt the deselected in-flight download")
			}
		})

		// A download still in flight for the profile we still want is left alone (no restart thrash).
		t.Run("in-flight download for the still-selected profile is not preempted", func(t *testing.T) {
			manager := missingBinaryMeshManager(t)
			manager.SetState("downloading")
			loadState := &runtimeLoadState{}
			loadState.SetStarting(profileA)
			cfg := agent.Config{RuntimeModel: profileA.UpstreamModel, ActiveProfileIDs: []string{profileA.ID}, Profiles: []agent.ModelProfile{profileA}}
			restartMu := &sync.Mutex{}
			restartPending := false

			if _, started := beginRuntimeProfileRestart(cfg, manager, loadState, restartMu, &restartPending); started {
				t.Fatal("a download for the still-selected profile must not restart while downloading")
			}
		})
	})
}

func TestREQRUN010ReadyRuntimeForSelectedProfileIsNotRestarted(t *testing.T) {
	t.Run("REQ-RUN-010", func(t *testing.T) {
		profileA := agent.ModelProfile{ID: "profile-a", UpstreamModel: "upstream-a", Version: 12}
		profileB := agent.ModelProfile{ID: "profile-b", UpstreamModel: "upstream-b", Version: 1}

		// Start() launches mesh-llm asynchronously and returns before the model is ready, so the
		// runtime reaches "ready" before loadState is marked loaded. A ready runtime already
		// serving the selected profile must not be torn down, or the reconciler SIGTERMs a healthy
		// runtime on every heartbeat and only requests landing in the brief ready window succeed.
		t.Run("ready runtime serving the selected profile is left alone", func(t *testing.T) {
			manager := missingBinaryMeshManager(t)
			manager.SetState("ready")
			loadState := &runtimeLoadState{}
			loadState.SetStarting(profileA) // launched, not yet marked loaded
			cfg := agent.Config{RuntimeModel: profileA.UpstreamModel, ActiveProfileIDs: []string{profileA.ID}, Profiles: []agent.ModelProfile{profileA}}
			restartMu := &sync.Mutex{}
			restartPending := false

			if _, started := beginRuntimeProfileRestart(cfg, manager, loadState, restartMu, &restartPending); started {
				t.Fatal("a ready runtime already serving the selected profile must not be restarted")
			}
		})

		// A genuine switch to a different profile must still restart, even from ready.
		t.Run("ready runtime is restarted when the selected profile changed", func(t *testing.T) {
			manager := missingBinaryMeshManager(t)
			manager.SetState("ready")
			loadState := &runtimeLoadState{}
			loadState.SetStarting(profileA)
			cfg := agent.Config{RuntimeModel: profileB.UpstreamModel, ActiveProfileIDs: []string{profileB.ID}, Profiles: []agent.ModelProfile{profileB}}
			restartMu := &sync.Mutex{}
			restartPending := false

			if _, started := beginRuntimeProfileRestart(cfg, manager, loadState, restartMu, &restartPending); !started {
				t.Fatal("a change to a different selected profile must restart the runtime")
			}
		})
	})
}
