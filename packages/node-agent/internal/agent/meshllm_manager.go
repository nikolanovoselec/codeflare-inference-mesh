package agent

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// meshProcess abstracts the supervised mesh-llm child process so tests can
// inject a fake in place of a real *exec.Cmd.
type meshProcess interface {
	Signal(sig os.Signal) error
	Kill() error
	Wait() error
}

// meshLauncher starts the mesh-llm binary and returns a handle to the running
// process. The context is the process-lifetime context: cancelling it kills
// the child, and it is never derived from a caller's request context.
type meshLauncher func(ctx context.Context, binary string, args []string, env []string) (meshProcess, error)

type execMeshProcess struct {
	cmd *exec.Cmd
}

func (p execMeshProcess) Signal(sig os.Signal) error { return p.cmd.Process.Signal(sig) }
func (p execMeshProcess) Kill() error                { return p.cmd.Process.Kill() }
func (p execMeshProcess) Wait() error                { return p.cmd.Wait() }

func launchMeshProcess(ctx context.Context, binary string, args []string, env []string) (meshProcess, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return execMeshProcess{cmd: cmd}, nil
}

// MeshLLMManager supervises exactly one managed mesh-llm process. It reuses
// the RuntimeManager lifecycle patterns (state machine strings, process-
// lifetime context, done/exited channels) and implements RuntimeController,
// with mesh-specific readiness (console /api/status + own /v1/models parse),
// SIGTERM-first stop, and router-driven restart triggers.
type MeshLLMManager struct {
	mu            sync.Mutex
	input         MeshLLMRenderInput
	contextWindow int
	dataDir       string
	binaryPath    string

	proc   meshProcess
	done   chan error
	exited chan struct{}
	cancel context.CancelFunc

	state     string
	lastError string

	bootstrap        *MeshBootstrap
	launchedRotation int
	token            string
	meshID           string
	readyModels      []string
	apiReady         bool

	// Test seams, mirroring the injection style of the RuntimeManager tests:
	// constructor defaults, overridable inside the package.
	launch           meshLauncher
	httpClient       *http.Client
	pollInterval     time.Duration
	readinessTimeout time.Duration
	stopGrace        time.Duration
	now              func() time.Time
}

var _ RuntimeController = (*MeshLLMManager)(nil)

func NewMeshLLMManager(in MeshLLMRenderInput, contextWindow int, dataDir string, binaryPath string) *MeshLLMManager {
	return &MeshLLMManager{
		input:            in,
		contextWindow:    contextWindow,
		dataDir:          dataDir,
		binaryPath:       binaryPath,
		state:            "stopped",
		launch:           launchMeshProcess,
		httpClient:       &http.Client{Timeout: 2 * time.Second},
		pollInterval:     500 * time.Millisecond,
		readinessTimeout: 30 * time.Minute,
		stopGrace:        10 * time.Second,
		now:              time.Now,
	}
}

func (m *MeshLLMManager) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.runningLocked() {
		m.mu.Unlock()
		return nil
	}
	if m.bootstrap != nil && m.bootstrap.Action == "wait" {
		// Bootstrap says wait: report the runtime starting without launching
		// mesh-llm; the next heartbeat retries with a fresh bootstrap.
		m.state = "starting"
		m.lastError = ""
		m.mu.Unlock()
		return nil
	}
	if _, err := exec.LookPath(m.binaryPath); err != nil {
		m.state = "dependency-missing"
		m.lastError = fmt.Sprintf("mesh-llm binary missing: %s", m.binaryPath)
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRuntimeDependencyMissing, m.binaryPath)
	}
	input := m.renderInputLocked()
	if err := m.writeContextConfig(&input); err != nil {
		m.state = "failed"
		m.lastError = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("write mesh-llm config: %w", err)
	}
	args := RenderMeshLLMArgs(input)
	env := MeshLLMEnv(os.Environ())
	processCtx, cancel := context.WithCancel(context.Background())
	m.state = "starting"
	m.lastError = ""
	proc, err := m.launch(processCtx, m.binaryPath, args, env)
	if err != nil {
		cancel()
		m.state = "failed"
		m.lastError = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("start mesh-llm: %w", err)
	}
	m.proc = proc
	m.cancel = cancel
	m.done = make(chan error, 1)
	m.exited = make(chan struct{})
	m.launchedRotation = input.Rotation
	exited := m.exited
	go m.wait(proc, m.done, exited)
	go m.awaitReadiness(proc, exited, input.ModelRef)
	m.mu.Unlock()
	return nil
}

