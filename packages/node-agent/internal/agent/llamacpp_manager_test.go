package agent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestREQRUN015LlamaCppRenderArgsIncludesCacheAndAlias(t *testing.T) {
	enabled := true
	flash := true
	args := RenderLlamaCppArgs(LlamaCppInput{
		UpstreamModel: "unsloth/Code-Model-GGUF:Q4_K_M",
		Settings: LlamaCppSettings{
			HFRepo:          "unsloth/Code-Model-GGUF",
			Quant:           "Q4_K_M",
			BindPort:        4300,
			ContextWindow:   262144,
			Parallel:        4,
			CachePrompt:     true,
			CacheReuse:      256,
			CacheTypeK:      "q4_0",
			CacheTypeV:      "q4_0",
			Batch:           8192,
			Ubatch:          2048,
			FlashAttn:       &flash,
			MaxOutputTokens: 16384,
			GPULayers:       "99",
			Reasoning:       &ReasoningSettings{Enabled: &enabled, Format: "deepseek", Budget: 8192},
		},
	})
	joined := joinArgs(args)
	for _, want := range []string{"--alias unsloth/Code-Model-GGUF:Q4_K_M", "--hf-repo unsloth/Code-Model-GGUF:Q4_K_M", "--ctx-size 262144", "--parallel 4", "--cache-type-k q4_0", "--cache-type-v q4_0", "--batch-size 8192", "--ubatch-size 2048", "--flash-attn on", "--predict 16384", "--gpu-layers 99", "--cache-prompt", "--cache-reuse 256", "--slots", "--metrics", "--jinja", "--reasoning on", "--reasoning-format deepseek", "--reasoning-budget 8192"} {
		if !containsArgSequence(joined, want) {
			t.Fatalf("rendered args missing %q in %q", want, joined)
		}
	}
	if !hasExactArg(args, "--kv-unified") || hasExactArg(args, "--no-kv-unified") {
		t.Fatalf("an absent kvUnified must render --kv-unified, got %q", joined)
	}
}

func TestREQRUN015LlamaCppRenderArgsKVUnifiedAndAutoParallel(t *testing.T) {
	settings := LlamaCppSettings{
		HFRepo:        "unsloth/Code-Model-GGUF",
		BindPort:      4300,
		ContextWindow: 262144,
		Parallel:      -1,
		CacheReuse:    256,
	}
	args := RenderLlamaCppArgs(LlamaCppInput{UpstreamModel: "m", Settings: settings})
	if !containsArgSequence(joinArgs(args), "--parallel -1") {
		t.Fatalf("auto parallel must pass through as -1, got %v", args)
	}
	if !hasExactArg(args, "--kv-unified") || hasExactArg(args, "--no-kv-unified") {
		t.Fatalf("auto parallel render must enable unified KV, got %v", args)
	}

	off := false
	settings.KVUnified = &off
	settings.Parallel = 4
	args = RenderLlamaCppArgs(LlamaCppInput{UpstreamModel: "m", Settings: settings})
	if !hasExactArg(args, "--no-kv-unified") || hasExactArg(args, "--kv-unified") {
		t.Fatalf("explicit off must render --no-kv-unified, got %v", args)
	}
}

func TestREQNODE013LlamaCppLaunchEnvIncludesRuntimeLibraryPath(t *testing.T) {
	env := llamaCppRuntimeEnv([]string{"PATH=/usr/bin", "LD_LIBRARY_PATH=/usr/lib"}, "/var/lib/inference-mesh/bin/llama-server")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "LD_LIBRARY_PATH=/var/lib/inference-mesh/bin") {
		t.Fatalf("LD_LIBRARY_PATH missing managed runtime dir in %q", joined)
	}
	if !strings.Contains(joined, "PATH=/var/lib/inference-mesh/bin") {
		t.Fatalf("PATH missing managed runtime dir in %q", joined)
	}
}

func TestREQNODE003ProxyReadsRuntimeTargetPerRequest(t *testing.T) {
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("x-target", "first") }))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("x-target", "second") }))
	defer second.Close()
	provider := &mutableTarget{url: first.URL}
	handler, err := ProxyHandler(provider, "secret")
	if err != nil {
		t.Fatal(err)
	}
	call := func() string {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		req.Header.Set("authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Header().Get("x-target")
	}
	if got := call(); got != "first" {
		t.Fatalf("first target = %q", got)
	}
	provider.url = second.URL
	if got := call(); got != "second" {
		t.Fatalf("second target = %q", got)
	}
}

type mutableTarget struct{ url string }

func (m *mutableTarget) TargetURL() string { return m.url }

func joinArgs(args []string) string {
	out := ""
	for i, arg := range args {
		if i > 0 {
			out += " "
		}
		out += arg
	}
	return out
}

func containsArgSequence(joined string, want string) bool {
	return strings.Contains(joined, want)
}

// hasExactArg matches a whole argv element; --kv-unified is a substring of
// --no-kv-unified, so substring matching cannot tell the two flags apart.
func hasExactArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
