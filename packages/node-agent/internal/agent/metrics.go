package agent

import (
	"strconv"
	"strings"
)

type NodeMetrics struct {
	GPUName           string  `json:"gpuName,omitempty"`
	GPUMemoryUsedMiB  int     `json:"gpuMemoryUsedMiB,omitempty"`
	GPUMemoryTotalMiB int     `json:"gpuMemoryTotalMiB,omitempty"`
	RuntimeState      string  `json:"runtimeState"`
	LoadedModel       string  `json:"loadedModel,omitempty"`
	ActiveRequests    int     `json:"activeRequests"`
	TokensPerSecond   float64 `json:"tokensPerSecond,omitempty"`
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
	return NodeMetrics{RuntimeState: state, LoadedModel: loadedModel, ActiveRequests: activeRequests}
}

func atoi(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return parsed
}

const MetricsAnchors = "REQ-OBS-003"
