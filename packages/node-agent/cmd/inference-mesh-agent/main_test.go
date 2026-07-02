package main

import (
	"context"
	"strings"
	"testing"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func TestREQRUN003RuntimeMetricsReportsActualLoadedProfile(t *testing.T) {
	loaded := agent.ModelProfile{ID: "loaded-profile", UpstreamModel: "loaded-upstream", Version: 2}
	loadState := &runtimeLoadState{}
	loadState.Set(loaded)
	cfg := agent.Config{RuntimeModel: "desired-upstream"}

	manager := agent.NewRuntimeManager(agent.RuntimeCommand{Executable: "definitely-missing-llama-server-for-test"})
	_ = manager.Start(context.Background())
	metrics := runtimeMetrics(manager, loadState, cfg, 0)

	if metrics.LoadedModel != "loaded-upstream" {
		t.Fatalf("expected loaded model from actual runtime state, got %q", metrics.LoadedModel)
	}
	if metrics.LoadedProfileID != "loaded-profile" || metrics.LoadedProfileVersion != 2 {
		t.Fatalf("expected loaded profile metadata from actual runtime state, got %q v%d", metrics.LoadedProfileID, metrics.LoadedProfileVersion)
	}
	if !strings.Contains(metrics.LastError, "definitely-missing-llama-server-for-test") {
		t.Fatalf("expected runtime manager last error to be reported, got %q", metrics.LastError)
	}
}
