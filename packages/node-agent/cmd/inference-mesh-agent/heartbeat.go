// What the agent reports to the router each tick, and what it does with the reply.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"context"
	"runtime"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

// collect runs the once-per-tick MeshLLM poll and assembles the heartbeat
// metrics and identity: mesh id and invite token are resent every tick.
func (s *serviceLoop) collect(ctx context.Context, current agent.Config) (agent.NodeMetrics, agent.HeartbeatIdentity) {
	identity := agent.HeartbeatIdentity{AgentVersion: s.agentVersion, ReloadNonce: s.lastReloadNonce}
	// One consistent manager per tick: a runtime switch mid-tick must not mix two
	// managers' state into one metrics object. REQ-OBS-008.
	manager, installError := s.managerSnapshot()
	metrics := runtimeMetrics(manager, s.loadState, current, s.activeRequests.Value(), installError)
	if manager != nil {
		if coordinator, ok := manager.(agent.MeshCoordinator); ok {
			status, consoleReady := coordinator.PollStatus(ctx)
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
			identity.MeshID = coordinator.CurrentMeshID()
			identity.MeshToken = coordinator.CurrentToken()
		} else if direct, ok := manager.(runtimeThroughputPoller); ok {
			// Live throughput rides the same tick: counter deltas since the
			// previous heartbeat become this heartbeat's tok/s. REQ-OBS-009.
			direct.PollThroughput(ctx)
			metrics = agent.MergeRuntimeMetrics(metrics, direct.Metrics())
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
		probeTimeout := s.gpuProbeTimeout
		if probeTimeout <= 0 {
			probeTimeout = defaultGpuProbeTimeout
		}
		gpuCtx, gpuCancel := context.WithTimeout(ctx, probeTimeout)
		gpu := agent.GPUFallbackMetrics(gpuCtx, goosName, runner)
		gpuCancel()
		if gpu.GPUMemoryTotalMiB > 0 || gpu.GPUMemoryUsedMiB > 0 {
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
		coordinator, isMesh := manager.(agent.MeshCoordinator)
		if isMesh {
			coordinator.ApplyBootstrap(response.MeshBootstrap)
		}
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
		} else if profile, ok := agent.SelectedProfile(next); versionErr == nil && err == nil && ok && runtimeKindMismatch(manager, profile) && beginRestart(&s.restartMu, &s.restartPending) {
			// A transiently failed runtime switch must not wedge the node: ApplyDesiredProfiles
			// reports no restart for an unchanged set, so a switch that died mid-flight would
			// leave actual and desired runtime kinds disagreeing forever. Reconcile them on
			// every heartbeat and relaunch through the switch path until they agree. REQ-RUN-010.
			s.loadState.SetStarting(profile)
			go s.finishProfileRestart(ctx, next, "starting")
		} else if s.meshWaitSelfHeal(next, response.MeshBootstrap) && beginRestart(&s.restartMu, &s.restartPending) {
			// MeshLLM can occasionally stay tokenless/peerless until a manual Force Reload. After the
			// node reports the stuck waiting state on consecutive heartbeats, relaunch once for this
			// bootstrap/profile key using the same path as Force Reload. REQ-RUN-005.
			go s.finishProfileRestart(ctx, next, "starting")
		} else if isMesh && coordinator.NeedsRestart(response.MeshBootstrap) && beginRestart(&s.restartMu, &s.restartPending) {
			// Mesh bootstrap changes and readiness self-heal also relaunch from the current selected
			// profile config, so a restart cannot preserve stale render inputs.
			go s.finishProfileRestart(ctx, next, "starting")
		}
	}
	s.maybeSelfUpdate(ctx, response.DesiredAgentVersion)
}

// runtimeKindMismatch reports whether the running manager's kind disagrees with the
// selected profile's runtime. Only managed kinds (runtimeSpecs members) participate:
// a nil manager is external mode, and an unknown/legacy profile runtime must never
// flap the runtime.
func runtimeKindMismatch(manager agent.RuntimeManager, profile agent.ModelProfile) bool {
	if _, ok := runtimeSpecs[profile.Runtime]; !ok {
		return false
	}
	kind := manager.Runtime()
	if _, ok := runtimeSpecs[kind]; !ok {
		return false
	}
	return kind != profile.Runtime
}
