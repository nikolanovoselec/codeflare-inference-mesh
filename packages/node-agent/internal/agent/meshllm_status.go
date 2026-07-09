package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

// MeshLLMStatus is the tolerant subset of the MeshLLM console
// `GET /api/status` payload the agent consumes. The upstream shape is
// pre-1.0, so decoding reads only these fields and ignores everything
// else. Prompt-versus-generation throughput splits are not exposed by the
// console and are deliberately absent — never fabricated.
type MeshLLMStatus struct {
	NodeID           string
	NodeState        string
	MeshID           string
	Token            string
	Version          string
	PeerCount        int
	StageCount       int
	StageZeroNodeID  string
	Stages           []MeshLLMStage
	ServingModels    []string
	TokPerSec        float64
	InflightRequests int
	GPUs             []GPUStatus
}

type MeshLLMStage struct {
	StageID        string `json:"stageId,omitempty"`
	StageIndex     int    `json:"stageIndex"`
	NodeID         string `json:"nodeId,omitempty"`
	LayerStart     int    `json:"layerStart"`
	LayerEnd       int    `json:"layerEnd"`
	State          string `json:"state,omitempty"`
	Backend        string `json:"backend,omitempty"`
	BindAddr       string `json:"bindAddr,omitempty"`
	SelectedDevice string `json:"selectedDevice,omitempty"`
}

// GPUStatus is the tolerant subset of a MeshLLM `gpus[]` entry the agent reads.
// Rated VRAM is the card's total; used VRAM is optional. The bogus top-level
// `my_vram_gb` field is deliberately ignored — only structured per-GPU rated
// memory is trusted.
type GPUStatus struct {
	Name        string
	RatedVRAMGB float64
	UsedVRAMGB  float64
}

// MeshLLMSplitReadiness is the tolerant subset of MeshLLM's
// `GET /api/diagnostics/split-readiness?model_ref=...` report. It carries the
// operator-facing reason a split model is not serving, especially capacity shortfalls
// that are invisible in the generic /api/status runtime state.
type MeshLLMSplitReadiness struct {
	ModelRef            string                         `json:"modelRef,omitempty"`
	Verdict             string                         `json:"verdict,omitempty"`
	ParticipantCount    int                            `json:"participantCount,omitempty"`
	ExclusionCount      int                            `json:"exclusionCount,omitempty"`
	ActiveTopologyCount int                            `json:"activeTopologyCount,omitempty"`
	ActiveStageCount    int                            `json:"activeStageCount,omitempty"`
	CapacityAdvice      *MeshLLMSplitCapacityAdvice    `json:"capacityAdvice,omitempty"`
	Participants        []MeshLLMSplitParticipant      `json:"participants,omitempty"`
	Blockers            []MeshLLMSplitReadinessBlocker `json:"blockers,omitempty"`
	Recommendations     []string                       `json:"recommendations,omitempty"`
}

type MeshLLMSplitCapacityAdvice struct {
	State                       string `json:"state,omitempty"`
	Reason                      string `json:"reason,omitempty"`
	RequiredBytes               uint64 `json:"requiredBytes,omitempty"`
	BestSingleNodeCapacityBytes uint64 `json:"bestSingleNodeCapacityBytes,omitempty"`
	AggregateCapacityBytes      uint64 `json:"aggregateCapacityBytes,omitempty"`
	ShortfallBytes              uint64 `json:"shortfallBytes,omitempty"`
	EligibleNodeCount           int    `json:"eligibleNodeCount,omitempty"`
	MissingCapacityNodeCount    int    `json:"missingCapacityNodeCount,omitempty"`
	ExcludedClientNodeCount     int    `json:"excludedClientNodeCount,omitempty"`
	SplitCapable                bool   `json:"splitCapable,omitempty"`
}

type MeshLLMSplitParticipant struct {
	NodeID                    string `json:"nodeId,omitempty"`
	ShortNodeID               string `json:"shortNodeId,omitempty"`
	Source                    string `json:"source,omitempty"`
	Role                      string `json:"role,omitempty"`
	VRAMBytes                 uint64 `json:"vramBytes,omitempty"`
	ArtifactTransferSupported bool   `json:"artifactTransferSupported,omitempty"`
	RTTMs                     *int   `json:"rttMs,omitempty"`
	ModelSourceState          string `json:"modelSourceState,omitempty"`
}

