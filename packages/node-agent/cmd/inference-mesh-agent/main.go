package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
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
	var manager *agent.MeshLLMManager
	installError := ""
	if profile, ok := agent.SelectedProfile(cfg); ok {
		loadState.SetStarting(profile)
		started, startInstallError, err := startMeshRuntime(serviceCtx, cfg, profile, claimBootstrap)
		if err != nil {
			return err
		}
		manager = started
		installError = startInstallError
		if manager.State() == "ready" {
			loadState.Set(profile)
		}
		defer func() {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = manager.Stop(stopCtx)
		}()
	}
	var loopRuntime meshRuntime
	dashboardControllers := []agent.RuntimeController{}
	if manager != nil {
		loopRuntime = manager
		dashboardControllers = append(dashboardControllers, manager)
	}
	var stateMu sync.RWMutex
	currentConfig := func() agent.Config {
		stateMu.RLock()
		defer stateMu.RUnlock()
		return cfg
	}
	telemetry := &runtimeTelemetry{}
	loop := &serviceLoop{
		configPath:     agent.ConfigPath(),
		stateMu:        &stateMu,
		cfg:            &cfg,
		manager:        loopRuntime,
		loadState:      loadState,
		telemetry:      telemetry,
		activeRequests: activeRequests,
		updater:        agent.NewSelfUpdater(version, agentReleaseRepo, cfg.DataDir),
		exit: func() {
			os.Exit(0)
		},
		agentVersion: version,
		installError: installError,
		drainTimeout: 2 * time.Minute,
	}
	go heartbeatLoop(serviceCtx, loop)
	proxy, err := agent.ProxyHandler(fmt.Sprintf("http://127.0.0.1:%d", cfg.MeshLLMAPIPort), cfg.UpstreamToken, activeRequests)
	if err != nil {
		return err
	}
	dashboardServer := &http.Server{Addr: cfg.DashboardAddress, Handler: agent.DashboardHandler(func() agent.DashboardStatus {
		current := currentConfig()
		metrics := telemetry.Snapshot(runtimeMetrics(loopRuntime, loadState, current, activeRequests.Value(), installError))
		return agent.DashboardStatus{Config: current, Metrics: metrics, RuntimeState: metrics.RuntimeState, Version: version}
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

// startMeshRuntime provisions the pinned mesh-llm binary and starts the
// manager for the selected profile. An install failure keeps the node up but
// never eligible: the manager reports dependency-missing and the install
// error rides heartbeat metrics as the last error.
func startMeshRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (*agent.MeshLLMManager, string, error) {
	binaryPath, installErr := agent.EnsureMeshLLM(cfg.DataDir, cfg.MeshLLMFlavor, cfg.MeshLLMAllowUnpinned)
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
type meshRuntime interface {
	agent.RuntimeController
	PollStatus(ctx context.Context) (agent.MeshLLMStatus, bool)
	ApplyBootstrap(bootstrap *agent.MeshBootstrap)
	NeedsRestart(bootstrap *agent.MeshBootstrap) bool
	CurrentToken() string
	CurrentMeshID() string
	ReadyModels() []string
	APIReady() bool
	State() string
	LastError() string
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
	configPath     string
	stateMu        *sync.RWMutex
	cfg            *agent.Config
	manager        meshRuntime
	loadState      *runtimeLoadState
	telemetry      *runtimeTelemetry
	activeRequests *agent.ActiveCounter
	updater        agentUpdater
	exit           func()
	agentVersion   string
	installError   string
	drainTimeout   time.Duration

	restartMu      sync.Mutex
	restartPending bool
	updateMu       sync.Mutex
	updateError    string
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

func (s *serviceLoop) tick(ctx context.Context) {
	current := s.currentConfig()
	metrics, identity := s.collect(ctx, current)
	client := agent.Client{RouterURL: current.RouterURL, HTTPClient: &http.Client{Timeout: 15 * time.Second}}
	response, err := client.Heartbeat(ctx, current.NodeToken, agent.HeartbeatFromConfig(current, metrics, s.activeRequests.Value(), identity))
	if err != nil {
		return
	}
	s.handleResponse(ctx, response)
}

// collect runs the once-per-tick MeshLLM poll and assembles the heartbeat
// metrics and identity: mesh id and invite token are resent every tick.
func (s *serviceLoop) collect(ctx context.Context, current agent.Config) (agent.NodeMetrics, agent.HeartbeatIdentity) {
	identity := agent.HeartbeatIdentity{AgentVersion: s.agentVersion}
	metrics := runtimeMetrics(s.manager, s.loadState, current, s.activeRequests.Value(), s.installError)
	if s.manager != nil {
		status, consoleReady := s.manager.PollStatus(ctx)
		profile, _ := agent.SelectedProfile(current)
		metrics = applyMeshStatusMetrics(metrics, profile, status, consoleReady, s.manager.APIReady(), s.manager.ReadyModels())
		identity.MeshID = s.manager.CurrentMeshID()
		identity.MeshToken = s.manager.CurrentToken()
	}
	s.telemetry.Store(metrics)
	metrics.LastError = s.foldUpdateError(metrics.LastError)
	return metrics, identity
}

func (s *serviceLoop) handleResponse(ctx context.Context, response agent.HeartbeatResponse) {
	s.stateMu.Lock()
	next, _, _, err := agent.ApplyDesiredProfiles(*s.cfg, response.DesiredProfiles, s.configPath)
	if err == nil {
		*s.cfg = next
	}
	s.stateMu.Unlock()
	if s.manager != nil {
		s.manager.ApplyBootstrap(response.MeshBootstrap)
		if err == nil && s.beginProfileRestart(next) {
			go s.finishProfileRestart(ctx, next)
		} else if s.manager.NeedsRestart(response.MeshBootstrap) && beginRestart(&s.restartMu, &s.restartPending) {
			go s.finishBootstrapRestart(ctx)
		}
	}
	s.maybeSelfUpdate(ctx, response.DesiredAgentVersion)
}

func (s *serviceLoop) beginProfileRestart(cfg agent.Config) bool {
	_, ok := beginRuntimeProfileRestart(cfg, s.manager, s.loadState, &s.restartMu, &s.restartPending)
	return ok
}

func (s *serviceLoop) finishProfileRestart(ctx context.Context, cfg agent.Config) {
	defer finishRestart(&s.restartMu, &s.restartPending)
	if err := restartRuntimeForSelectedProfile(ctx, cfg, s.manager, s.activeRequests, s.drainTimeout); err != nil {
		s.manager.SetFailure(err)
		return
	}
	if profile, ok := agent.SelectedProfile(cfg); ok && s.manager.State() == "ready" {
		s.loadState.Set(profile)
	}
}

func (s *serviceLoop) finishBootstrapRestart(ctx context.Context) {
	defer finishRestart(&s.restartMu, &s.restartPending)
	if err := waitForDrain(ctx, s.activeRequests, s.drainTimeout); err != nil {
		s.manager.SetFailure(err)
		return
	}
	if err := s.manager.Restart(ctx); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		s.manager.SetFailure(err)
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
	_ = waitForDrain(ctx, s.activeRequests, s.drainTimeout)
	if s.manager != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = s.manager.Stop(stopCtx)
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
	// Busy blocks a restart only when the in-flight work is for the profile we still
	// want; a switch to a different profile preempts the stale download/start instead
	// of waiting for it to finish (which for a large GGUF starves the switch for minutes).
	busy := (runtimeState == "starting" || runtimeState == "downloading" || runtimeState == "stopping") && loadState.TargetKey() == nextProfile
	if nextProfile == "" || nextProfile == loadState.Key() || busy || !beginRestart(restartMu, restartPending) {
		return agent.Config{}, false
	}
	manager.SetState("downloading")
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

func restartRuntimeForSelectedProfile(ctx context.Context, cfg agent.Config, manager meshRuntime, activeRequests *agent.ActiveCounter, drainTimeout time.Duration) error {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok {
		return nil
	}
	manager.SetState("downloading")
	if err := waitForDrain(ctx, activeRequests, drainTimeout); err != nil {
		return err
	}
	if err := manager.RestartWithInput(ctx, meshRenderInput(profile, cfg), profile.ContextWindow); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		return err
	}
	return nil
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
	if manager != nil {
		state = manager.State()
		lastError = manager.LastError()
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
	if loaded {
		metrics.LoadedProfileID = profile.ID
		metrics.LoadedProfileVersion = profile.Version
	}
	return metrics
}

// applyMeshStatusMetrics overlays the per-tick MeshLLM console and API poll
// onto the base metrics. Ready models are the ids parsed from the node's own
// /v1/models; a runtime reported ready is demoted (and its loaded fields
// cleared) unless the console still reports serving with the selected
// profile's upstream model routable in the union of both model surfaces.
func applyMeshStatusMetrics(metrics agent.NodeMetrics, profile agent.ModelProfile, status agent.MeshLLMStatus, consoleReady bool, apiReady bool, readyModels []string) agent.NodeMetrics {
	if metrics.RuntimeState == "ready" {
		unioned := agent.MeshStatusWithModels(status, readyModels)
		if mapped := agent.MapMeshLLMState(unioned, profile.UpstreamModel, true, consoleReady); mapped != "ready" {
			metrics.RuntimeState = mapped
			metrics.LoadedModel = ""
			metrics.LoadedProfileID = ""
			metrics.LoadedProfileVersion = 0
		}
	}
	metrics.MeshID = status.MeshID
	if consoleReady {
		metrics.MeshRole = agent.DeriveMeshRole(status, status.NodeID)
	}
	metrics.PeerCount = status.PeerCount
	metrics.ReadyModels = append([]string(nil), readyModels...)
	metrics.SplitEnabled = profile.MeshLLM.Split
	metrics.StageCount = status.StageCount
	metrics.APIReady = apiReady
	metrics.ConsoleReady = consoleReady
	metrics.MeshLLMVersion = status.Version
	if status.TokPerSec > 0 {
		metrics.TokensPerSecond = status.TokPerSec
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
	return fmt.Sprintf("%s:%d", profile.ID, profile.Version)
}

func waitForDrain(ctx context.Context, activeRequests *agent.ActiveCounter, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for activeRequests.Value() > 0 {
		select {
		case <-deadline.Done():
			return deadline.Err()
		case <-ticker.C:
		}
	}
	return nil
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
