package main

import (
	"context"
	"strings"
	"testing"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func TestREQRUN003RuntimeMetricsMarksLaunchedProfileLoaded(t *testing.T) {
	launched := agent.ModelProfile{ID: "launched-profile", UpstreamModel: "launched-upstream", Version: 2}
	desired := agent.ModelProfile{ID: "desired-profile", UpstreamModel: "desired-upstream", Version: 3}
	cfg := agent.Config{RuntimeModel: "desired-upstream", ActiveProfileIDs: []string{"desired-profile"}, Profiles: []agent.ModelProfile{desired}}
	manager := agent.NewRuntimeManager(agent.RuntimeCommand{Executable: "definitely-missing-llama-server-for-test"})
	manager.SetState("ready")
	loadState := &runtimeLoadState{}
	loadState.SetStarting(launched)

	metrics := runtimeMetrics(manager, loadState, cfg, 0)

	if metrics.LoadedModel != "launched-upstream" || metrics.LoadedProfileID != "launched-profile" || metrics.LoadedProfileVersion != 2 {
		t.Fatalf("ready runtime should report the launched profile until restart, got %#v", metrics)
	}
}

func TestREQRUN004RuntimeMetricsDoesNotRoutePendingProfileWhileDownloading(t *testing.T) {
	profile := agent.ModelProfile{ID: "pending-profile", UpstreamModel: "pending-upstream", Version: 4}
	cfg := agent.Config{RuntimeModel: "pending-upstream", ActiveProfileIDs: []string{"pending-profile"}, Profiles: []agent.ModelProfile{profile}}
	manager := agent.NewRuntimeManager(agent.RuntimeCommand{Executable: "definitely-missing-llama-server-for-test"})
	manager.SetState("downloading")
	loadState := &runtimeLoadState{}
	loadState.SetStarting(profile)

	metrics := runtimeMetrics(manager, loadState, cfg, 0)

	if metrics.LoadedModel != "" || metrics.LoadedProfileID != "" || metrics.LoadedProfileVersion != 0 {
		t.Fatalf("downloading runtime should not report the pending profile as loaded, got %#v", metrics)
	}
}

func TestREQRUN003RuntimeMetricsMarksReadySelectedProfileLoaded(t *testing.T) {
	profile := agent.ModelProfile{ID: "selected-profile", UpstreamModel: "selected-upstream", Version: 3}
	cfg := agent.Config{RuntimeModel: "selected-upstream", ActiveProfileIDs: []string{"selected-profile"}, Profiles: []agent.ModelProfile{profile}}
	manager := agent.NewRuntimeManager(agent.RuntimeCommand{Executable: "definitely-missing-llama-server-for-test"})
	manager.SetState("ready")
	loadState := &runtimeLoadState{}
	loadState.SetStarting(profile)

	metrics := runtimeMetrics(manager, loadState, cfg, 0)

	if metrics.LoadedModel != "selected-upstream" || metrics.LoadedProfileID != "selected-profile" || metrics.LoadedProfileVersion != 3 {
		t.Fatalf("ready runtime should report the selected loaded profile, got %#v", metrics)
	}
}

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
