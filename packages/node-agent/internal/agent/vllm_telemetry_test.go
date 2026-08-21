package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestREQOBS014NodeMetricsRendersOnlyObservedCapabilities(t *testing.T) {
	// Capability fields are observed-only wire values: an agent that never probed
	// renders no platform/cudaAvailable keys at all, while an observed false is a
	// real answer and must survive serialization. REQ-NODE-016 / REQ-OBS-014.
	unprobed, err := json.Marshal(NodeMetrics{RuntimeState: "ready"})
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"platform", "cudaAvailable", "vllmVersion"} {
		if strings.Contains(string(unprobed), banned) {
			t.Fatalf("unobserved %q must render absent, got %s", banned, unprobed)
		}
	}
	noCuda := false
	probed, err := json.Marshal(NodeMetrics{RuntimeState: "ready", Platform: "linux", CudaAvailable: &noCuda, VllmVersion: "0.27.1"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(probed, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["platform"] != "linux" {
		t.Fatalf("platform = %v", decoded["platform"])
	}
	if got, present := decoded["cudaAvailable"]; !present || got != false {
		t.Fatalf("an observed cudaAvailable=false must render as false, got %v (present=%v)", got, present)
	}
	if decoded["vllmVersion"] != "0.27.1" {
		t.Fatalf("vllmVersion = %v", decoded["vllmVersion"])
	}
}

func TestREQOBS003MergeRuntimeMetricsCarriesVllmFields(t *testing.T) {
	// Dashboard snapshots merge the cached tick over base metrics; the vllm
	// version and capability fields must ride that merge like every other
	// runtime's fields, or reads between ticks lose them.
	cuda := true
	merged := MergeRuntimeMetrics(NodeMetrics{RuntimeState: "ready"}, NodeMetrics{
		VllmVersion:   "0.27.1",
		Platform:      "linux",
		CudaAvailable: &cuda,
	})
	if merged.VllmVersion != "0.27.1" {
		t.Fatalf("VllmVersion = %q", merged.VllmVersion)
	}
	if merged.Platform != "linux" {
		t.Fatalf("Platform = %q", merged.Platform)
	}
	if merged.CudaAvailable == nil || !*merged.CudaAvailable {
		t.Fatalf("CudaAvailable = %v", merged.CudaAvailable)
	}
	kept := MergeRuntimeMetrics(merged, NodeMetrics{RuntimeState: "ready"})
	if kept.VllmVersion != "0.27.1" || kept.Platform != "linux" || kept.CudaAvailable == nil {
		t.Fatalf("an extra without observations must not erase base fields, got %+v", kept)
	}
}

func TestREQNODE017MergeRuntimeVersionsAdoptsDesiredVllm(t *testing.T) {
	current := RuntimeBinaryVersions{MeshLLM: "v0.72.2", Vllm: "0.27.1"}
	unchanged := mergeRuntimeVersions(current, RuntimeBinaryVersions{})
	if unchanged.Vllm != "0.27.1" {
		t.Fatalf("an absent desired vllm version must keep the current one, got %q", unchanged.Vllm)
	}
	adopted := mergeRuntimeVersions(current, RuntimeBinaryVersions{Vllm: "0.28.0"})
	if adopted.Vllm != "0.28.0" {
		t.Fatalf("a desired vllm version must be adopted, got %q", adopted.Vllm)
	}
	if adopted.MeshLLM != "v0.72.2" {
		t.Fatalf("adopting vllm must not disturb sibling versions, got %q", adopted.MeshLLM)
	}
}
