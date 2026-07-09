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
			{"stage_id":"stage-0","stage_index":0,"node_id":"node-abc","layer_start":0,"layer_end":15,"state":"ready","backend":"llama.cpp","bind_addr":"100.96.0.26:4420","selected_device":{"backend_device":"cuda:0"},"future": true},
			{"stage_id":"stage-1","stage_index":1,"node_id":"node-def","layer_start":16,"layer_end":31,"state":"ready","backend":"metal","bind_addr":"100.96.0.14:4420"}
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
				Stages: []MeshLLMStage{
					{StageID: "stage-0", StageIndex: 0, NodeID: "node-abc", LayerStart: 0, LayerEnd: 15, State: "ready", Backend: "llama.cpp", BindAddr: "100.96.0.26:4420", SelectedDevice: "cuda:0"},
					{StageID: "stage-1", StageIndex: 1, NodeID: "node-def", LayerStart: 16, LayerEnd: 31, State: "ready", Backend: "metal", BindAddr: "100.96.0.14:4420"},
				},
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

func TestREQOBS007ParsesSplitReadinessCapacityShortfall(t *testing.T) {
	body := `{
		"model_ref":"meshllm/ERNIE-layers",
		"verdict":"insufficient_capacity",
		"participant_count":2,
		"exclusion_count":0,
		"active_topology_count":0,
		"active_stage_count":0,
		"capacity_advice":{
			"state":"insufficient_capacity",
			"reason":"participant_split_capacity_insufficient",
			"required_bytes":18000000000,
			"best_single_node_capacity_bytes":12000000000,
			"aggregate_capacity_bytes":16000000000,
			"shortfall_bytes":2000000000,
			"eligible_node_count":2,
			"split_capable":true
		},
		"participants":[
			{"node_id":"mac-node","short_node_id":"Mac","source":"peer","role":"worker","vram_bytes":4000000000,"artifact_transfer_supported":true,"rtt_ms":36,"model_source_state":"available"},
			{"node_id":"battle-node","short_node_id":"battle","source":"local","role":"worker","vram_bytes":12000000000,"artifact_transfer_supported":true,"model_source_state":"available"}
		],
		"blockers":[{"reason":"split_capacity_shortfall","count":2,"short_node_ids":["Mac","battle"],"recommendation":"Increase available VRAM."}],
		"recommendations":["Increase max-vram or add another worker."]
	}`

	got, err := ParseMeshLLMSplitReadiness([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if got.Verdict != "insufficient_capacity" || got.CapacityAdvice == nil || got.CapacityAdvice.ShortfallBytes != 2_000_000_000 {
		t.Fatalf("capacity shortfall not decoded: %#v", got)
	}
	if len(got.Participants) != 2 || got.Participants[0].ShortNodeID != "Mac" || got.Participants[0].RTTMs == nil || *got.Participants[0].RTTMs != 36 {
		t.Fatalf("participants not decoded: %#v", got.Participants)
	}
	if len(got.Blockers) != 1 || got.Blockers[0].Reason != "split_capacity_shortfall" {
		t.Fatalf("blockers not decoded: %#v", got.Blockers)
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

func TestREQOBS008ServingModelRefMatchIsLenient(t *testing.T) {
	const gemmableLong = "Mia-AiLab/Gemmable-4-12B-MTP-GGUF:gemmable-4-12b-Q8_0"
	const gemmableShort = "Mia-AiLab/Gemmable-4-12B-MTP-GGUF:Q8_0"
	cases := []struct {
		name          string
		upstream      string
		servingModels []string
		want          string
	}{
		{
			name:          "console normalized quant tag still matches the profile file-tag ref",
			upstream:      gemmableLong,
			servingModels: []string{"other-model", gemmableShort},
			want:          "ready",
		},
		{
			name:          "match holds in the reverse direction too",
			upstream:      gemmableShort,
			servingModels: []string{gemmableLong},
			want:          "ready",
		},
		{
			name:          "exact ref still matches",
			upstream:      gemmableShort,
			servingModels: []string{gemmableShort},
			want:          "ready",
		},
		{
			name:          "same repo but a different quant never matches",
			upstream:      "Mia-AiLab/Gemmable-4-12B-MTP-GGUF:Q8_0",
			servingModels: []string{"Mia-AiLab/Gemmable-4-12B-MTP-GGUF:Q4_K_M"},
			want:          "starting",
		},
		{
			name:          "quant suffix without a delimiter does not collide (IQ4_XS vs Q4_XS)",
			upstream:      "owner/repo-GGUF:IQ4_XS",
			servingModels: []string{"owner/repo-GGUF:Q4_XS"},
			want:          "starting",
		},
		{
			name:          "same quant but a different repo never matches",
			upstream:      "owner/repo-a-GGUF:Q8_0",
			servingModels: []string{"owner/repo-b-GGUF:Q8_0"},
			want:          "starting",
		},
		{
			name:          "scheme refs match only exactly, not by quant heuristics",
			upstream:      "hf://meshllm/Model-UD-Q4_K_XL-layers@abc",
			servingModels: []string{"hf://meshllm/Model-UD-Q4_K_XL-layers@def"},
			want:          "starting",
		},
		{
			name:          "exact scheme ref matches",
			upstream:      "hf://meshllm/Model-UD-Q4_K_XL-layers@abc",
			servingModels: []string{"hf://meshllm/Model-UD-Q4_K_XL-layers@abc"},
			want:          "ready",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := MeshLLMStatus{NodeState: "serving", ServingModels: tc.servingModels}
			got := MapMeshLLMState(st, tc.upstream, true, true)
			if got != tc.want {
				t.Fatalf("MapMeshLLMState(serving, upstream=%q, models=%v) = %q, want %q",
					tc.upstream, tc.servingModels, got, tc.want)
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
		stages          []MeshLLMStage
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
			name:            "standby stage owner is serving-peer",
			stageZeroNodeID: "node-abc",
			nodeState:       "standby",
			ownNodeID:       "node-def",
			stages:          []MeshLLMStage{{StageIndex: 1, NodeID: "node-def", LayerStart: 27, LayerEnd: 28, State: "ready"}},
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
			st := MeshLLMStatus{StageZeroNodeID: tc.stageZeroNodeID, NodeState: tc.nodeState, Stages: tc.stages}
			got := DeriveMeshRole(st, tc.ownNodeID)
			if got != tc.want {
				t.Fatalf("DeriveMeshRole(stage0=%q, state=%s, own=%q) = %q, want %q",
					tc.stageZeroNodeID, tc.nodeState, tc.ownNodeID, got, tc.want)
			}
		})
	}
}
