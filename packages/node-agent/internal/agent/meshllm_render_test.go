package agent

import (
	"slices"
	"strings"
	"testing"
)

func renderInputSeed() MeshLLMRenderInput {
	return MeshLLMRenderInput{
		ProfileID:   "mesh-default-qwen36-35b",
		ModelRef:    "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
		Split:       false,
		BindPort:    4300,
		MeshIP:      "100.96.0.5",
		APIPort:     9337,
		ConsolePort: 3131,
		Rotation:    0,
	}
}

func renderInputJoiner() MeshLLMRenderInput {
	in := renderInputSeed()
	in.Rotation = 3
	in.MaxVramGb = 22.5
	in.Flavor = "cuda-12"
	in.ConfigPath = "/var/lib/inference-mesh/meshllm-mesh-default-qwen36-35b.toml"
	in.JoinTokens = []string{"join-token-one", "join-token-two"}
	return in
}

func renderInputSplitSeed() MeshLLMRenderInput {
	return MeshLLMRenderInput{
		ProfileID:   "mesh-split-qwen36-35b",
		ModelRef:    "hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@f00dfeed",
		Split:       true,
		BindPort:    4310,
		MeshIP:      "100.96.0.7",
		APIPort:     9337,
		ConsolePort: 3131,
		Rotation:    1,
	}
}

func renderInputSplitJoiner() MeshLLMRenderInput {
	in := renderInputSplitSeed()
	in.JoinTokens = []string{"split-token-one", "split-token-two"}
	return in
}

func allRenderForms() map[string]MeshLLMRenderInput {
	return map[string]MeshLLMRenderInput{
		"seed":         renderInputSeed(),
		"joiner":       renderInputJoiner(),
		"split seed":   renderInputSplitSeed(),
		"split joiner": renderInputSplitJoiner(),
	}
}

func argvValue(t *testing.T, args []string, flag string) string {
	t.Helper()
	for index, arg := range args {
		if arg == flag {
			if index+1 >= len(args) {
				t.Fatalf("flag %s has no value in %v", flag, args)
			}
			return args[index+1]
		}
	}
	t.Fatalf("flag %s missing from %v", flag, args)
	return ""
}

func TestREQRUN003RendererContract(t *testing.T) {
	rotated := renderInputSeed()
	rotated.Rotation = 7
	rotated.MaxVramGb = 24

	cases := []struct {
		name string
		in   MeshLLMRenderInput
		want []string
	}{
		{
			name: "seed renders the exact base argv",
			in:   renderInputSeed(),
			want: []string{
				"serve",
				"--model", "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
				"--headless",
				"--mesh-discovery-mode", "nostr",
				"--disable-iroh-relays",
				"--mesh-name", "codeflare-mesh-default-qwen36-35b-r0",
				"--bind-ip", "100.96.0.5",
				"--bind-port", "4300",
				"--port", "9337",
				"--console", "3131",
				"--log-format", "json",
			},
		},
		{
			name: "joiner renders optional flags and one --join per token in order",
			in:   renderInputJoiner(),
			want: []string{
				// joiner writes a per-profile config, so --model is omitted and the
				// config-owned [[models]] entry drives the startup load. REQ-RUN-003.
				"serve",
				"--headless",
				"--mesh-discovery-mode", "nostr",
				"--disable-iroh-relays",
				"--mesh-name", "codeflare-mesh-default-qwen36-35b-r3",
				"--bind-ip", "100.96.0.5",
				"--bind-port", "4300",
				"--port", "9337",
				"--console", "3131",
				"--max-vram", "22.5",
				"--llama-flavor", "cuda-12",
				"--config", "/var/lib/inference-mesh/meshllm-mesh-default-qwen36-35b.toml",
				"--log-format", "json",
				"--join", "join-token-one",
				"--join", "join-token-two",
			},
		},
		{
			name: "rotation changes only the mesh-name suffix and whole vram renders without decimals",
			in:   rotated,
			want: []string{
				"serve",
				"--model", "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
				"--headless",
				"--mesh-discovery-mode", "nostr",
				"--disable-iroh-relays",
				"--mesh-name", "codeflare-mesh-default-qwen36-35b-r7",
				"--bind-ip", "100.96.0.5",
				"--bind-port", "4300",
				"--port", "9337",
				"--console", "3131",
				"--max-vram", "24",
				"--log-format", "json",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RenderMeshLLMArgs(tc.in)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("argv mismatch\n got: %v\nwant: %v", got, tc.want)
			}
		})
	}
}

