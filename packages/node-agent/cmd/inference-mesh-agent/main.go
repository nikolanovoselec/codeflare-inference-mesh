package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

var version = "dev"

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
		if err := runService(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	fmt.Println("usage: inference-mesh-agent [version|install|run]")
}

func runInstall(args []string) {
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

func runService() error {
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
	}
	loadState := &runtimeLoadState{}
	var runtimeManager *agent.RuntimeManager
	if profile, ok := agent.SelectedProfile(cfg); ok {
		loadState.SetStarting(profile)
		started, err := startRuntimeForProfile(serviceCtx, cfg, profile)
		if err != nil {
			return err
		}
		runtimeManager = started
		if runtimeManager.State() == "ready" {
			loadState.Set(profile)
		}
		defer func() {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = runtimeManager.Stop(stopCtx)
		}()
	}
	var stateMu sync.RWMutex
	currentConfig := func() agent.Config {
		stateMu.RLock()
		defer stateMu.RUnlock()
		return cfg
	}
	telemetry := &runtimeTelemetry{}
	go heartbeatLoop(serviceCtx, &stateMu, &cfg, runtimeManager, loadState, telemetry, activeRequests)
	proxy, err := agent.ProxyHandler(cfg.RuntimeURL, cfg.UpstreamToken, activeRequests)
	if err != nil {
		return err
	}
	dashboardControllers := []agent.RuntimeController{}
	if runtimeManager != nil {
		dashboardControllers = append(dashboardControllers, runtimeManager)
	}
	dashboardServer := &http.Server{Addr: cfg.DashboardAddress, Handler: agent.DashboardHandler(func() agent.DashboardStatus {
		current := currentConfig()
		metrics := telemetry.Snapshot(runtimeMetrics(runtimeManager, loadState, current, activeRequests.Value()))
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

func startRuntimeForProfile(ctx context.Context, cfg agent.Config, profile agent.ModelProfile) (*agent.RuntimeManager, error) {
	listenAddress, err := agent.RuntimeListenAddress(cfg.RuntimeURL)
	if err != nil {
		return nil, err
	}
	if _, err := agent.EnsureModel(ctx, profile, cfg.DataDir, nil); err != nil {
		return nil, err
	}
	manager := agent.NewRuntimeManager(agent.LlamaCommand(profile, filepath.Join(cfg.DataDir, "models"), listenAddress))
	if err := manager.Start(ctx); err != nil {
		if errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return manager, nil
		}
		return nil, err
	}
	return manager, nil
}

func heartbeatLoop(ctx context.Context, stateMu *sync.RWMutex, cfg *agent.Config, runtimeManager *agent.RuntimeManager, loadState *runtimeLoadState, telemetry *runtimeTelemetry, activeRequests *agent.ActiveCounter) {
	restartMu := sync.Mutex{}
	restartPending := false
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stateMu.RLock()
			current := *cfg
			stateMu.RUnlock()
			metrics := telemetry.Refresh(ctx, current.RuntimeURL, runtimeMetrics(runtimeManager, loadState, current, activeRequests.Value()))
			client := agent.Client{RouterURL: current.RouterURL, HTTPClient: &http.Client{Timeout: 15 * time.Second}}
			response, err := client.Heartbeat(ctx, current.NodeToken, agent.HeartbeatFromConfig(current, metrics, activeRequests.Value()))
			if err != nil {
				continue
			}
			stateMu.Lock()
			next, _, _, err := agent.ApplyDesiredProfiles(*cfg, response.DesiredProfiles, agent.ConfigPath())
			if err == nil {
				*cfg = next
			}
			stateMu.Unlock()
			if err == nil && runtimeManager != nil {
				nextProfile := selectedProfileKey(next)
				runtimeState := runtimeManager.State()
				busy := runtimeState == "starting" || runtimeState == "downloading" || runtimeState == "stopping"
				if nextProfile != "" && nextProfile != loadState.Key() && !busy && beginRestart(&restartMu, &restartPending) {
					restartConfig := next
					runtimeManager.SetState("downloading")
					if profile, ok := agent.SelectedProfile(restartConfig); ok {
						loadState.SetStarting(profile)
					} else {
						loadState.Clear()
					}
					go func() {
						defer finishRestart(&restartMu, &restartPending)
						if err := restartRuntimeForSelectedProfile(ctx, restartConfig, runtimeManager, activeRequests); err != nil {
							runtimeManager.SetFailure(err)
							return
						}
						if profile, ok := agent.SelectedProfile(restartConfig); ok && runtimeManager.State() == "ready" {
							loadState.Set(profile)
						}
					}()
				}
			}
		}
	}
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

func restartRuntimeForSelectedProfile(ctx context.Context, cfg agent.Config, runtimeManager *agent.RuntimeManager, activeRequests *agent.ActiveCounter) error {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok {
		return nil
	}
	listenAddress, err := agent.RuntimeListenAddress(cfg.RuntimeURL)
	if err != nil {
		return err
	}
	runtimeManager.SetState("downloading")
	if _, err := agent.EnsureModel(ctx, profile, cfg.DataDir, nil); err != nil {
		return err
	}
	if err := waitForDrain(ctx, activeRequests, 2*time.Minute); err != nil {
		return err
	}
	if err := runtimeManager.RestartWithCommand(ctx, agent.LlamaCommand(profile, filepath.Join(cfg.DataDir, "models"), listenAddress)); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		return err
	}
	return nil
}

type runtimeTelemetry struct {
	mu      sync.RWMutex
	metrics agent.NodeMetrics
}

func (t *runtimeTelemetry) Refresh(ctx context.Context, runtimeURL string, base agent.NodeMetrics) agent.NodeMetrics {
	extra, err := agent.FetchLlamaMetrics(ctx, runtimeURL, nil)
	if err != nil {
		return t.Snapshot(base)
	}
	merged := agent.MergeRuntimeMetrics(base, extra)
	t.mu.Lock()
	t.metrics = merged
	t.mu.Unlock()
	return merged
}

func (t *runtimeTelemetry) Snapshot(base agent.NodeMetrics) agent.NodeMetrics {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return agent.MergeRuntimeMetrics(base, t.metrics)
}

func runtimeState(runtimeManager *agent.RuntimeManager) string {
	if runtimeManager == nil {
		return "external"
	}
	return runtimeManager.State()
}

func runtimeMetrics(runtimeManager *agent.RuntimeManager, loadState *runtimeLoadState, cfg agent.Config, active int) agent.NodeMetrics {
	lastError := ""
	if runtimeManager != nil {
		lastError = runtimeManager.LastError()
	}
	state := runtimeState(runtimeManager)
	profile, loaded := loadState.Snapshot()
	if !loaded && state == "ready" && profile.ID != "" {
		loadState.Set(profile)
		loaded = true
	}
	loadedModel := ""
	if loaded {
		loadedModel = profile.UpstreamModel
	} else if runtimeManager == nil {
		loadedModel = cfg.RuntimeModel
	}
	metrics := agent.RuntimeMetricsWithError(state, loadedModel, active, lastError)
	if loaded {
		metrics.LoadedProfileID = profile.ID
		metrics.LoadedProfileVersion = profile.Version
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

const MainAnchors = "REQ-NODE-001 REQ-NODE-002 REQ-NODE-003 REQ-NODE-004 REQ-NODE-005"
