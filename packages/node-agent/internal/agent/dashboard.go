package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
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
	mux.HandleFunc("/api/runtime/start", runtimeAction(status, controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Start(ctx) }))
	mux.HandleFunc("/api/runtime/stop", runtimeAction(status, controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Stop(ctx) }))
	mux.HandleFunc("/api/runtime/restart", runtimeAction(status, controllers, func(ctx context.Context, controller RuntimeController) error { return controller.Restart(ctx) }))
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		cfg := status().Config
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><title>Inference Mesh Agent</title><meta name=csrf-token content=\"" + html.EscapeString(cfg.DashboardToken) + "\"><main id=app data-status=/api/status></main>"))
	})
	return mux
}

func runtimeAction(status func() DashboardStatus, controllers []RuntimeController, action func(context.Context, RuntimeController) error) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			http.NotFound(w, req)
			return
		}
		cfg := status().Config
		if !dashboardControlAllowed(req, cfg) {
			http.Error(w, "forbidden", http.StatusForbidden)
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

func dashboardControlAllowed(req *http.Request, cfg Config) bool {
	if cfg.DashboardToken == "" || subtle.ConstantTimeCompare([]byte(req.Header.Get("x-inference-mesh-dashboard-token")), []byte(cfg.DashboardToken)) != 1 {
		return false
	}
	if !isLoopbackAddress(cfg.DashboardAddress) || !isLoopbackHost(req.Host) {
		return false
	}
	origin := req.Header.Get("origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	return sameHost(parsed.Host, req.Host) && isLoopbackHost(parsed.Host)
}

func sameHost(left string, right string) bool {
	return strings.EqualFold(left, right)
}

func isLoopbackAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	return isLoopbackHost(host)
}

func isLoopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

const DashboardAnchors = "REQ-NODE-004 REQ-SEC-004"