func TestREQRUN007SplitProfilesRenderModelAndSplitOnEveryNode(t *testing.T) {
	cases := []struct {
		name string
		in   MeshLLMRenderInput
		want []string
	}{
		{
			name: "split seed renders model and split",
			in:   renderInputSplitSeed(),
			want: []string{
				"serve",
				"--model", "hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@f00dfeed",
				"--split",
				"--headless",
				"--mesh-discovery-mode", "nostr",
				"--disable-iroh-relays",
				"--mesh-name", "codeflare-mesh-split-qwen36-35b-r1",
				"--bind-ip", "100.96.0.7",
				"--bind-port", "4310",
				"--port", "9337",
				"--console", "3131",
				"--log-format", "json",
			},
		},
		{
			name: "split joiner keeps model and split alongside join tokens",
			in:   renderInputSplitJoiner(),
			want: []string{
				"serve",
				"--model", "hf://meshllm/Qwen3.6-35B-A3B-UD-Q4_K_XL-layers@f00dfeed",
				"--split",
				"--headless",
				"--mesh-discovery-mode", "nostr",
				"--disable-iroh-relays",
				"--mesh-name", "codeflare-mesh-split-qwen36-35b-r1",
				"--bind-ip", "100.96.0.7",
				"--bind-port", "4310",
				"--port", "9337",
				"--console", "3131",
				"--log-format", "json",
				"--join", "split-token-one",
				"--join", "split-token-two",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RenderMeshLLMArgs(tc.in)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("argv mismatch\n got: %v\nwant: %v", got, tc.want)
			}
			if slices.Contains(got, "--join") {
				if !slices.Contains(got, "--split") || argvValue(t, got, "--model") == "" {
					t.Fatalf("joiner rendered a bare join without model and split: %v", got)
				}
			}
		})
	}
}

func assertNoForbiddenFlags(t *testing.T, form string, args []string) {
	t.Helper()
	// Public exposure/relay flags stay forbidden. Discovery is nostr (metadata-only rendezvous) while
	// iroh's data transport is pinned private with --disable-iroh-relays (no public relay/STUN fallback),
	// so inference data stays on the Cloudflare WARP overlay.
	forbidden := []string{"--publish", "--listen-all", "--auto", "--discover"}
	for _, arg := range args {
		if slices.Contains(forbidden, arg) {
			t.Fatalf("form %s rendered forbidden argv element %q: %v", form, arg, args)
		}
	}
	if mode := argvValue(t, args, "--mesh-discovery-mode"); mode != "nostr" {
		t.Fatalf("form %s rendered discovery mode %q, want nostr", form, mode)
	}
	if !slices.Contains(args, "--disable-iroh-relays") {
		t.Fatalf("form %s rendered without --disable-iroh-relays (iroh data must stay WARP-private): %v", form, args)
	}
}

func TestREQRUN003RendererForbidsPublicDiscoveryFlags(t *testing.T) {
	for form, in := range allRenderForms() {
		assertNoForbiddenFlags(t, form, RenderMeshLLMArgs(in))
	}
}

func TestREQSEC004ArgvListForbidsPublicExposureFlags(t *testing.T) {
	for form, in := range allRenderForms() {
		assertNoForbiddenFlags(t, form, RenderMeshLLMArgs(in))
	}
}

func TestREQSEC004RendererEnforcesHeadlessMode(t *testing.T) {
	for form, in := range allRenderForms() {
		args := RenderMeshLLMArgs(in)
		if !slices.Contains(args, "--headless") {
			t.Fatalf("form %s rendered without --headless: %v", form, args)
		}
	}
}

func TestREQRUN006BindsMeshIPSoTokensEmbedDialableAddresses(t *testing.T) {
	in := renderInputSeed()
	in.MeshIP = "100.96.12.34"
	args := RenderMeshLLMArgs(in)
	if got := argvValue(t, args, "--bind-ip"); got != "100.96.12.34" {
		t.Fatalf("--bind-ip = %q, want the node Mesh IP 100.96.12.34", got)
	}
	if got := argvValue(t, args, "--bind-port"); got != "4300" {
		t.Fatalf("--bind-port = %q, want the profile bind port 4300", got)
	}
	if got := argvValue(t, args, "--mesh-discovery-mode"); got != "nostr" {
		t.Fatalf("--mesh-discovery-mode = %q, want nostr", got)
	}
}

