package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// --- fakes and fixtures ---------------------------------------------------

type eventLog struct {
	mu      sync.Mutex
	entries []string
}

func (l *eventLog) add(entry string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entry)
}

func (l *eventLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.entries...)
}

type fakeMeshProcess struct {
	mu           sync.Mutex
	signals      []os.Signal
	exitOnSignal bool
	exitOnce     sync.Once
	exitCh       chan struct{}
	exitErr      error
	events       *eventLog
}

func newFakeMeshProcess(events *eventLog) *fakeMeshProcess {
	return &fakeMeshProcess{exitCh: make(chan struct{}), events: events}
}

func (p *fakeMeshProcess) Signal(sig os.Signal) error {
	p.mu.Lock()
	p.signals = append(p.signals, sig)
	exitNow := p.exitOnSignal
	p.mu.Unlock()
	if p.events != nil {
		if sig == syscall.SIGTERM {
			p.events.add("sigterm")
		} else {
			p.events.add("signal:" + sig.String())
		}
	}
	if exitNow {
		p.exitNow(errors.New("signal: terminated"))
	}
	return nil
}

func (p *fakeMeshProcess) Kill() error {
	if p.events != nil {
		p.events.add("kill")
	}
	p.exitNow(errors.New("signal: killed"))
	return nil
}

func (p *fakeMeshProcess) Wait() error {
	<-p.exitCh
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitErr
}

func (p *fakeMeshProcess) exitNow(err error) {
	p.exitOnce.Do(func() {
		p.mu.Lock()
		p.exitErr = err
		p.mu.Unlock()
		close(p.exitCh)
	})
}

func (p *fakeMeshProcess) firstSignal() os.Signal {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.signals) == 0 {
		return nil
	}
	return p.signals[0]
}

type launchRecord struct {
	binary string
	args   []string
	env    []string
	proc   *fakeMeshProcess
}

type fakeLaunch struct {
	mu     sync.Mutex
	queue  []*fakeMeshProcess
	events *eventLog
	calls  []launchRecord
}

func (f *fakeLaunch) launcher() meshLauncher {
	return func(_ context.Context, binary string, args []string, env []string, _ io.Writer) (meshProcess, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var proc *fakeMeshProcess
		if len(f.queue) > 0 {
			proc = f.queue[0]
			f.queue = f.queue[1:]
		} else {
			proc = newFakeMeshProcess(f.events)
		}
		f.calls = append(f.calls, launchRecord{
			binary: binary,
			args:   append([]string(nil), args...),
			env:    append([]string(nil), env...),
			proc:   proc,
		})
		if f.events != nil {
			f.events.add("launch")
		}
		return proc, nil
	}
}

func (f *fakeLaunch) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeLaunch) record(index int) launchRecord {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[index]
}

type consoleFixture struct {
	mu     sync.Mutex
	status map[string]any
	hits   int
}

func (c *consoleFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.URL.Path != "/api/status" {
		http.NotFound(w, r)
		return
	}
	c.hits++
	_ = json.NewEncoder(w).Encode(c.status)
}

func (c *consoleFixture) set(status map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status = status
}

type modelsFixture struct {
	mu   sync.Mutex
	ids  []string
	hits int
}

func (f *modelsFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path != "/v1/models" {
		http.NotFound(w, r)
		return
	}
	f.hits++
	entries := make([]map[string]any, 0, len(f.ids))
	for _, id := range f.ids {
		entries = append(entries, map[string]any{"id": id, "object": "model"})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": entries})
}

func (f *modelsFixture) setIDs(ids []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ids = append([]string(nil), ids...)
}

func (f *modelsFixture) hitCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits
}

// statusPayload builds a console /api/status body in the upstream wire shape
// (node_id/node_state/mesh_id/token/serving_models/peers/runtime.stages).
func statusPayload(nodeState string, meshID string, token string) map[string]any {
	return map[string]any{
		"node_id":           "node-1",
		"node_state":        nodeState,
		"mesh_id":           meshID,
		"token":             token,
		"version":           "0.72.2",
		"serving_models":    []string{},
		"models":            []string{},
		"peers":             []map[string]any{},
		"runtime":           map[string]any{"stages": []any{}},
		"tok_per_sec":       0.0,
		"inflight_requests": 0,
	}
}

