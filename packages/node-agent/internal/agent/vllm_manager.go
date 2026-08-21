// VllmManager runs a single-node vLLM OpenAI server from the agent-managed
// venv. It reuses the shared child-process plumbing (meshLauncher, runtimeLog)
// and satisfies RuntimeManager; there is no mesh coordination — vLLM joins the
// direct family beside llama.cpp. REQ-RUN-021 / REQ-RUN-022.
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// VllmInput is the deterministic renderer input for one vLLM launch.
type VllmInput struct {
	ProfileID      string
	ProfileVersion int
	UpstreamModel  string
	Settings       VllmSettings
	BinaryPath     string
	DataDir        string
	// InstalledVersion is the verified install the launch actually uses (from
	// the completion marker), not the router's desired selection; telemetry
	// reports it so desired-vs-installed can disagree. REQ-OBS-012.
	InstalledVersion string
}

type VllmManager struct {
	mu        sync.Mutex
	input     VllmInput
	proc      meshProcess
	done      chan error
	cancel    context.CancelFunc
	state     string
	lastError string
	apiReady  bool
	models    []string
	stderrLog *runtimeLog

	launch           meshLauncher
	httpClient       *http.Client
	pollInterval     time.Duration
	readinessTimeout time.Duration
	stopGrace        time.Duration

	// Live throughput derives from vLLM's cumulative Prometheus counters sampled
	// once per heartbeat tick; rates are the deltas over the tick window.
	nowFn            func() time.Time
	throughputSeeded bool
	throughputAt     time.Time
	promptTokTotal   float64
	generationTotal  float64
	promptRate       float64
	generationRate   float64
}

var _ RuntimeController = (*VllmManager)(nil)
var _ RuntimeTargetProvider = (*VllmManager)(nil)

func NewVllmManager(in VllmInput) *VllmManager {
	if in.BinaryPath == "" {
		in.BinaryPath = "vllm"
	}
	return &VllmManager{
		input:        in,
		state:        "stopped",
		launch:       launchMeshProcess,
		httpClient:   &http.Client{Timeout: 2 * time.Second},
		pollInterval: 500 * time.Millisecond,
		// Generous flat first-load deadline: the first launch may download 30-70 GB
		// of weights into the HF cache. Connection-refused counts as still-loading
		// and the cache resumes across restarts, so the flat deadline only has to
		// outlast one full download, not survive retries.
		readinessTimeout: 2 * time.Hour,
		stopGrace:        10 * time.Second,
		stderrLog:        &runtimeLog{},
		nowFn:            time.Now,
	}
}

func (m *VllmManager) Runtime() string { return "vllm" }

// vllmRuntimeEnvFor pins the runtime environment to the managed venv and the
// agent's data directory: the venv bin leads PATH, the Hugging Face and vLLM
// caches live under dataDir (visible to disk accounting and preflight), and
// vLLM's stdout-default logging is redirected to stderr so the shared runtime
// ring captures the last error line. REQ-NODE-017 / REQ-RUN-022.
func vllmRuntimeEnvFor(env []string, binaryPath string, dataDir string) []string {
	next := append([]string(nil), env...)
	if dir := filepath.Dir(binaryPath); dir != "." && dir != "" {
		next = upsertPathEnv(next, "PATH", dir)
	}
	next = upsertSingleEnv(next, "VLLM_LOGGING_STREAM", "ext://sys.stderr")
	if dataDir == "" {
		return next
	}
	next = upsertSingleEnv(next, "HF_HOME", filepath.Join(dataDir, ".cache", "huggingface"))
	return upsertSingleEnv(next, "VLLM_CACHE_ROOT", filepath.Join(dataDir, ".cache", "vllm"))
}

func (m *VllmManager) TargetURL() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.input.Settings.BindPort <= 0 {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d", m.input.Settings.BindPort)
}

