package agent

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type RuntimeBinaryVersions struct {
	MeshLLM  string `json:"meshllm,omitempty"`
	LlamaCpp string `json:"llamacpp,omitempty"`
}

type Config struct {
	RouterURL            string         `json:"routerUrl"`
	SetupToken           string         `json:"setupToken,omitempty"`
	NodeID               string         `json:"nodeId,omitempty"`
	NodeToken            string         `json:"nodeToken,omitempty"`
	UpstreamToken        string         `json:"upstreamToken,omitempty"`
	DisplayName          string         `json:"displayName"`
	MeshIP               string         `json:"meshIp"`
	ListenAddress        string         `json:"listenAddress"`
	InferencePort        int            `json:"inferencePort"`
	DashboardAddress     string         `json:"dashboardAddress"`
	DashboardToken       string         `json:"dashboardToken,omitempty"`
	MeshLLMAPIPort       int            `json:"meshllmApiPort"`
	MeshLLMConsolePort   int            `json:"meshllmConsolePort"`
	MeshLLMFlavor        string         `json:"meshllmFlavor,omitempty"`
	MeshLLMAllowUnpinned bool                  `json:"meshllmAllowUnpinned,omitempty"`
	// LlamaCppBinaryPath pins a host-installed llama-server binary, for example a CUDA-enabled install.
	// When set, the agent uses this binary instead of downloading the generic managed release.
	LlamaCppBinaryPath   string                `json:"llamaCppBinaryPath,omitempty"`
	RuntimeVersions      RuntimeBinaryVersions `json:"runtimeVersions,omitempty"`
	NostrRelays          []string              `json:"nostrRelays,omitempty"`
	RuntimeModel         string         `json:"runtimeModel"`
	PublicModels         []string       `json:"publicModels"`
	ActiveProfileIDs     []string       `json:"activeProfileIds"`
	Profiles             []ModelProfile `json:"profiles,omitempty"`
	Capacity             int            `json:"capacity"`
	DataDir              string         `json:"dataDir"`
	AllowAllInterfaces   bool           `json:"allowAllInterfaces"`
}

func DefaultConfig(dataDir string) Config {
	return Config{
		DisplayName:        hostname(),
		ListenAddress:      "",
		InferencePort:      8080,
		DashboardAddress:   "127.0.0.1:17777",
		DashboardToken:     dashboardToken(),
		MeshLLMAPIPort:     9337,
		MeshLLMConsolePort: 3131,
		RuntimeModel:       "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_S",
		PublicModels:       []string{"codeflare-mesh"},
		ActiveProfileIDs:   []string{"mesh-default-qwen36-35b"},
		Profiles:           nil,
		Capacity:           1,
		DataDir:            dataDir,
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
	if cfg.DashboardToken == "" {
		cfg.DashboardToken = dashboardToken()
		if cfg.DashboardToken == "" {
			return Config{}, fmt.Errorf("generate dashboard token")
		}
		if err := SaveConfig(path, cfg); err != nil {
			return Config{}, fmt.Errorf("persist dashboard token: %w", err)
		}
	}
	return cfg, nil
}

func ApplyDetectedMeshIP(cfg Config, path string, detect func() (string, bool)) (Config, bool, error) {
	if cfg.MeshIP != "" {
		return cfg, false, nil
	}
	meshIP, ok := detect()
	if !ok || meshIP == "" {
		return cfg, false, nil
	}
	next := cfg
	next.MeshIP = meshIP
	next.ListenAddress = ListenerAddress(next.MeshIP, next.InferencePort, next.AllowAllInterfaces)
	if err := SaveConfig(path, next); err != nil {
		return Config{}, false, err
	}
	return next, true, nil
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

// NamedInterface pairs a network interface name with its addresses so WARP
// detection can key on both the platform adapter name and the WARP CGNAT range.
type NamedInterface struct {
	Name  string
	Addrs []net.Addr
}

func DetectHostMeshIP() (string, bool) {
	if ip, ok := detectWARPInterfaceIP(); ok {
		return ip, true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", false
	}
	return DetectMeshIP(addrs)
}

// DetectWARPInterfaceName returns the name of the up WARP adapter (Linux and
// Windows name it, e.g. `CloudflareWARP`), used to scope the inbound mesh
// firewall rule to WARP traffic. It returns false when no named WARP interface
// is up (macOS routes WARP over an unnamed utun; the app-scoped firewall path
// does not need the name there).
func DetectWARPInterfaceName() (string, bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if warpInterfaceHint(iface.Name) {
			return iface.Name, true
		}
	}
	return "", false
}

// detectWARPInterfaceIP enumerates the up interfaces so WARP detection can match
// the Cloudflare WARP adapter by name, not only by address range.
func detectWARPInterfaceIP() (string, bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", false
	}
	named := make([]NamedInterface, 0, len(ifaces))
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		named = append(named, NamedInterface{Name: iface.Name, Addrs: addrs})
	}
	return DetectWARPMeshIP(named)
}

