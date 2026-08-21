// The service loop itself: what it holds, how the manager is swapped under it, and one tick.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

// meshRuntime is what the service loop needs from the MeshLLM manager; tests
// substitute a fake.
type runtimeTargetFunc func() string

func (f runtimeTargetFunc) TargetURL() string { return f() }

type splitReadinessPoller interface {
	PollSplitReadiness(ctx context.Context, modelRef string) (agent.MeshLLMSplitReadiness, bool)
}

type meshRuntimeBudgetReporter interface {
	MaxVramGb() float64
}

type meshRuntime interface {
	agent.RuntimeController
	Runtime() string
	TargetURL() string
	PollStatus(ctx context.Context) (agent.MeshLLMStatus, bool)
	ApplyBootstrap(bootstrap *agent.MeshBootstrap)
	NeedsRestart(bootstrap *agent.MeshBootstrap) bool
	CurrentToken() string
	CurrentMeshID() string
	ReadyModels() []string
	APIReady() bool
	State() string
	LastError() string
	RuntimeErrorDetail() string
	SetState(state string)
	SetFailure(err error)
	RestartWithInput(ctx context.Context, in agent.MeshLLMRenderInput, contextWindow int) error
}

// agentUpdater is the self-update seam; the real implementation is
// agent.SelfUpdater.
type agentUpdater interface {
	Maybe(desired string, now time.Time) (bool, error)
}

// serviceLoop owns the per-tick heartbeat pipeline: one console/API poll,
// metrics assembly, the heartbeat exchange, desired-profile and mesh
// bootstrap reconciliation, and the router-driven self-update.
type serviceLoop struct {
	configPath string
	stateMu    *sync.RWMutex
	cfg        *agent.Config
	// manager is the CURRENT runtime manager. Runtime-mode switches replace it, so
	// every consumer (dashboard, proxy, controls, shutdown) must go through
	// currentManager()/setManager — a startup-captured copy goes stale and reports
	// runtimeState=stopped while the live runtime serves traffic. REQ-OBS-008.
	manager   meshRuntime
	managerMu sync.RWMutex
	loadState *runtimeLoadState
	telemetry      *runtimeTelemetry
	activeRequests *agent.ActiveCounter
	updater        agentUpdater
	exit           func()
	agentVersion   string
	installError   string
	drainTimeout    time.Duration
	restartTimeout  time.Duration
	gpuProbeTimeout time.Duration
	cmdRunner      agent.CommandRunner
	goos           string
	warpIface      string
	deactivated    bool

	restartMu      sync.Mutex
	restartPending bool
	updateMu       sync.Mutex
	updateError    string

	// A failing heartbeat is the node's lifeline going dark: it is recorded for the
	// local dashboard and logged to errLog on every change, never swallowed. errLog
	// defaults to os.Stderr; tests inject a buffer.
	heartbeatErrMu     sync.Mutex
	lastHeartbeatError string
	errLog             io.Writer

	lastReloadNonce string
	lastMetrics     agent.NodeMetrics

	meshWaitSelfHealKey   string
	meshWaitSelfHealTicks int
	meshWaitSelfHealDone  bool
}

func heartbeatLoop(ctx context.Context, loop *serviceLoop) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			loop.tick(ctx)
		}
	}
}

func (s *serviceLoop) currentConfig() agent.Config {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	return *s.cfg
}

func (s *serviceLoop) currentManager() meshRuntime {
	s.managerMu.RLock()
	defer s.managerMu.RUnlock()
	return s.manager
}

// managerSnapshot reads the manager and its install error under one lock
// acquisition, so a concurrent setManager can never pair a new manager with a
// stale install error inside a single status read.
func (s *serviceLoop) managerSnapshot() (meshRuntime, string) {
	s.managerMu.RLock()
	defer s.managerMu.RUnlock()
	return s.manager, s.installError
}

// setManager swaps in a replacement runtime manager (and the install error from its
// launch) so dashboard, proxy, controls, and shutdown all follow the switch.
func (s *serviceLoop) setManager(manager meshRuntime, installError string) {
	// Start request accounting for the replacement runtime. Any old handler keeps
	// its prior generation, so a late completion cannot alter this count
	// (REQ-NODE-015).
	s.activeRequests.Reset()
	s.managerMu.Lock()
	s.manager = manager
	s.installError = installError
	s.managerMu.Unlock()
}

// dashboardStatus assembles the local dashboard snapshot from the CURRENT manager
// and config, never a startup capture. REQ-NODE-004 / REQ-OBS-008.
func (s *serviceLoop) dashboardStatus(version string) agent.DashboardStatus {
	current := s.currentConfig()
	manager, installError := s.managerSnapshot()
	metrics := s.telemetry.Snapshot(runtimeMetrics(manager, s.loadState, current, s.activeRequests.Value(), installError))
	return agent.DashboardStatus{Config: current, Metrics: metrics, RuntimeState: metrics.RuntimeState, Version: version, LastHeartbeatError: s.currentHeartbeatError()}
}

// currentRuntimeController dispatches dashboard runtime controls to the manager that
// is live NOW, so Start/Stop/Restart keep working after a runtime-mode switch.
type currentRuntimeController struct{ loop *serviceLoop }

func (c *currentRuntimeController) Start(ctx context.Context) error {
	if m := c.loop.currentManager(); m != nil {
		return m.Start(ctx)
	}
	return nil
}

func (c *currentRuntimeController) Stop(ctx context.Context) error {
	if m := c.loop.currentManager(); m != nil {
		return m.Stop(ctx)
	}
	return nil
}

func (c *currentRuntimeController) Restart(ctx context.Context) error {
	if m := c.loop.currentManager(); m != nil {
		return m.Restart(ctx)
	}
	return nil
}

func (s *serviceLoop) tick(ctx context.Context) {
	current := s.currentConfig()
	metrics, identity := s.collect(ctx, current)
	client := agent.Client{RouterURL: current.RouterURL, HTTPClient: &http.Client{Timeout: 15 * time.Second}}
	response, err := client.Heartbeat(ctx, current.NodeToken, agent.HeartbeatFromConfig(current, metrics, s.activeRequests.Value(), identity))
	if err != nil {
		s.recordHeartbeatError(err.Error())
		return
	}
	s.recordHeartbeatError("")
	s.handleResponse(ctx, response)
}

// recordHeartbeatError keeps the latest heartbeat failure for the local dashboard and
// logs each state CHANGE (fail, different failure, recovery) once — a rejected node
// must be diagnosable from its own host without guessing. Steady states stay quiet.
func (s *serviceLoop) recordHeartbeatError(message string) {
	s.heartbeatErrMu.Lock()
	previous := s.lastHeartbeatError
	s.lastHeartbeatError = message
	log := s.errLog
	s.heartbeatErrMu.Unlock()
	if log == nil {
		log = os.Stderr
	}
	if message == previous {
		return
	}
	if message != "" {
		fmt.Fprintf(log, "heartbeat failed: %s\n", message)
	} else if previous != "" {
		fmt.Fprintln(log, "heartbeat recovered")
	}
}

func (s *serviceLoop) currentHeartbeatError() string {
	s.heartbeatErrMu.Lock()
	defer s.heartbeatErrMu.Unlock()
	return s.lastHeartbeatError
}

// execCommandRunner is the production agent.CommandRunner: it shells out to the
// host GPU tool. Tests inject a fake runner instead.
func execCommandRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}
