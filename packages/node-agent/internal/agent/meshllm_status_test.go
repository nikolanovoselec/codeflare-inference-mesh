package agent

import (
	"reflect"
	"slices"
	"testing"
)

const fullStatusFixture = `{
	"node_id": "node-abc",
	"node_state": "serving",
	"llama_ready": true,
	"publication_state": "private",
	"load_pct": 42.5,
	"future_unknown_field": {"nested": [1, 2, 3]},
	"runtime": {
		"stages": [
			{"node_id": "node-abc", "layers": "0-15", "future": true},
			{"node_id": "node-def", "layers": "16-31"}
		],
		"other": "ignored"
	},
	"peers": [
		{"node_id": "node-def", "tok_per_sec": 11.5, "rtt_ms": 3, "vram_gb": 24, "version": "0.72.2"},
		{"node_id": "node-ghi", "tok_per_sec": 9.1, "rtt_ms": 5, "vram_gb": 16, "version": "0.72.2"}
	],
	"serving_models": ["unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S"],
	"models": ["unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S"],
	"token": "invite-token-xyz",
	"mesh_id": "mesh-123",
	"tok_per_sec": 20.6,
	"inflight_requests": 2,
	"version": "0.72.2"
}`

func TestREQOBS003ParsesMeshLLMStatus(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		want    MeshLLMStatus
		wantErr bool
	}{
		{
			name: "full payload with extra unknown fields decodes the subset",
			body: fullStatusFixture,
			want: MeshLLMStatus{
				NodeID:           "node-abc",
				NodeState:        "serving",
				MeshID:           "mesh-123",
				Token:            "invite-token-xyz",
				Version:          "0.72.2",
				PeerCount:        2,
				StageCount:       2,
				StageZeroNodeID:  "node-abc",
				ServingModels:    []string{"unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S"},
				TokPerSec:        20.6,
				InflightRequests: 2,
			},
		},
		{
			name: "empty object yields zero values without error",
			body: `{}`,
			want: MeshLLMStatus{},
		},
		{
			name: "missing optional fields keep zero values",
			body: `{"node_id": "node-1", "node_state": "standby"}`,
			want: MeshLLMStatus{NodeID: "node-1", NodeState: "standby"},
		},
		{
			name: "gpus array decodes rated and used VRAM",
			body: `{"node_id":"n","gpus":[{"name":"RTX 4090","rated_vram_gb":24,"used_vram_gb":8}]}`,
			want: MeshLLMStatus{NodeID: "n", GPUs: []GPUStatus{{Name: "RTX 4090", RatedVRAMGB: 24, UsedVRAMGB: 8}}},
		},
		{
			name:    "truncated JSON errors",
			body:    `{"node_state":`,
			wantErr: true,
		},
		{
			name:    "non-object JSON errors",
			body:    `[1, 2, 3]`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseMeshLLMStatus([]byte(tc.body))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ParseMeshLLMStatus(%q) = %+v, want error", tc.body, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseMeshLLMStatus returned error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("status mismatch\n got: %+v\nwant: %+v", got, tc.want)
			}
		})
	}
}

func TestREQRUN005ParseModelsResponseExtractsIds(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		want    []string
		wantErr bool
	}{
		{
			name: "openai models list yields data ids",
			body: `{"object": "list", "data": [
				{"id": "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S", "object": "model", "created": 1750000000, "owned_by": "meshllm"},
				{"id": "unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M"}
			]}`,
			want: []string{
				"unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
				"unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
			},
		},
		{
			name: "entries without id are skipped",
			body: `{"data": [{"object": "model"}, {"id": "model-a"}]}`,
			want: []string{"model-a"},
		},
		{
			name: "empty object yields no ids without error",
			body: `{}`,
			want: []string{},
		},
		{
			name:    "garbage errors",
			body:    `not-json`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseModelsResponse([]byte(tc.body))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ParseModelsResponse(%q) = %v, want error", tc.body, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseModelsResponse returned error: %v", err)
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("ids mismatch\n got: %v\nwant: %v", got, tc.want)
			}
		})
	}
}

