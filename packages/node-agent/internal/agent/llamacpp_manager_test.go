package agent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestREQLLAMACPPRenderArgsIncludesCacheAndAlias(t *testing.T) {
	enabled := true
	flash := true
	args := RenderLlamaCppArgs(LlamaCppInput{
		UpstreamModel: "unsloth/Code-Model-GGUF:Q4_K_M",
		Settings: LlamaCppSettings{
			HFRepo:          "unsloth/Code-Model-GGUF",
			Quant:           "Q4_K_M",
			BindPort:        4300,
			ContextWindow:   262144,
			Parallel:        2,
			CachePrompt:     true,
			CacheReuse:      256,
			CacheTypeK:      "q8_0",
			CacheTypeV:      "q8_0",
			Batch:           8192,
			Ubatch:          2048,
			FlashAttn:       &flash,
			MaxOutputTokens: 8192,
			GPULayers:       "99",
			Reasoning:       &ReasoningSettings{Enabled: &enabled, Format: "deepseek", Budget: 4096},
		},
	})
	joined := joinArgs(args)
	for _, want := range []string{"--alias unsloth/Code-Model-GGUF:Q4_K_M", "--hf-repo unsloth/Code-Model-GGUF:Q4_K_M", "--ctx-size 262144", "--parallel 2", "--cache-type-k q8_0", "--cache-type-v q8_0", "--batch-size 8192", "--ubatch-size 2048", "--flash-attn on", "--predict 8192", "--gpu-layers 99", "--cache-prompt", "--cache-reuse 256", "--slots", "--metrics", "--jinja", "--reasoning on", "--reasoning-format deepseek", "--reasoning-budget 4096"} {
		if !containsArgSequence(joined, want) {
			t.Fatalf("rendered args missing %q in %q", want, joined)
		}
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
