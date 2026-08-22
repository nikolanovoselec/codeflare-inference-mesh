// Choosing and starting the runtime a profile asks for, and the inputs it is rendered from.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

// launchInitialRuntime provisions and starts the boot profile's runtime in the
// background, landing the manager through setManager so dashboard, proxy, controls,
// and shutdown follow it. A start failure is logged and leaves the node up with no
// manager (ineligible, dashboard "external") instead of killing the service —
// heartbeats keep flowing either way. The starter is injected so tests can prove a
// blocking start never delays the heartbeat loop.
func launchInitialRuntime(ctx context.Context, loop *serviceLoop, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap, start func(context.Context, agent.Config, agent.ModelProfile, *agent.MeshBootstrap) (agent.RuntimeManager, string, error)) {
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

// runtimeSpec is one managed runtime's launch recipes: how to provision and
// start a manager for a profile, and how to restart the live manager in place.
// These are the only per-kind sites that cannot ask an existing manager what it
// supports; every other per-kind behavior hangs off interface asserts on the
// live manager (agent.MeshCoordinator and friends).
type runtimeSpec struct {
	start   func(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (agent.RuntimeManager, string, error)
	restart func(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, manager agent.RuntimeManager) (string, error)
}

// runtimeSpecs is initialised here once and never mutated; heartbeat, restart,
// and launch goroutines read it concurrently through specForRuntime.
var runtimeSpecs = map[string]runtimeSpec{
	"meshllm":  {start: startMeshRuntimeManager, restart: restartMeshRuntime},
	"llamacpp": {start: startLlamaCppRuntime, restart: restartLlamaCppRuntime},
	"vllm":     {start: startVllmRuntime, restart: restartVllmRuntime},
}

// effectiveRuntimeKind resolves a profile's runtime kind the way launch dispatch
// does: unknown or legacy values run as mesh-llm, matching the historical
// else-branch. Guards that separate mesh from non-mesh behavior key on this,
// never on the raw profile string.
func effectiveRuntimeKind(kind string) string {
	if _, ok := runtimeSpecs[kind]; ok {
		return kind
	}
	return "meshllm"
}

func specForRuntime(kind string) runtimeSpec {
	return runtimeSpecs[effectiveRuntimeKind(kind)]
}

func startRuntimeForProfile(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (agent.RuntimeManager, string, error) {
	return specForRuntime(profile.Runtime).start(ctx, cfg, profile, bootstrap)
}

func startLlamaCppRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, _ *agent.MeshBootstrap) (agent.RuntimeManager, string, error) {
	binaryPath, backend, installError := llamaCppBinaryPath(cfg)
	manager := agent.NewLlamaCppManager(llamaCppInput(profile, binaryPath, cfg.DataDir, backend))
	if err := manager.Start(ctx); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		return nil, installError, err
	}
	return manager, installError, nil
}

func startVllmRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, _ *agent.MeshBootstrap) (agent.RuntimeManager, string, error) {
	binaryPath, installError := vllmBinaryPath(ctx, cfg)
	manager := agent.NewVllmManager(vllmInput(profile, binaryPath, cfg.DataDir))
	if err := manager.Start(ctx); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
		return nil, installError, err
	}
	return manager, installError, nil
}

func vllmInput(profile agent.ModelProfile, binaryPath string, dataDir string) agent.VllmInput {
	return agent.VllmInput{ProfileID: profile.ID, ProfileVersion: profile.Version, UpstreamModel: profile.UpstreamModel, Settings: profile.Vllm, BinaryPath: binaryPath, DataDir: dataDir, InstalledVersion: agent.InstalledVllmVersion(dataDir)}
}

// vllmBinaryPath provisions the pinned vLLM venv. An install failure keeps the
// node up but never eligible: the missing binary makes the manager report
// dependency-missing and the install error rides heartbeat metrics.
func vllmBinaryPath(ctx context.Context, cfg agent.Config) (string, string) {
	binaryPath, installErr := agent.EnsureVllm(ctx, cfg.DataDir, cfg.RuntimeVersions.Vllm)
	if installErr != nil {
		return binaryPath, installErr.Error()
	}
	return binaryPath, ""
}