func TestREQOBS008MapsMeshLLMNodeStates(t *testing.T) {
	const upstream = "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S"
	cases := []struct {
		name             string
		nodeState        string
		servingModels    []string
		processAlive     bool
		consoleReachable bool
		want             string
	}{
		{
			name:             "loading maps to downloading",
			nodeState:        "loading",
			processAlive:     true,
			consoleReachable: true,
			want:             "downloading",
		},
		{
			name:             "serving with the upstream model routable maps to ready",
			nodeState:        "serving",
			servingModels:    []string{"other-model", upstream},
			processAlive:     true,
			consoleReachable: true,
			want:             "ready",
		},
		{
			name:             "serving without the upstream model stays starting",
			nodeState:        "serving",
			servingModels:    []string{"other-model"},
			processAlive:     true,
			consoleReachable: true,
			want:             "starting",
		},
		{
			name:             "standby maps to starting",
			nodeState:        "standby",
			processAlive:     true,
			consoleReachable: true,
			want:             "starting",
		},
		{
			name:             "client stays non-schedulable as starting",
			nodeState:        "client",
			processAlive:     true,
			consoleReachable: true,
			want:             "starting",
		},
		{
			name:             "unknown future console state stays non-schedulable as starting",
			nodeState:        "warping",
			processAlive:     true,
			consoleReachable: true,
			want:             "starting",
		},
		{
			name:             "dead process maps to failed even when status says serving",
			nodeState:        "serving",
			servingModels:    []string{upstream},
			processAlive:     false,
			consoleReachable: true,
			want:             "failed",
		},
		{
			name:             "unreachable console maps to failed even when status says serving",
			nodeState:        "serving",
			servingModels:    []string{upstream},
			processAlive:     true,
			consoleReachable: false,
			want:             "failed",
		},
		{
			name:             "dead process and unreachable console map to failed while loading",
			nodeState:        "loading",
			processAlive:     false,
			consoleReachable: false,
			want:             "failed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := MeshLLMStatus{NodeState: tc.nodeState, ServingModels: tc.servingModels}
			got := MapMeshLLMState(st, upstream, tc.processAlive, tc.consoleReachable)
			if got != tc.want {
				t.Fatalf("MapMeshLLMState(%s, alive=%t, console=%t) = %q, want %q",
					tc.nodeState, tc.processAlive, tc.consoleReachable, got, tc.want)
			}
		})
	}
}

func TestREQRUN007DerivesCoordinatorFromStageZeroOwnership(t *testing.T) {
	cases := []struct {
		name            string
		stageZeroNodeID string
		nodeState       string
		ownNodeID       string
		want            string
	}{
		{
			name:            "stage zero owner is coordinator",
			stageZeroNodeID: "node-abc",
			nodeState:       "serving",
			ownNodeID:       "node-abc",
			want:            "coordinator",
		},
		{
			name:            "stage zero owner is coordinator even while loading",
			stageZeroNodeID: "node-abc",
			nodeState:       "loading",
			ownNodeID:       "node-abc",
			want:            "coordinator",
		},
		{
			name:            "serving non-owner is serving-peer",
			stageZeroNodeID: "node-abc",
			nodeState:       "serving",
			ownNodeID:       "node-def",
			want:            "serving-peer",
		},
		{
			name:            "loading non-owner is serving-peer",
			stageZeroNodeID: "node-abc",
			nodeState:       "loading",
			ownNodeID:       "node-def",
			want:            "serving-peer",
		},
		{
			name:            "standby non-owner is api-client",
			stageZeroNodeID: "node-abc",
			nodeState:       "standby",
			ownNodeID:       "node-def",
			want:            "api-client",
		},
		{
			name:            "client state is api-client",
			stageZeroNodeID: "",
			nodeState:       "client",
			ownNodeID:       "node-def",
			want:            "api-client",
		},
		{
			name:            "empty ids never claim coordinator",
			stageZeroNodeID: "",
			nodeState:       "standby",
			ownNodeID:       "",
			want:            "api-client",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := MeshLLMStatus{StageZeroNodeID: tc.stageZeroNodeID, NodeState: tc.nodeState}
			got := DeriveMeshRole(st, tc.ownNodeID)
			if got != tc.want {
				t.Fatalf("DeriveMeshRole(stage0=%q, state=%s, own=%q) = %q, want %q",
					tc.stageZeroNodeID, tc.nodeState, tc.ownNodeID, got, tc.want)
			}
		})
	}
}