func serverPort(t *testing.T, server *httptest.Server) int {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func writeFakeMeshBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mesh-llm")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

type managerFixture struct {
	manager *MeshLLMManager
	launch  *fakeLaunch
	events  *eventLog
}

func newMeshManagerForTest(t *testing.T, in MeshLLMRenderInput, contextWindow int) *managerFixture {
	t.Helper()
	events := &eventLog{}
	launch := &fakeLaunch{events: events}
	if in.ProfileID == "" {
		in.ProfileID = "prof"
	}
	if in.ModelRef == "" {
		in.ModelRef = "target-model"
	}
	if in.Rotation == 0 {
		in.Rotation = 1
	}
	manager := NewMeshLLMManager(in, contextWindow, t.TempDir(), writeFakeMeshBinary(t))
	manager.launch = launch.launcher()
	manager.pollInterval = 10 * time.Millisecond
	manager.readinessTimeout = 30 * time.Second
	manager.stopGrace = 40 * time.Millisecond
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = manager.Stop(ctx)
	})
	return &managerFixture{manager: manager, launch: launch, events: events}
}

func waitForManagerState(t *testing.T, manager *MeshLLMManager, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if manager.State() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("manager state = %q, want %q (lastError %q)", manager.State(), want, manager.LastError())
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func envContains(env []string, pair string) bool {
	for _, entry := range env {
		if entry == pair {
			return true
		}
	}
	return false
}

func flagValues(args []string, flag string) []string {
	values := []string{}
	for index := 0; index < len(args)-1; index++ {
		if args[index] == flag {
			values = append(values, args[index+1])
		}
	}
	return values
}

func equalStrings(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

// --- REQ-RUN-003 -----------------------------------------------------------

func TestREQRUN010RuntimeEnvInheritsServiceEnvAndDisablesSelfUpdate(t *testing.T) {
	t.Run("REQ-RUN-010", func(t *testing.T) {
		t.Setenv("MESHLLM_MANAGER_TEST_MARKER", "inherited-value")
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if fixture.launch.count() != 1 {
			t.Fatalf("expected one launch, got %d", fixture.launch.count())
		}
		env := fixture.launch.record(0).env
		if !envContains(env, "MESHLLM_MANAGER_TEST_MARKER=inherited-value") {
			t.Fatalf("runtime env should inherit the service environment, got %d entries without the marker", len(env))
		}
		if !envContains(env, "MESH_LLM_NO_SELF_UPDATE=1") {
			t.Fatal("runtime env should always set MESH_LLM_NO_SELF_UPDATE=1")
		}
	})
}

func TestREQRUN010StopSendsSIGTERMBeforeKill(t *testing.T) {
	t.Run("REQ-RUN-010", func(t *testing.T) {
		t.Run("escalates to kill only after the grace period", func(t *testing.T) {
			fixture := newMeshManagerForTest(t, MeshLLMRenderInput{}, 0)
			if err := fixture.manager.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			proc := fixture.launch.record(0).proc
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := fixture.manager.Stop(ctx); err != nil {
				t.Fatal(err)
			}
			if got := proc.firstSignal(); got != syscall.SIGTERM {
				t.Fatalf("first signal = %v, want SIGTERM", got)
			}
			if events := fixture.events.snapshot(); !equalStrings(events, []string{"launch", "sigterm", "kill"}) {
				t.Fatalf("stop escalation order = %v, want [launch sigterm kill]", events)
			}
			if state := fixture.manager.State(); state != "stopped" {
				t.Fatalf("state after stop = %q, want stopped", state)
			}
		})
		t.Run("does not kill a process that exits within the grace period", func(t *testing.T) {
			fixture := newMeshManagerForTest(t, MeshLLMRenderInput{}, 0)
			cooperative := newFakeMeshProcess(fixture.events)
			cooperative.exitOnSignal = true
			fixture.launch.queue = []*fakeMeshProcess{cooperative}
			if err := fixture.manager.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := fixture.manager.Stop(ctx); err != nil {
				t.Fatal(err)
			}
			if events := fixture.events.snapshot(); !equalStrings(events, []string{"launch", "sigterm"}) {
				t.Fatalf("graceful stop events = %v, want [launch sigterm]", events)
			}
			if state := fixture.manager.State(); state != "stopped" {
				t.Fatalf("state after graceful stop = %q, want stopped", state)
			}
		})
	})
}

func TestREQRUN010MissingBinaryReportsDependencyMissing(t *testing.T) {
	t.Run("REQ-RUN-010", func(t *testing.T) {
		launch := &fakeLaunch{}
		manager := NewMeshLLMManager(MeshLLMRenderInput{ProfileID: "prof", ModelRef: "target-model", Rotation: 1}, 0, t.TempDir(), "definitely-missing-mesh-llm-for-test")
		manager.launch = launch.launcher()
		err := manager.Start(context.Background())
		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("start error = %v, want ErrRuntimeDependencyMissing", err)
		}
		if state := manager.State(); state != "dependency-missing" {
			t.Fatalf("state = %q, want dependency-missing", state)
		}
		if last := manager.LastError(); !strings.Contains(last, "definitely-missing-mesh-llm-for-test") {
			t.Fatalf("last error should name the missing binary, got %q", last)
		}
		if launch.count() != 0 {
			t.Fatalf("missing binary must not attempt an exec, got %d launches", launch.count())
		}
	})
}

func TestREQRUN003StartWritesContextConfigTOML(t *testing.T) {
	t.Run("REQ-RUN-003", func(t *testing.T) {
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{ProfileID: "prof-ctx", ModelRef: "target-model"}, 4096)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(fixture.manager.dataDir, "meshllm-prof-ctx.toml")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("expected context config file at %s: %v", path, err)
		}
		if want := MeshLLMConfigTOML(MeshLLMRenderInput{ModelRef: "target-model"}, 4096); string(data) != want || len(data) == 0 {
			t.Fatalf("config file content = %q, want rendered MeshLLMConfigTOML output", string(data))
		}

		zero := newMeshManagerForTest(t, MeshLLMRenderInput{ProfileID: "prof-zero", ModelRef: "target-model"}, 0)
		if err := zero.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		zeroPath := filepath.Join(zero.manager.dataDir, "meshllm-prof-zero.toml")
		if _, err := os.Stat(zeroPath); !os.IsNotExist(err) {
			t.Fatalf("context window 0 must not write a config file, stat err = %v", err)
		}
	})
}

