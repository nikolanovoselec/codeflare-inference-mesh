package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"time"
)

type Client struct {
	RouterURL  string
	HTTPClient *http.Client
}

type ClaimRequest struct {
	DisplayName      string   `json:"displayName"`
	MeshIP           string   `json:"meshIp"`
	InferencePort    int      `json:"inferencePort"`
	PublicModels     []string `json:"publicModels"`
	ActiveProfileIDs []string `json:"activeProfileIds"`
	Capacity         int      `json:"capacity"`
}

type ClaimResponse struct {
	NodeID        string         `json:"nodeId"`
	NodeToken     string         `json:"nodeToken"`
	UpstreamToken string         `json:"upstreamToken"`
	Profiles      []ModelProfile `json:"profiles"`
}

type HeartbeatRequest struct {
	NodeID             string      `json:"nodeId"`
	DisplayName        string      `json:"displayName"`
	MeshIP             string      `json:"meshIp"`
	InferencePort      int         `json:"inferencePort"`
	LocalDashboardPort int         `json:"localDashboardPort"`
	Status             string      `json:"status"`
	PublicModels       []string    `json:"publicModels"`
	ActiveProfileIDs   []string    `json:"activeProfileIds"`
	Capacity           int         `json:"capacity"`
	InFlight           int         `json:"inFlight"`
	Runtime            string      `json:"runtime"`
	RuntimeModel       string      `json:"runtimeModel,omitempty"`
	Metrics            NodeMetrics `json:"metrics"`
}

type HeartbeatResponse struct {
	OK              bool           `json:"ok"`
	DesiredProfiles []ModelProfile `json:"desiredProfiles"`
}

func (c Client) Claim(ctx context.Context, setupToken string, req ClaimRequest) (ClaimResponse, error) {
	var out ClaimResponse
	if err := c.post(ctx, "/node/claim", setupToken, req, &out); err != nil {
		return ClaimResponse{}, err
	}
	return out, nil
}

func (c Client) Heartbeat(ctx context.Context, nodeToken string, req HeartbeatRequest) (HeartbeatResponse, error) {
	var out HeartbeatResponse
	if err := c.post(ctx, "/node/heartbeat", nodeToken, req, &out); err != nil {
		return HeartbeatResponse{}, err
	}
	return out, nil
}

func ApplyClaim(cfg Config, claim ClaimResponse, path string) (Config, error) {
	next := cfg
	next.NodeID = claim.NodeID
	next.NodeToken = claim.NodeToken
	next.UpstreamToken = claim.UpstreamToken
	next.Profiles = append([]ModelProfile(nil), claim.Profiles...)
	next.SetupToken = ""
	if err := SaveConfig(path, next); err != nil {
		return Config{}, err
	}
	return next, nil
}

func ApplyDesiredProfiles(cfg Config, desired []ModelProfile, path string) (Config, bool, bool, error) {
	if len(desired) == 0 {
		return cfg, false, false, nil
	}
	before, hadBefore := SelectedProfile(cfg)
	next := cfg
	next.Profiles = append([]ModelProfile(nil), desired...)
	activeProfiles := activeDesiredProfiles(desired)
	if len(activeProfiles) > 0 {
		next.ActiveProfileIDs = profileIDs(activeProfiles)
		next.PublicModels = profileAliases(activeProfiles)
	}
	if selected, ok := SelectedProfile(next); ok {
		next.RuntimeModel = selected.UpstreamModel
	}
	changed := !reflect.DeepEqual(cfg.Profiles, next.Profiles) || !reflect.DeepEqual(cfg.ActiveProfileIDs, next.ActiveProfileIDs) || !reflect.DeepEqual(cfg.PublicModels, next.PublicModels) || cfg.RuntimeModel != next.RuntimeModel
	if !changed {
		return cfg, false, false, nil
	}
	if err := SaveConfig(path, next); err != nil {
		return Config{}, false, false, err
	}
	after, hasAfter := SelectedProfile(next)
	restart := hadBefore != hasAfter || (hadBefore && hasAfter && (before.ID != after.ID || before.Version != after.Version))
	return next, true, restart, nil
}

func activeDesiredProfiles(profiles []ModelProfile) []ModelProfile {
	active := make([]ModelProfile, 0, len(profiles))
	for _, profile := range profiles {
		if profile.Active {
			active = append(active, profile)
		}
	}
	return active
}

func profileIDs(profiles []ModelProfile) []string {
	ids := make([]string, 0, len(profiles))
	for _, profile := range profiles {
		ids = append(ids, profile.ID)
	}
	return ids
}

func profileAliases(profiles []ModelProfile) []string {
	seen := map[string]bool{}
	aliases := []string{}
	for _, profile := range profiles {
		for _, alias := range profile.PublicAliases {
			if !seen[alias] {
				seen[alias] = true
				aliases = append(aliases, alias)
			}
		}
	}
	return aliases
}

func HeartbeatFromConfig(cfg Config, metrics NodeMetrics, inFlight int) HeartbeatRequest {
	return HeartbeatRequest{
		NodeID:             cfg.NodeID,
		DisplayName:        cfg.DisplayName,
		MeshIP:             cfg.MeshIP,
		InferencePort:      cfg.InferencePort,
		LocalDashboardPort: 17777,
		Status:             "online",
		PublicModels:       append([]string(nil), cfg.PublicModels...),
		ActiveProfileIDs:   append([]string(nil), cfg.ActiveProfileIDs...),
		Capacity:           cfg.Capacity,
		InFlight:           inFlight,
		Runtime:            "llama.cpp",
		RuntimeModel:       cfg.RuntimeModel,
		Metrics:            metrics,
	}
}

func (c Client) post(ctx context.Context, path string, token string, req any, out any) error {
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.RouterURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+token)
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("router returned %d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

const ClientAnchors = "REQ-NODE-002"