// DetectWARPMeshIP finds the node's WARP overlay IPv4 across platforms: an IPv4
// carried on the named WARP adapter (Linux, Windows) or any IPv4 in the WARP
// CGNAT range (covers macOS's unnamed utun). It returns false when no WARP
// address exists or when the WARP addresses are ambiguous.
func DetectWARPMeshIP(ifaces []NamedInterface) (string, bool) {
	seen := map[string]struct{}{}
	warp := []string{}
	for _, iface := range ifaces {
		named := warpInterfaceHint(iface.Name)
		for _, addr := range iface.Addrs {
			ip, ok := ipFromAddr(addr)
			if !ok || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			if !isWARPRange(ip) && !(named && isPrivateOrCGNAT(ip)) {
				continue
			}
			text := ip.String()
			if _, dup := seen[text]; dup {
				continue
			}
			seen[text] = struct{}{}
			warp = append(warp, text)
		}
	}
	if len(warp) == 1 {
		return warp[0], true
	}
	return "", false
}

// DetectMeshIP resolves the Mesh IP from bare addresses when interface names are
// unavailable: a lone WARP-range address wins even when LAN addresses coexist,
// otherwise a single private/CGNAT address is used. Ambiguity within the chosen
// tier fails closed.
func DetectMeshIP(addrs []net.Addr) (string, bool) {
	warp := []string{}
	private := []string{}
	for _, addr := range addrs {
		ip, ok := ipFromAddr(addr)
		if !ok || ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		switch {
		case isWARPRange(ip):
			warp = append(warp, ip.String())
		case isPrivateOrCGNAT(ip):
			private = append(private, ip.String())
		}
	}
	if len(warp) == 1 {
		return warp[0], true
	}
	if len(warp) == 0 && len(private) == 1 {
		return private[0], true
	}
	return "", false
}

// RequireMeshIP fails when the Mesh IP is unresolved, before the agent attempts
// a claim the router would reject, pointing the operator at WARP and the config
// override.
func RequireMeshIP(cfg Config) error {
	if cfg.MeshIP == "" {
		return fmt.Errorf("mesh IP is unset and could not be auto-detected: ensure the Cloudflare WARP adapter is connected, or set \"meshIp\" in the agent config to the node's WARP address")
	}
	return nil
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
	if override := os.Getenv("INFERENCE_MESH_CONFIG"); override != "" {
		return override
	}
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
		RouterURL:            cfg.RouterURL,
		SetupToken:           redact(cfg.SetupToken),
		NodeID:               cfg.NodeID,
		NodeToken:            redact(cfg.NodeToken),
		UpstreamToken:        redact(cfg.UpstreamToken),
		DisplayName:          cfg.DisplayName,
		MeshIP:               cfg.MeshIP,
		ListenAddress:        cfg.ListenAddress,
		InferencePort:        cfg.InferencePort,
		DashboardAddress:     cfg.DashboardAddress,
		DashboardToken:       redact(cfg.DashboardToken),
		MeshLLMAPIPort:       cfg.MeshLLMAPIPort,
		MeshLLMConsolePort:   cfg.MeshLLMConsolePort,
		MeshLLMFlavor:        cfg.MeshLLMFlavor,
		MeshLLMAllowUnpinned: cfg.MeshLLMAllowUnpinned,
		NostrRelays:          append([]string(nil), cfg.NostrRelays...),
		RuntimeModel:         cfg.RuntimeModel,
		PublicModels:         append([]string(nil), cfg.PublicModels...),
		ActiveProfileIDs:     append([]string(nil), cfg.ActiveProfileIDs...),
		Profiles:             append([]ModelProfile(nil), cfg.Profiles...),
		Capacity:             cfg.Capacity,
		DataDir:              cfg.DataDir,
		AllowAllInterfaces:   cfg.AllowAllInterfaces,
	}
}

func dashboardToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(buf)
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

// isWARPRange reports whether an IPv4 is in Cloudflare WARP's 100.96.0.0/12
// device range, the address WARP assigns to the local machine.
func isWARPRange(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1] >= 96 && v4[1] <= 111
}

// warpInterfaceHint reports whether an interface name looks like the Cloudflare
// WARP virtual adapter. Linux and Windows expose a named "CloudflareWARP"
// tunnel; macOS presents an unnamed utun, handled by the WARP CGNAT range.
func warpInterfaceHint(name string) bool {
	return strings.Contains(strings.ToLower(name), "warp")
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "inference-node"
	}
	return name
}

const ConfigAnchors = "REQ-NODE-001 REQ-RUN-003 REQ-SEC-004"