func TestREQSEC004NostrRelaysAppendWhenConfiguredOnly(t *testing.T) {
	if args := RenderMeshLLMArgs(renderInputSeed()); slices.Contains(args, "--nostr-relay") {
		t.Fatalf("no configured relays must not render --nostr-relay (mesh-llm public defaults apply): %v", args)
	}
	in := renderInputSeed()
	in.NostrRelays = []string{"wss://relay.example.one", "wss://relay.example.two"}
	args := RenderMeshLLMArgs(in)
	var relays []string
	for index, arg := range args {
		if arg == "--nostr-relay" && index+1 < len(args) {
			relays = append(relays, args[index+1])
		}
	}
	if !slices.Equal(relays, []string{"wss://relay.example.one", "wss://relay.example.two"}) {
		t.Fatalf("configured relays must render one --nostr-relay each in order, got %v in %v", relays, args)
	}
}

// REQ-RUN-014: MeshLLM config rendering and unset-value omission are covered here.
func TestREQRUN014SplitProfilesRenderWarpTransportDefaults(t *testing.T) {
	// The stage lane rides the WARP overlay, so split profiles always carry the
	// WARP-optimized staged-transport defaults; single-node profiles never do.
	split := MeshLLMConfigTOML(MeshLLMRenderInput{ModelRef: "meshllm/E-layers", Split: true}, 0)
	if !strings.Contains(split, "[models.skippy]") || !strings.Contains(split, "activation_wire_dtype = \"q8\"") || !strings.Contains(split, "prefill_chunking = \"adaptive-ramp\"") {
		t.Fatalf("split profile must render WARP transport defaults, got:\n%s", split)
	}
	single := MeshLLMConfigTOML(MeshLLMRenderInput{ModelRef: "meshllm/E"}, 0)
	if strings.Contains(single, "skippy") {
		t.Fatalf("single-node profile must not render the skippy table, got:\n%s", single)
	}
	// Explicit tunables beat the split defaults, and chunk size renders when set.
	tuned := MeshLLMConfigTOML(MeshLLMRenderInput{ModelRef: "meshllm/E-layers", Split: true, Tunables: MeshLLMSettings{WireDtype: "f16", PrefillChunking: "fixed", PrefillChunkSize: 256}}, 0)
	if !strings.Contains(tuned, "activation_wire_dtype = \"f16\"") || !strings.Contains(tuned, "prefill_chunking = \"fixed\"") || !strings.Contains(tuned, "prefill_chunk_size = 256") {
		t.Fatalf("explicit staged-transport tunables must override the defaults, got:\n%s", tuned)
	}
	// A single-node profile renders the table only when explicitly tuned.
	singleTuned := MeshLLMConfigTOML(MeshLLMRenderInput{ModelRef: "meshllm/E", Tunables: MeshLLMSettings{WireDtype: "q8"}}, 0)
	if !strings.Contains(singleTuned, "activation_wire_dtype = \"q8\"") {
		t.Fatalf("explicit wire dtype must render for single-node profiles, got:\n%s", singleTuned)
	}
}

