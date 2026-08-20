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

func TestREQOBS011RuntimeLogErrorMarkersAnchorAtWordStart(t *testing.T) {
	// "oom" inside "making room" is a prompt-cache eviction, not an out-of-memory report:
	// a marker hiding inside a longer word must never become the surfaced error detail.
	// REQ-OBS-011.
	var log runtimeLog
	_, _ = log.Write([]byte("355.41.434.230 E srv alloc: - making room for prompt cache entry, removing oldest entry (size = 583.167 MiB)\n"))
	if log.Detail() != "" {
		t.Fatalf("'room' must not match the oom marker, got %q", log.Detail())
	}
	// A marker standing at a word start still surfaces.
	_, _ = log.Write([]byte("llama_model_load: oom while allocating the kv cache\n"))
	if !strings.Contains(log.Detail(), "oom while allocating") {
		t.Fatalf("a word-start oom must be captured, got %q", log.Detail())
	}
	// The anchor binds the start only, so an inflected marker keeps matching.
	var panicked runtimeLog
	_, _ = panicked.Write([]byte("thread 'stage-0' panicked at src/lane.rs:118\n"))
	if !strings.Contains(panicked.Detail(), "panicked at") {
		t.Fatalf("'panicked' must still match the panic marker, got %q", panicked.Detail())
	}
}

func TestREQOBS011RuntimeLogIgnoresLlamaCppLetterLevelLines(t *testing.T) {
	// llama.cpp shares this ring with mesh-llm but prints its severity as a bare uppercase
	// letter instead of a spelled-out JSON level, so a llama.cpp warning carrying a weak
	// marker word must still read as chatter while its error severity surfaces. REQ-OBS-011.
	var log runtimeLog
	_, _ = log.Write([]byte("355.41.434.230 W srv params_from_: unable to reuse slot, reprocessing prompt\n"))
	if log.Detail() != "" {
		t.Fatalf("a llama.cpp W-level line must not be captured, got %q", log.Detail())
	}
	_, _ = log.Write([]byte("355.41.434.231 E srv load_model: unable to load model\n"))
	if !strings.Contains(log.Detail(), "unable to load model") {
		t.Fatalf("a llama.cpp E-level line must be captured, got %q", log.Detail())
	}
	// A capital inside the message text is not a severity: only the leading level field is.
	var prose runtimeLog
	_, _ = prose.Write([]byte("stage lane I/O failed while opening the socket\n"))
	if !strings.Contains(prose.Detail(), "I/O failed") {
		t.Fatalf("a capital in message text is not a level, got %q", prose.Detail())
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

func TestREQOBS011RuntimeLogResetClearsCapturedLine(t *testing.T) {
	// A ready transition resets the ring: an error captured by a previous lifecycle
	// must not keep reporting after the runtime is healthy again. REQ-OBS-011.
	l := &runtimeLog{}
	_, _ = l.Write([]byte("E ggml_gallocr_reserve_n_impl: failed to allocate Vulkan0 buffer\n"))
	if got := l.Detail(); got == "" {
		t.Fatal("setup: the error line must be captured before the reset")
	}
	l.Reset()
	if got := l.Detail(); got != "" {
		t.Fatalf("reset must clear the captured line, got %q", got)
	}
}

func TestREQOBS013RuntimeLogFlagsMultimodalCacheReusePerLifecycle(t *testing.T) {
	// llama.cpp disables only its cross-divergence reuse optimization on this
	// line; ordinary text prefix caching is separate. The capability applies
	// only to the model lifecycle that emitted it.
	l := &runtimeLog{}
	_, _ = l.Write([]byte("load_model: loaded multimodal model, '/cache/Qwen3.8-27B-UD-Q3_K_XL.gguf'\n"))
	if l.Multimodal() {
		t.Fatal("the model-load line alone must not flag multimodal cache-reuse")
	}
	_, _ = l.Write([]byte("load_model: cache_reuse is not supported by multimodal, it will be disabled\n"))
	if !l.Multimodal() {
		t.Fatal("the cache_reuse multimodal line must flag the ring")
	}
	l.ResetLifecycle()
	if l.Multimodal() {
		t.Fatal("a new model lifecycle must not inherit the previous model's multimodal state")
	}
}
