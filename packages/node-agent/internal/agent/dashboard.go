package agent

import (
	"encoding/json"
	"net/http"
)

type DashboardStatus struct {
	Config       Config      `json:"config"`
	Metrics      NodeMetrics `json:"metrics"`
	RuntimeState string      `json:"runtimeState"`
	Version      string      `json:"version"`
}

func DashboardHandler(status func() DashboardStatus) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("content-type", "application/json")
		safe := status()
		safe.Config = RedactedConfig(safe.Config)
		_ = json.NewEncoder(w).Encode(safe)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><title>Inference Mesh Agent</title><main id=app data-status=/api/status></main>"))
	})
	return mux
}

const DashboardAnchors = "REQ-NODE-004"