func TestREQRUN014ContextLimitConfigRendering(t *testing.T) {
	on := true
	off := false
	cases := []struct {
		name          string
		modelRef      string
		contextWindow int
		tunables      MeshLLMSettings
		want          string
	}{
		{
			name:          "positive context renders a models entry with model field and model_fit ctx_size",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: 262144,
			want:          "[[models]]\nmodel = \"unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S\"\n\n[models.model_fit]\nctx_size = 262144\n",
		},
		{
			name:          "zero context and no tunables renders nothing",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: 0,
			want:          "",
		},
		{
			name:          "negative context and no tunables renders nothing",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: -1,
			want:          "",
		},
		{
			name:          "tunables render under model_fit, throughput, and request_defaults when context is auto",
			modelRef:      "unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K",
			contextWindow: 0,
			tunables: MeshLLMSettings{
				Parallel:        4,
				CacheTypeK:      "q8_0",
				CacheTypeV:      "q8_0",
				Batch:           2048,
				Ubatch:          512,
				FlashAttn:       &on,
				MaxOutputTokens: 4096,
				Reasoning:       &ReasoningSettings{Enabled: &on, Format: "deepseek", Budget: 4096},
			},
			want: "[[models]]\nmodel = \"unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K\"\n\n[models.model_fit]\nbatch = 2048\nubatch = 512\ncache_type_k = \"q8_0\"\ncache_type_v = \"q8_0\"\nflash_attention = \"enabled\"\n\n[models.throughput]\nparallel = 4\n\n[models.request_defaults]\nmax_tokens = 4096\nreasoning_enabled = true\nreasoning_format = \"deepseek\"\nreasoning_budget = 4096\n",
		},
		{
			name:          "pinned context and lanes render together with quantized kv",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: 262144,
			tunables:      MeshLLMSettings{Parallel: 2, CacheTypeK: "q4_0", CacheTypeV: "q4_0"},
			want:          "[[models]]\nmodel = \"unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S\"\n\n[models.model_fit]\nctx_size = 262144\ncache_type_k = \"q4_0\"\ncache_type_v = \"q4_0\"\n\n[models.throughput]\nparallel = 2\n",
		},
		{
			name:          "prefix cache renders payload and shared tuning as a model_fit subtable before throughput",
			modelRef:      "unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K",
			contextWindow: 0,
			tunables: MeshLLMSettings{
				Parallel:    4,
				Batch:       2048,
				PrefixCache: &PrefixCacheSettings{Enabled: &on, MaxEntries: 16, PayloadMode: "kv-recurrent", SharedStrideTokens: 128, SharedRecordLimit: 4},
			},
			want: "[[models]]\nmodel = \"unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K\"\n\n[models.model_fit]\nbatch = 2048\n\n[models.model_fit.prefix_cache]\nenabled = true\nmax_entries = 16\npayload_mode = \"kv-recurrent\"\nshared_stride_tokens = 128\nshared_record_limit = 4\n\n[models.throughput]\nparallel = 4\n",
		},
		{
			name:          "prefix cache disabled renders enabled false",
			modelRef:      "unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K",
			contextWindow: 0,
			tunables:      MeshLLMSettings{Batch: 2048, PrefixCache: &PrefixCacheSettings{Enabled: &off}},
			want:          "[[models]]\nmodel = \"unsloth/Qwen3.5-4B-MTP-GGUF:Q6_K\"\n\n[models.model_fit]\nbatch = 2048\n\n[models.model_fit.prefix_cache]\nenabled = false\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := MeshLLMConfigTOML(MeshLLMRenderInput{ModelRef: tc.modelRef, Tunables: tc.tunables}, tc.contextWindow)
			if got != tc.want {
				t.Fatalf("MeshLLMConfigTOML = %q, want %q", got, tc.want)
			}
		})
	}

	withConfig := renderInputSeed()
	withConfig.ConfigPath = "/data/meshllm-mesh-default-qwen36-35b.toml"
	if got := argvValue(t, RenderMeshLLMArgs(withConfig), "--config"); got != "/data/meshllm-mesh-default-qwen36-35b.toml" {
		t.Fatalf("--config = %q, want the per-profile config path", got)
	}
	// A written config owns the startup [[models]] entry; passing --model would make mesh-llm
	// take the CLI startup path and discard config model_fit (ctx_size, cache_type, batch,
	// parallel), so it must be absent when ConfigPath is set. REQ-RUN-003.
	if args := RenderMeshLLMArgs(withConfig); slices.Contains(args, "--model") {
		t.Fatalf("config-owned startup must not render --model: %v", args)
	}
	if args := RenderMeshLLMArgs(renderInputSeed()); !slices.Contains(args, "--model") {
		t.Fatalf("configless profile must render --model: %v", args)
	}
	if args := RenderMeshLLMArgs(renderInputSeed()); slices.Contains(args, "--config") {
		t.Fatalf("empty config path must not render --config: %v", args)
	}
}

func TestREQRUN010MeshLLMEnvAppendsNoSelfUpdate(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HF_TOKEN=secret"}
	got := MeshLLMEnv(base, false)
	want := []string{"PATH=/usr/bin", "HF_TOKEN=secret", "MESH_LLM_NO_SELF_UPDATE=1"}
	if !slices.Equal(got, want) {
		t.Fatalf("MeshLLMEnv = %v, want %v", got, want)
	}
	if !slices.Equal(base, []string{"PATH=/usr/bin", "HF_TOKEN=secret"}) {
		t.Fatalf("MeshLLMEnv mutated its input: %v", base)
	}
	forced := MeshLLMEnv(base, true)
	if !slices.Equal(forced, append(want, "MESH_FORCE_TOOL_EMULATION=1")) {
		t.Fatalf("forced tool emulation must append the mesh-llm override, got %v", forced)
	}
	if empty := MeshLLMEnv(nil, false); !slices.Equal(empty, []string{"MESH_LLM_NO_SELF_UPDATE=1"}) {
		t.Fatalf("MeshLLMEnv(nil) = %v, want the self-update guard alone", empty)
	}
}
