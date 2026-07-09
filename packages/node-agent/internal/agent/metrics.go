package agent

import (
	"strconv"
	"strings"
)

type NodeMetrics struct {
	RuntimeKind               string   `json:"runtimeKind,omitempty"`
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
	MeshNodeID                string   `json:"meshNodeId,omitempty"`
	MeshRole                  string   `json:"meshRole,omitempty"`
	PeerCount                 int      `json:"peerCount,omitempty"`
	ReadyModels               []string                `json:"readyModels,omitempty"`
	SplitEnabled              bool                    `json:"splitEnabled,omitempty"`
	StageCount                int                     `json:"stageCount,omitempty"`
	StageAssignments          []MeshLLMStage          `json:"stageAssignments,omitempty"`
	MeshMaxVramGb             float64                 `json:"meshMaxVramGb,omitempty"`
	SplitReadiness            *MeshLLMSplitReadiness  `json:"splitReadiness,omitempty"`
	APIReady                  bool                    `json:"apiReady,omitempty"`
	ConsoleReady              bool                    `json:"consoleReady,omitempty"`
	MeshLLMVersion            string   `json:"meshllmVersion,omitempty"`
	LlamaCppVersion           string   `json:"llamacppVersion,omitempty"`
	CtxSize                   int      `json:"ctxSize,omitempty"`
	Parallel                  int      `json:"parallel,omitempty"`
	CachePrompt               bool     `json:"cachePrompt,omitempty"`
	CacheReuse                int      `json:"cacheReuse,omitempty"`
	SlotCount                 int      `json:"slotCount,omitempty"`
	ActiveSlots               int      `json:"activeSlots,omitempty"`
	CachedTokensLast          int      `json:"cachedTokensLast,omitempty"`
	LastError                 string   `json:"lastError,omitempty"`
	// RuntimeDetail is the most recent error-looking line from mesh-llm's own stderr, so the
	// console can show why a runtime is wedged; NodeState is the console's raw node_state. REQ-OBS-011.
	RuntimeDetail string `json:"runtimeDetail,omitempty"`
	NodeState     string `json:"nodeState,omitempty"`
}

// ParseNvidiaSMI parses `name,memory.used,memory.total` CSV rows. nvidia-smi emits
// one row per GPU, so used and total memory are summed across all rows (a single-GPU
// host sums to itself) and the name is taken from the first row.
func ParseNvidiaSMI(csv string) NodeMetrics {
	metrics := NodeMetrics{RuntimeState: "unknown"}
	for _, raw := range strings.Split(csv, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 3 {
			continue
		}
		if metrics.GPUName == "" {
			metrics.GPUName = strings.TrimSpace(parts[0])
		}
		metrics.GPUMemoryUsedMiB += atoi(strings.TrimSpace(parts[1]))
		metrics.GPUMemoryTotalMiB += atoi(strings.TrimSpace(parts[2]))
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
	if extra.RuntimeKind != "" {
		merged.RuntimeKind = extra.RuntimeKind
	}
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
	if extra.MeshNodeID != "" {
		merged.MeshNodeID = extra.MeshNodeID
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
	if len(extra.StageAssignments) > 0 {
		merged.StageAssignments = append([]MeshLLMStage(nil), extra.StageAssignments...)
	}
	if extra.MeshMaxVramGb != 0 {
		merged.MeshMaxVramGb = extra.MeshMaxVramGb
	}
	if extra.SplitReadiness != nil {
		report := *extra.SplitReadiness
		merged.SplitReadiness = &report
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
	if extra.LlamaCppVersion != "" {
		merged.LlamaCppVersion = extra.LlamaCppVersion
	}
	if extra.CtxSize != 0 {
		merged.CtxSize = extra.CtxSize
	}
	if extra.Parallel != 0 {
		merged.Parallel = extra.Parallel
	}
	if extra.CachePrompt {
		merged.CachePrompt = true
	}
	if extra.CacheReuse != 0 {
		merged.CacheReuse = extra.CacheReuse
	}
	if extra.SlotCount != 0 {
		merged.SlotCount = extra.SlotCount
	}
	if extra.ActiveSlots != 0 {
		merged.ActiveSlots = extra.ActiveSlots
	}
	if extra.CachedTokensLast != 0 {
		merged.CachedTokensLast = extra.CachedTokensLast
	}
	if extra.NodeState != "" {
		merged.NodeState = extra.NodeState
	}
	if extra.RuntimeDetail != "" {
		merged.RuntimeDetail = extra.RuntimeDetail
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
