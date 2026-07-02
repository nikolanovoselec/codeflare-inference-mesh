package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ModelProfile struct {
	ID                  string            `json:"id"`
	PublicAliases       []string          `json:"publicAliases"`
	UpstreamModel       string            `json:"upstreamModel"`
	SourceMode          string            `json:"sourceMode"`
	HFSpecifier         string            `json:"hfSpecifier,omitempty"`
	DownloadURL         string            `json:"downloadUrl,omitempty"`
	LocalFilename       string            `json:"localFilename,omitempty"`
	SHA256              string            `json:"sha256,omitempty"`
	LlamaServerModelArg string            `json:"llamaServerModelArg,omitempty"`
	ContextWindow       int               `json:"contextWindow"`
	Runtime             string            `json:"runtime"`
	RuntimeCommand      RuntimeCommand    `json:"runtimeCommand"`
	Version             int               `json:"version"`
	RolloutPercent      int               `json:"rolloutPercent"`
	Active              bool              `json:"active"`
	Metadata            map[string]string `json:"metadata,omitempty"`
}

type RuntimeCommand struct {
	Executable   string            `json:"executable"`
	Args         []string          `json:"args"`
	Env          map[string]string `json:"env"`
	ReadinessURL string            `json:"readinessUrl,omitempty"`
}

var ErrRuntimeDependencyMissing = errors.New("runtime dependency missing")

type RuntimeController interface {
	Start(context.Context) error
	Stop(context.Context) error
	Restart(context.Context) error
}

type RuntimeManager struct {
	command   RuntimeCommand
	mu        sync.Mutex
	cmd       *exec.Cmd
	done      chan error
	exited    chan struct{}
	cancel    context.CancelFunc
	state     string
	lastError string
}

func NewRuntimeManager(command RuntimeCommand) *RuntimeManager {
	return &RuntimeManager{command: command, state: "stopped"}
}

func (m *RuntimeManager) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.runningLocked() {
		m.mu.Unlock()
		return nil
	}
	if _, err := exec.LookPath(m.command.Executable); err != nil {
		m.state = "dependency-missing"
		m.lastError = fmt.Sprintf("%s missing from PATH", m.command.Executable)
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRuntimeDependencyMissing, m.command.Executable)
	}
	processCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(processCtx, m.command.Executable, m.command.Args...)
	cmd.Env = runtimeEnvironment(m.command.Env)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	m.state = "starting"
	m.lastError = ""
	if err := cmd.Start(); err != nil {
		cancel()
		m.state = "failed"
		m.lastError = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("start runtime: %w", err)
	}
	m.cmd = cmd
	m.cancel = cancel
	m.done = make(chan error, 1)
	m.exited = make(chan struct{})
	readinessURL := m.command.ReadinessURL
	exited := m.exited
	go m.wait(cmd, m.done, exited)
	if readinessURL == "" {
		m.state = "ready"
		m.mu.Unlock()
		return nil
	}
	go m.awaitReadiness(cmd, exited, readinessURL)
	m.mu.Unlock()
	return nil
}

func (m *RuntimeManager) Stop(ctx context.Context) error {
	m.mu.Lock()
	cmd := m.cmd
	done := m.done
	cancel := m.cancel
	if cmd == nil || cmd.Process == nil {
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

	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		if killErr := cmd.Process.Kill(); killErr != nil {
			m.mu.Lock()
			if m.cmd == cmd {
				m.done = done
				m.cancel = cancel
				m.state = "failed"
			}
			m.mu.Unlock()
			return fmt.Errorf("stop runtime: %w", err)
		}
	}

	select {
	case <-ctx.Done():
		if cancel != nil {
			cancel()
		}
		_ = cmd.Process.Kill()
		m.finishStop(cmd, cancel, "failed")
		return ctx.Err()
	case err := <-done:
		if cancel != nil {
			cancel()
		}
		if err != nil && !strings.Contains(err.Error(), "signal") {
			m.finishStop(cmd, cancel, "failed")
			return fmt.Errorf("wait runtime: %w", err)
		}
		m.finishStop(cmd, cancel, "stopped")
		return nil
	}
}

func (m *RuntimeManager) Restart(ctx context.Context) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	return m.Start(ctx)
}

func (m *RuntimeManager) RestartWithCommand(ctx context.Context, command RuntimeCommand) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	m.mu.Lock()
	m.command = command
	m.mu.Unlock()
	return m.Start(ctx)
}

func (m *RuntimeManager) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runningLocked()
	return m.state
}