// Stop signals SIGTERM first and escalates to Kill only after the grace
// period (REQ-RUN-003 AC9).
func (m *MeshLLMManager) Stop(ctx context.Context) error {
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
		m.mu.Unlock()
		return nil
	}
	m.done = nil
	m.state = "stopping"
	m.mu.Unlock()

	if err := proc.Signal(syscall.SIGTERM); err != nil {
		if killErr := proc.Kill(); killErr != nil {
			m.mu.Lock()
			if m.proc == proc {
				m.done = done
				m.cancel = cancel
				m.state = "failed"
				m.lastError = err.Error()
			}
			m.mu.Unlock()
			return fmt.Errorf("stop mesh-llm: %w", err)
		}
	}

	grace := time.NewTimer(m.stopGrace)
	defer grace.Stop()
	select {
	case <-ctx.Done():
		_ = proc.Kill()
		m.finishStop(proc, cancel, "failed")
		return ctx.Err()
	case err := <-done:
		if err != nil && !strings.Contains(err.Error(), "signal") {
			m.finishStop(proc, cancel, "failed")
			return fmt.Errorf("wait mesh-llm: %w", err)
		}
		m.finishStop(proc, cancel, "stopped")
		return nil
	case <-grace.C:
	}

	_ = proc.Kill()
	select {
	case <-ctx.Done():
		m.finishStop(proc, cancel, "failed")
		return ctx.Err()
	case <-done:
		m.finishStop(proc, cancel, "stopped")
		return nil
	}
}

func (m *MeshLLMManager) Restart(ctx context.Context) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	return m.Start(ctx)
}

// RestartWithInput stops the running process, swaps the render input to the
// newly selected profile, and starts again. Callers drain in-flight requests
// before invoking it; a stored bootstrap keeps overriding rotation and join
// tokens on the relaunch render.
func (m *MeshLLMManager) RestartWithInput(ctx context.Context, in MeshLLMRenderInput, contextWindow int) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	m.mu.Lock()
	m.input = in
	m.contextWindow = contextWindow
	m.mu.Unlock()
	return m.Start(ctx)
}

// SetState overrides the reported runtime state; any state other than failed
// clears the last error.
func (m *MeshLLMManager) SetState(state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state
	if state != "failed" {
		m.lastError = ""
	}
}

// SetFailure marks the runtime failed with the given error as last error.
func (m *MeshLLMManager) SetFailure(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = "failed"
	m.lastError = err.Error()
}

func (m *MeshLLMManager) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runningLocked()
	return m.state
}

func (m *MeshLLMManager) LastError() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runningLocked()
	return m.lastError
}

// PollStatus performs the per-tick poll: one console /api/status request
// (capturing the invite token and mesh id for heartbeats) plus one API
// /v1/models request refreshing the ready-model set. The returned bool is
// console reachability. Ready models fail closed when the API is unreachable.
func (m *MeshLLMManager) PollStatus(ctx context.Context) (MeshLLMStatus, bool) {
	m.mu.Lock()
	client := m.httpClient
	consolePort := m.input.ConsolePort
	apiPort := m.input.APIPort
	m.mu.Unlock()

	status, consoleReachable := fetchMeshLLMStatus(ctx, client, consolePort)
	models, apiReachable := fetchMeshLLMModels(ctx, client, apiPort)

	m.mu.Lock()
	if consoleReachable {
		if status.Token != "" {
			m.token = status.Token
		}
		if status.MeshID != "" {
			m.meshID = status.MeshID
		}
	}
	if apiReachable {
		m.readyModels = models
	} else {
		m.readyModels = nil
	}
	m.apiReady = apiReachable
	m.mu.Unlock()
	return status, consoleReachable
}

