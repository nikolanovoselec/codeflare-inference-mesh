package agent

import (
	"context"
	"errors"
)

// ModelProfile mirrors the router's profile wire shape. MeshLLM owns model
// acquisition, so the profile carries only the model reference and mesh
// transport values inside MeshLLM; there are no per-file download fields.
type ModelProfile struct {
	ID             string            `json:"id"`
	PublicAliases  []string          `json:"publicAliases"`
	UpstreamModel  string            `json:"upstreamModel"`
	SourceMode     string            `json:"sourceMode"`
	ContextWindow  int               `json:"contextWindow"`
	Runtime        string            `json:"runtime"`
	MeshLLM        MeshLLMSettings   `json:"meshllm"`
	LlamaCpp       LlamaCppSettings  `json:"llamacpp"`
	Version        int               `json:"version"`
	RolloutPercent int               `json:"rolloutPercent"`
	Active         bool              `json:"active"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

type LlamaCppSettings struct {
	ModelRef        string             `json:"modelRef"`
	HFRepo          string             `json:"hfRepo"`
	HFFile          string             `json:"hfFile,omitempty"`
	Quant           string             `json:"quant,omitempty"`
	BindPort        int                `json:"bindPort"`
	ContextWindow   int                `json:"contextWindow"`
	Parallel        int                `json:"parallel"`
	CachePrompt     bool               `json:"cachePrompt"`
	CacheReuse      int                `json:"cacheReuse"`
	// KVUnified nil or true renders --kv-unified so one request can use the whole
	// context window; false renders --no-kv-unified, which divides --ctx-size
	// evenly across parallel slots (REQ-RUN-015).
	KVUnified       *bool              `json:"kvUnified,omitempty"`
	CacheTypeK      string             `json:"cacheTypeK,omitempty"`
	CacheTypeV      string             `json:"cacheTypeV,omitempty"`
	Batch           int                `json:"batch,omitempty"`
	Ubatch          int                `json:"ubatch,omitempty"`
	FlashAttn       *bool              `json:"flashAttn,omitempty"`
	MaxOutputTokens int                `json:"maxOutputTokens,omitempty"`
	GPULayers       string             `json:"gpuLayers,omitempty"`
	Alias           string             `json:"alias"`
	Reasoning       *ReasoningSettings `json:"reasoning,omitempty"`
}

type MeshLLMSettings struct {
	ModelRef  string  `json:"modelRef"`
	Split     bool    `json:"split"`
	BindPort  int     `json:"bindPort"`
	MaxVramGb float64 `json:"maxVramGb,omitempty"`
	// Per-model mesh-llm runtime tunables (REQ-RUN-002 / REQ-RUN-003). Each maps to a
	// mesh-llm config key; a zero/empty/nil value means "unset" and is omitted so
	// mesh-llm auto-plans it. An omitted Parallel does NOT auto-plan to 4 lanes (it may
	// pick 1); PrefixCache, not Parallel, turns on input caching, and it needs Parallel
	// of at least 2 to run in unified-KV mode.
	Parallel        int                  `json:"parallel,omitempty"`
	CacheTypeK      string               `json:"cacheTypeK,omitempty"`
	CacheTypeV      string               `json:"cacheTypeV,omitempty"`
	Batch           int                  `json:"batch,omitempty"`
	Ubatch          int                  `json:"ubatch,omitempty"`
	FlashAttn       *bool                `json:"flashAttn,omitempty"`
	MaxOutputTokens int                  `json:"maxOutputTokens,omitempty"`
	Reasoning       *ReasoningSettings   `json:"reasoning,omitempty"`
	PrefixCache     *PrefixCacheSettings `json:"prefixCache,omitempty"`
	// ToolEmulation forces mesh-llm's server-side tool-call emulation
	// (MESH_FORCE_TOOL_EMULATION=1) for models whose template advertises a
	// native tool grammar that mesh-llm cannot parse (e.g. ERNIE Thinking).
	ToolEmulation bool `json:"toolEmulation,omitempty"`
	// Staged-transport tunables. Empty values resolve to the WARP-optimized
	// defaults on split profiles (q8 wire, adaptive-ramp prefill).
	WireDtype        string `json:"wireDtype,omitempty"`
	PrefillChunking  string `json:"prefillChunking,omitempty"`
	PrefillChunkSize int    `json:"prefillChunkSize,omitempty"`
}

// ReasoningSettings carries the model's thinking-phase config. Enabled nil means
// unset (omitted); Format "" and Budget 0 are likewise omitted.
type ReasoningSettings struct {
	Enabled *bool  `json:"enabled,omitempty"`
	Format  string `json:"format,omitempty"`
	Budget  int    `json:"budget,omitempty"`
}

// PrefixCacheSettings turns on mesh-llm's resident prompt-prefix cache, which is
// what populates OpenAI's prompt_tokens_details.cached_tokens. It is NOT gated by
// parallel lanes: without an explicit enable, mesh-llm defers to per-family
// auto-detection, which leaves the cache off for any uncertified model family, so
// every request re-prefills the whole prompt. Enabled nil means unset (omitted).
type PrefixCacheSettings struct {
	Enabled            *bool  `json:"enabled,omitempty"`
	MaxEntries         int    `json:"maxEntries,omitempty"`
	PayloadMode        string `json:"payloadMode,omitempty"`
	SharedStrideTokens int    `json:"sharedStrideTokens,omitempty"`
	SharedRecordLimit  int    `json:"sharedRecordLimit,omitempty"`
}

var ErrRuntimeDependencyMissing = errors.New("runtime dependency missing")

type RuntimeController interface {
	Start(context.Context) error
	Stop(context.Context) error
	Restart(context.Context) error
}

// SelectedProfile picks the one profile the node runs: the first active
// profile id with a matching profile entry, falling back to an upstream-model
// match. The agent runs at most one mesh-llm process, so when several active
// MeshLLM profiles apply, the first active profile wins.
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

const RuntimeAnchors = "REQ-RUN-006"