func (m *RuntimeManager) LastError() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runningLocked()
	return m.lastError
}

func (m *RuntimeManager) runningLocked() bool {
	if m.cmd == nil {
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
		if m.cancel != nil {
			m.cancel()
		}
		m.cmd = nil
		m.done = nil
		m.exited = nil
		m.cancel = nil
		if m.state == "failed" {
			return false
		}
		if m.state == "starting" {
			m.state = "failed"
			m.lastError = "runtime process exited before readiness"
			return false
		}
		if err != nil && !strings.Contains(err.Error(), "signal") {
			m.state = "failed"
			m.lastError = err.Error()
		} else {
			m.state = "stopped"
		}
		return false
	default:
		return true
	}
}

func (m *RuntimeManager) wait(cmd *exec.Cmd, done chan error, exited chan struct{}) {
	err := cmd.Wait()
	close(exited)
	done <- err
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == cmd && m.done == done {
		m.cmd = nil
		m.done = nil
		m.exited = nil
		m.cancel = nil
		if m.state == "failed" {
			return
		}
		if m.state == "starting" {
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
}

func (m *RuntimeManager) awaitReadiness(cmd *exec.Cmd, exited <-chan struct{}, readinessURL string) {
	readyCtx, cancelReady := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancelReady()
	if err := waitForRuntimeReadyUntil(readyCtx, readinessURL, nil, exited); err != nil {
		m.mu.Lock()
		if m.cmd == cmd && m.state == "starting" {
			m.state = "failed"
			m.lastError = err.Error()
		}
		m.mu.Unlock()
		return
	}
	m.mu.Lock()
	if m.cmd == cmd && m.state == "starting" {
		m.state = "ready"
	}
	m.mu.Unlock()
}

func (m *RuntimeManager) finishStop(cmd *exec.Cmd, cancel context.CancelFunc, state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == cmd {
		m.cmd = nil
		m.done = nil
		m.exited = nil
		m.cancel = nil
	}
	if cancel != nil {
		cancel()
	}
	m.state = state
}

func (m *RuntimeManager) SetState(state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state
	if state != "failed" {
		m.lastError = ""
	}
}

func (m *RuntimeManager) SetFailure(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = "failed"
	m.lastError = err.Error()
}

func LlamaCommand(profile ModelProfile, modelDir string, listenAddress string) RuntimeCommand {
	modelPath := filepath.Join(modelDir, profile.LocalFilename)
	if profile.LlamaServerModelArg != "" && profile.LocalFilename == "" {
		modelPath = profile.LlamaServerModelArg
	}
	dataDir := modelDir
	if filepath.Base(modelDir) == "models" {
		dataDir = filepath.Dir(modelDir)
	}
	values := runtimeTemplateValues{
		host:      hostOnly(listenAddress),
		port:      portOnly(listenAddress),
		dataDir:   dataDir,
		modelDir:  modelDir,
		modelPath: modelPath,
	}
	if profile.RuntimeCommand.Executable != "" {
		return RuntimeCommand{
			Executable:   profile.RuntimeCommand.Executable,
			Args:         renderRuntimeArgs(profile.RuntimeCommand.Args, values),
			Env:          renderRuntimeEnv(profile.RuntimeCommand.Env, values),
			ReadinessURL: "http://" + listenAddress + "/v1/models",
		}
	}
	args := []string{"--model", modelPath, "--ctx-size", fmt.Sprintf("%d", profile.ContextWindow), "--host", values.host, "--port", values.port}
	return RuntimeCommand{Executable: "llama-server", Args: args, Env: map[string]string{"LLAMA_ARG_THREADS": "auto"}, ReadinessURL: "http://" + listenAddress + "/v1/models"}
}

type runtimeTemplateValues struct {
	host      string
	port      string
	dataDir   string
	modelDir  string
	modelPath string
}

func renderRuntimeArgs(args []string, values runtimeTemplateValues) []string {
	rendered := make([]string, 0, len(args))
	for _, arg := range args {
		rendered = append(rendered, renderRuntimeValue(arg, values))
	}
	return rendered
}

func renderRuntimeEnv(env map[string]string, values runtimeTemplateValues) map[string]string {
	rendered := make(map[string]string, len(env))
	for key, value := range env {
		rendered[key] = renderRuntimeValue(value, values)
	}
	return rendered
}

func renderRuntimeValue(value string, values runtimeTemplateValues) string {
	return strings.NewReplacer(
		"{{HOST}}", values.host,
		"{{PORT}}", values.port,
		"{{DATA_DIR}}", values.dataDir,
		"{{MODEL_DIR}}", values.modelDir,
		"{{MODEL_PATH}}", values.modelPath,
	).Replace(value)
}

func waitForRuntimeReady(ctx context.Context, readinessURL string, client *http.Client) error {
	return waitForRuntimeReadyUntil(ctx, readinessURL, client, nil)
}

func waitForRuntimeReadyUntil(ctx context.Context, readinessURL string, client *http.Client, exited <-chan struct{}) error {
	if readinessURL == "" {
		return nil
	}
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, readinessURL, nil)
		if err != nil {
			return err
		}
		response, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-exited:
			return errors.New("runtime process exited before readiness")
		case <-ticker.C:
		}
	}
}

