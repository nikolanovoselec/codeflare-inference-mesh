// The vllm runtime's dispatch, keying, telemetry stamping, and crash semantics
// at the agent-command layer. REQ-RUN-024 / REQ-NODE-016.
package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func vllmTestProfile(id string) agent.ModelProfile {
	return agent.ModelProfile{
		ID:            id,
		UpstreamModel: "org/model",
		Version:       1,
		Runtime:       "vllm",
		Vllm:          agent.VllmSettings{HfRepo: "org/model", BindPort: 4400, ContextWindow: 8192},
	}
}

func TestREQRUN024VllmIsAManagedRuntimeKind(t *testing.T) {
	// "vllm" must resolve to itself, not fall through the legacy default to
	// mesh-llm: the fallback would launch a mesh process for a vLLM profile and
	// open its mesh-peer firewall port. REQ-RUN-024 / REQ-SEC-013.
	if got := effectiveRuntimeKind("vllm"); got != "vllm" {
		t.Fatalf("effectiveRuntimeKind(vllm) = %q, want vllm", got)
	}
	if got := effectiveRuntimeKind("legacy-kind"); got != "meshllm" {
		t.Fatalf("unknown kinds must still resolve to meshllm, got %q", got)
	}
	counter := &agent.ActiveCounter{}
	vllmManager := &fakeKindRuntime{fakeMeshRuntime: newFakeMeshRuntime(counter), kind: "vllm"}
	if !runtimeKindMismatch(vllmManager, agent.ModelProfile{Runtime: "meshllm"}) {
		t.Fatal("a vllm manager under a meshllm profile is a kind mismatch the reconciler must repair")
	}
	meshManager := &fakeKindRuntime{fakeMeshRuntime: newFakeMeshRuntime(counter), kind: "meshllm"}
	if !runtimeKindMismatch(meshManager, vllmTestProfile("kind-check")) {
		t.Fatal("a meshllm manager under a vllm profile is a kind mismatch the reconciler must repair")
	}
}

func TestREQRUN024ProfileKeyHashesVllmSettings(t *testing.T) {
	// The profile key decides restart-on-change; a vllm tunable edit that does
	// not alter the key would leave the runtime serving stale argv forever.
	base := vllmTestProfile("key-check")
	changed := base
	changed.Vllm.HfRepo = "org/other-model"
	if profileKey(base) == profileKey(changed) {
		t.Fatal("profiles differing only in vllm settings must produce different keys")
	}
	same := vllmTestProfile("key-check")
	if profileKey(base) != profileKey(same) {
		t.Fatal("identical vllm profiles must produce identical keys")
	}
}

func TestREQRUN010CrashedVllmRuntimeIsNotHotRelaunched(t *testing.T) {
	// vLLM exits its whole process on engine death (OOM watchdog). The reconciler
	// must not hot-relaunch the crashed runtime for the profile it already
	// loaded — that loop would re-OOM forever. Failed is sticky until an operator
	// acts; a profile content change still restarts. This pins the loadState-key
	// semantics the crash-loop-backoff decision rests on. REQ-RUN-010.
	counter := &agent.ActiveCounter{}
	manager := &fakeKindRuntime{fakeMeshRuntime: newFakeMeshRuntime(counter), kind: "vllm"}
	profile := vllmTestProfile("crash-check")
	cfg := agent.Config{RuntimeModel: "org/model", ActiveProfileIDs: []string{"crash-check"}, Profiles: []agent.ModelProfile{profile}}
	loadState := &runtimeLoadState{}
	loadState.Set(profile)
	manager.SetState("failed")

	var mu sync.Mutex
	pending := false
	if _, ok := beginRuntimeProfileRestart(cfg, manager, loadState, &mu, &pending); ok {
		t.Fatal("a crashed runtime for the already-loaded profile must stay down, not hot-relaunch")
	}

	// Operator recovery: a version bump (Force Reload / saved change) re-keys the
	// profile and must restart even from failed.
	bumped := profile
	bumped.Version = 2
	bumpedCfg := cfg
	bumpedCfg.Profiles = []agent.ModelProfile{bumped}
	if _, ok := beginRuntimeProfileRestart(bumpedCfg, manager, loadState, &mu, &pending); !ok {
		t.Fatal("a re-keyed profile must restart a failed runtime")
	}
}

