package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type LlamaCppInput struct {
	ProfileID      string
	ProfileVersion int
	UpstreamModel  string
	Settings       LlamaCppSettings
	BinaryPath     string
}

type LlamaCppManager struct {
	mu        sync.Mutex
	input     LlamaCppInput
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
}

var _ RuntimeController = (*LlamaCppManager)(nil)
var _ RuntimeTargetProvider = (*LlamaCppManager)(nil)

func NewLlamaCppManager(in LlamaCppInput) *LlamaCppManager {
	if in.BinaryPath == "" {
		in.BinaryPath = "llama-server"
	}
	return &LlamaCppManager{
		input:            in,
		state:            "stopped",
		launch:           launchMeshProcess,
		httpClient:       &http.Client{Timeout: 2 * time.Second},
		pollInterval:     500 * time.Millisecond,
		readinessTimeout: 30 * time.Minute,
		stopGrace:        10 * time.Second,
		stderrLog:        &runtimeLog{},
	}
}

func (m *LlamaCppManager) Runtime() string { return "llamacpp" }

func llamaCppRuntimeEnv(env []string, binaryPath string) []string {
	dir := filepath.Dir(binaryPath)
	if dir == "." || dir == "" {
		return env
	}
	next := upsertPathEnv(env, "LD_LIBRARY_PATH", dir)
	next = upsertPathEnv(next, "DYLD_LIBRARY_PATH", dir)
	return upsertPathEnv(next, "PATH", dir)
}

func upsertPathEnv(env []string, key string, dir string) []string {
	prefix := key + "="
	for i, item := range env {
		if strings.HasPrefix(item, prefix) {
			current := strings.TrimPrefix(item, prefix)
			copyEnv := append([]string(nil), env...)
			if current == "" {
				copyEnv[i] = prefix + dir
			} else {
				copyEnv[i] = prefix + dir + string(os.PathListSeparator) + current
			}
			return copyEnv
		}
	}
	return append(append([]string(nil), env...), prefix+dir)
}

func (m *LlamaCppManager) TargetURL() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.input.Settings.BindPort <= 0 {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d", m.input.Settings.BindPort)
}

func (m *LlamaCppManager) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.proc != nil {
		m.mu.Unlock()
		return nil
	}
	if _, err := exec.LookPath(m.input.BinaryPath); err != nil {
		m.state = "dependency-missing"
		m.lastError = fmt.Sprintf("llama-server binary missing: %s", m.input.BinaryPath)
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRuntimeDependencyMissing, m.input.BinaryPath)
	}
	args := RenderLlamaCppArgs(m.input)
	processCtx, cancel := context.WithCancel(context.Background())
	m.state = "starting"
	m.lastError = ""
	proc, err := m.launch(processCtx, m.input.BinaryPath, args, llamaCppRuntimeEnv(os.Environ(), m.input.BinaryPath), m.stderrLog)
	if err != nil {
		cancel()
		m.state = "failed"
		m.lastError = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("start llama.cpp: %w", err)
	}
	m.proc = proc
	m.cancel = cancel
	m.done = make(chan error, 1)
	done := m.done
	go func() { done <- proc.Wait() }()
	go m.awaitReadiness(proc)
	m.mu.Unlock()
	return nil
}

func RenderLlamaCppArgs(in LlamaCppInput) []string {
	settings := in.Settings
	args := []string{
		"--host", "127.0.0.1",
		"--port", fmt.Sprintf("%d", settings.BindPort),
		"--hf-repo", hfRepoWithQuant(settings),
		"--alias", in.UpstreamModel,
		"--ctx-size", fmt.Sprintf("%d", settings.ContextWindow),
		"--parallel", fmt.Sprintf("%d", settings.Parallel),
		"--cache-reuse", fmt.Sprintf("%d", settings.CacheReuse),
		"--slots",
		"--metrics",
		"--jinja",
	}
	// Unified KV shares one buffer across slots so a single request can use the whole
	// --ctx-size; non-unified divides it per slot (ctx/slots), which 400s long
	// requests. An absent toggle means on. REQ-RUN-015.
	if settings.KVUnified != nil && !*settings.KVUnified {
		args = append(args, "--no-kv-unified")
	} else {
		args = append(args, "--kv-unified")
	}
	if settings.HFFile != "" {
		args = append(args, "--hf-file", settings.HFFile)
	}
	if settings.CacheTypeK != "" {
		args = append(args, "--cache-type-k", settings.CacheTypeK)
	}
	if settings.CacheTypeV != "" {
		args = append(args, "--cache-type-v", settings.CacheTypeV)
	}
	if settings.Batch > 0 {
		args = append(args, "--batch-size", fmt.Sprintf("%d", settings.Batch))
	}
	if settings.Ubatch > 0 {
		args = append(args, "--ubatch-size", fmt.Sprintf("%d", settings.Ubatch))
	}
	if settings.FlashAttn != nil {
		if *settings.FlashAttn {
			args = append(args, "--flash-attn", "on")
		} else {
			args = append(args, "--flash-attn", "off")
		}
	}
	if settings.MaxOutputTokens > 0 {
		args = append(args, "--predict", fmt.Sprintf("%d", settings.MaxOutputTokens))
	}
	if settings.GPULayers != "" {
		args = append(args, "--gpu-layers", settings.GPULayers)
	}
	if settings.CachePrompt {
		args = append(args, "--cache-prompt")
	}
	if settings.Reasoning != nil {
		if settings.Reasoning.Enabled != nil {
			if *settings.Reasoning.Enabled {
				args = append(args, "--reasoning", "on")
			} else {
				args = append(args, "--reasoning", "off")
			}
		}
		if settings.Reasoning.Format != "" {
			args = append(args, "--reasoning-format", settings.Reasoning.Format)
		}
		if settings.Reasoning.Budget != 0 {
			args = append(args, "--reasoning-budget", fmt.Sprintf("%d", settings.Reasoning.Budget))
		}
	}
	return args
}