// APIReady reports whether the last poll reached the node's own /v1/models
// endpoint with a parseable 2xx response.
func (m *MeshLLMManager) APIReady() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.apiReady
}

// NeedsRestart reports whether a heartbeat bootstrap demands a drain and
// restart: the response rotation differs from the running rotation, the
// response mesh id differs from the running mesh id with join tokens present,
// or create arrives while a mesh is running. Callers drain via waitForDrain
// before acting on it.
func (m *MeshLLMManager) NeedsRestart(b *MeshBootstrap) bool {
	if b == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.runningLocked() {
		return false
	}
	if b.Rotation != m.launchedRotation {
		return true
	}
	if b.MeshID != "" && m.meshID != "" && b.MeshID != m.meshID && len(b.JoinTokens) > 0 {
		return true
	}
	if b.Action == "create" {
		return true
	}
	return false
}

// ApplyBootstrap stores the latest mesh bootstrap; the next render picks up
// its rotation and join tokens.
func (m *MeshLLMManager) ApplyBootstrap(b *MeshBootstrap) {
	if b == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := *b
	copied.JoinTokens = append([]string(nil), b.JoinTokens...)
	m.bootstrap = &copied
}

func (m *MeshLLMManager) CurrentToken() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.token
}

func (m *MeshLLMManager) CurrentMeshID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.meshID
}

// Rotation returns the rotation baked into the running mesh identity, or the
// pending bootstrap rotation when no process is running.
func (m *MeshLLMManager) Rotation() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runningLocked() {
		return m.launchedRotation
	}
	if m.bootstrap != nil {
		return m.bootstrap.Rotation
	}
	return m.input.Rotation
}

// ReadyModels returns the ids parsed from the node's own /v1/models response
// on the last poll.
func (m *MeshLLMManager) ReadyModels() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.readyModels...)
}

func (m *MeshLLMManager) renderInputLocked() MeshLLMRenderInput {
	input := m.input
	input.JoinTokens = append([]string(nil), m.input.JoinTokens...)
	if m.bootstrap != nil {
		input.Rotation = m.bootstrap.Rotation
		if m.bootstrap.Action == "join" {
			input.JoinTokens = append([]string(nil), m.bootstrap.JoinTokens...)
		} else {
			input.JoinTokens = nil
		}
	}
	return input
}

func (m *MeshLLMManager) writeContextConfig(input *MeshLLMRenderInput) error {
	content := MeshLLMConfigTOML(*input, m.contextWindow)
	if content == "" {
		input.ConfigPath = ""
		return nil
	}
	if input.ConfigPath == "" {
		input.ConfigPath = filepath.Join(m.dataDir, "meshllm-"+input.ProfileID+".toml")
	}
	if err := os.MkdirAll(filepath.Dir(input.ConfigPath), 0o700); err != nil {
		return err
	}
	return os.WriteFile(input.ConfigPath, []byte(content), 0o600)
}

func (m *MeshLLMManager) runningLocked() bool {
	if m.proc == nil {
		if m.state == "" {
			m.state = "stopped"
		}
		return false
	}
	if m.done == nil {
		return true
	}
	select {
	case err := <-m.done:
		m.settleExitLocked(err)
		return false
	default:
		return true
	}
}

func (m *MeshLLMManager) wait(proc meshProcess, done chan error, exited chan struct{}) {
	err := proc.Wait()
	close(exited)
	done <- err
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.proc == proc && m.done == done {
		m.settleExitLocked(err)
	}
}

