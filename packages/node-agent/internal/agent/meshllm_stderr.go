package agent

import (
	"bytes"
	"strings"
	"sync"
)

// runtimeErrorMarkers are the lowercase substrings that flag a mesh-llm log line as an
// error worth surfacing. mesh-llm logs JSON (`--log-format json`), so a matching line is a
// full JSON entry; it is kept verbatim (truncated) so operators see the real cause — an OOM,
// a CUDA fault, a stage-lane handshake failure — in heartbeat metrics rather than only in the
// host journal.
var runtimeErrorMarkers = []string{
	"error", "failed", "fatal", "panic", "out of memory", "oom",
	"cuda", "unable", "refused", "not ready", "timed out", "no such",
}

// A warn/info/debug/trace-leveled tracing line is runtime chatter (mesh-llm warns freely
// during QUIC path churn), never the reason the runtime failed — unless the line also
// carries one of these hard tokens, which override the level gate.
var runtimeNonErrorLevels = []string{"warn", "info", "debug", "trace"}

// llama.cpp shares this ring but prints its severity as a bare uppercase letter
// ("355.41.434.230 W srv alloc: ...") rather than spelling it out the way mesh-llm's JSON
// does, so the spelled-out gate above never saw it and every llama.cpp warning carrying a
// weak marker read as a live runtime error.
var runtimeLetterNonErrorLevels = []string{"W", "I", "D"}

var runtimeStrongErrorMarkers = []string{"error", "fatal", "panic"}

// containsMarker reports whether any marker stands at the start of a word. Anchoring the
// start keeps a short marker from hiding inside a longer one: "oom" inside "making room
// for prompt cache entry" is a cache eviction, not an out-of-memory report. The end stays
// free so an inflected marker ("panicked at") still matches.
func containsMarker(value string, markers []string) bool {
	for _, marker := range markers {
		for offset := 0; offset < len(value); {
			i := strings.Index(value[offset:], marker)
			if i < 0 {
				break
			}
			at := offset + i
			if !isWordByte(value, at-1) {
				return true
			}
			offset = at + 1
		}
	}
	return false
}

// letterLevelChatter reports whether the line leads with llama.cpp's bare severity letter.
// That level is its own field near the start of the line, so only the leading fields are
// considered. A capital standing deeper in a message, the "I/O" of "I/O failed on stage
// lane", is part of the text rather than a severity and must keep surfacing.
func letterLevelChatter(line string) bool {
	fields := strings.Fields(line)
	if len(fields) > 2 {
		fields = fields[:2]
	}
	for _, field := range fields {
		for _, level := range runtimeLetterNonErrorLevels {
			if field == level {
				return true
			}
		}
	}
	return false
}

// isWordByte treats letters and digits as word interior; an underscore separates words in
// runtime log identifiers ("srv_oom_kill"), so it stays a boundary.
func isWordByte(value string, i int) bool {
	if i < 0 || i >= len(value) {
		return false
	}
	c := value[i]
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// containsLevelToken matches level markers as whole words only — "trace" inside
// "backtrace" or "info" inside "information" is not a log level and must not make
// an error line read as leveled chatter.
func containsLevelToken(value string, markers []string) bool {
	for _, token := range strings.FieldsFunc(value, func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z')
	}) {
		for _, marker := range markers {
			if token == marker {
				return true
			}
		}
	}
	return false
}

const runtimeLogLineCap = 500

// runtimeLog is a bounded, line-oriented sink for the managed runtime's stderr. It retains
// the most recent error-looking line so the agent can report why mesh-llm failed in heartbeat
// metrics. It is an io.Writer teed alongside os.Stderr and is safe for concurrent use.
type runtimeLog struct {
	mu         sync.Mutex
	pending    []byte
	lastErr    string
	multimodal bool
}

func (l *runtimeLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	l.pending = append(l.pending, p...)
	for {
		i := bytes.IndexByte(l.pending, '\n')
		if i < 0 {
			break
		}
		l.consumeLine(string(l.pending[:i]))
		l.pending = l.pending[i+1:]
	}
	// Bound the unterminated-line buffer so a no-newline stream cannot grow without limit.
	if len(l.pending) > 8192 {
		l.pending = l.pending[len(l.pending)-8192:]
	}
	l.mu.Unlock()
	return len(p), nil
}

func (l *runtimeLog) consumeLine(raw string) {
	line := strings.TrimSpace(raw)
	if line == "" {
		return
	}
	// llama.cpp reports its cross-divergence reuse optimization as unsupported
	// for multimodal models. Ordinary text prefix caching remains separate and
	// available through cache-prompt. REQ-OBS-013.
	if strings.Contains(line, "cache_reuse is not supported by multimodal") {
		l.multimodal = true
	}
	lower := strings.ToLower(line)
	chatter := containsLevelToken(lower, runtimeNonErrorLevels) || letterLevelChatter(line)
	if !containsMarker(lower, runtimeStrongErrorMarkers) && chatter {
		return
	}
	if containsMarker(lower, runtimeErrorMarkers) {
		if len(line) > runtimeLogLineCap {
			line = line[:runtimeLogLineCap]
		}
		l.lastErr = line
	}
}

// Detail returns the most recent error-looking runtime log line, or "" if none has been seen.
func (l *runtimeLog) Detail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastErr
}

// Reset clears the captured line. The runtime just reached a fresh ready state, so
// whatever the ring still holds belongs to an earlier lifecycle and must not keep
// reporting as a live degradation on a healthy node (REQ-OBS-011). The multimodal
// flag is a fact about the loaded model, not about a failure, so it survives.
func (l *runtimeLog) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lastErr = ""
}

// ResetLifecycle clears model-specific state before a replacement process starts.
// Readiness Reset deliberately preserves multimodal for the current process, while
// a new model must rediscover that capability from its own stderr.
func (l *runtimeLog) ResetLifecycle() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lastErr = ""
	l.multimodal = false
}

// Multimodal reports whether llama-server announced that the current loaded model
// cannot use the cross-divergence reuse optimization.
func (l *runtimeLog) Multimodal() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.multimodal
}
