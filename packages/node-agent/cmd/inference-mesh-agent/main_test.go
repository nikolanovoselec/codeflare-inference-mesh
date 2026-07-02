package main

import (
	"testing"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func TestRuntimeMetricsReportsActualLoadedProfile(t *testing.T) {
	loaded := agent.ModelProfile{ID: "loaded-profile", UpstreamModel: "loaded-upstream", Version: 2}
	loadState := &runtimeLoadState{}
	loadState.Set(loaded)
	cfg := agent.Config{RuntimeModel: "desired-upstream"}

	metrics := runtimeMetrics(agent.NewRuntimeManager(agent.RuntimeCommand{}), loadState, cfg, 0)

	if metrics.LoadedModel != "loaded-upstream" {
		t.Fatalf("expected loaded model from actual runtime state, got %q", metrics.LoadedModel)
	}
	if metrics.LoadedProfileID != "loaded-profile" || metrics.LoadedProfileVersion != 2 {
		t.Fatalf("expected loaded profile metadata from actual runtime state, got %q v%d", metrics.LoadedProfileID, metrics.LoadedProfileVersion)
	}
}
