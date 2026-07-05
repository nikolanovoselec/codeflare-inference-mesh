package agent

import (
	"strconv"
	"strings"
)

type NodeMetrics struct {
	GPUName                   string   `json:"gpuName,omitempty"`
	GPUMemoryUsedMiB          int      `json:"gpuMemoryUsedMiB,omitempty"`
	GPUMemoryTotalMiB         int      `json:"gpuMemoryTotalMiB,omitempty"`
	RuntimeState              string   `json:"runtimeState"`
	LoadedModel               string   `json:"loadedModel,omitempty"`
	LoadedProfileID           string   `json:"loadedProfileId,omitempty"`
	LoadedProfileVersion      int      `json:"loadedProfileVersion,omitempty"`
	ActiveRequests            int      `json:"activeRequests"`
	TokensPerSecond           float64  `json:"tokensPerSecond,omitempty"`
	PromptTokensPerSecond     float64  `json:"promptTokensPerSecond,omitempty"`
	GenerationTokensPerSecond float64  `json:"generationTokensPerSecond,omitempty"`
	MeshID                    string   `json:"meshId,omitempty"`
	MeshRole                  string   `json:"meshRole,omitempty"`
	PeerCount                 int      `json:"peerCount,omitempty"`
	ReadyModels               []string `json:"readyModels,omitempty"`
	SplitEnabled              bool     `json:"splitEnabled,omitempty"`
	StageCount                int      `json:"stageCount,omitempty"`
	APIReady                  bool     `json:"apiReady,omitempty"`
	ConsoleReady              bool     `json:"consoleReady,omitempty"`
	MeshLLMVersion            string   `json:"meshllmVersion,omitempty"`
	LastError                 string   `json:"lastError,omitempty"`
}

func ParseNvidiaSMI(csv string) NodeMetrics {
	line := strings.TrimSpace(csv)
	parts := strings.Split(line, ",")
	metrics := NodeMetrics{RuntimeState: "unknown"}
	if len(parts) >= 3 {
		metrics.GPUName = strings.TrimSpace(parts[0])
		metrics.GPUMemoryUsedMiB = atoi(strings.TrimSpace(parts[1]))
		metrics.GPUMemoryTotalMiB = atoi(strings.TrimSpace(parts[2]))
	}
	return metrics
}

func RuntimeMetrics(state string, loadedModel string, activeRequests int) NodeMetrics {
	return RuntimeMetricsWithError(state, loadedModel, activeRequests, "")
}

func RuntimeMetricsWithError(state string, loadedModel string, activeRequests int, lastError string) NodeMetrics {
	return NodeMetrics{RuntimeState: state, LoadedModel: loadedModel, ActiveRequests: activeRequests, LastError: lastError}
}

// MeshStatusWithModels returns a copy of st whose ServingModels is the union
// of the console-reported serving models and the ids parsed from the node's
// own /v1/models poll. Readiness and metrics call sites judge against the
// union so a model routable on either surface counts, while the manager's
// fail-closed model poll keeps an unreachable API from ever contributing ids.
// Neither input slice is mutated.
func MeshStatusWithModels(st MeshLLMStatus, modelIDs []string) MeshLLMStatus {
	unioned := st
	unioned.ServingModels = append([]string(nil), st.ServingModels...)
	seen := make(map[string]bool, len(unioned.ServingModels))
	for _, id := range unioned.ServingModels {
		seen[id] = true
	}
	for _, id := range modelIDs {
		if !seen[id] {
			seen[id] = true
			unioned.ServingModels = append(unioned.ServingModels, id)
		}
	}
	return unioned
}

// MergeRuntimeMetrics overlays throughput and mesh fields captured on the
// last status poll onto live base metrics. Zero values never overwrite, so
// absent MeshLLM signals stay absent instead of being fabricated.
func MergeRuntimeMetrics(base NodeMetrics, extra NodeMetrics) NodeMetrics {
	merged := base
	if extra.GPUName != "" {
		merged.GPUName = extra.GPUName
	}
	if extra.GPUMemoryUsedMiB != 0 {
		merged.GPUMemoryUsedMiB = extra.GPUMemoryUsedMiB
	}
	if extra.GPUMemoryTotalMiB != 0 {
		merged.GPUMemoryTotalMiB = extra.GPUMemoryTotalMiB
	}
	if extra.TokensPerSecond != 0 {
		merged.TokensPerSecond = extra.TokensPerSecond
	}
	if extra.PromptTokensPerSecond != 0 {
		merged.PromptTokensPerSecond = extra.PromptTokensPerSecond
	}
	if extra.GenerationTokensPerSecond != 0 {
		merged.GenerationTokensPerSecond = extra.GenerationTokensPerSecond
	}
	if extra.MeshID != "" {
		merged.MeshID = extra.MeshID
	}
	if extra.MeshRole != "" {
		merged.MeshRole = extra.MeshRole
	}
	if extra.PeerCount != 0 {
		merged.PeerCount = extra.PeerCount
	}
	if len(extra.ReadyModels) > 0 {
		merged.ReadyModels = append([]string(nil), extra.ReadyModels...)
	}
	if extra.SplitEnabled {
		merged.SplitEnabled = true
	}
	if extra.StageCount != 0 {
		merged.StageCount = extra.StageCount
	}
	if extra.APIReady {
		merged.APIReady = true
	}
	if extra.ConsoleReady {
		merged.ConsoleReady = true
	}
	if extra.MeshLLMVersion != "" {
		merged.MeshLLMVersion = extra.MeshLLMVersion
	}
	return merged
}

func atoi(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return parsed
}

const MetricsAnchors = "REQ-OBS-003"
