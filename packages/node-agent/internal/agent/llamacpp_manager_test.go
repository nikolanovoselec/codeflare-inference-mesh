package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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

// Auto context (0) must pass through as --ctx-size 0, llama-server's "load the
// model's native training context" sentinel — never a fabricated fixed size. REQ-RUN-015.
func TestREQRUN015LlamaCppRenderArgsAutoContext(t *testing.T) {
	args := RenderLlamaCppArgs(LlamaCppInput{
		UpstreamModel: "unsloth/Code-Model-GGUF:Q4_K_M",
		Settings: LlamaCppSettings{
			HFRepo:        "unsloth/Code-Model-GGUF",
			Quant:         "Q4_K_M",
			BindPort:      4300,
			ContextWindow: 0,
		},
	})
	if !containsArgSequence(joinArgs(args), "--ctx-size 0") {
		t.Fatalf("Auto context must render --ctx-size 0, got %q", joinArgs(args))
	}
}

type fakeLlamaMetrics struct {
	mu     sync.Mutex
	body   string
	broken bool
}

func (f *fakeLlamaMetrics) set(prompt float64, predicted float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.body = "# HELP llamacpp:prompt_tokens_total number of prompt tokens processed\n" +
		fmt.Sprintf("llamacpp:prompt_tokens_total %g\n", prompt) +
		"llamacpp:requests_processing 0\n" +
		fmt.Sprintf("llamacpp:tokens_predicted_total %g\n", predicted)
	f.broken = false
}

func (f *fakeLlamaMetrics) fail() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broken = true
}

func (f *fakeLlamaMetrics) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path != "/metrics" || f.broken {
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	_, _ = w.Write([]byte(f.body))
}

func portOf(t *testing.T, rawURL string) int {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func throughputManager(t *testing.T, fake *fakeLlamaMetrics) (*LlamaCppManager, *time.Time) {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	manager := NewLlamaCppManager(LlamaCppInput{
		UpstreamModel: "unsloth/Test-GGUF:Q4",
		Settings:      LlamaCppSettings{BindPort: portOf(t, server.URL)},
	})
	now := time.Unix(1_700_000_000, 0)
	manager.nowFn = func() time.Time { return now }
	return manager, &now
}

func TestREQOBS009LlamaCppLiveThroughputFromCounterDeltas(t *testing.T) {
	fake := &fakeLlamaMetrics{}
	fake.set(1000, 100)
	manager, now := throughputManager(t, fake)

	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 || metrics.TokensPerSecond != 0 {
		t.Fatalf("seed poll must not fabricate rates: %+v", metrics)
	}

	fake.set(1000+33450, 100+1845)
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	metrics := manager.Metrics()
	if metrics.PromptTokensPerSecond != 2230 {
		t.Fatalf("prompt rate = %v, want 2230", metrics.PromptTokensPerSecond)
	}
	if metrics.GenerationTokensPerSecond != 123 {
		t.Fatalf("generation rate = %v, want 123", metrics.GenerationTokensPerSecond)
	}
	if metrics.TokensPerSecond != 123 {
		t.Fatalf("aggregate tok/s must ride the generation rate, got %v", metrics.TokensPerSecond)
	}

	// An idle window reports zero, never the previous burst.
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.GenerationTokensPerSecond != 0 || metrics.TokensPerSecond != 0 {
		t.Fatalf("idle window must decay to zero: %+v", metrics)
	}
}

func TestREQOBS009LlamaCppThroughputResetsOnRestartAndFailure(t *testing.T) {
	fake := &fakeLlamaMetrics{}
	fake.set(5000, 500)
	manager, now := throughputManager(t, fake)
	manager.PollThroughput(context.Background())

	// Counters going backwards mean llama-server restarted: zero rates, reseed.
	fake.set(100, 10)
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 {
		t.Fatalf("restart must not produce negative-delta rates: %+v", metrics)
	}
	fake.set(400, 40)
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 20 || metrics.GenerationTokensPerSecond != 2 {
		t.Fatalf("post-restart deltas must compute from the reseeded counters: %+v", metrics)
	}

	// A failed poll zeroes the rates and forces a reseed so the next good sample
	// never pairs with pre-failure counters.
	fake.fail()
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 {
		t.Fatalf("failed poll must zero the rates: %+v", metrics)
	}
	fake.set(700, 70)
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 {
		t.Fatalf("first poll after a failure must reseed, not compute a bogus delta: %+v", metrics)
	}
}