func RuntimeListenAddress(runtimeURL string) (string, error) {
	parsed, err := url.Parse(runtimeURL)
	if err != nil {
		return "", fmt.Errorf("parse runtime url: %w", err)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("runtime url missing host")
	}
	return parsed.Host, nil
}

func SelectedProfile(cfg Config) (ModelProfile, bool) {
	for _, activeID := range cfg.ActiveProfileIDs {
		for _, profile := range cfg.Profiles {
			if profile.ID == activeID {
				return profile, true
			}
		}
	}
	for _, profile := range cfg.Profiles {
		if profile.UpstreamModel == cfg.RuntimeModel {
			return profile, true
		}
	}
	return ModelProfile{}, false
}

func EnsureModel(ctx context.Context, profile ModelProfile, dataDir string, client *http.Client) (string, error) {
	if profile.SourceMode == "llama-hf" {
		return "", nil
	}
	path := ModelCachePath(dataDir, profile)
	if profile.LocalFilename == "" {
		return profile.LlamaServerModelArg, nil
	}
	if ok, err := existingModelOK(path, profile.SHA256); err != nil {
		return "", err
	} else if ok {
		return path, nil
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Minute}
	}
	return DownloadModel(ctx, ModelDownloadURL(profile), path, profile.SHA256, client)
}

func DownloadModel(ctx context.Context, sourceURL string, destination string, expectedSHA256 string, client *http.Client) (string, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", fmt.Errorf("create model cache: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return "", fmt.Errorf("create model request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download model: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("download model returned %d", resp.StatusCode)
	}
	tmp := destination + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", fmt.Errorf("create model file: %w", err)
	}
	_, copyErr := io.Copy(file, resp.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return "", fmt.Errorf("write model file: %w", copyErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close model file: %w", closeErr)
	}
	if expectedSHA256 != "" {
		ok, err := VerifyFileSHA256(tmp, expectedSHA256)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", fmt.Errorf("model checksum mismatch")
		}
	}
	if err := os.Rename(tmp, destination); err != nil {
		return "", fmt.Errorf("store model file: %w", err)
	}
	return destination, nil
}

func ModelDownloadURL(profile ModelProfile) string {
	if profile.DownloadURL != "" {
		return profile.DownloadURL
	}
	repository, filename, ok := strings.Cut(profile.HFSpecifier, ":")
	if !ok || repository == "" || filename == "" {
		return ""
	}
	return fmt.Sprintf("https://huggingface.co/%s/resolve/main/%s", repository, filename)
}

func VerifyFileSHA256(path string, expected string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("open checksum file: %w", err)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false, fmt.Errorf("hash file: %w", err)
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	return actual == expected, nil
}

func ModelCachePath(dataDir string, profile ModelProfile) string {
	return filepath.Join(dataDir, "models", profile.LocalFilename)
}

func existingModelOK(path string, expectedSHA256 string) (bool, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("stat model file: %w", err)
	}
	if expectedSHA256 == "" {
		return true, nil
	}
	return VerifyFileSHA256(path, expectedSHA256)
}

func runtimeEnvironment(values map[string]string) []string {
	return append(os.Environ(), envPairs(values)...)
}

func envPairs(values map[string]string) []string {
	pairs := make([]string, 0, len(values))
	for key, value := range values {
		pairs = append(pairs, key+"="+value)
	}
	return pairs
}

func hostOnly(address string) string {
	for index := len(address) - 1; index >= 0; index-- {
		if address[index] == ':' {
			return address[:index]
		}
	}
	return address
}

func portOnly(address string) string {
	for index := len(address) - 1; index >= 0; index-- {
		if address[index] == ':' {
			return address[index+1:]
		}
	}
	return "8081"
}

const RuntimeAnchors = "REQ-RUN-003"
