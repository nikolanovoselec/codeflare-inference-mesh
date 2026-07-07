package agent

import (
	"strings"
	"testing"
)

func TestREQOBS011RuntimeLogCapturesLastErrorLine(t *testing.T) {
	// The ring keeps the most recent error-looking line and ignores healthy lines, so heartbeat
	// metrics can report why mesh-llm failed. REQ-OBS-011.
	var log runtimeLog
	if _, err := log.Write([]byte(`{"level":"info","msg":"loading model"}` + "\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if log.Detail() != "" {
		t.Fatalf("a healthy line must not be captured, got %q", log.Detail())
	}
	_, _ = log.Write([]byte(`{"level":"error","msg":"persistent downstream lane did not become ready"}` + "\n"))
	if !strings.Contains(log.Detail(), "did not become ready") {
		t.Fatalf("expected the error line captured, got %q", log.Detail())
	}
	// A later error line replaces the earlier one.
	_, _ = log.Write([]byte(`{"level":"error","msg":"cuda out of memory"}` + "\n"))
	if !strings.Contains(log.Detail(), "out of memory") {
		t.Fatalf("expected the most recent error line, got %q", log.Detail())
	}
}

func TestREQOBS011RuntimeLogHandlesSplitWrites(t *testing.T) {
	// A line split across writes is captured only once its newline arrives.
	var log runtimeLog
	_, _ = log.Write([]byte(`{"level":"error","msg":"CUDA `))
	if log.Detail() != "" {
		t.Fatalf("an unterminated line must not be captured yet, got %q", log.Detail())
	}
	_, _ = log.Write([]byte(`error: no kernel image"}` + "\n"))
	if !strings.Contains(log.Detail(), "no kernel image") {
		t.Fatalf("expected the reassembled line captured, got %q", log.Detail())
	}
}

func TestREQOBS011RuntimeErrorDetailReflectsRing(t *testing.T) {
	// The manager surfaces its stderr ring's latest error line through RuntimeErrorDetail, which
	// the heartbeat metrics carry to the console. REQ-OBS-011.
	m := NewMeshLLMManager(MeshLLMRenderInput{}, 0, t.TempDir(), "unused-binary")
	_, _ = m.stderrLog.Write([]byte(`{"level":"error","msg":"out of memory"}` + "\n"))
	if got := m.RuntimeErrorDetail(); !strings.Contains(got, "out of memory") {
		t.Fatalf("expected RuntimeErrorDetail to reflect the stderr ring, got %q", got)
	}
}