type MeshLLMSplitReadinessBlocker struct {
	Reason         string   `json:"reason,omitempty"`
	Count          int      `json:"count,omitempty"`
	ShortNodeIDs   []string `json:"shortNodeIds,omitempty"`
	Recommendation string   `json:"recommendation,omitempty"`
}

// ParseMeshLLMStatus decodes a console status body into the tolerant
// subset. Unknown fields are ignored, missing optional fields keep zero
// values, and non-JSON input returns an error. Stage 0 is the first entry
// of `runtime.stages`; peers and stages are counted without depending on
// their element shape.
func ParseMeshLLMStatus(body []byte) (MeshLLMStatus, error) {
	var payload struct {
		NodeID    string `json:"node_id"`
		NodeState string `json:"node_state"`
		MeshID    string `json:"mesh_id"`
		Token     string `json:"token"`
		Version   string `json:"version"`
		Runtime   struct {
			Stages []struct {
				StageID       string `json:"stage_id"`
				StageIndex    int    `json:"stage_index"`
				NodeID        string `json:"node_id"`
				LayerStart    int    `json:"layer_start"`
				LayerEnd      int    `json:"layer_end"`
				State         string `json:"state"`
				Backend       string `json:"backend"`
				BindAddr      string `json:"bind_addr"`
				SelectedDevice *struct {
					BackendDevice string `json:"backend_device"`
					StableID      string `json:"stable_id"`
				} `json:"selected_device"`
			} `json:"stages"`
		} `json:"runtime"`
		Peers            []json.RawMessage `json:"peers"`
		ServingModels    []string          `json:"serving_models"`
		TokPerSec        float64           `json:"tok_per_sec"`
		InflightRequests int               `json:"inflight_requests"`
		GPUs             []struct {
			Name        string  `json:"name"`
			RatedVRAMGB float64 `json:"rated_vram_gb"`
			UsedVRAMGB  float64 `json:"used_vram_gb"`
		} `json:"gpus"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return MeshLLMStatus{}, fmt.Errorf("parse meshllm status: %w", err)
	}
	status := MeshLLMStatus{
		NodeID:           payload.NodeID,
		NodeState:        payload.NodeState,
		MeshID:           payload.MeshID,
		Token:            payload.Token,
		Version:          payload.Version,
		PeerCount:        len(payload.Peers),
		StageCount:       len(payload.Runtime.Stages),
		ServingModels:    payload.ServingModels,
		TokPerSec:        payload.TokPerSec,
		InflightRequests: payload.InflightRequests,
	}
	for _, gpu := range payload.GPUs {
		status.GPUs = append(status.GPUs, GPUStatus{Name: gpu.Name, RatedVRAMGB: gpu.RatedVRAMGB, UsedVRAMGB: gpu.UsedVRAMGB})
	}
	for _, stage := range payload.Runtime.Stages {
		selected := ""
		if stage.SelectedDevice != nil {
			selected = stage.SelectedDevice.BackendDevice
			if selected == "" {
				selected = stage.SelectedDevice.StableID
			}
		}
		status.Stages = append(status.Stages, MeshLLMStage{StageID: stage.StageID, StageIndex: stage.StageIndex, NodeID: stage.NodeID, LayerStart: stage.LayerStart, LayerEnd: stage.LayerEnd, State: stage.State, Backend: stage.Backend, BindAddr: stage.BindAddr, SelectedDevice: selected})
	}
	if len(status.Stages) > 0 {
		status.StageZeroNodeID = status.Stages[0].NodeID
	}
	return status, nil
}

// ParseModelsResponse extracts the model ids from an OpenAI-compatible
// `/v1/models` response body (`data[].id`). Entries without an id are
// skipped; non-JSON input returns an error.
func ParseModelsResponse(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("parse models response: %w", err)
	}
	ids := make([]string, 0, len(payload.Data))
	for _, model := range payload.Data {
		if model.ID != "" {
			ids = append(ids, model.ID)
		}
	}
	return ids, nil
}

// ParseMeshLLMSplitReadiness decodes the MeshLLM split diagnostic endpoint into
// the camelCase heartbeat shape the router and Admin UI consume.
func ParseMeshLLMSplitReadiness(body []byte) (MeshLLMSplitReadiness, error) {
	var payload struct {
		ModelRef            string `json:"model_ref"`
		Verdict             string `json:"verdict"`
		ParticipantCount    int    `json:"participant_count"`
		ExclusionCount      int    `json:"exclusion_count"`
		ActiveTopologyCount int    `json:"active_topology_count"`
		ActiveStageCount    int    `json:"active_stage_count"`
		CapacityAdvice      *struct {
			State                       string `json:"state"`
			Reason                      string `json:"reason"`
			RequiredBytes               uint64 `json:"required_bytes"`
			BestSingleNodeCapacityBytes uint64 `json:"best_single_node_capacity_bytes"`
			AggregateCapacityBytes      uint64 `json:"aggregate_capacity_bytes"`
			ShortfallBytes              uint64 `json:"shortfall_bytes"`
			EligibleNodeCount           int    `json:"eligible_node_count"`
			MissingCapacityNodeCount    int    `json:"missing_capacity_node_count"`
			ExcludedClientNodeCount     int    `json:"excluded_client_node_count"`
			SplitCapable                bool   `json:"split_capable"`
		} `json:"capacity_advice"`
		Participants []struct {
			NodeID                    string `json:"node_id"`
			ShortNodeID               string `json:"short_node_id"`
			Source                    string `json:"source"`
			Role                      string `json:"role"`
			VRAMBytes                 uint64 `json:"vram_bytes"`
			ArtifactTransferSupported bool   `json:"artifact_transfer_supported"`
			RTTMs                     *int   `json:"rtt_ms"`
			ModelSourceState          string `json:"model_source_state"`
		} `json:"participants"`
		Blockers []struct {
			Reason         string   `json:"reason"`
			Count          int      `json:"count"`
			ShortNodeIDs   []string `json:"short_node_ids"`
			Recommendation string   `json:"recommendation"`
		} `json:"blockers"`
		Recommendations []string `json:"recommendations"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return MeshLLMSplitReadiness{}, fmt.Errorf("parse meshllm split readiness: %w", err)
	}
	report := MeshLLMSplitReadiness{
		ModelRef:            payload.ModelRef,
		Verdict:             payload.Verdict,
		ParticipantCount:    payload.ParticipantCount,
		ExclusionCount:      payload.ExclusionCount,
		ActiveTopologyCount: payload.ActiveTopologyCount,
		ActiveStageCount:    payload.ActiveStageCount,
		Recommendations:     append([]string(nil), payload.Recommendations...),
	}
	if payload.CapacityAdvice != nil {
		report.CapacityAdvice = &MeshLLMSplitCapacityAdvice{
			State:                       payload.CapacityAdvice.State,
			Reason:                      payload.CapacityAdvice.Reason,
			RequiredBytes:               payload.CapacityAdvice.RequiredBytes,
			BestSingleNodeCapacityBytes: payload.CapacityAdvice.BestSingleNodeCapacityBytes,
			AggregateCapacityBytes:      payload.CapacityAdvice.AggregateCapacityBytes,
			ShortfallBytes:              payload.CapacityAdvice.ShortfallBytes,
			EligibleNodeCount:           payload.CapacityAdvice.EligibleNodeCount,
			MissingCapacityNodeCount:    payload.CapacityAdvice.MissingCapacityNodeCount,
			ExcludedClientNodeCount:     payload.CapacityAdvice.ExcludedClientNodeCount,
			SplitCapable:                payload.CapacityAdvice.SplitCapable,
		}
	}
	for _, participant := range payload.Participants {
		report.Participants = append(report.Participants, MeshLLMSplitParticipant{
			NodeID:                    participant.NodeID,
			ShortNodeID:               participant.ShortNodeID,
			Source:                    participant.Source,
			Role:                      participant.Role,
			VRAMBytes:                 participant.VRAMBytes,
			ArtifactTransferSupported: participant.ArtifactTransferSupported,
			RTTMs:                     participant.RTTMs,
			ModelSourceState:          participant.ModelSourceState,
		})
	}
	for _, blocker := range payload.Blockers {
		report.Blockers = append(report.Blockers, MeshLLMSplitReadinessBlocker{
			Reason:         blocker.Reason,
			Count:          blocker.Count,
			ShortNodeIDs:   append([]string(nil), blocker.ShortNodeIDs...),
			Recommendation: blocker.Recommendation,
		})
	}
	return report, nil
}

