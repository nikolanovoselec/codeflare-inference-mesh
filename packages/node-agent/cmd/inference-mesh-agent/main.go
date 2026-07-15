package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

var version = "dev"

// agentReleaseRepo is the GitHub repository whose releases carry the agent
// artifacts the self-updater downloads.
const agentReleaseRepo = "nikolanovoselec/codeflare-inference-mesh"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "install" {
		runInstall(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "run" {
		if err := runService(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	fmt.Println("usage: inference-mesh-agent [version|install|run]")
}

func runInstall(args []string) {
	if configPath := configPathFromArgs(args); configPath != "" {
		_ = os.Setenv("INFERENCE_MESH_CONFIG", configPath)
	}
	cfg := agent.DefaultConfig(defaultDataDir())
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--router":
			if i+1 < len(args) {
				cfg.RouterURL = args[i+1]
				i++
			}
		case "--setup-token":
			if i+1 < len(args) {
				cfg.SetupToken = args[i+1]
				i++
			}
		case "--data-dir":
			if i+1 < len(args) {
				cfg.DataDir = args[i+1]
				i++
			}
		}
	}
	if cfg.ListenAddress == "" {
		cfg.ListenAddress = agent.ListenerAddress(cfg.MeshIP, cfg.InferencePort, cfg.AllowAllInterfaces)
	}
	path := agent.ConfigPath()
	if err := agent.SaveConfig(path, cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	plan := agent.ServiceInstallPlan(os.Args[0], path, "")
	_ = json.NewEncoder(os.Stdout).Encode(plan)
}

func runService(args []string) error {
	if configPath := configPathFromArgs(args); configPath != "" {
		_ = os.Setenv("INFERENCE_MESH_CONFIG", configPath)
	}
	cfg, err := agent.LoadConfig(agent.ConfigPath())
	if err != nil {
		return err
	}
	serviceCtx, stopService := signal.NotifyContext(context.Background(), serviceSignals()...)
	defer stopService()
	activeRequests := &agent.ActiveCounter{}
	if next, _, err := agent.ApplyDetectedMeshIP(cfg, agent.ConfigPath(), agent.DetectHostMeshIP); err != nil {
		return err
	} else {
		cfg = next
	}
	if err := agent.RequireMeshIP(cfg); err != nil {
		return err
	}
	// WARP is up and the mesh port is known here, so provision the inbound firewall
	// rule best-effort: a default-deny host firewall would otherwise silently drop
	// the router's requests (the original handshake-timeout symptom). Never fatal.
	warpIface, _ := agent.DetectWARPInterfaceName()
	if err := agent.EnsureInboundRule(serviceCtx, execCommandRunner, runtime.GOOS, warpIface, cfg.InferencePort, "tcp"); err != nil {
		fmt.Fprintf(os.Stderr, "mesh inbound firewall rule not provisioned (allow inbound TCP %d on the WARP interface manually): %v\n", cfg.InferencePort, err)
	}
	var claimBootstrap *agent.MeshBootstrap
	if cfg.SetupToken != "" && cfg.NodeToken == "" {
		claimClient := agent.Client{RouterURL: cfg.RouterURL}
		claim, err := claimClient.Claim(serviceCtx, cfg.SetupToken, agent.ClaimRequest{DisplayName: cfg.DisplayName, MeshIP: cfg.MeshIP, InferencePort: cfg.InferencePort, PublicModels: cfg.PublicModels, ActiveProfileIDs: cfg.ActiveProfileIDs, Capacity: cfg.Capacity})
		if err != nil {
			return err
		}
		next, err := agent.ApplyClaim(cfg, claim, agent.ConfigPath())
		if err != nil {
			return err
		}
		cfg = next
		claimBootstrap = claim.MeshBootstrap
	}
	loadState := &runtimeLoadState{}
	var stateMu sync.RWMutex
	telemetry := &runtimeTelemetry{}
	loop := &serviceLoop{
		configPath:     agent.ConfigPath(),
		stateMu:        &stateMu,
		cfg:            &cfg,
		loadState:      loadState,
		telemetry:      telemetry,
		activeRequests: activeRequests,
		updater:        agent.NewSelfUpdater(version, agentReleaseRepo, cfg.DataDir),
		exit: func() {
			os.Exit(0)
		},
		agentVersion:   version,
		drainTimeout:   2 * time.Minute,
		restartTimeout: defaultRestartTimeout,
		cmdRunner:      execCommandRunner,
		goos:           runtime.GOOS,
		warpIface:      warpIface,
	}
	// Runtime switches replace loop.manager, so shutdown must stop whatever manager
	// is CURRENT then — a startup capture would stop a long-dead process. REQ-OBS-008.
	defer func() {
		if current := loop.currentManager(); current != nil {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = current.Stop(stopCtx)
		}
	}()
	// Heartbeats are the node's lifeline and must never wait on runtime provisioning:
	// a hanging binary download or a wedged mesh-llm start previously blocked the FIRST
	// heartbeat forever, leaving the node permanently offline with no control-plane
	// trace. The initial runtime starts in the background and lands via setManager.
	go heartbeatLoop(serviceCtx, loop)
	if profile, ok := agent.SelectedProfile(cfg); ok {
		provisionMeshPeerFirewall(serviceCtx, execCommandRunner, runtime.GOOS, warpIface, profile)
		loadState.SetStarting(profile)
		launchInitialRuntime(serviceCtx, loop, cfg, profile, claimBootstrap, startRuntimeForProfile)
	}
	dashboardControllers := []agent.RuntimeController{&currentRuntimeController{loop: loop}}
	proxy, err := agent.ProxyHandler(runtimeTargetFunc(func() string {
		if current := loop.currentManager(); current != nil {
			return current.TargetURL()
		}
		return ""
	}), cfg.UpstreamToken, activeRequests)
	if err != nil {
		return err
	}
	dashboardServer := &http.Server{Addr: cfg.DashboardAddress, Handler: agent.DashboardHandler(func() agent.DashboardStatus {
		return loop.dashboardStatus(version)
	}, dashboardControllers...)}
	go func() {
		_ = dashboardServer.ListenAndServe()
	}()
	defer shutdownServer(dashboardServer)

	proxyServer := &http.Server{Addr: agent.ListenerAddress(cfg.MeshIP, cfg.InferencePort, cfg.AllowAllInterfaces), Handler: proxy}
	errCh := make(chan error, 1)
	go func() { errCh <- proxyServer.ListenAndServe() }()
	select {
	case <-serviceCtx.Done():
		shutdownServer(proxyServer)
		return nil
	case err := <-errCh:
		stopService()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// launchInitialRuntime provisions and starts the boot profile's runtime in the
// background, landing the manager through setManager so dashboard, proxy, controls,
// and shutdown follow it. A start failure is logged and leaves the node up with no
// manager (ineligible, dashboard "external") instead of killing the service —
// heartbeats keep flowing either way. The starter is injected so tests can prove a
// blocking start never delays the heartbeat loop.
func launchInitialRuntime(ctx context.Context, loop *serviceLoop, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap, start func(context.Context, agent.Config, agent.ModelProfile, *agent.MeshBootstrap) (meshRuntime, string, error)) {
	go func() {
		started, installError, err := start(ctx, cfg, profile, bootstrap)
		if err != nil {
			fmt.Fprintf(os.Stderr, "runtime start failed: %v\n", err)
			return
		}
		loop.setManager(started, installError)
		if started.State() == "ready" {
			loop.loadState.Set(profile)
		}
	}()
}

func startRuntimeForProfile(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (meshRuntime, string, error) {
	if profile.Runtime == "llamacpp" {
		binaryPath, installError := llamaCppBinaryPath(cfg)
		manager := agent.NewLlamaCppManager(llamaCppInput(profile, binaryPath))
		if err := manager.Start(ctx); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return nil, installError, err
		}
		return manager, installError, nil
	}
	return startMeshRuntime(ctx, cfg, profile, bootstrap)
}

// startMeshRuntime provisions the selected mesh-llm binary and starts the
// manager for the selected profile. An install failure keeps the node up but
// never eligible: the manager reports dependency-missing and the install
// error rides heartbeat metrics as the last error.
func startMeshRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (*agent.MeshLLMManager, string, error) {
	binaryPath, installErr := agent.EnsureMeshLLMVersion(cfg.DataDir, cfg.MeshLLMFlavor, cfg.MeshLLMAllowUnpinned, cfg.RuntimeVersions.MeshLLM)
	installError := ""
	if installErr != nil {
		installError = installErr.Error()
	}
	manager := agent.NewMeshLLMManager(meshRenderInput(profile, cfg), profile.ContextWindow, cfg.DataDir, binaryPath)
	manager.ApplyBootstrap(bootstrap)
	if err := manager.Start(ctx); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		return nil, installError, err
	}
	return manager, installError, nil
}

// provisionMeshPeerFirewall best-effort opens the profile's iroh UDP bind-port for
// inbound WARP traffic, so a default-deny host firewall cannot drop the QUIC
// mesh-peer handshake and leave a multi-node mesh stuck at zero peers. It mirrors the
// TCP data-plane rule opened at startup, is scoped to the active profile's port (which
// moves with the selected model), and is likewise never fatal. REQ-NODE-010.
func llamaCppInput(profile agent.ModelProfile, binaryPath string) agent.LlamaCppInput {
	return agent.LlamaCppInput{ProfileID: profile.ID, ProfileVersion: profile.Version, UpstreamModel: profile.UpstreamModel, Settings: profile.LlamaCpp, BinaryPath: binaryPath}
}

func llamaCppBinaryPath(cfg agent.Config) (string, string) {
	if override := strings.TrimSpace(cfg.LlamaCppBinaryPath); override != "" {
		return override, ""
	}
	binaryPath, installErr := agent.EnsureLlamaCpp(cfg.DataDir, cfg.RuntimeVersions.LlamaCpp)
	if installErr != nil {
		return binaryPath, installErr.Error()
	}
	return binaryPath, ""
}

func provisionMeshPeerFirewall(ctx context.Context, run agent.CommandRunner, goos string, iface string, profile agent.ModelProfile) {
	if profile.Runtime == "llamacpp" {
		return
	}
	port := profile.MeshLLM.BindPort
	if run == nil || port <= 0 {
		return
	}
	if err := agent.EnsureInboundRule(ctx, run, goos, iface, port, "udp"); err != nil {
		fmt.Fprintf(os.Stderr, "mesh peer firewall rule not provisioned (allow inbound UDP %d on the WARP interface manually): %v\n", port, err)
	}
}

// meshRenderInput assembles the deterministic renderer input from the
// selected profile and node-local agent config. Rotation and join tokens are
// deliberately absent: the manager overlays them from the last stored mesh
// bootstrap when rendering.
func meshRenderInput(profile agent.ModelProfile, cfg agent.Config) agent.MeshLLMRenderInput {
	return agent.MeshLLMRenderInput{
		ProfileID:   profile.ID,
		ModelRef:    profile.MeshLLM.ModelRef,
		Split:       profile.MeshLLM.Split,
		BindPort:    profile.MeshLLM.BindPort,
		MaxVramGb:   profile.MeshLLM.MaxVramGb,
		MeshIP:      cfg.MeshIP,
		APIPort:     cfg.MeshLLMAPIPort,
		ConsolePort: cfg.MeshLLMConsolePort,
		Flavor:      meshFlavorFlag(cfg),
		NostrRelays: cfg.NostrRelays,
		Tunables:    profile.MeshLLM,
	}
}

// meshFlavorFlag resolves the rendered runtime flavor flag value: the
// configured override when set, otherwise hardware detection. Both cuda-12 and
// cuda-13 install-asset flavors map to upstream's plain cuda flag vocabulary;
// the CUDA major only selects which binary is downloaded, not the runtime flag.
func meshFlavorFlag(cfg agent.Config) string {
	flavor := cfg.MeshLLMFlavor
	if flavor == "" {
		flavor = agent.DetectMeshLLMFlavor(runtime.GOOS, runtime.GOARCH, func() bool {
			_, err := exec.LookPath("nvidia-smi")
			return err == nil
		}, agent.DetectHostCUDAMajor)
	}
	if flavor == "cuda-12" || flavor == "cuda-13" {
		return "cuda"
	}
	return flavor
}

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
	drainTimeout   time.Duration
	restartTimeout time.Duration
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

func (s *serviceLoop) currentInstallError() string {
	s.managerMu.RLock()
	defer s.managerMu.RUnlock()
	return s.installError
}

// setManager swaps in a replacement runtime manager (and the install error from its
// launch) so dashboard, proxy, controls, and shutdown all follow the switch.
func (s *serviceLoop) setManager(manager meshRuntime, installError string) {
	s.managerMu.Lock()
	s.manager = manager
	s.installError = installError
	s.managerMu.Unlock()
}

// dashboardStatus assembles the local dashboard snapshot from the CURRENT manager
// and config, never a startup capture. REQ-NODE-004 / REQ-OBS-008.
func (s *serviceLoop) dashboardStatus(version string) agent.DashboardStatus {
	current := s.currentConfig()
	metrics := s.telemetry.Snapshot(runtimeMetrics(s.currentManager(), s.loadState, current, s.activeRequests.Value(), s.currentInstallError()))
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

// collect runs the once-per-tick MeshLLM poll and assembles the heartbeat
// metrics and identity: mesh id and invite token are resent every tick.
func (s *serviceLoop) collect(ctx context.Context, current agent.Config) (agent.NodeMetrics, agent.HeartbeatIdentity) {
	identity := agent.HeartbeatIdentity{AgentVersion: s.agentVersion, ReloadNonce: s.lastReloadNonce}
	// One consistent manager per tick: a runtime switch mid-tick must not mix two
	// managers' state into one metrics object. REQ-OBS-008.
	manager := s.currentManager()
	metrics := runtimeMetrics(manager, s.loadState, current, s.activeRequests.Value(), s.currentInstallError())
	if manager != nil {
		if manager.Runtime() == "llamacpp" {
			if direct, ok := manager.(*agent.LlamaCppManager); ok {
				metrics = agent.MergeRuntimeMetrics(metrics, direct.Metrics())
			}
		} else {
			status, consoleReady := manager.PollStatus(ctx)
			profile, _ := agent.SelectedProfile(current)
			metrics = applyMeshStatusMetrics(metrics, profile, status, consoleReady, manager.APIReady(), manager.ReadyModels())
			if budget, ok := manager.(meshRuntimeBudgetReporter); ok {
				metrics.MeshMaxVramGb = budget.MaxVramGb()
			}
			if profile.MeshLLM.Split {
				modelRef := profile.MeshLLM.ModelRef
				if modelRef == "" {
					modelRef = profile.UpstreamModel
				}
				if poller, ok := manager.(splitReadinessPoller); ok {
					if report, ok := poller.PollSplitReadiness(ctx, modelRef); ok {
						metrics.SplitReadiness = &report
					}
				}
			}
			identity.MeshID = manager.CurrentMeshID()
			identity.MeshToken = manager.CurrentToken()
		}
		if detail := manager.RuntimeErrorDetail(); detail != "" {
			metrics.RuntimeDetail = detail
		}
	}
	// The MeshLLM console does not always report complete GPU memory. Fall back to
	// the host GPU tool for any missing part: total VRAM when absent, and used VRAM
	// when MeshLLM reports only card capacity. This keeps /api/v1/nodes and the UI
	// on trusted GPU telemetry, never split-readiness planner capacity.
	if metrics.GPUMemoryTotalMiB == 0 || metrics.GPUMemoryUsedMiB == 0 {
		runner := s.cmdRunner
		if runner == nil {
			runner = execCommandRunner
		}
		goosName := s.goos
		if goosName == "" {
			goosName = runtime.GOOS
		}
		if gpu := agent.GPUFallbackMetrics(ctx, goosName, runner); gpu.GPUMemoryTotalMiB > 0 || gpu.GPUMemoryUsedMiB > 0 {
			if metrics.GPUName == "" {
				metrics.GPUName = gpu.GPUName
			}
			if metrics.GPUMemoryUsedMiB == 0 {
				metrics.GPUMemoryUsedMiB = gpu.GPUMemoryUsedMiB
			}
			if metrics.GPUMemoryTotalMiB == 0 {
				metrics.GPUMemoryTotalMiB = gpu.GPUMemoryTotalMiB
			}
		}
	}
	s.telemetry.Store(metrics)
	metrics.LastError = s.foldUpdateError(metrics.LastError)
	s.lastMetrics = metrics
	return metrics, identity
}

func (s *serviceLoop) handleResponse(ctx context.Context, response agent.HeartbeatResponse) {
	// A deactivated node is tainted: it keeps heartbeating and self-updating but runs no model.
	// Tear down a running runtime (idempotent) and hold it down until the taint clears. REQ-NODE-011.
	if response.Deactivated {
		if manager := s.currentManager(); !s.deactivated && manager != nil {
			_ = waitForDrain(ctx, s.activeRequests, manager, s.drainTimeout)
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = manager.Stop(stopCtx)
			cancel()
			manager.SetState("deactivated")
		}
		s.deactivated = true
		s.maybeSelfUpdate(ctx, response.DesiredAgentVersion)
		return
	}
	reactivated := s.deactivated
	s.deactivated = false
	// A Force Reload directive is one-shot: apply a new nonce once, echo it back on the next
	// heartbeat (via collect) so the router retires it, and never re-fire the same nonce nor
	// re-fire a stale one after an agent restart. REQ-NODE-012.
	reloadRequested := response.ReloadNonce != "" && response.ReloadNonce != s.lastReloadNonce
	if reloadRequested {
		s.lastReloadNonce = response.ReloadNonce
	}
	s.stateMu.Lock()
	next, runtimeVersionsChanged, versionErr := agent.ApplyDesiredRuntimeVersions(*s.cfg, response.DesiredRuntimeVersions, s.configPath)
	if versionErr == nil {
		*s.cfg = next
	}
	next, _, profilesRestart, err := agent.ApplyDesiredProfiles(*s.cfg, response.DesiredProfiles, s.configPath)
	if err == nil {
		*s.cfg = next
	}
	s.stateMu.Unlock()
	if manager := s.currentManager(); manager != nil {
		manager.ApplyBootstrap(response.MeshBootstrap)
		if reactivated {
			// Taint cleared: relaunch the selected profile even though the desired profiles are
			// unchanged (ApplyDesiredProfiles reports no restart for an unchanged set). REQ-NODE-011.
			if profile, ok := agent.SelectedProfile(next); ok && beginRestart(&s.restartMu, &s.restartPending) {
				s.loadState.SetStarting(profile)
				go s.finishProfileRestart(ctx, next, "starting")
			}
		} else if versionErr == nil && err == nil && profilesRestart && s.beginProfileRestart(next) {
			go s.finishProfileRestart(ctx, next, "starting")
		} else if versionErr == nil && err == nil && runtimeVersionsChanged && beginRestart(&s.restartMu, &s.restartPending) {
			if profile, ok := agent.SelectedProfile(next); ok {
				s.loadState.SetStarting(profile)
			}
			go s.finishProfileRestart(ctx, next, "downloading")
		} else if reloadRequested && beginRestart(&s.restartMu, &s.restartPending) {
			// Force Reload: drain and restart from the current selected profile config on operator demand.
			// This must not reuse the manager's previous render input, otherwise changed runtime tunables
			// such as maxVramGb keep relaunching with stale argv. REQ-NODE-012 / REQ-RUN-003.
			go s.finishProfileRestart(ctx, next, "starting")
		} else if s.meshWaitSelfHeal(next, response.MeshBootstrap) && beginRestart(&s.restartMu, &s.restartPending) {
			// MeshLLM can occasionally stay tokenless/peerless until a manual Force Reload. After the
			// node reports the stuck waiting state on consecutive heartbeats, relaunch once for this
			// bootstrap/profile key using the same path as Force Reload. REQ-RUN-005.
			go s.finishProfileRestart(ctx, next, "starting")
		} else if manager.NeedsRestart(response.MeshBootstrap) && beginRestart(&s.restartMu, &s.restartPending) {
			// Mesh bootstrap changes and readiness self-heal also relaunch from the current selected
			// profile config, so a restart cannot preserve stale render inputs.
			go s.finishProfileRestart(ctx, next, "starting")
		}
	}
	s.maybeSelfUpdate(ctx, response.DesiredAgentVersion)
}

func (s *serviceLoop) meshWaitSelfHeal(cfg agent.Config, bootstrap *agent.MeshBootstrap) bool {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok || profile.Runtime == "llamacpp" || !profile.MeshLLM.Split || bootstrap == nil {
		s.resetMeshWaitSelfHeal()
		return false
	}
	if bootstrap.Action != "create" && bootstrap.Action != "join" {
		s.resetMeshWaitSelfHeal()
		return false
	}
	metrics := s.lastMetrics
	if !meshWaitStuck(metrics) {
		s.resetMeshWaitSelfHeal()
		return false
	}
	key := selectedProfileKey(cfg) + "|" + bootstrap.Action + "|" + bootstrap.MeshID + "|" + fmt.Sprint(bootstrap.Rotation)
	if key != s.meshWaitSelfHealKey {
		s.meshWaitSelfHealKey = key
		s.meshWaitSelfHealTicks = 1
		s.meshWaitSelfHealDone = false
		return false
	}
	if s.meshWaitSelfHealDone {
		return false
	}
	s.meshWaitSelfHealTicks++
	if s.meshWaitSelfHealTicks < 2 {
		return false
	}
	s.meshWaitSelfHealDone = true
	return true
}

func (s *serviceLoop) resetMeshWaitSelfHeal() {
	s.meshWaitSelfHealKey = ""
	s.meshWaitSelfHealTicks = 0
	s.meshWaitSelfHealDone = false
}

func meshWaitStuck(metrics agent.NodeMetrics) bool {
	if !metrics.SplitEnabled || metrics.ActiveRequests > 0 {
		return false
	}
	if metrics.SplitReadiness != nil {
		verdict := strings.ToLower(metrics.SplitReadiness.Verdict)
		reason := ""
		if len(metrics.SplitReadiness.Blockers) > 0 {
			reason = strings.ToLower(metrics.SplitReadiness.Blockers[0].Reason)
		} else if metrics.SplitReadiness.CapacityAdvice != nil {
			reason = strings.ToLower(metrics.SplitReadiness.CapacityAdvice.Reason)
		}
		servingEvidence := len(metrics.ReadyModels) > 0 || (metrics.StageCount > 0 && metrics.APIReady && metrics.ConsoleReady)
		if verdict == "waiting_for_peers" || reason == "waiting_for_peers" || ((verdict == "model_size_unknown" || reason == "model_size_unknown") && !servingEvidence) {
			return true
		}
	}
	state := strings.ToLower(metrics.RuntimeState)
	nodeState := strings.ToLower(metrics.NodeState)
	return (state == "starting" || state == "ready" || state == "running") && nodeState == "standby" && metrics.PeerCount == 0 && metrics.StageCount == 0
}

// defaultRestartTimeout bounds a single runtime restart attempt. It must exceed a
// legitimate drain (drainTimeout) plus mesh-llm's stop grace so a healthy slow restart
// is never cut short, while still guaranteeing that a Stop hung on a mesh-llm ignoring
// SIGTERM releases the restart-pending latch, so a later heartbeat retries instead of
// the node wedging in a transient state until it is relaunched by hand. REQ-RUN-010.
const defaultRestartTimeout = 3 * time.Minute

// restartCtx derives the bounded context for one restart attempt, falling back to the
// default when unset so a zero value never yields an already-expired context.
func (s *serviceLoop) restartCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.restartTimeout
	if timeout <= 0 {
		timeout = defaultRestartTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

func (s *serviceLoop) beginProfileRestart(cfg agent.Config) bool {
	_, ok := beginRuntimeProfileRestart(cfg, s.currentManager(), s.loadState, &s.restartMu, &s.restartPending)
	return ok
}

func (s *serviceLoop) finishProfileRestart(ctx context.Context, cfg agent.Config, restartState string) {
	defer finishRestart(&s.restartMu, &s.restartPending)
	// Bound the restart so a Stop hung on a mesh-llm ignoring SIGTERM cannot block this
	// goroutine and strand the restart-pending latch, which would suppress every future
	// restart on this node until it is relaunched by hand. REQ-RUN-010.
	ctx, cancel := s.restartCtx(ctx)
	defer cancel()
	profile, hasProfile := agent.SelectedProfile(cfg)
	if hasProfile {
		// The bind-port moves with the selected model, so re-provision the UDP mesh-peer
		// rule on every profile switch, not just at startup. REQ-NODE-010.
		provisionMeshPeerFirewall(ctx, s.cmdRunner, s.goos, s.warpIface, profile)
	}
	manager := s.currentManager()
	if hasProfile && manager != nil && manager.Runtime() != profile.Runtime {
		if err := waitForDrain(ctx, s.activeRequests, manager, s.drainTimeout); err != nil && ctx.Err() != nil {
			manager.SetFailure(err)
			return
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = manager.Stop(stopCtx)
		stopCancel()
		started, installError, err := startRuntimeForProfile(ctx, cfg, profile, nil)
		if err != nil {
			s.setManager(manager, installError)
			manager.SetFailure(err)
			return
		}
		// Publish the replacement manager so dashboard status, runtime controls, the
		// proxy target, and shutdown all follow the switch. REQ-OBS-008.
		s.setManager(started, installError)
		if started.State() == "ready" {
			s.loadState.Set(profile)
		}
		return
	}
	installError, err := restartRuntimeForSelectedProfile(ctx, cfg, manager, s.activeRequests, s.drainTimeout, restartState)
	s.setManager(manager, installError)
	if err != nil {
		manager.SetFailure(err)
		return
	}
	if hasProfile && manager.State() == "ready" {
		s.loadState.Set(profile)
	}
}

// maybeSelfUpdate runs one router-driven update pass. After a staged binary
// is applied the loop drains in-flight requests, stops the managed runtime,
// and exits so the service manager restarts the new binary; failures are
// reported as the node's last error while the current version keeps running.
func (s *serviceLoop) maybeSelfUpdate(ctx context.Context, desired string) {
	if s.updater == nil {
		return
	}
	applied, err := s.updater.Maybe(desired, time.Time{})
	if err != nil {
		s.setUpdateError(err.Error())
		return
	}
	if !applied {
		return
	}
	manager := s.currentManager()
	_ = waitForDrain(ctx, s.activeRequests, manager, s.drainTimeout)
	if manager != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = manager.Stop(stopCtx)
		cancel()
	}
	fmt.Printf("agent updated to version %s; exiting for service restart\n", desired)
	s.exit()
}

func (s *serviceLoop) setUpdateError(message string) {
	s.updateMu.Lock()
	defer s.updateMu.Unlock()
	s.updateError = message
}

func (s *serviceLoop) foldUpdateError(current string) string {
	s.updateMu.Lock()
	defer s.updateMu.Unlock()
	if current == "" && s.updateError != "" {
		return s.updateError
	}
	return current
}

func beginRuntimeProfileRestart(cfg agent.Config, manager meshRuntime, loadState *runtimeLoadState, restartMu *sync.Mutex, restartPending *bool) (agent.Config, bool) {
	nextProfile := selectedProfileKey(cfg)
	runtimeState := manager.State()
	// upForTarget blocks a restart while the runtime is already up for the profile we still
	// want, whether it is still loading it (starting/downloading/stopping) or already serving
	// it (ready/running). Start() launches mesh-llm asynchronously and returns before the model
	// is ready, so the runtime reaches "ready" before loadState is marked loaded; without the
	// ready/running case here the reconciler would SIGTERM a healthy runtime on every heartbeat.
	// A switch to a different profile (nextProfile != TargetKey) still preempts the stale start,
	// and a failed runtime still restarts, since neither is up for the target.
	upForTarget := (runtimeState == "starting" || runtimeState == "downloading" || runtimeState == "stopping" || runtimeState == "ready" || runtimeState == "running") && loadState.TargetKey() == nextProfile
	if nextProfile == "" || nextProfile == loadState.Key() || upForTarget || !beginRestart(restartMu, restartPending) {
		return agent.Config{}, false
	}
	manager.SetState("starting")
	if profile, ok := agent.SelectedProfile(cfg); ok {
		loadState.SetStarting(profile)
	} else {
		loadState.Clear()
	}
	return cfg, true
}

func beginRestart(mu *sync.Mutex, pending *bool) bool {
	mu.Lock()
	defer mu.Unlock()
	if *pending {
		return false
	}
	*pending = true
	return true
}

func finishRestart(mu *sync.Mutex, pending *bool) {
	mu.Lock()
	defer mu.Unlock()
	*pending = false
}

func restartRuntimeForSelectedProfile(ctx context.Context, cfg agent.Config, manager meshRuntime, activeRequests *agent.ActiveCounter, drainTimeout time.Duration, restartState string) (string, error) {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok {
		return "", nil
	}
	if restartState == "" {
		restartState = "starting"
	}
	manager.SetState(restartState)
	if err := waitForDrain(ctx, activeRequests, manager, drainTimeout); err != nil && ctx.Err() != nil {
		return "", err
	}
	if profile.Runtime == "llamacpp" {
		if direct, ok := manager.(*agent.LlamaCppManager); ok {
			binaryPath, installError := llamaCppBinaryPath(cfg)
			if err := direct.RestartWithLlamaInput(ctx, llamaCppInput(profile, binaryPath)); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
				return installError, err
			}
			return installError, nil
		}
	}
	if mesh, ok := manager.(*agent.MeshLLMManager); ok {
		binaryPath, installErr := agent.EnsureMeshLLMVersion(cfg.DataDir, cfg.MeshLLMFlavor, cfg.MeshLLMAllowUnpinned, cfg.RuntimeVersions.MeshLLM)
		installError := ""
		if installErr != nil {
			installError = installErr.Error()
		}
		if err := mesh.RestartWithBinaryInput(ctx, meshRenderInput(profile, cfg), profile.ContextWindow, binaryPath); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return installError, err
		}
		return installError, nil
	}
	if err := manager.RestartWithInput(ctx, meshRenderInput(profile, cfg), profile.ContextWindow); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		return "", err
	}
	return "", nil
}

// runtimeTelemetry caches the last fully assembled metrics so dashboard reads
// between heartbeat ticks keep the mesh and throughput fields.
type runtimeTelemetry struct {
	mu      sync.RWMutex
	metrics agent.NodeMetrics
}

func (t *runtimeTelemetry) Store(metrics agent.NodeMetrics) {
	t.mu.Lock()
	t.metrics = metrics
	t.mu.Unlock()
}

func (t *runtimeTelemetry) Snapshot(base agent.NodeMetrics) agent.NodeMetrics {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return agent.MergeRuntimeMetrics(base, t.metrics)
}

// runtimeMetrics builds the manager-derived base metrics: runtime state,
// loaded model and profile bookkeeping, and the last runtime error. An
// install failure replaces the generic dependency-missing message with the
// install error detail.
func runtimeMetrics(manager meshRuntime, loadState *runtimeLoadState, cfg agent.Config, active int, installError string) agent.NodeMetrics {
	state := "external"
	lastError := ""
	runtimeKind := "external"
	if manager != nil {
		state = manager.State()
		lastError = manager.LastError()
		runtimeKind = manager.Runtime()
	}
	if state == "dependency-missing" && installError != "" {
		lastError = installError
	}
	profile, loaded := loadState.Snapshot()
	if !loaded && state == "ready" && profile.ID != "" {
		loadState.Set(profile)
		loaded = true
	}
	loadedModel := ""
	if loaded {
		loadedModel = profile.UpstreamModel
	} else if manager == nil {
		loadedModel = cfg.RuntimeModel
	}
	metrics := agent.RuntimeMetricsWithError(state, loadedModel, active, lastError)
	metrics.RuntimeKind = runtimeKind
	if !loaded && state == "starting" && profile.UpstreamModel != "" {
		metrics.NodeState = "loading model " + profile.UpstreamModel
	}
	if state != "downloading" && state != "dependency-missing" && installError == "" {
		if runtimeKind == "meshllm" {
			metrics.MeshLLMVersion = runtimeVersionOrDefault(cfg.RuntimeVersions.MeshLLM, agent.MeshLLMPinnedVersion)
		}
		if runtimeKind == "llamacpp" {
			metrics.LlamaCppVersion = runtimeVersionOrDefault(cfg.RuntimeVersions.LlamaCpp, agent.LlamaCppDefaultVersion)
		}
	}
	if loaded {
		metrics.LoadedProfileID = profile.ID
		metrics.LoadedProfileVersion = profile.Version
	}
	return metrics
}

func runtimeVersionOrDefault(value string, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// applyMeshStatusMetrics overlays the per-tick MeshLLM console and API poll
// onto the base metrics. Ready models are the ids parsed from the node's own
// /v1/models; a runtime reported ready is demoted (and its loaded fields
// cleared) unless the console still reports serving with the selected
// profile's upstream model routable in the union of both model surfaces.
func applyMeshStatusMetrics(metrics agent.NodeMetrics, profile agent.ModelProfile, status agent.MeshLLMStatus, consoleReady bool, apiReady bool, readyModels []string) agent.NodeMetrics {
	unioned := agent.MeshStatusWithModels(status, readyModels)
	mapped := agent.MapMeshLLMState(unioned, profile.UpstreamModel, true, consoleReady)
	trustMeshProbe := metrics.RuntimeState == "ready" || consoleReady
	if trustMeshProbe {
		metrics.RuntimeState = mapped
	}
	if trustMeshProbe && mapped == "ready" {
		metrics.LoadedModel = profile.UpstreamModel
		metrics.LoadedProfileID = profile.ID
		metrics.LoadedProfileVersion = profile.Version
	} else if trustMeshProbe {
		metrics.LoadedModel = ""
		metrics.LoadedProfileID = ""
		metrics.LoadedProfileVersion = 0
	}
	metrics.MeshID = status.MeshID
	metrics.MeshNodeID = status.NodeID
	if consoleReady {
		metrics.MeshRole = agent.DeriveMeshRole(status, status.NodeID)
	}
	metrics.PeerCount = status.PeerCount
	metrics.ReadyModels = append([]string(nil), readyModels...)
	metrics.SplitEnabled = profile.MeshLLM.Split
	metrics.StageCount = status.StageCount
	metrics.StageAssignments = append([]agent.MeshLLMStage(nil), status.Stages...)
	metrics.APIReady = apiReady
	metrics.ConsoleReady = consoleReady
	metrics.MeshLLMVersion = status.Version
	metrics.NodeState = status.NodeState
	if status.TokPerSec > 0 {
		metrics.TokensPerSecond = status.TokPerSec
	}
	// Prefer MeshLLM's structured per-GPU rated memory over the bogus top-level
	// my_vram_gb; the nvidia-smi/system_profiler fallback in collect() fills in
	// when the console reports no GPUs at all.
	if len(status.GPUs) > 0 {
		// Sum rated and used VRAM across every GPU so a multi-GPU node reports its
		// full memory, not just the first card; the name comes from the first GPU.
		var ratedGB, usedGB float64
		for _, gpu := range status.GPUs {
			ratedGB += gpu.RatedVRAMGB
			usedGB += gpu.UsedVRAMGB
		}
		if name := status.GPUs[0].Name; name != "" {
			metrics.GPUName = name
		}
		if ratedGB > 0 {
			metrics.GPUMemoryTotalMiB = int(ratedGB * 1024)
		}
		if usedGB > 0 {
			metrics.GPUMemoryUsedMiB = int(usedGB * 1024)
		}
	}
	return metrics
}

type runtimeLoadState struct {
	mu      sync.RWMutex
	profile agent.ModelProfile
	loaded  bool
}

func (s *runtimeLoadState) SetStarting(profile agent.ModelProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profile = profile
	s.loaded = false
}

func (s *runtimeLoadState) Set(profile agent.ModelProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profile = profile
	s.loaded = true
}

func (s *runtimeLoadState) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profile = agent.ModelProfile{}
	s.loaded = false
}

func (s *runtimeLoadState) Snapshot() (agent.ModelProfile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.profile, s.loaded
}

func (s *runtimeLoadState) Key() string {
	profile, loaded := s.Snapshot()
	if !loaded {
		return ""
	}
	return profileKey(profile)
}

// TargetKey is the profile the runtime is loading or has loaded, regardless of
// whether the load finished. It lets the reconciler tell "busy loading the
// profile we still want" (skip) apart from "busy loading a profile we no longer
// want" (preempt), so a mid-download switch is not starved until the download ends.
func (s *runtimeLoadState) TargetKey() string {
	profile, _ := s.Snapshot()
	if profile.ID == "" {
		return ""
	}
	return profileKey(profile)
}

func selectedProfileKey(cfg agent.Config) string {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok {
		return ""
	}
	return profileKey(profile)
}

func profileKey(profile agent.ModelProfile) string {
	launch := struct {
		Runtime       string
		ID            string
		Version       int
		UpstreamModel string
		ContextWindow int
		MeshLLM       agent.MeshLLMSettings
		LlamaCpp      agent.LlamaCppSettings
	}{
		Runtime:       profile.Runtime,
		ID:            profile.ID,
		Version:       profile.Version,
		UpstreamModel: profile.UpstreamModel,
		ContextWindow: profile.ContextWindow,
		MeshLLM:       profile.MeshLLM,
		LlamaCpp:      profile.LlamaCpp,
	}
	encoded, err := json.Marshal(launch)
	if err != nil {
		return fmt.Sprintf("%s:%s:%d", profile.Runtime, profile.ID, profile.Version)
	}
	return string(encoded)
}

func waitForDrain(ctx context.Context, activeRequests *agent.ActiveCounter, manager meshRuntime, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	// Drain both the local proxy counter and the MeshLLM console's own
	// inflight_requests. The proxy counter releases a request once it has
	// relayed the upstream response, but MeshLLM can still be generating for a
	// request the proxy already let go; waiting on the console count too keeps a
	// restart or SIGTERM from landing mid-inference. The proxy check short
	// circuits the console poll while local traffic is still in flight.
	for activeRequests.Value() > 0 || meshLLMInflight(deadline, manager) > 0 {
		select {
		case <-deadline.Done():
			return deadline.Err()
		case <-ticker.C:
		}
	}
	return nil
}

// meshLLMInflight reports the MeshLLM console's current inflight_requests, or 0
// when the runtime is absent or its console is unreachable. An unobservable
// console contributes no backpressure so drain still completes on the proxy
// counter and the outer timeout.
func meshLLMInflight(ctx context.Context, manager meshRuntime) int {
	if manager == nil {
		return 0
	}
	status, reachable := manager.PollStatus(ctx)
	if !reachable {
		return 0
	}
	return status.InflightRequests
}

func shutdownServer(server *http.Server) {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func defaultDataDir() string {
	if dir := os.Getenv("INFERENCE_MESH_DATA_DIR"); dir != "" {
		return dir
	}
	return ".inference-mesh"
}

// configPathFromArgs returns the value of a --config flag when present. install
// and run both accept it so the installed service resolves the exact config path
// the install step wrote, independent of the invoking user's home directory.
func configPathFromArgs(args []string) string {
	for i := 0; i < len(args); i++ {
		if args[i] == "--config" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

const MainAnchors = "REQ-NODE-001 REQ-NODE-002 REQ-NODE-003 REQ-NODE-004 REQ-NODE-005"
