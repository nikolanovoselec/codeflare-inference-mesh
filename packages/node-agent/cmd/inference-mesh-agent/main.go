// Process entry point: flags, the install path, and the service that runs until signalled.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
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
		agentVersion:    version,
		drainTimeout:    2 * time.Minute,
		restartTimeout:  defaultRestartTimeout,
		gpuProbeTimeout: defaultGpuProbeTimeout,
		cmdRunner:       execCommandRunner,
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
