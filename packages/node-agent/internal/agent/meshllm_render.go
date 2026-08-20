package agent

import (
	"fmt"
	"strconv"
	"strings"
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
	// MeshLLMVersion and MeshLLMRepository pin where the launched mesh-llm
	// process resolves its native-runtime manifest. When a fork repository is
	// active they aim MESH_LLM_NATIVE_RUNTIME_MANIFEST_URL at that fork's
	// release, so a freshly-installing node fetches platform runtimes from the
	// same source as its binary instead of upstream. REQ-NODE-014.
	MeshLLMVersion    string
	MeshLLMRepository string
	Rotation          int
	JoinTokens        []string
	NostrRelays       []string
	ConfigPath        string
	// Per-model runtime tunables rendered into the mesh-llm config file (not argv).
	// A zero/empty/nil value is unset and omitted so mesh-llm auto-plans it.
	Tunables MeshLLMSettings
}

// RenderMeshLLMArgs renders the exact `mesh-llm serve` argument list. The order
// is fixed. Discovery is `nostr`: public relays carry only rendezvous metadata
// (never inference), so peers on the Cloudflare WARP overlay can find each other
// without multicast (WARP is unicast, so `mdns` forms only single-node meshes).
// `--bind-ip <MeshIP>` plus `--disable-iroh-relays` confine iroh's encrypted data
// transport to the private WARP overlay with no public relay/STUN fallback, so
// inference data never leaves the mesh. Operator-supplied --nostr-relay entries
// override mesh-llm's public defaults (the hook for a private relay). The rotation
// counter is baked into the mesh name so a rotation deterministically demands a
// different mesh identity.
func RenderMeshLLMArgs(in MeshLLMRenderInput) []string {
	// mesh-llm lets an explicit CLI --model win over config [[models]] at startup
	// (config_owned=false), which discards the config's model_fit: ctx_size, cache_type_k/v,
	// batch, ubatch, and parallel are dropped and the model loads at default context with f16
	// KV (OOMs a large model on a tight GPU). A written per-profile config always carries a
	// [[models]] entry, so omit --model and let that config-owned entry drive the startup load;
	// a configless profile still passes --model directly. REQ-RUN-003.
	args := []string{"serve"}
	if in.ConfigPath == "" {
		args = append(args, "--model", in.ModelRef)
	}
	if in.Split {
		args = append(args, "--split")
	}
	args = append(args,
		"--headless",
		"--mesh-discovery-mode", "nostr",
		"--disable-iroh-relays",
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
	// Operator-configured relays override mesh-llm's public defaults; empty keeps the defaults.
	for _, relay := range in.NostrRelays {
		args = append(args, "--nostr-relay", relay)
	}
	for _, token := range in.JoinTokens {
		args = append(args, "--join", token)
	}
	return args
}

// MeshLLMEnv returns a new environment slice: the inherited base (so
// passthrough values like HF_TOKEN survive) plus MESH_LLM_NO_SELF_UPDATE=1,
// which keeps the upstream self-updater from racing the agent-managed
// binary install. When the profile forces tool emulation it also sets
// MESH_FORCE_TOOL_EMULATION=1, routing tool calls through mesh-llm's
// text-convention emulation instead of the template's native grammar parser.
// A non-empty nativeRuntimeManifestURL sets MESH_LLM_NATIVE_RUNTIME_MANIFEST_URL
// so the subprocess resolves its native runtimes from the active source rather
// than mesh-llm's hardcoded upstream default. The input slice is never mutated.
func MeshLLMEnv(base []string, forceToolEmulation bool, nativeRuntimeManifestURL string) []string {
	env := make([]string, 0, len(base)+3)
	env = append(env, base...)
	env = append(env, "MESH_LLM_NO_SELF_UPDATE=1")
	if forceToolEmulation {
		env = append(env, "MESH_FORCE_TOOL_EMULATION=1")
	}
	if nativeRuntimeManifestURL != "" {
		env = append(env, "MESH_LLM_NATIVE_RUNTIME_MANIFEST_URL="+nativeRuntimeManifestURL)
	}
	return env
}

// meshLLMNativeRuntimesManifestFile is the release asset mesh-llm fetches to
// discover installable native runtimes for the host platform.
const meshLLMNativeRuntimesManifestFile = "native-runtimes.json"

// meshLLMNativeRuntimeManifestURL returns the native-runtime manifest URL the
// mesh-llm subprocess must fetch via MESH_LLM_NATIVE_RUNTIME_MANIFEST_URL, or ""
// when no fork repository is active — mesh-llm then keeps its built-in upstream
// default. mesh-llm hardcodes github.com/Mesh-LLM/mesh-llm for the manifest even
// in fork builds, so without this override a fork-only tag 404s there and a
// freshly-installing node can never provision its runtime (REQ-NODE-014).
func meshLLMNativeRuntimeManifestURL(version, repository string) string {
	if repository == "" {
		return ""
	}
	return meshLLMReleaseBaseURLFor(version, repository) + "/" + meshLLMNativeRuntimesManifestFile
}

// MeshLLMConfigTOML renders the per-profile mesh-llm config file: one `[[models]]`
// entry naming the model in the required `model` field (a bare `name` field is
// rejected with "missing field model"), plus any set runtime tunables under their
// mesh-llm subtables — `[models.model_fit]` (ctx_size, batch, ubatch,
// cache_type_k/v, flash_attention), `[models.throughput]` (parallel), and
// `[models.request_defaults]` (max_tokens, reasoning_*). Every tunable left unset
// (0 / "" / nil, or a non-positive contextWindow) is omitted so mesh-llm
// auto-plans it. `parallel` unset lets mesh-llm plan lanes (auto up to 4); 2+
// enables input caching, 1 disables it. When even the model ref is empty the
// function returns "" and no config file is written.
func MeshLLMConfigTOML(in MeshLLMRenderInput, contextWindow int) string {
	if in.ModelRef == "" {
		return ""
	}
	t := in.Tunables

	var fit strings.Builder
	if contextWindow > 0 {
		fmt.Fprintf(&fit, "ctx_size = %d\n", contextWindow)
	}
	if t.Batch > 0 {
		fmt.Fprintf(&fit, "batch = %d\n", t.Batch)
	}
	if t.Ubatch > 0 {
		fmt.Fprintf(&fit, "ubatch = %d\n", t.Ubatch)
	}
	if t.CacheTypeK != "" {
		fmt.Fprintf(&fit, "cache_type_k = %q\n", t.CacheTypeK)
	}
	if t.CacheTypeV != "" {
		fmt.Fprintf(&fit, "cache_type_v = %q\n", t.CacheTypeV)
	}
	if t.FlashAttn != nil {
		fmt.Fprintf(&fit, "flash_attention = %q\n", flashAttentionValue(*t.FlashAttn))
	}

	var pc strings.Builder
	if t.PrefixCache != nil {
		if t.PrefixCache.Enabled != nil {
			fmt.Fprintf(&pc, "enabled = %t\n", *t.PrefixCache.Enabled)
		}
		if t.PrefixCache.MaxEntries > 0 {
			fmt.Fprintf(&pc, "max_entries = %d\n", t.PrefixCache.MaxEntries)
		}
		// payload_mode is load-bearing: left unset, mesh-llm's Auto inference matches the
		// "qwen3" substring and picks resident-kv, which silently no-ops for recurrent-hybrid
		// architectures (qwen35, qwen3-next, falcon-h1). Pin kv-recurrent for those.
		if t.PrefixCache.PayloadMode != "" {
			fmt.Fprintf(&pc, "payload_mode = %q\n", t.PrefixCache.PayloadMode)
		}
		if t.PrefixCache.SharedStrideTokens > 0 {
			fmt.Fprintf(&pc, "shared_stride_tokens = %d\n", t.PrefixCache.SharedStrideTokens)
		}
		if t.PrefixCache.SharedRecordLimit > 0 {
			fmt.Fprintf(&pc, "shared_record_limit = %d\n", t.PrefixCache.SharedRecordLimit)
		}
	}

	var req strings.Builder
	if t.MaxOutputTokens > 0 {
		fmt.Fprintf(&req, "max_tokens = %d\n", t.MaxOutputTokens)
	}
	if t.Reasoning != nil {
		if t.Reasoning.Enabled != nil {
			fmt.Fprintf(&req, "reasoning_enabled = %t\n", *t.Reasoning.Enabled)
		}
		if t.Reasoning.Format != "" {
			fmt.Fprintf(&req, "reasoning_format = %q\n", t.Reasoning.Format)
		}
		if t.Reasoning.Budget > 0 {
			fmt.Fprintf(&req, "reasoning_budget = %d\n", t.Reasoning.Budget)
		}
	}

	// Staged-transport table. The stage lane rides the WARP overlay (never LAN),
	// where load-induced queueing inflates RTT past the stage tolerance mesh-llm
	// enforces: q8 activation frames halve the wire volume and adaptive-ramp
	// prefill paces bursts so the lane stays under it. Explicit tunables win;
	// unset values fall back to those WARP-optimized defaults on split profiles.
	wire := t.WireDtype
	chunking := t.PrefillChunking
	if in.Split {
		if wire == "" {
			wire = "q8"
		}
		if chunking == "" {
			chunking = "adaptive-ramp"
		}
	}
	var sk strings.Builder
	if wire != "" {
		fmt.Fprintf(&sk, "activation_wire_dtype = %q\n", wire)
	}
	if chunking != "" {
		fmt.Fprintf(&sk, "prefill_chunking = %q\n", chunking)
	}
	if t.PrefillChunkSize > 0 {
		fmt.Fprintf(&sk, "prefill_chunk_size = %d\n", t.PrefillChunkSize)
	}

	// Nothing overrides the mesh-llm defaults: render no config file so the
	// runtime keeps its own auto-planning (backward-compatible with a bare
	// profile that carried no context limit and no tunables).
	if fit.Len() == 0 && pc.Len() == 0 && req.Len() == 0 && sk.Len() == 0 && t.Parallel <= 0 {
		return ""
	}

	var b strings.Builder
	fmt.Fprintf(&b, "[[models]]\nmodel = %q\n", in.ModelRef)
	if fit.Len() > 0 {
		b.WriteString("\n[models.model_fit]\n")
		b.WriteString(fit.String())
	}
	// prefix_cache is a subtable of model_fit, so it must precede the throughput
	// table (once [models.throughput] opens, no more [models.model_fit.*] may follow).
	if pc.Len() > 0 {
		b.WriteString("\n[models.model_fit.prefix_cache]\n")
		b.WriteString(pc.String())
	}
	if t.Parallel > 0 {
		fmt.Fprintf(&b, "\n[models.throughput]\nparallel = %d\n", t.Parallel)
	}
	if req.Len() > 0 {
		b.WriteString("\n[models.request_defaults]\n")
		b.WriteString(req.String())
	}
	if sk.Len() > 0 {
		b.WriteString("\n[models.skippy]\n")
		b.WriteString(sk.String())
	}
	return b.String()
}

// flashAttentionValue maps the on/off toggle to mesh-llm's snake_case
// FlashAttentionType variants.
func flashAttentionValue(on bool) string {
	if on {
		return "enabled"
	}
	return "disabled"
}

const MeshLLMRenderAnchors = "REQ-RUN-003 REQ-RUN-006 REQ-RUN-007 REQ-SEC-004"
