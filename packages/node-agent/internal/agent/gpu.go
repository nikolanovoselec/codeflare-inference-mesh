package agent

import (
	"context"
	"strings"
)

// CommandRunner runs an external command and returns its stdout. It is injected
// so GPU discovery can be tested without real hardware or a real subprocess.
type CommandRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// GPUFallbackMetrics probes the host for GPU memory when the MeshLLM console did
// not report it. Best-effort per OS: any failure yields zero GPU fields, which
// the caller treats as "unknown" rather than an error. Only the GPU fields of
// the returned NodeMetrics are meaningful.
func GPUFallbackMetrics(ctx context.Context, goos string, run CommandRunner) NodeMetrics {
	switch goos {
	case "windows":
		if out, err := run(ctx, "nvidia-smi.exe", nvidiaSMIArgs()...); err == nil {
			return ParseNvidiaSMI(string(out))
		}
	case "darwin":
		if out, err := run(ctx, "system_profiler", "SPDisplaysDataType"); err == nil {
			metrics := parseSystemProfilerVRAM(string(out))
			if metrics.GPUMemoryTotalMiB == 0 {
				metrics.GPUMemoryTotalMiB = appleUnifiedMemoryBudgetMiB(ctx, run)
			}
			return metrics
		}
	default: // linux and other unix
		if out, err := run(ctx, "nvidia-smi", nvidiaSMIArgs()...); err == nil {
			return ParseNvidiaSMI(string(out))
		}
	}
	return NodeMetrics{}
}

// appleUnifiedMemoryBudgetMiB reports the GPU budget on Apple Silicon, where
// system_profiler prints no VRAM line because the GPU shares unified memory.
// Metal's recommended working set is ~75% of physical RAM — the same figure the
// mesh-llm console reports on this hardware — so both runtimes agree in the UI.
func appleUnifiedMemoryBudgetMiB(ctx context.Context, run CommandRunner) int {
	out, err := run(ctx, "sysctl", "-n", "hw.memsize")
	if err != nil {
		return 0
	}
	memBytes := atoi(strings.TrimSpace(string(out)))
	if memBytes <= 0 {
		return 0
	}
	return memBytes / (1024 * 1024) * 3 / 4
}

func nvidiaSMIArgs() []string {
	return []string{"--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"}
}

// parseSystemProfilerVRAM extracts the GPU name and total VRAM from macOS
// `system_profiler SPDisplaysDataType`. Apple Silicon shares system memory and
// often omits a VRAM line, so total may stay zero (unknown) — never fabricated.
func parseSystemProfilerVRAM(out string) NodeMetrics {
	metrics := NodeMetrics{}
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "Chipset Model:") {
			metrics.GPUName = strings.TrimSpace(strings.TrimPrefix(line, "Chipset Model:"))
		}
		// "VRAM (Total): 24 GB" or "VRAM (Dynamic, Max): 8192 MB"
		if strings.HasPrefix(line, "VRAM") && metrics.GPUMemoryTotalMiB == 0 {
			metrics.GPUMemoryTotalMiB = parseVRAMToMiB(line)
		}
	}
	return metrics
}

func parseVRAMToMiB(line string) int {
	idx := strings.Index(line, ":")
	if idx < 0 {
		return 0
	}
	fields := strings.Fields(strings.TrimSpace(line[idx+1:]))
	if len(fields) < 2 {
		return 0
	}
	amount := atoi(fields[0])
	switch strings.ToUpper(fields[1]) {
	case "GB":
		return amount * 1024
	case "MB":
		return amount
	}
	return 0
}