func hfRepoWithQuant(settings LlamaCppSettings) string {
	if settings.Quant == "" || strings.Contains(settings.HFRepo, ":") {
		return settings.HFRepo
	}
	return settings.HFRepo + ":" + settings.Quant
}

func (m *LlamaCppManager) Stop(ctx context.Context) error {
	m.mu.Lock()
	proc := m.proc
	done := m.done
	cancel := m.cancel
	if proc == nil || done == nil {
		m.state = "stopped"
		m.mu.Unlock()
		return nil
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

func (m *LlamaCppManager) Restart(ctx context.Context) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	return m.Start(ctx)
}

func (m *LlamaCppManager) RestartWithLlamaInput(ctx context.Context, in LlamaCppInput) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	m.mu.Lock()
	m.input = in
	m.mu.Unlock()
	return m.Start(ctx)
}

func (m *LlamaCppManager) RestartWithInput(ctx context.Context, _ MeshLLMRenderInput, _ int) error {
	return m.Restart(ctx)
}

func (m *LlamaCppManager) PollStatus(_ context.Context) (MeshLLMStatus, bool) {
	return MeshLLMStatus{}, m.APIReady()
}

func (m *LlamaCppManager) ApplyBootstrap(_ *MeshBootstrap) {}

func (m *LlamaCppManager) NeedsRestart(_ *MeshBootstrap) bool { return false }

func (m *LlamaCppManager) CurrentToken() string { return "" }

func (m *LlamaCppManager) CurrentMeshID() string { return "" }

func (m *LlamaCppManager) finishStop(proc meshProcess, cancel context.CancelFunc, state string) {
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

func (m *LlamaCppManager) awaitReadiness(proc meshProcess) {
	deadline := time.NewTimer(m.readinessTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(m.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			m.SetFailure(fmt.Errorf("llama.cpp readiness timed out"))
			return
		case <-ticker.C:
			models, ok := m.pollModels(context.Background())
			if ok && containsString(models, m.input.UpstreamModel) {
				m.mu.Lock()
				if m.proc == proc {
					m.state = "ready"
					m.apiReady = true
					m.models = models
				}
				m.mu.Unlock()
				return
			}
		}
	}
}

func (m *LlamaCppManager) pollModels(ctx context.Context) ([]string, bool) {
	url := strings.TrimRight(m.TargetURL(), "/") + "/v1/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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
		Data []struct{ ID string `json:"id"` } `json:"data"`
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

func (m *LlamaCppManager) Metrics() NodeMetrics {
	m.mu.Lock()
	defer m.mu.Unlock()
	return NodeMetrics{
		RuntimeKind:          "llamacpp",
		RuntimeState:         m.state,
		LoadedModel:          m.input.UpstreamModel,
		LoadedProfileID:      m.input.ProfileID,
		LoadedProfileVersion: m.input.ProfileVersion,
		ReadyModels:          append([]string(nil), m.models...),
		APIReady:             m.apiReady,
		CtxSize:              m.input.Settings.ContextWindow,
		Parallel:             m.input.Settings.Parallel,
		CachePrompt:          m.input.Settings.CachePrompt,
		CacheReuse:           m.input.Settings.CacheReuse,
		LastError:            m.lastError,
		RuntimeDetail:        m.RuntimeErrorDetail(),
	}
}

func (m *LlamaCppManager) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

func (m *LlamaCppManager) LastError() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastError
}

func (m *LlamaCppManager) SetState(state string) {
	m.mu.Lock()
	m.state = state
	m.mu.Unlock()
}

func (m *LlamaCppManager) SetFailure(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = "failed"
	if err != nil {
		m.lastError = err.Error()
	}
}

func (m *LlamaCppManager) RuntimeErrorDetail() string {
	if m.stderrLog == nil {
		return ""
	}
	return m.stderrLog.Detail()
}

func (m *LlamaCppManager) ReadyModels() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.models...)
}

func (m *LlamaCppManager) APIReady() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apiReady
}

func (m *LlamaCppManager) Inflight() int { return 0 }

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

const LlamaCppManagerAnchors = "REQ-RUN-011 REQ-SCH-004"