// MapMeshLLMState maps console node state onto the agent runtime state
// vocabulary. A dead process or an unreachable console (after the
// manager's grace period) is failed regardless of the last status text.
// `loading` maps to downloading; `serving` is ready only while the
// selected profile's upstream model is routable in the status model list.
func MapMeshLLMState(st MeshLLMStatus, upstreamModel string, processAlive, consoleReachable bool) string {
	if !processAlive || !consoleReachable {
		return "failed"
	}
	switch st.NodeState {
	case "loading":
		return "downloading"
	case "serving":
		for _, model := range st.ServingModels {
			if modelRefMatches(model, upstreamModel) {
				return "ready"
			}
		}
	}
	// standby, client, serving-without-the-model, and any unknown pre-1.0
	// console state: the runtime is up but not serving the selected
	// profile — report starting so the node is never schedulable.
	return "starting"
}

// modelRefMatches reports whether a serving-model id reported by the console/API
// identifies the same model as the profile's expected upstream ref. An exact
// match always wins. Otherwise, for Hugging Face `owner/repo:quant` refs, the
// repo must match exactly and the quant tags must be equal or differ only by a
// leading model-name segment: mesh-llm normalizes a file-name-style quant tag
// (e.g. "gemmable-4-12b-Q8_0") down to the bare quant it serves ("Q8_0"), which
// would otherwise leave a correctly-serving node stuck reporting "starting" and
// never schedulable. The `-`-delimited suffix guard keeps distinct quants such
// as "IQ4_XS" and "Q4_XS" from colliding, and scheme refs / quant-less refs fall
// back to exact matching only.
func modelRefMatches(served, expected string) bool {
	if served == expected {
		return true
	}
	servedRepo, servedQuant, servedOK := splitHFModelRef(served)
	expectedRepo, expectedQuant, expectedOK := splitHFModelRef(expected)
	if !servedOK || !expectedOK || servedRepo != expectedRepo {
		return false
	}
	servedQuant = strings.ToLower(servedQuant)
	expectedQuant = strings.ToLower(expectedQuant)
	if servedQuant == expectedQuant {
		return true
	}
	return strings.HasSuffix(servedQuant, "-"+expectedQuant) || strings.HasSuffix(expectedQuant, "-"+servedQuant)
}