// --- REQ-RUN-005 -----------------------------------------------------------

func TestREQRUN005ReadinessRequiresUpstreamModelInOwnModels(t *testing.T) {
	t.Run("REQ-RUN-005", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("serving", "mesh-1", "tok-1")}
		consoleServer := httptest.NewServer(console)
		defer consoleServer.Close()
		models := &modelsFixture{ids: []string{"other-model"}}
		modelsServer := httptest.NewServer(models)
		defer modelsServer.Close()

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
		}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "three /v1/models polls", func() bool { return models.hitCount() >= 3 })
		if state := fixture.manager.State(); state == "ready" {
			t.Fatal("a 2xx /v1/models response without the upstream model id must not be ready")
		}

		models.setIDs([]string{"other-model", "target-model"})
		waitForManagerState(t, fixture.manager, "ready")
	})
}

func TestREQRUN005LoadingStateExtendsReadinessDeadline(t *testing.T) {
	t.Run("REQ-RUN-005", func(t *testing.T) {
		t.Run("loading keeps the runtime alive past the original deadline", func(t *testing.T) {
			console := &consoleFixture{status: statusPayload("loading", "", "")}
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
			fixture.manager.readinessTimeout = 120 * time.Millisecond
			if err := fixture.manager.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			waitForManagerState(t, fixture.manager, "downloading")
			time.Sleep(360 * time.Millisecond)
			if state := fixture.manager.State(); state == "failed" {
				t.Fatalf("loading must extend the readiness deadline, got failed (lastError %q)", fixture.manager.LastError())
			}

			console.set(statusPayload("serving", "mesh-1", "tok-1"))
			models.setIDs([]string{"target-model"})
			waitForManagerState(t, fixture.manager, "ready")
		})
		t.Run("without loading progress the deadline still fails the runtime", func(t *testing.T) {
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
			fixture.manager.readinessTimeout = 120 * time.Millisecond
			if err := fixture.manager.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			waitForManagerState(t, fixture.manager, "failed")
			if last := fixture.manager.LastError(); !strings.Contains(last, "deadline") {
				t.Fatalf("deadline failure should be reported, got %q", last)
			}
			if !fixture.manager.NeedsRestart(&MeshBootstrap{Action: "create"}) {
				t.Fatal("readiness deadline failure must self-heal by requesting a restart on the next heartbeat")
			}
		})
	})
}

