// Which profile is loading or loaded, how a profile is keyed, and draining before a swap.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

type runtimeLoadState struct {
	mu      sync.RWMutex
	profile agent.ModelProfile
	loaded  bool
}

func (s *runtimeLoadState) SetStarting(profile agent.ModelProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profile = profile
	s.loaded = false
}

func (s *runtimeLoadState) Set(profile agent.ModelProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profile = profile
	s.loaded = true
}

func (s *runtimeLoadState) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profile = agent.ModelProfile{}
	s.loaded = false
}

func (s *runtimeLoadState) Snapshot() (agent.ModelProfile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.profile, s.loaded
}

func (s *runtimeLoadState) Key() string {
	profile, loaded := s.Snapshot()
	if !loaded {
		return ""
	}
	return profileKey(profile)
}

// TargetKey is the profile the runtime is loading or has loaded, regardless of
// whether the load finished. It lets the reconciler tell "busy loading the
// profile we still want" (skip) apart from "busy loading a profile we no longer
// want" (preempt), so a mid-download switch is not starved until the download ends.
func (s *runtimeLoadState) TargetKey() string {
	profile, _ := s.Snapshot()
	if profile.ID == "" {
		return ""
	}
	return profileKey(profile)
}

func selectedProfileKey(cfg agent.Config) string {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok {
		return ""
	}
	return profileKey(profile)
}

func profileKey(profile agent.ModelProfile) string {
	launch := struct {
		Runtime       string
		ID            string
		Version       int
		UpstreamModel string
		ContextWindow int
		MeshLLM       agent.MeshLLMSettings
		LlamaCpp      agent.LlamaCppSettings
	}{
		Runtime:       profile.Runtime,
		ID:            profile.ID,
		Version:       profile.Version,
		UpstreamModel: profile.UpstreamModel,
		ContextWindow: profile.ContextWindow,
		MeshLLM:       profile.MeshLLM,
		LlamaCpp:      profile.LlamaCpp,
	}
	encoded, err := json.Marshal(launch)
	if err != nil {
		return fmt.Sprintf("%s:%s:%d", profile.Runtime, profile.ID, profile.Version)
	}
	return string(encoded)
}

func waitForDrain(ctx context.Context, activeRequests *agent.ActiveCounter, manager meshRuntime, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	// Drain both the local proxy counter and the MeshLLM console's own
	// inflight_requests. The proxy counter releases a request once it has
	// relayed the upstream response, but MeshLLM can still be generating for a
	// request the proxy already let go; waiting on the console count too keeps a
	// restart or SIGTERM from landing mid-inference. The proxy check short
	// circuits the console poll while local traffic is still in flight.
	for activeRequests.Value() > 0 || meshLLMInflight(deadline, manager) > 0 {
		select {
		case <-deadline.Done():
			return deadline.Err()
		case <-ticker.C:
		}
	}
	return nil
}

// meshLLMInflight reports the MeshLLM console's current inflight_requests, or 0
// when the runtime is absent or its console is unreachable. An unobservable
// console contributes no backpressure so drain still completes on the proxy
// counter and the outer timeout.
func meshLLMInflight(ctx context.Context, manager meshRuntime) int {
	if manager == nil {
		return 0
	}
	status, reachable := manager.PollStatus(ctx)
	if !reachable {
		return 0
	}
	return status.InflightRequests
}

func shutdownServer(server *http.Server) {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}
