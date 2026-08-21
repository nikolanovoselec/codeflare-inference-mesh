package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestREQRUN022VllmRenderArgsCoreContract(t *testing.T) {
	args := RenderVllmArgs(VllmInput{
		UpstreamModel: "org/model-awq",
		Settings: VllmSettings{
			HfRepo:               "org/model-awq",
			BindPort:             4400,
			ContextWindow:        32768,
			MaxNumSeqs:           8,
			GpuMemoryUtilization: 0.85,
			Dtype:                "half",
			Quantization:         "awq",
		},
	})
	if len(args) < 2 || args[0] != "serve" || args[1] != "org/model-awq" {
		t.Fatalf("argv must start with `serve <hfRepo>`, got %v", args)
	}
	joined := joinArgs(args)
	for _, want := range []string{
		"--host 127.0.0.1",
		"--port 4400",
		"--served-model-name org/model-awq",
		"--max-model-len 32768",
		"--max-num-seqs 8",
		"--gpu-memory-utilization 0.85",
		"--dtype half",
		"--quantization awq",
		"--disable-access-log-for-endpoints /health,/metrics",
	} {
		if !containsArgSequence(joined, want) {
			t.Fatalf("rendered args missing %q in %q", want, joined)
		}
	}
}

func TestREQRUN022VllmRenderArgsOmitsUnsetTunables(t *testing.T) {
	// Auto context (0) and unset optional tunables must be omitted entirely so
	// vLLM's own defaults rule; a fabricated flag value would silently override
	// the engine's model-derived choices. REQ-RUN-022.
	args := RenderVllmArgs(VllmInput{
		UpstreamModel: "org/model",
		Settings:      VllmSettings{HfRepo: "org/model", BindPort: 4400},
	})
	joined := joinArgs(args)
	for _, banned := range []string{"--max-model-len", "--max-num-seqs", "--gpu-memory-utilization", "--dtype", "--quantization"} {
		if hasExactArg(args, banned) {
			t.Fatalf("unset tunable must not render %q, got %q", banned, joined)
		}
	}
}

func TestREQSEC013VllmRenderArgsAlwaysBindsLoopback(t *testing.T) {
	// vLLM's upstream default binds every interface, and its /metrics and
	// /invocations endpoints ignore --api-key; the loopback bind is the security
	// boundary and must be hardcoded, not settings-driven. REQ-SEC-013.
	for name, in := range map[string]VllmInput{
		"empty settings": {UpstreamModel: "m"},
		"full settings":  {UpstreamModel: "m", Settings: VllmSettings{HfRepo: "org/m", BindPort: 4400, ContextWindow: 8192}},
	} {
		args := RenderVllmArgs(in)
		bound := ""
		for i, arg := range args {
			if arg == "--host" && i+1 < len(args) {
				bound = args[i+1]
			}
		}
		if bound != "127.0.0.1" {
			t.Fatalf("%s: --host must be pinned to 127.0.0.1, got %q in %v", name, bound, args)
		}
	}
}

func TestREQNODE017VllmLaunchEnvPinsCachesUnderDataDir(t *testing.T) {
	env := vllmRuntimeEnvFor(
		[]string{"PATH=/usr/bin", "HF_HOME=/root/.cache/huggingface"},
		"/var/lib/inference-mesh/runtimes/vllm/current/venv/bin/vllm",
		"/var/lib/inference-mesh")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "HF_HOME=/var/lib/inference-mesh/.cache/huggingface") {
		t.Fatalf("HF_HOME not pinned under dataDir in %q", joined)
	}
	if strings.Contains(joined, "HF_HOME=/var/lib/inference-mesh/.cache/huggingface:/root/.cache/huggingface") {
		t.Fatalf("HF_HOME must replace the inherited value, not prepend to it: %q", joined)
	}
	if !strings.Contains(joined, "VLLM_CACHE_ROOT=/var/lib/inference-mesh/.cache/vllm") {
		t.Fatalf("VLLM_CACHE_ROOT not pinned under dataDir in %q", joined)
	}
	if !strings.Contains(joined, "VLLM_LOGGING_STREAM=ext://sys.stderr") {
		t.Fatalf("vLLM logs default to stdout; the stderr redirect feeds the shared runtime ring, missing in %q", joined)
	}
	if !strings.Contains(joined, "PATH=/var/lib/inference-mesh/runtimes/vllm/current/venv/bin") {
		t.Fatalf("PATH must lead with the venv bin dir in %q", joined)
	}
}