func TestREQRUN005MeshLLMReadinessFailsWhenProcessExits(t *testing.T) {
	t.Run("REQ-RUN-005", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("serving", "mesh-1", "tok-1")}
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
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		fixture.launch.record(0).proc.exitNow(errors.New("exit status 1"))
		waitForManagerState(t, fixture.manager, "failed")
		if last := fixture.manager.LastError(); !strings.Contains(last, "exited before readiness") {
			t.Fatalf("exit before readiness should be reported, got %q", last)
		}
	})
}

// --- REQ-RUN-006 -----------------------------------------------------------

func TestREQRUN006WaitDefersLaunchAndJoinRendersTokens(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{}, 0)
		fixture.manager.ApplyBootstrap(&MeshBootstrap{Action: "wait", Rotation: 1})
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if state := fixture.manager.State(); state != "starting" {
			t.Fatalf("wait action should report starting, got %q", state)
		}
		if fixture.launch.count() != 0 {
			t.Fatalf("wait action must not launch mesh-llm, got %d launches", fixture.launch.count())
		}

		fixture.manager.ApplyBootstrap(&MeshBootstrap{Action: "join", Rotation: 1, MeshID: "mesh-1", JoinTokens: []string{"tokA", "tokB"}})
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if fixture.launch.count() != 1 {
			t.Fatalf("join action should launch mesh-llm once, got %d launches", fixture.launch.count())
		}
		joins := flagValues(fixture.launch.record(0).args, "--join")
		if !equalStrings(joins, []string{"tokA", "tokB"}) {
			t.Fatalf("join argv tokens = %v, want [tokA tokB]", joins)
		}
	})
}

func TestREQRUN006TokenlessStartupRestartsWhenJoinArrivesBeforeMeshID(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{ProfileID: "prof", ModelRef: "target-model", Rotation: 1}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if fixture.launch.count() != 1 {
			t.Fatalf("initial tokenless launch count = %d, want 1", fixture.launch.count())
		}
		if meshID := fixture.manager.CurrentMeshID(); meshID != "" {
			t.Fatalf("fresh tokenless launch must not have captured a mesh id yet, got %q", meshID)
		}

		bootstrap := &MeshBootstrap{Action: "join", Rotation: 1, MeshID: "mesh-1", JoinTokens: []string{"tokA"}}
		if !fixture.manager.NeedsRestart(bootstrap) {
			t.Fatal("tokenless startup must restart when the router later returns a join token before any mesh id is captured")
		}
	})
}

