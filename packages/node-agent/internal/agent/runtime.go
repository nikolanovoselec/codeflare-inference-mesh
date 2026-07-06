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
	Version        int               `json:"version"`
	RolloutPercent int               `json:"rolloutPercent"`
	Active         bool              `json:"active"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

type MeshLLMSettings struct {
	ModelRef  string  `json:"modelRef"`
	Split     bool    `json:"split"`
	BindPort  int     `json:"bindPort"`
	MaxVramGb float64 `json:"maxVramGb,omitempty"`
	// Per-model mesh-llm runtime tunables (REQ-RUN-003). Each maps to a mesh-llm
	// config key; a zero/empty/nil value means "unset" and is omitted from the
	// rendered config so mesh-llm auto-plans it. Parallel omitted (0) leaves lane
	// planning to mesh-llm (auto up to 4); 1 disables input caching, 2+ enables it.
	Parallel        int                `json:"parallel,omitempty"`
	CacheTypeK      string             `json:"cacheTypeK,omitempty"`
	CacheTypeV      string             `json:"cacheTypeV,omitempty"`
	Batch           int                `json:"batch,omitempty"`
	Ubatch          int                `json:"ubatch,omitempty"`
	FlashAttn       *bool              `json:"flashAttn,omitempty"`
	MaxOutputTokens int                `json:"maxOutputTokens,omitempty"`
	Reasoning       *ReasoningSettings `json:"reasoning,omitempty"`
}

// ReasoningSettings carries the model's thinking-phase config. Enabled nil means
// unset (omitted); Format "" and Budget 0 are likewise omitted.
type ReasoningSettings struct {
	Enabled *bool  `json:"enabled,omitempty"`
	Format  string `json:"format,omitempty"`
	Budget  int    `json:"budget,omitempty"`
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
