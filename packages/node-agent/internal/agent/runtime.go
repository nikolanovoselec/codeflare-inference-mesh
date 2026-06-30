package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

func LlamaCommand(profile ModelProfile, cacheDir string, listenAddress string) RuntimeCommand {
	modelPath := filepath.Join(cacheDir, profile.LocalFilename)
	args := []string{"--model", modelPath, "--ctx-size", fmt.Sprintf("%d", profile.ContextWindow), "--host", hostOnly(listenAddress)}
	if profile.LlamaServerModelArg != "" && profile.LocalFilename == "" {
		args[1] = profile.LlamaServerModelArg
	}
	return RuntimeCommand{Executable: "llama-server", Args: args, Env: map[string]string{"LLAMA_ARG_THREADS": "auto"}}
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

func hostOnly(address string) string {
	for index := len(address) - 1; index >= 0; index-- {
		if address[index] == ':' {
			return address[:index]
		}
	}
	return address
}

const RuntimeAnchors = "REQ-RUN-003"
