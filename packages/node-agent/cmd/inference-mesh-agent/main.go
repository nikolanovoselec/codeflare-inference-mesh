package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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
	activeRequests := &agent.ActiveCounter{}
	if cfg.SetupToken != "" && cfg.NodeToken == "" {
		claimClient := agent.Client{RouterURL: cfg.RouterURL}
		claim, err := claimClient.Claim(context.Background(), cfg.SetupToken, agent.ClaimRequest{DisplayName: cfg.DisplayName, MeshIP: cfg.MeshIP, InferencePort: cfg.InferencePort, PublicModels: cfg.PublicModels, ActiveProfileIDs: cfg.ActiveProfileIDs, Capacity: cfg.Capacity})
		if err != nil {
			return err
		}
		next, err := agent.ApplyClaim(cfg, claim, agent.ConfigPath())
		if err != nil {
			return err
		}
		cfg = next
	}
	runtimeState := "external"
	var runtimeManager *agent.RuntimeManager
	if profile, ok := agent.SelectedProfile(cfg); ok {
		listenAddress, err := agent.RuntimeListenAddress(cfg.RuntimeURL)
		if err != nil {
			return err
		}
		if _, err := agent.EnsureModel(context.Background(), profile, cfg.DataDir, nil); err != nil {
			return err
		}
		runtimeManager = agent.NewRuntimeManager(agent.LlamaCommand(profile, filepath.Join(cfg.DataDir, "models"), listenAddress))
		if err := runtimeManager.Start(context.Background()); err != nil {
			return err
		}
		runtimeState = "ready"
	}
	go func() {
		client := agent.Client{RouterURL: cfg.RouterURL, HTTPClient: &http.Client{Timeout: 15 * time.Second}}
		for range time.Tick(15 * time.Second) {
			metrics := agent.RuntimeMetrics(runtimeState, cfg.RuntimeModel, activeRequests.Value())
			_, _ = client.Heartbeat(context.Background(), cfg.NodeToken, agent.HeartbeatFromConfig(cfg, metrics, activeRequests.Value()))
		}
	}()
	proxy, err := agent.ProxyHandler(cfg.RuntimeURL, cfg.UpstreamToken, activeRequests)
	if err != nil {
		return err
	}
	go func() {
		_ = http.ListenAndServe(cfg.DashboardAddress, agent.DashboardHandler(func() agent.DashboardStatus {
			metrics := agent.RuntimeMetrics(runtimeState, cfg.RuntimeModel, activeRequests.Value())
			return agent.DashboardStatus{Config: cfg, Metrics: metrics, RuntimeState: metrics.RuntimeState, Version: version}
		}, runtimeManager))
	}()
	return http.ListenAndServe(agent.ListenerAddress(cfg.MeshIP, cfg.InferencePort, cfg.AllowAllInterfaces), proxy)
}

func defaultDataDir() string {
	if dir := os.Getenv("INFERENCE_MESH_DATA_DIR"); dir != "" {
		return dir
	}
	return ".inference-mesh"
}

const MainAnchors = "REQ-NODE-001 REQ-NODE-002 REQ-NODE-003 REQ-NODE-004 REQ-NODE-005"
