package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	HFSpecifier         string            `json:"hfSpecifier"`
	LocalFilename       string            `json:"localFilename"`
	SHA256              string            `json:"sha256,omitempty"`
	LlamaServerModelArg string            `json:"llamaServerModelArg"`
	ContextWindow       int               `json:"contextWindow"`
	Runtime             string            `json:"runtime"`
	RuntimeCommand      RuntimeCommand    `json:"runtimeCommand"`
	Version             int               `json:"version"`
	RolloutPercent      int               `json:"rolloutPercent"`
	Active              bool              `json:"active"`
	Metadata            map[string]string `json:"metadata,omitempty"`
}

type RuntimeCommand struct {
	Executable string            `json:"executable"`
	Args       []string          `json:"args"`
	Env        map[string]string `json:"env"`
}

type RuntimeController interface {
	Start(context.Context) error
	Stop(context.Context) error
	Restart(context.Context) error
}

type RuntimeManager struct {
	command RuntimeCommand
	mu      sync.Mutex
	cmd     *exec.Cmd
	done    chan error
	cancel  context.CancelFunc
	state   string
}

func NewRuntimeManager(command RuntimeCommand) *RuntimeManager {
	return &RuntimeManager{command: command, state: "stopped"}
}

func (m *RuntimeManager) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runningLocked() {
		return nil
	}
	processCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(processCtx, m.command.Executable, m.command.Args...)
	cmd.Env = append(os.Environ(), envPairs(m.command.Env)...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	m.state = "starting"
	if err := cmd.Start(); err != nil {
		cancel()
		m.state = "failed"
		return fmt.Errorf("start runtime: %w", err)
	}
	m.cmd = cmd
	m.cancel = cancel
	m.done = make(chan error, 1)
	m.state = "ready"
	go m.wait(cmd, m.done)
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

func (m *RuntimeManager) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runningLocked()
	return m.state
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
		m.cancel = nil
		if err != nil && !strings.Contains(err.Error(), "signal") {
			m.state = "failed"
		} else {
			m.state = "stopped"
		}
		return false
	default:
		return true
	}
}

func (m *RuntimeManager) wait(cmd *exec.Cmd, done chan error) {
	err := cmd.Wait()
	done <- err
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == cmd && m.done == done {
		m.cmd = nil
		m.done = nil
		m.cancel = nil
		if err != nil && !strings.Contains(err.Error(), "signal") {
			m.state = "failed"
		} else {
			m.state = "stopped"
		}
	}
}

func (m *RuntimeManager) finishStop(cmd *exec.Cmd, cancel context.CancelFunc, state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == cmd {
		m.cmd = nil
		m.done = nil
		m.cancel = nil
	}
	if cancel != nil {
		cancel()
	}
	m.state = state
}

func (m *RuntimeManager) setState(state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state
}

func LlamaCommand(profile ModelProfile, cacheDir string, listenAddress string) RuntimeCommand {
	modelPath := filepath.Join(cacheDir, profile.LocalFilename)
	if profile.LlamaServerModelArg != "" && profile.LocalFilename == "" {
		modelPath = profile.LlamaServerModelArg
	}
	args := []string{"--model", modelPath, "--ctx-size", fmt.Sprintf("%d", profile.ContextWindow), "--host", hostOnly(listenAddress), "--port", portOnly(listenAddress)}
	return RuntimeCommand{Executable: "llama-server", Args: args, Env: map[string]string{"LLAMA_ARG_THREADS": "auto"}}
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
