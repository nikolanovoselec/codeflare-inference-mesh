package agent

import (
	"context"
	"testing"
)

// Apple Silicon prints no VRAM line: the darwin fallback derives the GPU budget from
// unified memory (hw.memsize) at Metal's ~75% working-set convention. REQ-OBS-009.
func TestREQOBS009AppleSiliconUnifiedMemoryBudget(t *testing.T) {
	run := func(_ context.Context, name string, _ ...string) ([]byte, error) {
		switch name {
		case "system_profiler":
			return []byte("Graphics/Displays:\n    Apple M2 Pro:\n      Chipset Model: Apple M2 Pro\n      Metal Support: Metal 3\n"), nil
		case "sysctl":
			return []byte("68719476736\n"), nil
		default:
			t.Fatalf("unexpected command %q", name)
			return nil, nil
		}
	}
	got := GPUFallbackMetrics(context.Background(), "darwin", run)
	if got.GPUName != "Apple M2 Pro" {
		t.Fatalf("GPU name: %#v", got)
	}
	if got.GPUMemoryTotalMiB != 49152 {
		t.Fatalf("expected 75%% of 64 GiB unified memory (49152 MiB), got %d", got.GPUMemoryTotalMiB)
	}
	if got.GPUMemoryUsedMiB != 0 {
		t.Fatalf("used VRAM must stay unknown, got %d", got.GPUMemoryUsedMiB)
	}
}