func startMeshRuntimeManager(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (agent.RuntimeManager, string, error) {
	return startMeshRuntime(ctx, cfg, profile, bootstrap)
}

// startMeshRuntime provisions the selected mesh-llm binary and starts the
// manager for the selected profile. An install failure keeps the node up but
// never eligible: the manager reports dependency-missing and the install
// error rides heartbeat metrics as the last error.
func startMeshRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, bootstrap *agent.MeshBootstrap) (*agent.MeshLLMManager, string, error) {
	binaryPath, installErr := agent.EnsureMeshLLMVersion(cfg.DataDir, cfg.MeshLLMFlavor, cfg.MeshLLMAllowUnpinned, cfg.RuntimeVersions.MeshLLM, agent.WithMeshLLMRepository(cfg.RuntimeVersions.MeshLLMRepository))
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

func llamaCppInput(profile agent.ModelProfile, binaryPath string, dataDir string, backend string) agent.LlamaCppInput {
	return agent.LlamaCppInput{ProfileID: profile.ID, ProfileVersion: profile.Version, UpstreamModel: profile.UpstreamModel, Settings: profile.LlamaCpp, BinaryPath: binaryPath, Backend: backend, DataDir: dataDir}
}

func llamaCppBinaryPath(cfg agent.Config) (string, string, string) {
	if override := strings.TrimSpace(cfg.LlamaCppBinaryPath); override != "" {
		return override, "unknown", ""
	}
	binaryPath, installErr := agent.EnsureLlamaCpp(cfg.DataDir, cfg.RuntimeVersions.LlamaCpp)
	backend := managedLlamaCppBackend(cfg.DataDir, binaryPath)
	if installErr != nil {
		return binaryPath, backend, installErr.Error()
	}
	return binaryPath, backend, ""
}

func managedLlamaCppBackend(dataDir string, binaryPath string) string {
	managedRoot := filepath.Clean(filepath.Join(dataDir, "bin"))
	cleanBinary := filepath.Clean(binaryPath)
	relative, err := filepath.Rel(managedRoot, cleanBinary)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "unknown"
	}
	directory := filepath.Base(filepath.Dir(cleanBinary))
	if strings.HasPrefix(directory, "llamacpp-") {
		return strings.TrimPrefix(directory, "llamacpp-")
	}
	if filepath.Dir(cleanBinary) == managedRoot {
		requested := agent.DetectLlamaCppBackend(runtime.GOOS)
		return agent.ResolvedLlamaCppBackend(runtime.GOOS, runtime.GOARCH, requested)
	}
	return "unknown"
}

// provisionMeshPeerFirewall best-effort opens the profile's iroh UDP bind-port for
// inbound WARP traffic, so a default-deny host firewall cannot drop the QUIC
// mesh-peer handshake and leave a multi-node mesh stuck at zero peers. It mirrors the
// TCP data-plane rule opened at startup, is scoped to the active profile's port (which
// moves with the selected model), and is likewise never fatal. REQ-NODE-010.
func provisionMeshPeerFirewall(ctx context.Context, run agent.CommandRunner, goos string, iface string, profile agent.ModelProfile) {
	// Only mesh-llm profiles carry a mesh peer port; keying on the resolved mesh
	// kind (not "anything but llamacpp") keeps a future non-mesh kind out of the
	// mesh path while legacy empty-runtime profiles still run as mesh.
	if effectiveRuntimeKind(profile.Runtime) != "meshllm" {
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
		ProfileID:         profile.ID,
		ModelRef:          profile.MeshLLM.ModelRef,
		Split:             profile.MeshLLM.Split,
		BindPort:          profile.MeshLLM.BindPort,
		MaxVramGb:         profile.MeshLLM.MaxVramGb,
		MeshIP:            cfg.MeshIP,
		APIPort:           cfg.MeshLLMAPIPort,
		ConsolePort:       cfg.MeshLLMConsolePort,
		Flavor:            meshFlavorFlag(cfg),
		MeshLLMVersion:    cfg.RuntimeVersions.MeshLLM,
		MeshLLMRepository: cfg.RuntimeVersions.MeshLLMRepository,
		NostrRelays:       cfg.NostrRelays,
		Tunables:          profile.MeshLLM,
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
