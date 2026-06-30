package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type DashboardStatus struct {
	Config       Config      `json:"config"`
	Metrics      NodeMetrics `json:"metrics"`
	RuntimeState string      `json:"runtimeState"`
	Version      string      `json:"version"`
}

func DashboardHandler(status func() DashboardStatus, controllers ...RuntimeController) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("content-type", "application/json")
		safe := status()
		safe.Config = RedactedConfig(safe.Config)
		_ = json.NewEncoder(w).Encode(safe)
	})
	mux.HandleFunc("/api/runtime/start", runtimeAction(controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Start(ctx) }))
	mux.HandleFunc("/api/runtime/stop", runtimeAction(controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Stop(ctx) }))
	mux.HandleFunc("/api/runtime/restart", runtimeAction(controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Restart(ctx) }))
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><title>Inference Mesh Agent</title><main id=app data-status=/api/status></main>"))
	})
	return mux
}

func runtimeAction(controllers []RuntimeController, action func(context.Context, RuntimeController) error) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			http.NotFound(w, req)
			return
		}
		if len(controllers) == 0 || controllers[0] == nil {
			http.Error(w, "runtime controller unavailable", http.StatusConflict)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), 30*time.Second)
		defer cancel()
		if err := action(ctx, controllers[0]); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

const DashboardAnchors = "REQ-NODE-004"