func TestREQOBS003VllmVersionReportsInstalledNotDesired(t *testing.T) {
	// The console's desired-vs-installed comparison is only meaningful when the
	// reported version comes from the completed-install marker, never echoed
	// back from the desired config. REQ-OBS-003.
	dataDir := t.TempDir()
	versionDir := filepath.Join(dataDir, "runtimes", "vllm", "0.27.1")
	if err := os.MkdirAll(versionDir, 0o700); err != nil {
		t.Fatalf("create version dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(versionDir, ".install-complete"), []byte("0.27.1\n"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	if err := os.Symlink(versionDir, filepath.Join(dataDir, "runtimes", "vllm", "current")); err != nil {
		t.Fatalf("symlink current: %v", err)
	}
	manager := agent.NewVllmManager(vllmInput(vllmTestProfile("obs-check"), "/missing/vllm", dataDir))
	if got := manager.Metrics().VllmVersion; got != "0.27.1" {
		t.Fatalf("manager must report the marker-installed version, got %q", got)
	}
	// With 0.28.0 desired and 0.27.1 installed the heartbeat must still carry
	// the installed version, so the two can actually disagree mid-upgrade.
	loadState := &runtimeLoadState{}
	desired := runtimeMetrics(manager, loadState, agent.Config{RuntimeVersions: agent.RuntimeBinaryVersions{Vllm: "0.28.0"}}, 0, "")
	if desired.VllmVersion != "" {
		t.Fatalf("runtimeMetrics must not echo the desired vllm version, got %q", desired.VllmVersion)
	}
	if desired.MeshLLMVersion != "" || desired.LlamaCppVersion != "" {
		t.Fatalf("a vllm runtime must not stamp sibling runtime versions, got %+v", desired)
	}
	merged := agent.MergeRuntimeMetrics(desired, manager.Metrics())
	if merged.VllmVersion != "0.27.1" {
		t.Fatalf("heartbeat merge must carry the installed version, got %q", merged.VllmVersion)
	}
}

func TestREQNODE016CollectReportsObservedCapabilities(t *testing.T) {
	// The scheduler's capability gate fails closed on absent fields, so the agent
	// must report what it actually observed each tick: the platform it runs on
	// and whether CUDA is present — including an explicit false. REQ-NODE-016.
	counter := &agent.ActiveCounter{}
	manager := newFakeMeshRuntime(counter)
	profile := agent.ModelProfile{ID: "cap-check", UpstreamModel: "m", Version: 1, Runtime: "meshllm", MeshLLM: agent.MeshLLMSettings{ModelRef: "m", BindPort: 4300}}
	cfg := agent.Config{RuntimeModel: "m", ActiveProfileIDs: []string{"cap-check"}, Profiles: []agent.ModelProfile{profile}}
	loop := newLoopForTest(t, cfg, counter, manager, &fakeUpdater{}, nil)
	loop.goos = "linux"
	loop.cudaProbe = func() bool { return false }

	metrics, _ := loop.collect(context.Background(), cfg)
	if metrics.Platform != "linux" {
		t.Fatalf("platform = %q", metrics.Platform)
	}
	if metrics.CudaAvailable == nil || *metrics.CudaAvailable {
		t.Fatalf("an observed no-CUDA host must report cudaAvailable=false, got %v", metrics.CudaAvailable)
	}

	loop.cudaProbe = func() bool { return true }
	metrics, _ = loop.collect(context.Background(), cfg)
	if metrics.CudaAvailable == nil || !*metrics.CudaAvailable {
		t.Fatalf("an observed CUDA host must report cudaAvailable=true, got %v", metrics.CudaAvailable)
	}
}
