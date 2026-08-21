// Fakes and recorders the agent-command tests drive the service loop with.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

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
	restarted        chan struct{}
	restartBlock     bool
	runtimeDetail    string
	maxVramGb        float64
	splitReadiness   agent.MeshLLMSplitReadiness
	splitReadinessOK bool
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

func (f *fakeMeshRuntime) setRestartBlock(v bool) {
	f.mu.Lock()
	f.restartBlock = v
	f.mu.Unlock()
}

func (f *fakeMeshRuntime) blocksRestart() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.restartBlock
}

func (f *fakeMeshRuntime) Start(context.Context) error { f.record("start"); return nil }

func (f *fakeMeshRuntime) Stop(context.Context) error { f.record("stop"); return nil }

func (f *fakeMeshRuntime) Runtime() string { return "meshllm" }

func (f *fakeMeshRuntime) TargetURL() string { return "http://127.0.0.1:9337" }

func (f *fakeMeshRuntime) MaxVramGb() float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxVramGb
}

func (f *fakeMeshRuntime) PollSplitReadiness(context.Context, string) (agent.MeshLLMSplitReadiness, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.splitReadiness, f.splitReadinessOK
}

func (f *fakeMeshRuntime) Restart(context.Context) error {
	f.recordRestart(nil)
	return nil
}

func (f *fakeMeshRuntime) RestartWithInput(ctx context.Context, in agent.MeshLLMRenderInput, _ int) error {
	if f.blocksRestart() {
		<-ctx.Done()
		return ctx.Err()
	}
	f.recordRestart(&in)
	return nil
}

func (f *fakeMeshRuntime) PollStatus(context.Context) (agent.MeshLLMStatus, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status, f.consoleOK
}

func (f *fakeMeshRuntime) Inflight(context.Context) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.consoleOK {
		return 0
	}
	return f.status.InflightRequests
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

func (f *fakeMeshRuntime) RuntimeErrorDetail() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runtimeDetail
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

// fakeKindRuntime reports an arbitrary runtime kind over the mesh fake, for
// exercising how the reconciler resolves unmanaged kind strings.
type fakeKindRuntime struct {
	*fakeMeshRuntime
	kind string
}

func (f *fakeKindRuntime) Runtime() string { return f.kind }

// fakeSeamlessRuntime hides the embedded fake's RestartWithInput behind an
// incompatible signature, yielding a RuntimeManager that satisfies neither
// restart seam (not *agent.MeshLLMManager, not meshInputRestarter).
type fakeSeamlessRuntime struct{ *fakeMeshRuntime }

func (f *fakeSeamlessRuntime) RestartWithInput() {}

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

func newLoopForTest(t *testing.T, cfg agent.Config, counter *agent.ActiveCounter, manager agent.RuntimeManager, updater agentUpdater, exit func()) *serviceLoop {
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