func TestREQRUN006RestartTriggersDrainAndRelaunch(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("serving", "mesh-1", "tok-1")}
		consoleServer := httptest.NewServer(console)
		defer consoleServer.Close()
		models := &modelsFixture{ids: []string{"target-model"}}
		modelsServer := httptest.NewServer(models)
		defer modelsServer.Close()

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ProfileID:   "prof",
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
			Rotation:    1,
		}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		waitForManagerState(t, fixture.manager, "ready")
		waitFor(t, "mesh id capture from console", func() bool { return fixture.manager.CurrentMeshID() == "mesh-1" })
		if rotation := fixture.manager.Rotation(); rotation != 1 {
			t.Fatalf("running rotation = %d, want 1", rotation)
		}

		cases := []struct {
			name      string
			bootstrap *MeshBootstrap
			want      bool
		}{
			{"nil bootstrap", nil, false},
			{"no change", &MeshBootstrap{Action: "join", Rotation: 1, MeshID: "mesh-1", JoinTokens: []string{"tok-1"}}, false},
			{"rotation bump", &MeshBootstrap{Action: "join", Rotation: 2, MeshID: "mesh-1", JoinTokens: []string{"tok-1"}}, true},
			{"foreign mesh id with join tokens", &MeshBootstrap{Action: "join", Rotation: 1, MeshID: "mesh-2", JoinTokens: []string{"tokX"}}, true},
			{"foreign mesh id without join tokens", &MeshBootstrap{Action: "join", Rotation: 1, MeshID: "mesh-2"}, false},
			{"steady-state create heartbeat to the already-running creator does not restart", &MeshBootstrap{Action: "create", Rotation: 1}, false},
		}
		for _, testCase := range cases {
			if got := fixture.manager.NeedsRestart(testCase.bootstrap); got != testCase.want {
				t.Fatalf("NeedsRestart(%s) = %v, want %v", testCase.name, got, testCase.want)
			}
		}

		idle := NewMeshLLMManager(MeshLLMRenderInput{ProfileID: "idle", ModelRef: "target-model", Rotation: 1}, 0, t.TempDir(), writeFakeMeshBinary(t))
		if idle.NeedsRestart(&MeshBootstrap{Action: "join", Rotation: 5, JoinTokens: []string{"tokX"}}) {
			t.Fatal("NeedsRestart must be false when no runtime is running")
		}

		// A process launched as a joiner (join tokens present) that is promoted to seed
		// (action "create") at the same rotation must restart to become the creator; only
		// the steady-state creator-getting-create case above is a no-op.
		joiner := newMeshManagerForTest(t, MeshLLMRenderInput{
			ProfileID:   "prof-joiner",
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
			Rotation:    1,
			JoinTokens:  []string{"tok-1"},
		}, 0)
		if err := joiner.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		waitForManagerState(t, joiner.manager, "ready")
		if !joiner.manager.NeedsRestart(&MeshBootstrap{Action: "create", Rotation: 1}) {
			t.Fatal("a joiner promoted to create (seed) must restart to become the creator")
		}

		fixture.manager.ApplyBootstrap(&MeshBootstrap{Action: "join", Rotation: 2, MeshID: "mesh-2", JoinTokens: []string{"tokX"}})
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := fixture.manager.Restart(ctx); err != nil {
			t.Fatal(err)
		}
		if fixture.launch.count() != 2 {
			t.Fatalf("restart should relaunch, got %d launches", fixture.launch.count())
		}
		events := fixture.events.snapshot()
		if !equalStrings(events, []string{"launch", "sigterm", "kill", "launch"}) {
			t.Fatalf("restart must stop the old process before relaunching, got %v", events)
		}
		relaunch := fixture.launch.record(1).args
		if names := flagValues(relaunch, "--mesh-name"); !equalStrings(names, []string{"codeflare-prof-r2"}) {
			t.Fatalf("relaunch mesh name = %v, want [codeflare-prof-r2] (rotation baked into identity)", names)
		}
		if joins := flagValues(relaunch, "--join"); !equalStrings(joins, []string{"tokX"}) {
			t.Fatalf("relaunch join tokens = %v, want [tokX]", joins)
		}
		if rotation := fixture.manager.Rotation(); rotation != 2 {
			t.Fatalf("rotation after relaunch = %d, want 2", rotation)
		}
	})
}

func TestREQRUN006PollStatusCapturesTokenAndMeshID(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		console := &consoleFixture{status: statusPayload("serving", "mesh-xyz", "tok-abc")}
		consoleServer := httptest.NewServer(console)
		models := &modelsFixture{ids: []string{"target-model"}}
		modelsServer := httptest.NewServer(models)

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ModelRef:    "target-model",
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
		}, 0)
		status, reachable := fixture.manager.PollStatus(context.Background())
		if !reachable {
			t.Fatal("console should be reachable")
		}
		if status.Token != "tok-abc" || status.MeshID != "mesh-xyz" {
			t.Fatalf("parsed status token/meshId = %q/%q, want tok-abc/mesh-xyz", status.Token, status.MeshID)
		}
		if fixture.manager.CurrentToken() != "tok-abc" {
			t.Fatalf("CurrentToken = %q, want tok-abc", fixture.manager.CurrentToken())
		}
		if fixture.manager.CurrentMeshID() != "mesh-xyz" {
			t.Fatalf("CurrentMeshID = %q, want mesh-xyz", fixture.manager.CurrentMeshID())
		}
		if ready := fixture.manager.ReadyModels(); !equalStrings(ready, []string{"target-model"}) {
			t.Fatalf("ReadyModels = %v, want [target-model]", ready)
		}

		consoleServer.Close()
		modelsServer.Close()
		_, reachable = fixture.manager.PollStatus(context.Background())
		if reachable {
			t.Fatal("closed console must report unreachable")
		}
		if fixture.manager.CurrentToken() != "tok-abc" || fixture.manager.CurrentMeshID() != "mesh-xyz" {
			t.Fatal("last-known token and mesh id must be retained across a failed poll")
		}
		if ready := fixture.manager.ReadyModels(); len(ready) != 0 {
			t.Fatalf("ready models must fail closed when the API is unreachable, got %v", ready)
		}
	})
}