func TestREQRUN022VllmManagerIdentityAndTarget(t *testing.T) {
	manager := NewVllmManager(VllmInput{
		ProfileID:      "p-vllm",
		ProfileVersion: 3,
		UpstreamModel:  "org/model",
		Settings:       VllmSettings{HfRepo: "org/model", BindPort: 4411, ContextWindow: 8192},
	})
	if manager.Runtime() != "vllm" {
		t.Fatalf("Runtime() = %q", manager.Runtime())
	}
	if manager.TargetURL() != "http://127.0.0.1:4411" {
		t.Fatalf("TargetURL() = %q", manager.TargetURL())
	}
	metrics := manager.Metrics()
	if metrics.RuntimeKind != "vllm" {
		t.Fatalf("metrics runtime kind = %q", metrics.RuntimeKind)
	}
	if metrics.LoadedProfileID != "p-vllm" || metrics.LoadedProfileVersion != 3 {
		t.Fatalf("metrics must carry profile bookkeeping, got %+v", metrics)
	}
	var runtimeManager RuntimeManager = manager
	_ = runtimeManager
}

func TestREQRUN022VllmReadinessTreatsConnectionRefusedAsLoading(t *testing.T) {
	// vLLM binds its socket before loading weights but does not listen until the
	// engine is up, so probes see connection-refused for the whole (possibly very
	// long) first load. Refused must mean "still loading", never "failed"; the
	// runtime flips ready once /v1/models serves the served-model-name. REQ-RUN-022.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	manager := NewVllmManager(VllmInput{
		UpstreamModel: "org/model",
		Settings:      VllmSettings{HfRepo: "org/model", BindPort: port},
	})
	manager.pollInterval = 5 * time.Millisecond
	manager.SetState("starting")
	proc := newFakeMeshProcess(&eventLog{})
	manager.proc = proc
	exit := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		manager.awaitReadiness(proc, exit)
		close(done)
	}()

	time.Sleep(60 * time.Millisecond)
	if got := manager.State(); got != "starting" {
		t.Fatalf("connection-refused polls must keep the runtime loading, got state %q", got)
	}

	models := &modelsFixture{ids: []string{"org/model"}}
	var server *httptest.Server
	for attempt := 0; attempt < 200; attempt++ {
		rebind, listenErr := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if listenErr == nil {
			server = &httptest.Server{Listener: rebind, Config: &http.Server{Handler: models}}
			server.Start()
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if server == nil {
		t.Fatal("could not rebind the runtime port for the ready phase")
	}
	t.Cleanup(server.Close)

	deadline := time.Now().Add(5 * time.Second)
	for manager.State() != "ready" {
		if time.Now().After(deadline) {
			t.Fatalf("runtime never reached ready once the API began serving, state %q", manager.State())
		}
		time.Sleep(5 * time.Millisecond)
	}
	<-done
	if !manager.APIReady() {
		t.Fatal("ready runtime must report APIReady")
	}
	if models := manager.ReadyModels(); len(models) != 1 || models[0] != "org/model" {
		t.Fatalf("ready models = %v", models)
	}
}

func TestREQRUN022VllmReadinessDeadlineFailsClosed(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	manager := NewVllmManager(VllmInput{
		UpstreamModel: "org/model",
		Settings:      VllmSettings{HfRepo: "org/model", BindPort: port},
	})
	manager.pollInterval = 5 * time.Millisecond
	manager.readinessTimeout = 50 * time.Millisecond
	manager.SetState("starting")
	proc := newFakeMeshProcess(&eventLog{})
	manager.proc = proc
	exit := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		manager.awaitReadiness(proc, exit)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("readiness loop never returned after its deadline")
	}
	if got := manager.State(); got != "failed" {
		t.Fatalf("expired readiness deadline must fail the runtime, got %q", got)
	}
	if !strings.Contains(manager.LastError(), "readiness") {
		t.Fatalf("failure must name the readiness deadline, got %q", manager.LastError())
	}
}

