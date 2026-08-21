// A split mesh that never finishes waiting for peers heals itself, once.
//
// Part of the agent command; see main.go for the entry point.
package main

import (
	"fmt"
	"strings"

	"github.com/nikolanovoselec/codeflare-inference-mesh/packages/node-agent/internal/agent"
)

func (s *serviceLoop) meshWaitSelfHeal(cfg agent.Config, bootstrap *agent.MeshBootstrap) bool {
	profile, ok := agent.SelectedProfile(cfg)
	if !ok || profile.Runtime == "llamacpp" || !profile.MeshLLM.Split || bootstrap == nil {
		s.resetMeshWaitSelfHeal()
		return false
	}
	if bootstrap.Action != "create" && bootstrap.Action != "join" {
		s.resetMeshWaitSelfHeal()
		return false
	}
	metrics := s.lastMetrics
	if !meshWaitStuck(metrics) {
		s.resetMeshWaitSelfHeal()
		return false
	}
	key := selectedProfileKey(cfg) + "|" + bootstrap.Action + "|" + bootstrap.MeshID + "|" + fmt.Sprint(bootstrap.Rotation)
	if key != s.meshWaitSelfHealKey {
		s.meshWaitSelfHealKey = key
		s.meshWaitSelfHealTicks = 1
		s.meshWaitSelfHealDone = false
		return false
	}
	if s.meshWaitSelfHealDone {
		return false
	}
	s.meshWaitSelfHealTicks++
	if s.meshWaitSelfHealTicks < 2 {
		return false
	}
	s.meshWaitSelfHealDone = true
	return true
}

func (s *serviceLoop) resetMeshWaitSelfHeal() {
	s.meshWaitSelfHealKey = ""
	s.meshWaitSelfHealTicks = 0
	s.meshWaitSelfHealDone = false
}

func meshWaitStuck(metrics agent.NodeMetrics) bool {
	if !metrics.SplitEnabled || metrics.ActiveRequests > 0 {
		return false
	}
	if metrics.SplitReadiness != nil {
		verdict := strings.ToLower(metrics.SplitReadiness.Verdict)
		reason := ""
		if len(metrics.SplitReadiness.Blockers) > 0 {
			reason = strings.ToLower(metrics.SplitReadiness.Blockers[0].Reason)
		} else if metrics.SplitReadiness.CapacityAdvice != nil {
			reason = strings.ToLower(metrics.SplitReadiness.CapacityAdvice.Reason)
		}
		servingEvidence := len(metrics.ReadyModels) > 0 || (metrics.StageCount > 0 && metrics.APIReady && metrics.ConsoleReady)
		if verdict == "waiting_for_peers" || reason == "waiting_for_peers" || ((verdict == "model_size_unknown" || reason == "model_size_unknown") && !servingEvidence) {
			return true
		}
	}
	state := strings.ToLower(metrics.RuntimeState)
	nodeState := strings.ToLower(metrics.NodeState)
	return (state == "starting" || state == "ready" || state == "running") && nodeState == "standby" && metrics.PeerCount == 0 && metrics.StageCount == 0
}
