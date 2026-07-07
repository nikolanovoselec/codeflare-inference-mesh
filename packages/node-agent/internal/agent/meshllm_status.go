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
	ServingModels    []string
	TokPerSec        float64
	InflightRequests int
	GPUs             []GPUStatus
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