func TestREQRUN022VllmExitBeforeReadinessFailsRuntime(t *testing.T) {
	// An engine crash during load exits the whole vLLM process. The readiness
	// loop must fail the runtime on that exit immediately — not let the crash
	// masquerade as a slow model download until the flat deadline. REQ-RUN-022.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	manager := NewVllmManager(VllmInput{
		UpstreamModel: "org/model",
		Settings:      VllmSettings{HfRepo: "org/model", BindPort: port},
	})
	manager.pollInterval = 5 * time.Millisecond
	manager.readinessTimeout = time.Hour // only the exit may fail the runtime here
	manager.SetState("starting")
	proc := newFakeMeshProcess(&eventLog{})
	manager.proc = proc
	exit := make(chan error, 1)
	exit <- errors.New("engine OOM")
	finished := make(chan struct{})
	go func() {
		manager.awaitReadiness(proc, exit)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("readiness loop never returned after the process exit")
	}
	if got := manager.State(); got != "failed" {
		t.Fatalf("an exit before readiness must fail the runtime, got %q", got)
	}
	if !strings.Contains(manager.LastError(), "exited before readiness") {
		t.Fatalf("failure must name the pre-readiness exit, got %q", manager.LastError())
	}
	select {
	case <-exit:
	default:
		t.Fatal("the exit result must be re-buffered for the stop path")
	}
}

func TestREQRUN010StopDuringConcurrentStopFailsLoudly(t *testing.T) {
	// A Stop that finds another Stop mid-shutdown must not report success: a
	// restart would swap input and "start" over the still-terminating process,
	// never relaunching with the new argv. REQ-RUN-010.
	manager := NewVllmManager(VllmInput{UpstreamModel: "org/model"})
	manager.proc = newFakeMeshProcess(&eventLog{})
	manager.done = nil
	if err := manager.Stop(context.Background()); !errors.Is(err, errStopInProgress) {
		t.Fatalf("Stop during a concurrent stop = %v, want errStopInProgress", err)
	}
}

func TestREQOBS014VllmMetricsParserAcceptsTotalSuffixAndLabels(t *testing.T) {
	// The exposition appends _total to counters and labels every series; the
	// parser must read both spellings and only the served model's series, so an
	// upstream naming change or a co-resident model never zeroes or pollutes
	// throughput. REQ-OBS-014 / REQ-OBS-009.
	exposition := "# TYPE vllm:num_requests_running gauge\n" +
		"vllm:num_requests_running{engine=\"0\",model_name=\"org/model\"} 2\n" +
		"vllm:num_requests_waiting{engine=\"0\",model_name=\"org/model\"} 1\n" +
		// An unconsumed series in the exposition must be skipped, never break the parse.
		"vllm:kv_cache_usage_perc{engine=\"0\",model_name=\"org/model\"} 0.42\n" +
		"vllm:prompt_tokens_total{engine=\"0\",model_name=\"org/model\"} 1200\n" +
		"vllm:generation_tokens_total{engine=\"0\",model_name=\"org/model\"} 340\n" +
		"vllm:num_requests_running{engine=\"0\",model_name=\"other/model\"} 9\n" +
		"vllm:prompt_tokens_total{engine=\"0\",model_name=\"other/model\"} 99999\n"
	sample, ok := parseVllmMetrics(strings.NewReader(exposition), "org/model")
	if !ok {
		t.Fatal("labeled _total exposition must parse")
	}
	if sample.Running != 2 || sample.Waiting != 1 {
		t.Fatalf("queue gauges = running %d waiting %d", sample.Running, sample.Waiting)
	}
	if sample.PromptTokens != 1200 || sample.GenerationTokens != 340 {
		t.Fatalf("token counters = prompt %v generation %v (another model's series must not leak in)", sample.PromptTokens, sample.GenerationTokens)
	}

	bare, ok := parseVllmMetrics(strings.NewReader(
		"vllm:prompt_tokens{model_name=\"org/model\"} 50\n"+
			"vllm:generation_tokens{model_name=\"org/model\"} 20\n"), "org/model")
	if !ok || bare.PromptTokens != 50 || bare.GenerationTokens != 20 {
		t.Fatalf("bare counter names must also parse, got %+v ok=%v", bare, ok)
	}
}

