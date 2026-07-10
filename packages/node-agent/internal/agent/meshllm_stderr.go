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

const runtimeLogLineCap = 500

// runtimeLog is a bounded, line-oriented sink for the managed runtime's stderr. It retains
// the most recent error-looking line so the agent can report why mesh-llm failed in heartbeat
// metrics. It is an io.Writer teed alongside os.Stderr and is safe for concurrent use.
type runtimeLog struct {
	mu      sync.Mutex
	pending []byte
	lastErr string
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
	lower := strings.ToLower(line)
	for _, marker := range runtimeErrorMarkers {
		if strings.Contains(lower, marker) {
			if len(line) > runtimeLogLineCap {
				line = line[:runtimeLogLineCap]
			}
			l.lastErr = line
			return
		}
	}
}

// Detail returns the most recent error-looking runtime log line, or "" if none has been seen.
func (l *runtimeLog) Detail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastErr
}
