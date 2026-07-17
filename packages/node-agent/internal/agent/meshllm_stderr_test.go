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

func TestREQOBS011RuntimeLogIgnoresNonErrorLevelLines(t *testing.T) {
	// mesh-llm warns freely during QUIC path churn; a warn/info-leveled line — even one
	// containing "failed" — is runtime chatter, not the reason the runtime failed, so it
	// must never become the surfaced error detail. REQ-OBS-011.
	var log runtimeLog
	_, _ = log.Write([]byte("\x1b[2m2026-07-15T19:14:17Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mnoq_proto::connection\x1b[0m: failed closing path \x1b[3merr\x1b[0m=MultipathNotNegotiated\n"))
	if log.Detail() != "" {
		t.Fatalf("a WARN-leveled line must not be captured, got %q", log.Detail())
	}
	_, _ = log.Write([]byte(`{"level":"info","msg":"retry failed, backing off"}` + "\n"))
	if log.Detail() != "" {
		t.Fatalf("an info-leveled line must not be captured, got %q", log.Detail())
	}
	// A hard error token overrides the level gate, and non-leveled raw stderr keeps working.
	_, _ = log.Write([]byte(`{"level":"warn","msg":"panic recovered in stage lane"}` + "\n"))
	if !strings.Contains(log.Detail(), "panic recovered") {
		t.Fatalf("a strong token must override the level gate, got %q", log.Detail())
	}
	_, _ = log.Write([]byte("CUDA error: out of memory\n"))
	if !strings.Contains(log.Detail(), "out of memory") {
		t.Fatalf("plain error stderr must still be captured, got %q", log.Detail())
	}
}

func TestREQOBS011RuntimeLogLevelTokensMatchWholeWordsOnly(t *testing.T) {
	// "trace" inside "backtrace" and "info" inside "information" are not log levels;
	// an error line carrying such a substring must still surface. REQ-OBS-011.
	var log runtimeLog
	_, _ = log.Write([]byte("stack backtrace: connection refused by peer\n"))
	if !strings.Contains(log.Detail(), "refused") {
		t.Fatalf("a backtrace line with a weak marker must be captured, got %q", log.Detail())
	}
	var infoLike runtimeLog
	_, _ = infoLike.Write([]byte("gathering information: peer not ready\n"))
	if !strings.Contains(infoLike.Detail(), "not ready") {
		t.Fatalf("'information' is not the info level, got %q", infoLike.Detail())
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
