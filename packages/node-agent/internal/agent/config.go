package agent

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Config struct {
	RouterURL          string   `json:"routerUrl"`
	SetupToken         string   `json:"setupToken,omitempty"`
	NodeID             string   `json:"nodeId,omitempty"`
	NodeToken          string   `json:"nodeToken,omitempty"`
	UpstreamToken      string   `json:"upstreamToken,omitempty"`
	DisplayName        string   `json:"displayName"`
	MeshIP             string   `json:"meshIp"`
	ListenAddress      string   `json:"listenAddress"`
	InferencePort      int      `json:"inferencePort"`
	DashboardAddress   string   `json:"dashboardAddress"`
	RuntimeURL         string   `json:"runtimeUrl"`
	RuntimeModel       string   `json:"runtimeModel"`
	PublicModels       []string `json:"publicModels"`
	ActiveProfileIDs   []string `json:"activeProfileIds"`
	Capacity           int      `json:"capacity"`
	DataDir            string   `json:"dataDir"`
	ReleaseURL         string   `json:"releaseUrl"`
	AllowAllInterfaces bool     `json:"allowAllInterfaces"`
}

func DefaultConfig(dataDir string) Config {
	return Config{
		DisplayName:      hostname(),
		ListenAddress:    "",
		InferencePort:    8080,
		DashboardAddress: "127.0.0.1:17777",
		RuntimeURL:       "http://127.0.0.1:8081",
		RuntimeModel:     "qwen36-27b-256k-3090",
		PublicModels:     []string{"mesh-default"},
		ActiveProfileIDs: []string{"qwen36-27b-256k-3090"},
		Capacity:         1,
		DataDir:          dataDir,
		ReleaseURL:       "https://api.github.com/repos/nikolanovoselec/cloudflare-inference-mesh/releases/latest",
	}
}

func LoadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	return cfg, nil
}

func SaveConfig(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

func DetectMeshIP(addrs []net.Addr) (string, bool) {
	for _, addr := range addrs {
		ip, ok := ipFromAddr(addr)
		if !ok || ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		if isPrivateOrCGNAT(ip) {
			return ip.String(), true
		}
	}
	return "", false
}

func ListenerAddress(meshIP string, port int, allowAllInterfaces bool) string {
	if meshIP != "" {
		return fmt.Sprintf("%s:%d", meshIP, port)
	}
	if allowAllInterfaces {
		return fmt.Sprintf("0.0.0.0:%d", port)
	}
	return fmt.Sprintf("127.0.0.1:%d", port)
}

func ConfigPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("ProgramData"), "InferenceMesh", "config.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", "inference-mesh-config.json")
	}
	return filepath.Join(home, ".config", "inference-mesh", "config.json")
}

func RedactedConfig(cfg Config) Config {
	return Config{
		RouterURL:          cfg.RouterURL,
		SetupToken:         redact(cfg.SetupToken),
		NodeID:             cfg.NodeID,
		NodeToken:          redact(cfg.NodeToken),
		UpstreamToken:      redact(cfg.UpstreamToken),
		DisplayName:        cfg.DisplayName,
		MeshIP:             cfg.MeshIP,
		ListenAddress:      cfg.ListenAddress,
		InferencePort:      cfg.InferencePort,
		DashboardAddress:   cfg.DashboardAddress,
		RuntimeURL:         cfg.RuntimeURL,
		RuntimeModel:       cfg.RuntimeModel,
		PublicModels:       append([]string(nil), cfg.PublicModels...),
		ActiveProfileIDs:   append([]string(nil), cfg.ActiveProfileIDs...),
		Capacity:           cfg.Capacity,
		DataDir:            cfg.DataDir,
		ReleaseURL:         cfg.ReleaseURL,
		AllowAllInterfaces: cfg.AllowAllInterfaces,
	}
}

func redact(value string) string {
	if value == "" {
		return ""
	}
	return "[redacted]"
}

func ipFromAddr(addr net.Addr) (net.IP, bool) {
	text := addr.String()
	if slash := strings.Index(text, "/"); slash >= 0 {
		text = text[:slash]
	}
	ip := net.ParseIP(text)
	return ip, ip != nil
}

func isPrivateOrCGNAT(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	return v4[0] == 10 || (v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] == 192 && v4[1] == 168) || (v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127)
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "inference-node"
	}
	return name
}

const ConfigAnchors = "REQ-NODE-001 REQ-SEC-004"