func (m *MeshLLMManager) settleExitLocked(err error) {
	m.clearProcessLocked()
	if m.state == "failed" {
		return
	}
	if m.state == "starting" || m.state == "downloading" {
		m.state = "failed"
		m.lastError = "runtime process exited before readiness"
		return
	}
	if err != nil && !strings.Contains(err.Error(), "signal") {
		m.state = "failed"
		m.lastError = err.Error()
	} else {
		m.state = "stopped"
	}
}

func (m *MeshLLMManager) clearProcessLocked() {
	if m.cancel != nil {
		m.cancel()
	}
	m.proc = nil
	m.done = nil
	m.exited = nil
	m.cancel = nil
}

func (m *MeshLLMManager) finishStop(proc meshProcess, cancel context.CancelFunc, state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.proc == proc {
		m.proc = nil
		m.done = nil
		m.exited = nil
		m.cancel = nil
	}
	if cancel != nil {
		cancel()
	}
	m.state = state
}

// awaitReadiness polls the console and the node's own /v1/models until
// MapMeshLLMState reports ready. While the console reports node_state
// loading, the readiness deadline extends instead of failing the runtime
// (progress is not failure; the cap resets on every loading observation).
// Process exit before readiness is settled by the wait goroutine.
func (m *MeshLLMManager) awaitReadiness(proc meshProcess, exited <-chan struct{}, modelRef string) {
	deadline := m.now().Add(m.readinessTimeout)
	ticker := time.NewTicker(m.pollInterval)
	defer ticker.Stop()
	for {
		status, consoleReachable := m.PollStatus(context.Background())
		// Readiness judges the union of console serving models and the ids
		// parsed from the node's own /v1/models poll; the process is alive
		// here because the exited channel select below ends the loop.
		unioned := MeshStatusWithModels(status, m.ReadyModels())
		mapped := MapMeshLLMState(unioned, modelRef, true, consoleReachable)

		m.mu.Lock()
		if m.proc != proc || (m.state != "starting" && m.state != "downloading") {
			m.mu.Unlock()
			return
		}
		if mapped == "ready" {
			m.state = "ready"
			m.lastError = ""
			m.mu.Unlock()
			return
		}
		if mapped == "downloading" || (consoleReachable && status.NodeState == "loading") {
			deadline = m.now().Add(m.readinessTimeout)
			m.state = "downloading"
		}
		m.mu.Unlock()

		if m.now().After(deadline) {
			m.mu.Lock()
			if m.proc == proc && (m.state == "starting" || m.state == "downloading") {
				m.state = "failed"
				m.lastError = "mesh-llm readiness deadline exceeded"
			}
			m.mu.Unlock()
			return
		}
		select {
		case <-exited:
			return
		case <-ticker.C:
		}
	}
}

func fetchMeshLLMStatus(ctx context.Context, client *http.Client, port int) (MeshLLMStatus, bool) {
	body, ok := fetchLocalBody(ctx, client, port, "/api/status")
	if !ok {
		return MeshLLMStatus{}, false
	}
	status, err := ParseMeshLLMStatus(body)
	if err != nil {
		return MeshLLMStatus{}, false
	}
	return status, true
}

func fetchMeshLLMModels(ctx context.Context, client *http.Client, port int) ([]string, bool) {
	body, ok := fetchLocalBody(ctx, client, port, "/v1/models")
	if !ok {
		return nil, false
	}
	models, err := ParseModelsResponse(body)
	if err != nil {
		return nil, false
	}
	return models, true
}

func fetchLocalBody(ctx context.Context, client *http.Client, port int, path string) ([]byte, bool) {
	if port <= 0 {
		return nil, false
	}
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	if err != nil {
		return nil, false
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil, false
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, false
	}
	return body, true
}

const MeshLLMManagerAnchors = "REQ-RUN-003 REQ-RUN-005 REQ-RUN-006 REQ-RUN-007"