func TestREQRUN006PollStatusClearsStaleMeshIDWhenConsoleReportsNone(t *testing.T) {
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
			t.Fatal("console should be reachable")
		}
		if fixture.manager.CurrentMeshID() != "mesh-xyz" {
			t.Fatalf("CurrentMeshID = %q, want mesh-xyz", fixture.manager.CurrentMeshID())
		}

		// A fresh mesh-llm process reports it holds no mesh yet: the console mesh_id is null.
		// The manager must clear the stale id rather than keep replaying mesh-xyz to the router.
		console.set(statusPayload("loading", "", "tok-abc"))
		if _, reachable := fixture.manager.PollStatus(context.Background()); !reachable {
			t.Fatal("console should still be reachable")
		}
		if fixture.manager.CurrentMeshID() != "" {
			t.Fatalf("CurrentMeshID = %q, want empty after the console reports a null mesh id", fixture.manager.CurrentMeshID())
		}
	})
}

func TestREQRUN006StartClearsStaleMeshIdentity(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{ModelRef: "target-model"}, 0)
		// A prior process left a mesh identity behind. Launching a new process must clear it so
		// the router is not sent, and NeedsRestart does not trip on, a mesh the runtime dropped.
		fixture.manager.mu.Lock()
		fixture.manager.meshID = "stale-mesh"
		fixture.manager.token = "stale-token"
		fixture.manager.readyModels = []string{"stale-model"}
		fixture.manager.apiReady = true
		fixture.manager.mu.Unlock()

		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if got := fixture.manager.CurrentMeshID(); got != "" {
			t.Fatalf("CurrentMeshID = %q, want empty after launching a new process", got)
		}
		if got := fixture.manager.CurrentToken(); got != "" {
			t.Fatalf("CurrentToken = %q, want empty after launching a new process", got)
		}
		if fixture.manager.APIReady() {
			t.Fatal("APIReady must reset to false on a new process launch")
		}
	})
}

func TestREQRUN006SingleProcessSelectsFirstActiveProfile(t *testing.T) {
	t.Run("REQ-RUN-006", func(t *testing.T) {
		first := ModelProfile{ID: "p1", UpstreamModel: "model-1", Runtime: "meshllm", Active: true, MeshLLM: MeshLLMSettings{ModelRef: "model-1", BindPort: 4300}}
		second := ModelProfile{ID: "p2", UpstreamModel: "model-2", Runtime: "meshllm", Active: true, MeshLLM: MeshLLMSettings{ModelRef: "model-2", BindPort: 4310}}
		cfg := Config{ActiveProfileIDs: []string{"p1", "p2"}, Profiles: []ModelProfile{second, first}}
		selected, ok := SelectedProfile(cfg)
		if !ok || selected.ID != "p1" {
			t.Fatalf("SelectedProfile = %q ok=%v, want first active profile p1", selected.ID, ok)
		}

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{ProfileID: "p1", ModelRef: "model-1"}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if fixture.launch.count() != 1 {
			t.Fatalf("agent must run at most one mesh-llm process, got %d launches", fixture.launch.count())
		}
	})
}

// --- REQ-RUN-007 -----------------------------------------------------------

func TestREQRUN007SplitReadinessGatedOnFullModelId(t *testing.T) {
	t.Run("REQ-RUN-007", func(t *testing.T) {
		layerPackage := "hf://meshllm/qwen-layers@rev1"
		console := &consoleFixture{status: statusPayload("serving", "mesh-1", "tok-1")}
		consoleServer := httptest.NewServer(console)
		defer consoleServer.Close()
		models := &modelsFixture{}
		modelsServer := httptest.NewServer(models)
		defer modelsServer.Close()

		fixture := newMeshManagerForTest(t, MeshLLMRenderInput{
			ModelRef:    layerPackage,
			Split:       true,
			APIPort:     serverPort(t, modelsServer),
			ConsolePort: serverPort(t, consoleServer),
		}, 0)
		if err := fixture.manager.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "three /v1/models polls", func() bool { return models.hitCount() >= 3 })
		if state := fixture.manager.State(); state == "ready" {
			t.Fatal("split profile must not be ready until the full model id is listed")
		}

		models.setIDs([]string{layerPackage})
		waitForManagerState(t, fixture.manager, "ready")
	})
}
