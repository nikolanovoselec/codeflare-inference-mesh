package agent

import (
	"slices"
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
				"--mesh-discovery-mode", "mdns",
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
				"serve",
				"--model", "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
				"--headless",
				"--mesh-discovery-mode", "mdns",
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
				"--mesh-discovery-mode", "mdns",
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
				"--mesh-discovery-mode", "mdns",
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
				"--mesh-discovery-mode", "mdns",
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
	forbidden := []string{"--publish", "--listen-all", "--auto", "--discover", "nostr"}
	for _, arg := range args {
		if slices.Contains(forbidden, arg) {
			t.Fatalf("form %s rendered forbidden argv element %q: %v", form, arg, args)
		}
	}
	if mode := argvValue(t, args, "--mesh-discovery-mode"); mode != "mdns" {
		t.Fatalf("form %s rendered discovery mode %q, want mdns", form, mode)
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
	if got := argvValue(t, args, "--mesh-discovery-mode"); got != "mdns" {
		t.Fatalf("--mesh-discovery-mode = %q, want mdns", got)
	}
}

func TestREQRUN003ContextLimitConfigRendering(t *testing.T) {
	cases := []struct {
		name          string
		modelRef      string
		contextWindow int
		want          string
	}{
		{
			name:          "positive context renders a models entry with name and ctx_size",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: 262144,
			want:          "[[models]]\nname = \"unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S\"\nctx_size = 262144\n",
		},
		{
			name:          "zero context renders nothing",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: 0,
			want:          "",
		},
		{
			name:          "negative context renders nothing",
			modelRef:      "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
			contextWindow: -1,
			want:          "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MeshLLMConfigTOML(tc.modelRef, tc.contextWindow); got != tc.want {
				t.Fatalf("MeshLLMConfigTOML = %q, want %q", got, tc.want)
			}
		})
	}

	withConfig := renderInputSeed()
	withConfig.ConfigPath = "/data/meshllm-mesh-default-qwen36-35b.toml"
	if got := argvValue(t, RenderMeshLLMArgs(withConfig), "--config"); got != "/data/meshllm-mesh-default-qwen36-35b.toml" {
		t.Fatalf("--config = %q, want the per-profile config path", got)
	}
	if args := RenderMeshLLMArgs(renderInputSeed()); slices.Contains(args, "--config") {
		t.Fatalf("empty config path must not render --config: %v", args)
	}
}

func TestREQRUN010MeshLLMEnvAppendsNoSelfUpdate(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HF_TOKEN=secret"}
	got := MeshLLMEnv(base)
	want := []string{"PATH=/usr/bin", "HF_TOKEN=secret", "MESH_LLM_NO_SELF_UPDATE=1"}
	if !slices.Equal(got, want) {
		t.Fatalf("MeshLLMEnv = %v, want %v", got, want)
	}
	if !slices.Equal(base, []string{"PATH=/usr/bin", "HF_TOKEN=secret"}) {
		t.Fatalf("MeshLLMEnv mutated its input: %v", base)
	}
	if empty := MeshLLMEnv(nil); !slices.Equal(empty, []string{"MESH_LLM_NO_SELF_UPDATE=1"}) {
		t.Fatalf("MeshLLMEnv(nil) = %v, want the self-update guard alone", empty)
	}
}
