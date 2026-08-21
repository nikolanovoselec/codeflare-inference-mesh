// Restarting the runtime for a profile, and the latches that keep it from racing.
package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func TestREQRUN010RestartLatchReleasedWhenRuntimeHangs(t *testing.T) {
	// A runtime restart whose Stop blocks (a mesh-llm ignoring SIGTERM) must not strand the
	// restart-pending latch. The bounded restart timeout unblocks it so a later heartbeat can
	// retry, instead of the node wedging in a transient state forever. REQ-RUN-003.
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	manager.setRestartBlock(true)
	profile := agent.ModelProfile{ID: "wedge-profile", UpstreamModel: "wedge-upstream", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "wedge-upstream", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "wedge-upstream", ActiveProfileIDs: []string{"wedge-profile"}, Profiles: []agent.ModelProfile{profile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.restartTimeout = 80 * time.Millisecond

	if !beginRestart(&loop.restartMu, &loop.restartPending) {
		t.Fatal("precondition: latch should start clear")
	}

	done := make(chan struct{})
	go func() {
		loop.finishProfileRestart(context.Background(), cfg, "starting")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("finishProfileRestart never returned: a hung Stop stranded the restart latch")
	}

	loop.restartMu.Lock()
	pending := loop.restartPending
	loop.restartMu.Unlock()
	if pending {
		t.Fatal("restartPending not released after bounded restart timeout; node would never retry")
	}
	if got := manager.State(); got != "failed" {
		t.Fatalf("expected runtime marked failed after restart timeout, got %q", got)
	}
}

func TestREQRUN010UnmanagedManagerKindRestartsInPlaceForMeshProfile(t *testing.T) {
	// A live manager reporting an unmanaged runtime kind resolves to the mesh kind,
	// exactly like an unknown profile runtime does at launch: the reconciler restarts
	// it in place instead of treating the unknown string as a cross-kind switch and
	// tearing the runtime down to relaunch from scratch. REQ-RUN-010.
	counter := &agent.ActiveCounter{}
	manager := &fakeKindRuntime{fakeMeshRuntime: newFakeMeshRuntime(counter), kind: "legacy-kind"}
	profile := agent.ModelProfile{ID: "kind-profile", UpstreamModel: "kind-upstream", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "kind-upstream", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "kind-upstream", ActiveProfileIDs: []string{"kind-profile"}, Profiles: []agent.ModelProfile{profile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)

	loop.finishProfileRestart(context.Background(), cfg, "starting")

	if got := loop.currentManager(); got != agent.RuntimeManager(manager) {
		t.Fatal("in-place restart must keep the live manager; a kind-resolved match is not a runtime switch")
	}
	if manager.restartCount() != 1 {
		t.Fatalf("expected one in-place restart, got %d", manager.restartCount())
	}
}

func TestREQRUN010ManagerWithoutRestartSeamFailsClosed(t *testing.T) {
	// A manager satisfying neither restart seam must surface a failed restart —
	// never a silent success the reconciler then marks ready. REQ-RUN-010.
	counter := &agent.ActiveCounter{}
	manager := &fakeSeamlessRuntime{fakeMeshRuntime: newFakeMeshRuntime(counter)}
	profile := agent.ModelProfile{ID: "seamless-profile", UpstreamModel: "seamless-upstream", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "seamless-upstream", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "seamless-upstream", ActiveProfileIDs: []string{"seamless-profile"}, Profiles: []agent.ModelProfile{profile}}

	if _, err := restartMeshRuntime(context.Background(), cfg, profile, manager); err == nil {
		t.Fatal("restartMeshRuntime must error for a manager satisfying neither restart seam")
	}

	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.finishProfileRestart(context.Background(), cfg, "starting")
	if got := manager.State(); got != "failed" {
		t.Fatalf("expected failed state after restart without a seam, got %q", got)
	}
	if manager.LastError() == "" {
		t.Fatal("expected the restart failure to surface as the runtime's last error")
	}
}

func TestREQRUN010LlamaProfileWithoutRestartSeamFailsClosed(t *testing.T) {
	// The documented llama.cpp fall-through: a llamacpp-profile restart whose live
	// manager is neither the concrete llama.cpp manager nor a mesh restart seam
	// reaches the mesh tail and fails closed there. REQ-RUN-010.
	counter := &agent.ActiveCounter{}
	manager := &fakeSeamlessRuntime{fakeMeshRuntime: newFakeMeshRuntime(counter)}
	profile := agent.ModelProfile{ID: "direct-profile", UpstreamModel: "direct-upstream", Version: 1, Runtime: "llamacpp"}
	cfg := agent.Config{RuntimeModel: "direct-upstream", ActiveProfileIDs: []string{"direct-profile"}, Profiles: []agent.ModelProfile{profile}}

	if _, err := restartLlamaCppRuntime(context.Background(), cfg, profile, manager); err == nil {
		t.Fatal("restartLlamaCppRuntime must fail closed when the manager matches neither restart seam")
	}
}

func TestREQRUN010ProfileRestartContinuesAfterStaleDrainCounter(t *testing.T) {
	// A stale proxy counter from an aborted/hung request must not strand a model deploy as
	// "failed" before the new runtime can even start loading the selected model. The drain
	// window is best-effort for operator-driven profile changes; after it expires, restart anyway.
	counter := &agent.ActiveCounter{}
	counter.Inc()
	manager := newFakeMeshRuntime(counter)
	profile := agent.ModelProfile{ID: "next-profile", UpstreamModel: "next-upstream", Version: 2, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "next-upstream", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "next-upstream", ActiveProfileIDs: []string{"next-profile"}, Profiles: []agent.ModelProfile{profile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.drainTimeout = 20 * time.Millisecond

	loop.finishProfileRestart(context.Background(), cfg, "starting")

	if manager.restartCount() != 1 {
		t.Fatalf("expected stale counter to stop blocking profile restart, got %d restarts", manager.restartCount())
	}
	if manager.State() == "failed" || manager.LastError() != "" {
		t.Fatalf("stale drain counter should not mark runtime failed, state=%q error=%q", manager.State(), manager.LastError())
	}
	manager.mu.Lock()
	drained := append([]int(nil), manager.restartDrained...)
	manager.mu.Unlock()
	if len(drained) != 1 || drained[0] != 0 {
		t.Fatalf("replacement runtime must start with fresh request accounting, got %v", drained)
	}
}

// REQ-RUN-014: updated render inputs are applied after content-change restart.
func TestREQRUN014ProfileContentChangeRestartsWithUpdatedRenderInput(t *testing.T) {
	// Same ID/version with changed launch settings is still a different runtime target. The heartbeat
	// handler must restart with the updated render input, otherwise a saved maxVramGb change leaves
	// mesh-llm running the old --max-vram until the agent process itself restarts. REQ-RUN-003.
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	oldProfile := agent.ModelProfile{ID: "p1", UpstreamModel: "u1", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "u1", MaxVramGb: 12}}
	newProfile := oldProfile
	newProfile.MeshLLM.MaxVramGb = 16
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"p1"}, Profiles: []agent.ModelProfile{oldProfile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.loadState.Set(oldProfile)

	loop.handleResponse(context.Background(), agent.HeartbeatResponse{OK: true, DesiredProfiles: []agent.ModelProfile{newProfile}})
	select {
	case <-manager.restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("selected profile content change did not restart runtime")
	}
	if len(manager.restartInputs) != 1 || manager.restartInputs[0].MaxVramGb != 16 {
		t.Fatalf("runtime must restart with updated maxVramGb, got inputs %#v", manager.restartInputs)
	}
}

func TestREQRUN005WaitingForPeersSelfHealsWithOneRestart(t *testing.T) {
	// A split node that keeps reporting waiting_for_peers should get the same automatic relaunch
	// operators were doing with Force Reload, but only after consecutive stuck heartbeats and only
	// once for the current mesh bootstrap/profile key.
	profile := agent.ModelProfile{ID: "split", UpstreamModel: "u1", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "u1", Split: true, BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"split"}, Profiles: []agent.ModelProfile{profile}}
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.loadState.Set(profile)
	loop.lastMetrics = agent.NodeMetrics{RuntimeKind: "meshllm", RuntimeState: "starting", NodeState: "standby", SplitEnabled: true, ActiveRequests: 0, SplitReadiness: &agent.MeshLLMSplitReadiness{Verdict: "waiting_for_peers"}}
	response := agent.HeartbeatResponse{OK: true, MeshBootstrap: &agent.MeshBootstrap{Action: "create", Rotation: 7}}

	loop.handleResponse(context.Background(), response)
	if manager.restartCount() != 0 {
		t.Fatalf("first waiting heartbeat should arm self-heal, not restart immediately: %d", manager.restartCount())
	}
	loop.handleResponse(context.Background(), response)
	select {
	case <-manager.restarted:
	case <-time.After(time.Second):
		t.Fatal("waiting_for_peers self-heal did not restart the runtime")
	}
	if manager.restartCount() != 1 {
		t.Fatalf("expected one self-heal restart, got %d", manager.restartCount())
	}
	loop.handleResponse(context.Background(), response)
	select {
	case <-manager.restarted:
		t.Fatal("self-heal must not restart repeatedly for the same bootstrap/profile key")
	case <-time.After(20 * time.Millisecond):
	}
}

func TestREQRUN005ModelSizeUnknownSelfHealsOnlyWhenNotServing(t *testing.T) {
	profile := agent.ModelProfile{ID: "split", UpstreamModel: "u1", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "u1", Split: true, BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"split"}, Profiles: []agent.ModelProfile{profile}}
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.loadState.Set(profile)
	loop.lastMetrics = agent.NodeMetrics{RuntimeKind: "meshllm", RuntimeState: "starting", NodeState: "standby", SplitEnabled: true, ActiveRequests: 0, SplitReadiness: &agent.MeshLLMSplitReadiness{Verdict: "model_size_unknown"}}
	response := agent.HeartbeatResponse{OK: true, MeshBootstrap: &agent.MeshBootstrap{Action: "create", Rotation: 9}}

	loop.handleResponse(context.Background(), response)
	loop.handleResponse(context.Background(), response)
	select {
	case <-manager.restarted:
	case <-time.After(time.Second):
		t.Fatal("model_size_unknown without serving evidence did not self-heal")
	}

	serving := newFakeMeshRuntime(counter)
	servingLoop := newLoopForTest(t, cfg, counter, serving, &fakeUpdater{}, nil)
	servingLoop.loadState.Set(profile)
	servingLoop.lastMetrics = agent.NodeMetrics{RuntimeKind: "meshllm", RuntimeState: "ready", NodeState: "serving", SplitEnabled: true, ActiveRequests: 0, APIReady: true, ConsoleReady: true, StageCount: 2, ReadyModels: []string{"u1"}, SplitReadiness: &agent.MeshLLMSplitReadiness{Verdict: "model_size_unknown"}}
	servingLoop.handleResponse(context.Background(), response)
	servingLoop.handleResponse(context.Background(), response)
	select {
	case <-serving.restarted:
		t.Fatal("model_size_unknown must not relaunch a serving split runtime")
	case <-time.After(20 * time.Millisecond):
	}
}

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

	if !started || manager.State() != "starting" || !restartPending {
		t.Fatalf("expected profile restart initiation to mark runtime starting and pending, started=%v state=%q pending=%v", started, manager.State(), restartPending)
	}
	if metrics.LoadedModel != "" || metrics.LoadedProfileID != "" || metrics.LoadedProfileVersion != 0 {
		t.Fatalf("starting restart should not report the pending profile as loaded, got %#v", metrics)
	}
	if metrics.NodeState != "loading model pending-upstream" {
		t.Fatalf("starting restart should name the model being loaded, got %q", metrics.NodeState)
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
		profile := agent.ModelProfile{ID: "split-profile", UpstreamModel: "meshllm/model-layers", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "meshllm/model-layers", Split: true, BindPort: 4420}}
		cfg := agent.Config{RouterURL: router.server.URL, NodeToken: "node-token", Capacity: 1, RuntimeModel: profile.UpstreamModel, ActiveProfileIDs: []string{profile.ID}, Profiles: []agent.ModelProfile{profile}}
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

func TestREQRUN010RuntimeKindMismatchSelfHealsEachHeartbeat(t *testing.T) {
	// A transiently failed runtime switch must not wedge the node: ApplyDesiredProfiles
	// reports no restart for an unchanged set, so the agent reconciles the running
	// manager's kind against the selected profile on every heartbeat until they agree.
	profile := agent.ModelProfile{ID: "p1", UpstreamModel: "u1", Version: 1, Runtime: "llamacpp", LlamaCpp: agent.LlamaCppSettings{ModelRef: "u1", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "u1", ActiveProfileIDs: []string{"p1"}, Profiles: []agent.ModelProfile{profile}}
	counter := &agent.ActiveCounter{}
	// A busy drain plus a tiny restart budget makes each reconcile attempt fail fast and
	// observably (SetFailure) without reaching a real runtime launch.
	counter.Inc()
	manager := newFakeMeshRuntime(counter) // reports Runtime() == "meshllm": kind mismatch
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.loadState.Set(profile)
	loop.restartTimeout = time.Millisecond

	waitFailed := func(step string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if manager.State() == "failed" {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("%s: runtime kind mismatch did not trigger a reconcile restart", step)
	}
	unchanged := agent.HeartbeatResponse{OK: true, DesiredProfiles: []agent.ModelProfile{profile}}
	loop.handleResponse(context.Background(), unchanged)
	waitFailed("first heartbeat")
	// The reconcile retries on every later heartbeat, not only once.
	manager.SetState("ready")
	loop.handleResponse(context.Background(), unchanged)
	waitFailed("second heartbeat")
}
