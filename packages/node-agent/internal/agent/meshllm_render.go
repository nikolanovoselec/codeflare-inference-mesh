package agent

import (
	"fmt"
	"strconv"
)

// MeshLLMRenderInput carries every value the deterministic mesh-llm argv
// renderer consumes. The manager assembles it from the selected profile,
// agent config, and the router's mesh bootstrap response.
type MeshLLMRenderInput struct {
	ProfileID   string
	ModelRef    string
	Split       bool
	BindPort    int
	MaxVramGb   float64
	MeshIP      string
	APIPort     int
	ConsolePort int
	Flavor      string
	Rotation    int
	JoinTokens  []string
	ConfigPath  string
}

// RenderMeshLLMArgs renders the exact `mesh-llm serve` argument list. The
// order is fixed and by construction the list never contains `--publish`,
// `--listen-all`, `--auto`, `--discover`, or the `nostr` discovery mode:
// discovery is hardwired to `mdns`, which only suppresses public relay,
// STUN, and Nostr egress. The rotation counter is baked into the mesh name
// so a rotation deterministically demands a different mesh identity.
func RenderMeshLLMArgs(in MeshLLMRenderInput) []string {
	args := []string{"serve", "--model", in.ModelRef}
	if in.Split {
		args = append(args, "--split")
	}
	args = append(args,
		"--headless",
		"--mesh-discovery-mode", "mdns",
		"--mesh-name", fmt.Sprintf("codeflare-%s-r%d", in.ProfileID, in.Rotation),
		"--bind-ip", in.MeshIP,
		"--bind-port", strconv.Itoa(in.BindPort),
		"--port", strconv.Itoa(in.APIPort),
		"--console", strconv.Itoa(in.ConsolePort),
	)
	if in.MaxVramGb > 0 {
		args = append(args, "--max-vram", strconv.FormatFloat(in.MaxVramGb, 'f', -1, 64))
	}
	if in.Flavor != "" {
		args = append(args, "--llama-flavor", in.Flavor)
	}
	if in.ConfigPath != "" {
		args = append(args, "--config", in.ConfigPath)
	}
	args = append(args, "--log-format", "json")
	for _, token := range in.JoinTokens {
		args = append(args, "--join", token)
	}
	return args
}

// MeshLLMEnv returns a new environment slice: the inherited base (so
// passthrough values like HF_TOKEN survive) plus MESH_LLM_NO_SELF_UPDATE=1,
// which keeps the upstream self-updater from racing the agent-managed
// binary install. The input slice is never mutated.
func MeshLLMEnv(base []string) []string {
	env := make([]string, 0, len(base)+1)
	env = append(env, base...)
	return append(env, "MESH_LLM_NO_SELF_UPDATE=1")
}

// MeshLLMConfigTOML renders the per-profile mesh-llm config file carrying
// the profile context limit as a `[[models]]` entry with `ctx_size`. A
// non-positive context window returns "" — the context limit is then
// client-facing metadata only and no config file is rendered.
func MeshLLMConfigTOML(modelRef string, contextWindow int) string {
	if contextWindow <= 0 {
		return ""
	}
	return fmt.Sprintf("[[models]]\nname = %q\nctx_size = %d\n", modelRef, contextWindow)
}

const MeshLLMRenderAnchors = "REQ-RUN-003 REQ-RUN-006 REQ-RUN-007 REQ-SEC-004"
