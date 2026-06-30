package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/nikolanovoselec/cloudflare-inference-mesh/packages/node-agent/internal/agent"
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
	metrics := agent.RuntimeMetrics("ready", cfg.RuntimeModel, 0)
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
	go func() {
		client := agent.Client{RouterURL: cfg.RouterURL, HTTPClient: &http.Client{Timeout: 15 * time.Second}}
		for range time.Tick(15 * time.Second) {
			_, _ = client.Heartbeat(context.Background(), cfg.NodeToken, agent.HeartbeatFromConfig(cfg, metrics, 0))
		}
	}()
	proxy, err := agent.ProxyHandler(cfg.RuntimeURL, cfg.UpstreamToken)
	if err != nil {
		return err
	}
	go func() {
		_ = http.ListenAndServe(cfg.DashboardAddress, agent.DashboardHandler(func() agent.DashboardStatus {
			return agent.DashboardStatus{Config: cfg, Metrics: metrics, RuntimeState: metrics.RuntimeState, Version: version}
		}))
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