// splitHFModelRef splits an `owner/repo:quant` Hugging Face GGUF ref into its
// repo and quant parts. Scheme refs (containing "://", e.g. hf:// layer
// packages) and refs without a trailing quant are rejected so callers fall back
// to exact matching.
func splitHFModelRef(ref string) (repo, quant string, ok bool) {
	if strings.Contains(ref, "://") {
		return "", "", false
	}
	idx := strings.LastIndex(ref, ":")
	if idx <= 0 || idx == len(ref)-1 {
		return "", "", false
	}
	return ref[:idx], ref[idx+1:], true
}

// DeriveMeshRole derives the reported mesh role: coordinator exactly when
// this node owns stage 0 in console status, stage owner when it owns any
// other stage, otherwise serving-peer while serving or loading a model, else
// api-client.
func DeriveMeshRole(st MeshLLMStatus, ownNodeID string) string {
	if ownNodeID != "" && st.StageZeroNodeID == ownNodeID {
		return "coordinator"
	}
	if ownNodeID != "" {
		for _, stage := range st.Stages {
			if stage.NodeID == ownNodeID {
				return "serving-peer"
			}
		}
	}
	switch st.NodeState {
	case "serving", "loading":
		return "serving-peer"
	}
	return "api-client"
}

const MeshLLMStatusAnchors = "REQ-OBS-003 REQ-RUN-005 REQ-RUN-007"