func (m *VllmManager) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.proc != nil {
		m.mu.Unlock()
		return nil
	}
	m.stderrLog.ResetLifecycle()
	if _, err := exec.LookPath(m.input.BinaryPath); err != nil {
		m.state = "dependency-missing"
		m.lastError = fmt.Sprintf("vllm binary missing: %s", m.input.BinaryPath)
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRuntimeDependencyMissing, m.input.BinaryPath)
	}
	args := RenderVllmArgs(m.input)
	processCtx, cancel := context.WithCancel(context.Background())
	m.state = "starting"
	m.lastError = ""
	proc, err := m.launch(processCtx, m.input.BinaryPath, args, vllmRuntimeEnvFor(os.Environ(), m.input.BinaryPath, m.input.DataDir), m.stderrLog)
	if err != nil {
		cancel()
		m.state = "failed"
		m.lastError = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("start vllm: %w", err)
	}
	m.proc = proc
	m.cancel = cancel
	m.done = make(chan error, 1)
	done := m.done
	go func() { done <- proc.Wait() }()
	go m.awaitReadiness(proc, done)
	m.mu.Unlock()
	return nil
}

// RenderVllmArgs renders the deterministic vLLM argv. The loopback bind is
// hardcoded: vLLM's upstream default binds every interface and leaves /metrics
// and /invocations outside --api-key, so the agent proxy must stay the only
// ingress (REQ-SEC-013). Unset tunables are omitted so vLLM's model-derived
// defaults rule. REQ-RUN-022.
func RenderVllmArgs(in VllmInput) []string {
	settings := in.Settings
	args := []string{
		"serve", settings.HfRepo,
		"--host", "127.0.0.1",
		"--port", fmt.Sprintf("%d", settings.BindPort),
		// Readiness matches the served model name on /v1/models, like llama --alias.
		"--served-model-name", in.UpstreamModel,
	}
	if settings.ContextWindow > 0 {
		args = append(args, "--max-model-len", fmt.Sprintf("%d", settings.ContextWindow))
	}
	if settings.MaxNumSeqs > 0 {
		args = append(args, "--max-num-seqs", fmt.Sprintf("%d", settings.MaxNumSeqs))
	}
	if settings.GpuMemoryUtilization > 0 {
		args = append(args, "--gpu-memory-utilization", strconv.FormatFloat(settings.GpuMemoryUtilization, 'g', -1, 64))
	}
	if settings.Dtype != "" {
		args = append(args, "--dtype", settings.Dtype)
	}
	if settings.Quantization != "" {
		args = append(args, "--quantization", settings.Quantization)
	}
	// Health and metrics polls run every tick; keep them out of the access log.
	return append(args, "--disable-access-log-for-endpoints", "/health,/metrics")
}

func (m *VllmManager) Stop(ctx context.Context) error {
	m.mu.Lock()
	proc := m.proc
	done := m.done
	cancel := m.cancel
	if proc == nil {
		m.state = "stopped"
		m.mu.Unlock()
		return nil
	}
	if done == nil {
		// A concurrent Stop owns this process's shutdown; fail loudly so a
		// restart cannot swap input and report success without relaunching.
		m.mu.Unlock()
		return ErrStopInProgress
	}
	m.done = nil
	m.state = "stopping"
	m.mu.Unlock()
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		_ = proc.Kill()
	}
	grace := time.NewTimer(m.stopGrace)
	defer grace.Stop()
	select {
	case <-ctx.Done():
		_ = proc.Kill()
		m.finishStop(proc, cancel, "failed")
		return ctx.Err()
	case err := <-done:
		state := "stopped"
		if err != nil && !strings.Contains(err.Error(), "signal") {
			state = "failed"
		}
		m.finishStop(proc, cancel, state)
		return nil
	case <-grace.C:
		_ = proc.Kill()
		m.finishStop(proc, cancel, "stopped")
		return nil
	}
}

func (m *VllmManager) Restart(ctx context.Context) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	return m.Start(ctx)
}

// RestartWithVllmInput swaps the render input before relaunch so a saved
// tunable change never restarts with stale argv. REQ-RUN-003 discipline.
func (m *VllmManager) RestartWithVllmInput(ctx context.Context, in VllmInput) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	m.mu.Lock()
	m.input = in
	m.mu.Unlock()
	return m.Start(ctx)
}

