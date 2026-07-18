package agent

import (
	"context"
	"testing"
)

// Apple Silicon prints no VRAM line: the darwin fallback derives the GPU budget from
// unified memory (hw.memsize) at Metal's ~75% working-set convention and reads live
// consumption from the IORegistry accelerator statistics. REQ-OBS-009.
func TestREQOBS009AppleSiliconUnifiedMemoryBudget(t *testing.T) {
	run := func(_ context.Context, name string, _ ...string) ([]byte, error) {
		switch name {
		case "system_profiler":
			return []byte("Graphics/Displays:\n    Apple M2 Pro:\n      Chipset Model: Apple M2 Pro\n      Metal Support: Metal 3\n"), nil
		case "sysctl":
			return []byte("68719476736\n"), nil
		case "ioreg":
			return []byte("+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X>\n    \"PerformanceStatistics\" = {\"Device Utilization %\"=27,\"In use system memory\" = 3221225472,\"Alloc system memory\"=4294967296}\n"), nil
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
	if got.GPUMemoryUsedMiB != 3072 {
		t.Fatalf("expected the IORegistry in-use counter (3072 MiB), got %d", got.GPUMemoryUsedMiB)
	}
}

// An unreadable accelerator entry must degrade to unknown consumption, never an error
// or a fabricated value. REQ-OBS-009.
func TestREQOBS009AppleSiliconInUseUnavailableStaysUnknown(t *testing.T) {
	run := func(_ context.Context, name string, _ ...string) ([]byte, error) {
		switch name {
		case "system_profiler":
			return []byte("Graphics/Displays:\n    Apple M1:\n      Chipset Model: Apple M1\n"), nil
		case "sysctl":
			return []byte("17179869184\n"), nil
		case "ioreg":
			return []byte("+-o AGXAcceleratorG13  <class AGXAcceleratorG13>\n"), nil
		default:
			t.Fatalf("unexpected command %q", name)
			return nil, nil
		}
	}
	got := GPUFallbackMetrics(context.Background(), "darwin", run)
	if got.GPUMemoryTotalMiB != 12288 {
		t.Fatalf("expected 75%% of 16 GiB unified memory (12288 MiB), got %d", got.GPUMemoryTotalMiB)
	}
	if got.GPUMemoryUsedMiB != 0 {
		t.Fatalf("used must stay unknown without the in-use counter, got %d", got.GPUMemoryUsedMiB)
	}
}
