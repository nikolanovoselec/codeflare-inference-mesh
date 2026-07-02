package agent

import (
	"strconv"
	"strings"
)

type NodeMetrics struct {
	GPUName                   string  `json:"gpuName,omitempty"`
	GPUMemoryUsedMiB          int     `json:"gpuMemoryUsedMiB,omitempty"`
	GPUMemoryTotalMiB         int     `json:"gpuMemoryTotalMiB,omitempty"`
	RuntimeState              string  `json:"runtimeState"`
	LoadedModel               string  `json:"loadedModel,omitempty"`
	LoadedProfileID           string  `json:"loadedProfileId,omitempty"`
	LoadedProfileVersion      int     `json:"loadedProfileVersion,omitempty"`
	ActiveRequests            int     `json:"activeRequests"`
	TokensPerSecond           float64 `json:"tokensPerSecond,omitempty"`
	PromptTokensPerSecond     float64 `json:"promptTokensPerSecond,omitempty"`
	GenerationTokensPerSecond float64 `json:"generationTokensPerSecond,omitempty"`
	LastError                 string  `json:"lastError,omitempty"`
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

func atoi(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return parsed
}

const MetricsAnchors = "REQ-OBS-003"
