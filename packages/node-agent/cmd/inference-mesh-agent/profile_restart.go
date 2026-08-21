// Restarting the runtime for a profile, and staging an agent self-update, without racing.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

// defaultRestartTimeout bounds a single runtime restart attempt. It must exceed a
// legitimate drain (drainTimeout) plus mesh-llm's stop grace so a healthy slow restart
// is never cut short, while still guaranteeing that a Stop hung on a mesh-llm ignoring
// SIGTERM releases the restart-pending latch, so a later heartbeat retries instead of
// the node wedging in a transient state until it is relaunched by hand. REQ-RUN-010.
const defaultRestartTimeout = 3 * time.Minute

// defaultGpuProbeTimeout bounds the host GPU telemetry probe inside a heartbeat tick.
// macOS system_profiler can stall for minutes under Metal churn during a model switch,
// and an unbounded probe freezes the whole heartbeat loop with it. REQ-NODE-002.
const defaultGpuProbeTimeout = 10 * time.Second

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
	if hasProfile && manager != nil && effectiveRuntimeKind(manager.Runtime()) != effectiveRuntimeKind(profile.Runtime) {
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

func beginRuntimeProfileRestart(cfg agent.Config, manager agent.RuntimeManager, loadState *runtimeLoadState, restartMu *sync.Mutex, restartPending *bool) (agent.Config, bool) {
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

func restartRuntimeForSelectedProfile(ctx context.Context, cfg agent.Config, manager agent.RuntimeManager, activeRequests *agent.ActiveCounter, drainTimeout time.Duration, restartState string) (string, error) {
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
	// A timed-out drain may represent a request that died with the old runtime.
	// Start a new accounting generation before relaunch; old handler completions
	// remain bound to the previous generation.
	activeRequests.Reset()
	return specForRuntime(profile.Runtime).restart(ctx, cfg, profile, manager)
}

// restartLlamaCppRuntime re-renders the llama.cpp input against the current
// config and restarts in place. A live manager that is not the concrete
// llama.cpp manager (mid-switch, test fakes) falls through to the mesh restart
// tail: its seam asserts still apply, and a manager matching neither restart
// seam fails closed there.
func restartLlamaCppRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, manager agent.RuntimeManager) (string, error) {
	if direct, ok := manager.(*agent.LlamaCppManager); ok {
		binaryPath, backend, installError := llamaCppBinaryPath(cfg)
		if err := direct.RestartWithLlamaInput(ctx, llamaCppInput(profile, binaryPath, cfg.DataDir, backend)); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return installError, err
		}
		return installError, nil
	}
	return restartMeshRuntime(ctx, cfg, profile, manager)
}

// restartVllmRuntime re-renders the vLLM input against the current config
// (re-resolving the pinned venv binary) and restarts in place. A live manager
// that is not the concrete vLLM manager falls through to the mesh restart
// tail, whose fail-closed ending covers managers matching no restart seam.
func restartVllmRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, manager agent.RuntimeManager) (string, error) {
	if direct, ok := manager.(*agent.VllmManager); ok {
		binaryPath, installError := vllmBinaryPath(cfg)
		if err := direct.RestartWithVllmInput(ctx, vllmInput(profile, binaryPath, cfg.DataDir)); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return installError, err
		}
		return installError, nil
	}
	return restartMeshRuntime(ctx, cfg, profile, manager)
}

// meshInputRestarter is the render-input restart seam for managers that are not
// the concrete MeshLLM manager (test fakes); the concrete manager instead
// re-resolves its pinned binary before restarting.
type meshInputRestarter interface {
	RestartWithInput(ctx context.Context, in agent.MeshLLMRenderInput, contextWindow int) error
}

func restartMeshRuntime(ctx context.Context, cfg agent.Config, profile agent.ModelProfile, manager agent.RuntimeManager) (string, error) {
	if mesh, ok := manager.(*agent.MeshLLMManager); ok {
		binaryPath, installErr := agent.EnsureMeshLLMVersion(cfg.DataDir, cfg.MeshLLMFlavor, cfg.MeshLLMAllowUnpinned, cfg.RuntimeVersions.MeshLLM, agent.WithMeshLLMRepository(cfg.RuntimeVersions.MeshLLMRepository))
		installError := ""
		if installErr != nil {
			installError = installErr.Error()
		}
		if err := mesh.RestartWithBinaryInput(ctx, meshRenderInput(profile, cfg), profile.ContextWindow, binaryPath); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return installError, err
		}
		return installError, nil
	}
	if restarter, ok := manager.(meshInputRestarter); ok {
		if err := restarter.RestartWithInput(ctx, meshRenderInput(profile, cfg), profile.ContextWindow); err != nil && !errors.Is(err, agent.ErrRuntimeDependencyMissing) {
			return "", err
		}
		return "", nil
	}
	// Fail closed: a manager satisfying neither restart seam must surface as a
	// failed restart, never as a silent success the reconciler marks ready.
	return "", fmt.Errorf("no restart path for runtime kind %q", manager.Runtime())
}
