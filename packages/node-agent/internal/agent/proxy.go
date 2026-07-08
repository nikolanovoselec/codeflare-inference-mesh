package agent

import (
	"crypto/subtle"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
)

type ActiveCounter struct {
	value int64
}

func (c *ActiveCounter) Inc() {
	atomic.AddInt64(&c.value, 1)
}

func (c *ActiveCounter) Dec() {
	atomic.AddInt64(&c.value, -1)
}

func (c *ActiveCounter) Value() int {
	return int(atomic.LoadInt64(&c.value))
}

type RuntimeTargetProvider interface {
	TargetURL() string
}

type staticTarget string

func (s staticTarget) TargetURL() string { return string(s) }

// ProxyHandler guards the local runtime API: only /v1/chat/completions is
// forwarded, only with the upstream bearer token, and never with credential
// headers. The target may be a fixed string or a RuntimeTargetProvider; providers
// are read per request so runtime/profile switches do not rebuild the HTTP server.
func ProxyHandler(targetInput any, upstreamToken string, counters ...*ActiveCounter) (http.Handler, error) {
	provider, err := targetProvider(targetInput)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, req)
			return
		}
		if subtle.ConstantTimeCompare([]byte(req.Header.Get("authorization")), []byte("Bearer "+upstreamToken)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		targetText := strings.TrimRight(provider.TargetURL(), "/")
		if targetText == "" {
			http.Error(w, "runtime_unavailable", http.StatusServiceUnavailable)
			return
		}
		target, err := url.Parse(targetText)
		if err != nil {
			http.Error(w, "runtime_unavailable", http.StatusServiceUnavailable)
			return
		}
		proxy := httputil.NewSingleHostReverseProxy(target)
		originalDirector := proxy.Director
		proxy.Director = func(req *http.Request) {
			originalDirector(req)
			req.URL.Path = singleJoiningSlash(target.Path, req.URL.Path)
			filterRuntimeHeaders(req.Header)
		}
		if len(counters) > 0 && counters[0] != nil {
			counters[0].Inc()
			defer counters[0].Dec()
		}
		proxy.ServeHTTP(w, req)
	}), nil
}

func targetProvider(input any) (RuntimeTargetProvider, error) {
	switch target := input.(type) {
	case string:
		if _, err := url.Parse(strings.TrimRight(target, "/")); err != nil {
			return nil, err
		}
		return staticTarget(target), nil
	case RuntimeTargetProvider:
		return target, nil
	default:
		return nil, http.ErrAbortHandler
	}
}

func filterRuntimeHeaders(headers http.Header) {
	for name := range headers {
		lower := strings.ToLower(name)
		if lower == "authorization" || strings.HasPrefix(lower, "cf-") || strings.Contains(lower, "api-token") {
			headers.Del(name)
		}
	}
}

func singleJoiningSlash(left string, right string) string {
	leftSlash := strings.HasSuffix(left, "/")
	rightSlash := strings.HasPrefix(right, "/")
	switch {
	case leftSlash && rightSlash:
		return left + right[1:]
	case !leftSlash && !rightSlash:
		return left + "/" + right
	default:
		return left + right
	}
}

const ProxyAnchors = "REQ-NODE-003 REQ-SEC-003 REQ-SEC-004"