func (m *VllmManager) finishStop(proc meshProcess, cancel context.CancelFunc, state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.proc == proc {
		m.proc = nil
		m.cancel = nil
		m.state = state
		m.apiReady = false
		m.models = nil
		if cancel != nil {
			cancel()
		}
	}
}

// awaitReadiness polls /v1/models until it lists the served model. vLLM binds
// its socket before loading weights but does not listen until the engine is up,
// so connection-refused means still-loading — only the flat deadline fails the
// runtime. REQ-RUN-022.
func (m *VllmManager) awaitReadiness(proc meshProcess, done chan error) {
	// The render input is swapped under m.mu on restart; capture the model this
	// lifecycle is waiting for once, instead of racing the swap on every poll.
	m.mu.Lock()
	upstream := m.input.UpstreamModel
	m.mu.Unlock()
	deadline := time.NewTimer(m.readinessTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(m.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			// The child exited before readiness: mark failure now instead of
			// letting the crash masquerade as a slow model download until the
			// flat deadline. Re-buffer the exit result for Stop's consumer.
			done <- err
			m.mu.Lock()
			if m.proc == proc && m.state == "starting" {
				m.state = "failed"
				m.lastError = "vllm exited before readiness"
			}
			m.mu.Unlock()
			return
		case <-deadline.C:
			// Only the goroutine still owning the live process may fail it: a
			// restart orphans this loop, and the replacement runtime must not be
			// marked failed by its predecessor's deadline.
			m.mu.Lock()
			if m.proc == proc {
				m.state = "failed"
				m.lastError = "vllm readiness timed out"
			}
			m.mu.Unlock()
			return
		case <-ticker.C:
			models, ok := m.pollModels(context.Background())
			if ok && containsString(models, upstream) {
				m.mu.Lock()
				if m.proc == proc {
					m.state = "ready"
					m.apiReady = true
					m.models = models
					// A fresh ready state outlives the previous lifecycle: clear the
					// captured startup error and the stderr ring (REQ-OBS-011 discipline).
					m.lastError = ""
					m.stderrLog.Reset()
				}
				m.mu.Unlock()
				return
			}
		}
	}
}

func (m *VllmManager) pollModels(ctx context.Context) ([]string, bool) {
	target := m.TargetURL()
	if target == "" {
		return nil, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(target, "/")+"/v1/models", nil)
	if err != nil {
		return nil, false
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, false
	}
	models := make([]string, 0, len(body.Data))
	for _, item := range body.Data {
		if item.ID != "" {
			models = append(models, item.ID)
		}
	}
	return models, true
}

func (m *VllmManager) Metrics() NodeMetrics {
	m.mu.Lock()
	defer m.mu.Unlock()
	return NodeMetrics{
		RuntimeKind:               "vllm",
		RuntimeState:              m.state,
		VllmVersion:               m.input.InstalledVersion,
		LoadedModel:               m.input.UpstreamModel,
		LoadedProfileID:           m.input.ProfileID,
		LoadedProfileVersion:      m.input.ProfileVersion,
		ReadyModels:               append([]string(nil), m.models...),
		APIReady:                  m.apiReady,
		CtxSize:                   m.input.Settings.ContextWindow,
		TokensPerSecond:           m.generationRate,
		PromptTokensPerSecond:     m.promptRate,
		GenerationTokensPerSecond: m.generationRate,
		LastError:                 m.lastError,
		RuntimeDetail:             m.RuntimeErrorDetail(),
	}
}

