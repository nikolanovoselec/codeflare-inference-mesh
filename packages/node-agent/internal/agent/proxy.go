package agent

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func ProxyHandler(runtimeURL string, upstreamToken string) (http.Handler, error) {
	target, err := url.Parse(strings.TrimRight(runtimeURL, "/"))
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = singleJoiningSlash(target.Path, req.URL.Path)
		filterRuntimeHeaders(req.Header)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, req)
			return
		}
		if req.Header.Get("authorization") != "Bearer "+upstreamToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		proxy.ServeHTTP(w, req)
	}), nil
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
