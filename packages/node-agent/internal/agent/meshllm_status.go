package agent

import (
	"encoding/json"
	"fmt"
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
	ServingModels    []string
	TokPerSec        float64
	InflightRequests int
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
			Stages []json.RawMessage `json:"stages"`
		} `json:"runtime"`
		Peers            []json.RawMessage `json:"peers"`
		ServingModels    []string          `json:"serving_models"`
		TokPerSec        float64           `json:"tok_per_sec"`
		InflightRequests int               `json:"inflight_requests"`
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
	if len(payload.Runtime.Stages) > 0 {
		var stage struct {
			NodeID string `json:"node_id"`
		}
		if err := json.Unmarshal(payload.Runtime.Stages[0], &stage); err == nil {
			status.StageZeroNodeID = stage.NodeID
		}
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
			if model == upstreamModel {
				return "ready"
			}
		}
	}
	// standby, client, serving-without-the-model, and any unknown pre-1.0
	// console state: the runtime is up but not serving the selected
	// profile — report starting so the node is never schedulable.
	return "starting"
}

// DeriveMeshRole derives the reported mesh role: coordinator exactly when
// this node owns stage 0 in console status, otherwise serving-peer while
// serving or loading a model, else api-client.
func DeriveMeshRole(st MeshLLMStatus, ownNodeID string) string {
	if ownNodeID != "" && st.StageZeroNodeID == ownNodeID {
		return "coordinator"
	}
	switch st.NodeState {
	case "serving", "loading":
		return "serving-peer"
	}
	return "api-client"
}

const MeshLLMStatusAnchors = "REQ-OBS-003 REQ-RUN-005 REQ-RUN-007"