type fakeVllmMetrics struct {
	mu     sync.Mutex
	body   string
	broken bool
}

func (f *fakeVllmMetrics) set(model string, running int, waiting int, prompt float64, generation float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.body = fmt.Sprintf("vllm:num_requests_running{model_name=%q} %d\n", model, running) +
		fmt.Sprintf("vllm:num_requests_waiting{model_name=%q} %d\n", model, waiting) +
		fmt.Sprintf("vllm:prompt_tokens_total{model_name=%q} %g\n", model, prompt) +
		fmt.Sprintf("vllm:generation_tokens_total{model_name=%q} %g\n", model, generation)
	f.broken = false
}

func (f *fakeVllmMetrics) fail() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broken = true
}

func (f *fakeVllmMetrics) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path != "/metrics" || f.broken {
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	_, _ = w.Write([]byte(f.body))
}

func vllmThroughputManager(t *testing.T, fake *fakeVllmMetrics) (*VllmManager, *time.Time) {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	manager := NewVllmManager(VllmInput{
		UpstreamModel: "org/model",
		Settings:      VllmSettings{HfRepo: "org/model", BindPort: portOf(t, server.URL)},
	})
	now := time.Unix(1_700_000_000, 0)
	manager.nowFn = func() time.Time { return now }
	return manager, &now
}

func TestREQOBS009VllmLiveThroughputFromCounterDeltas(t *testing.T) {
	fake := &fakeVllmMetrics{}
	fake.set("org/model", 0, 0, 1000, 100)
	manager, now := vllmThroughputManager(t, fake)

	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 {
		t.Fatalf("seed poll must not fabricate rates: %+v", metrics)
	}

	fake.set("org/model", 0, 0, 1000+3000, 100+150)
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	metrics := manager.Metrics()
	if metrics.PromptTokensPerSecond != 200 {
		t.Fatalf("prompt rate = %v, want 200", metrics.PromptTokensPerSecond)
	}
	if metrics.GenerationTokensPerSecond != 10 {
		t.Fatalf("generation rate = %v, want 10", metrics.GenerationTokensPerSecond)
	}
	if metrics.TokensPerSecond != 10 {
		t.Fatalf("aggregate tok/s must ride the generation rate, got %v", metrics.TokensPerSecond)
	}

	// A failed poll zeroes the rates and reseeds so the next good sample never
	// pairs with pre-failure counters.
	fake.fail()
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 {
		t.Fatalf("failed poll must zero the rates: %+v", metrics)
	}
	fake.set("org/model", 0, 0, 9000, 900)
	*now = now.Add(15 * time.Second)
	manager.PollThroughput(context.Background())
	if metrics := manager.Metrics(); metrics.PromptTokensPerSecond != 0 || metrics.GenerationTokensPerSecond != 0 {
		t.Fatalf("first poll after a failure must reseed, not compute a bogus delta: %+v", metrics)
	}
}

func TestREQRUN022VllmInflightCountsRunningAndWaiting(t *testing.T) {
	// Drain-before-restart waits on the runtime's own outstanding work; for vLLM
	// that is the running plus queued requests from its scheduler gauges. An
	// unreachable runtime contributes no backpressure. REQ-RUN-022.
	fake := &fakeVllmMetrics{}
	fake.set("org/model", 2, 1, 0, 0)
	manager, _ := vllmThroughputManager(t, fake)
	if got := manager.Inflight(context.Background()); got != 3 {
		t.Fatalf("Inflight = %d, want running+waiting = 3", got)
	}
	fake.fail()
	if got := manager.Inflight(context.Background()); got != 0 {
		t.Fatalf("unreachable runtime must report 0 inflight, got %d", got)
	}
	idle := NewVllmManager(VllmInput{UpstreamModel: "org/model"})
	if got := idle.Inflight(context.Background()); got != 0 {
		t.Fatalf("a runtime with no bind port must report 0 inflight, got %d", got)
	}
}
