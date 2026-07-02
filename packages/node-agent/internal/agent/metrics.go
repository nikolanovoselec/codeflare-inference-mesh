package agent

import (
	"context"
	"io"
	"net/http"
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

func FetchLlamaMetrics(ctx context.Context, runtimeURL string, client *http.Client) (NodeMetrics, error) {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(runtimeURL, "/")+"/metrics", nil)
	if err != nil {
		return NodeMetrics{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return NodeMetrics{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return NodeMetrics{}, nil
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return NodeMetrics{}, err
	}
	return ParseLlamaMetrics(string(body)), nil
}

func ParseLlamaMetrics(text string) NodeMetrics {
	metrics := NodeMetrics{RuntimeState: "unknown"}
	var promptTokens, promptSeconds, generationTokens, generationSeconds float64
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := metricNameValue(line)
		if !ok {
			continue
		}
		switch {
		case strings.Contains(name, "tokens_prompt_total") || strings.Contains(name, "prompt_tokens_total"):
			promptTokens = value
		case strings.Contains(name, "tokens_predicted_total") || strings.Contains(name, "predicted_tokens_total") || strings.Contains(name, "generation_tokens_total"):
			generationTokens = value
		case strings.Contains(name, "prompt_seconds_total"):
			promptSeconds = value
		case strings.Contains(name, "predicted_seconds_total") || strings.Contains(name, "generation_seconds_total"):
			generationSeconds = value
		case strings.Contains(name, "prompt") && strings.Contains(name, "tokens") && strings.Contains(name, "second"):
			metrics.PromptTokensPerSecond = value
		case (strings.Contains(name, "generation") || strings.Contains(name, "predicted")) && strings.Contains(name, "tokens") && strings.Contains(name, "second"):
			metrics.GenerationTokensPerSecond = value
		case strings.Contains(name, "tokens") && strings.Contains(name, "second"):
			metrics.TokensPerSecond = value
		}
	}
	if metrics.PromptTokensPerSecond == 0 && promptTokens > 0 && promptSeconds > 0 {
		metrics.PromptTokensPerSecond = promptTokens / promptSeconds
	}
	if metrics.GenerationTokensPerSecond == 0 && generationTokens > 0 && generationSeconds > 0 {
		metrics.GenerationTokensPerSecond = generationTokens / generationSeconds
	}
	if metrics.TokensPerSecond == 0 {
		metrics.TokensPerSecond = metrics.PromptTokensPerSecond + metrics.GenerationTokensPerSecond
	}
	return metrics
}

func MergeRuntimeMetrics(base NodeMetrics, extra NodeMetrics) NodeMetrics {
	merged := base
	if extra.TokensPerSecond != 0 {
		merged.TokensPerSecond = extra.TokensPerSecond
	}
	if extra.PromptTokensPerSecond != 0 {
		merged.PromptTokensPerSecond = extra.PromptTokensPerSecond
	}
	if extra.GenerationTokensPerSecond != 0 {
		merged.GenerationTokensPerSecond = extra.GenerationTokensPerSecond
	}
	return merged
}

func metricNameValue(line string) (string, float64, bool) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", 0, false
	}
	value, err := strconv.ParseFloat(fields[len(fields)-1], 64)
	if err != nil {
		return "", 0, false
	}
	name := fields[0]
	if brace := strings.IndexByte(name, '{'); brace >= 0 {
		name = name[:brace]
	}
	return strings.ToLower(name), value, true
}

func atoi(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return parsed
}

const MetricsAnchors = "REQ-OBS-003"
