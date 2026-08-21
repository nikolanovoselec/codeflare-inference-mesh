// Runtime telemetry: the last snapshot, and the mesh status folded into it.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"sync"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

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
func runtimeMetrics(manager agent.RuntimeManager, loadState *runtimeLoadState, cfg agent.Config, active int, installError string) agent.NodeMetrics {
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
			if direct, ok := manager.(*agent.LlamaCppManager); ok {
				metrics.LlamaCppBackend = direct.Metrics().LlamaCppBackend
			}
		}
		if runtimeKind == "vllm" {
			metrics.VllmVersion = runtimeVersionOrDefault(cfg.RuntimeVersions.Vllm, agent.VllmPinnedVersion)
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
