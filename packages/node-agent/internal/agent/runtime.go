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