// PollThroughput samples vLLM's cumulative token counters and turns the deltas
// since the previous heartbeat tick into live prompt/generation tok/s. A failed
// poll zeroes the rates and drops the seed; counters going backwards (server
// restarted) reseed instead of computing a negative delta. REQ-OBS-009 discipline.
func (m *VllmManager) PollThroughput(ctx context.Context) {
	sample, ok := m.pollMetrics(ctx)
	now := m.nowFn()
	m.mu.Lock()
	defer m.mu.Unlock()
	if !ok {
		m.throughputSeeded = false
		m.promptRate = 0
		m.generationRate = 0
		return
	}
	elapsed := now.Sub(m.throughputAt).Seconds()
	if m.throughputSeeded && elapsed > 0 && sample.PromptTokens >= m.promptTokTotal && sample.GenerationTokens >= m.generationTotal {
		m.promptRate = (sample.PromptTokens - m.promptTokTotal) / elapsed
		m.generationRate = (sample.GenerationTokens - m.generationTotal) / elapsed
	} else {
		m.promptRate = 0
		m.generationRate = 0
	}
	m.throughputSeeded = true
	m.throughputAt = now
	m.promptTokTotal = sample.PromptTokens
	m.generationTotal = sample.GenerationTokens
}

// Inflight reports the runtime's own outstanding work — running plus queued
// requests from the scheduler gauges — so drain-before-restart waits for the
// whole queue, not just what the proxy has seen. An unreachable runtime
// contributes no backpressure. REQ-RUN-010.
func (m *VllmManager) Inflight(ctx context.Context) int {
	sample, ok := m.pollMetrics(ctx)
	if !ok {
		return 0
	}
	return sample.Running + sample.Waiting
}

func (m *VllmManager) pollMetrics(ctx context.Context) (vllmMetricsSample, bool) {
	target := m.TargetURL()
	if target == "" {
		return vllmMetricsSample{}, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(target, "/")+"/metrics", nil)
	if err != nil {
		return vllmMetricsSample{}, false
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return vllmMetricsSample{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return vllmMetricsSample{}, false
	}
	m.mu.Lock()
	model := m.input.UpstreamModel
	m.mu.Unlock()
	return parseVllmMetrics(resp.Body, model)
}

type vllmMetricsSample struct {
	Running          int
	Waiting          int
	PromptTokens     float64
	GenerationTokens float64
}

// parseVllmMetrics scans vLLM's Prometheus exposition for the queue gauges and
// token counters. The exposition appends _total to counters and labels every
// series (model_name, engine); the parser accepts both counter spellings and
// reads only the served model's series, so an upstream naming change or a
// co-resident model never zeroes or pollutes the sample. A valid sample
// requires both token counters. REQ-OBS-009 / REQ-OBS-014.
func parseVllmMetrics(r io.Reader, servedModel string) (vllmMetricsSample, bool) {
	scanner := bufio.NewScanner(r)
	sample := vllmMetricsSample{}
	var havePrompt, haveGeneration bool
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(fields[len(fields)-1], 64)
		if err != nil {
			continue
		}
		name, labels, _ := strings.Cut(fields[0], "{")
		if model, ok := vllmSeriesModel(labels); ok && model != servedModel {
			continue
		}
		switch strings.TrimSuffix(name, "_total") {
		case "vllm:num_requests_running":
			sample.Running = int(value)
		case "vllm:num_requests_waiting":
			sample.Waiting = int(value)
		case "vllm:prompt_tokens":
			sample.PromptTokens, havePrompt = value, true
		case "vllm:generation_tokens":
			sample.GenerationTokens, haveGeneration = value, true
		}
	}
	return sample, havePrompt && haveGeneration
}

// vllmSeriesModel extracts the model_name label from a series' label blob;
// a label-free series matches any model (upstream tolerance).
func vllmSeriesModel(labels string) (string, bool) {
	const key = `model_name="`
	start := strings.Index(labels, key)
	if start < 0 {
		return "", false
	}
	rest := labels[start+len(key):]
	end := strings.Index(rest, `"`)
	if end < 0 {
		return "", false
	}
	return rest[:end], true
}

func (m *VllmManager) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

func (m *VllmManager) LastError() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastError
}

func (m *VllmManager) SetState(state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state
}

func (m *VllmManager) SetFailure(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = "failed"
	if err != nil {
		m.lastError = err.Error()
	}
}

func (m *VllmManager) RuntimeErrorDetail() string {
	if m.stderrLog == nil {
		return ""
	}
	return m.stderrLog.Detail()
}

func (m *VllmManager) ReadyModels() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.models...)
}

func (m *VllmManager) APIReady() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apiReady
}
