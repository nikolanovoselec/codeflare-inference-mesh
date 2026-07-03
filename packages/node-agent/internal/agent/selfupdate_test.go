package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testSelfUpdateRepo = "nikolanovoselec/codeflare-inference-mesh"

func testReleaseBinaryName() string {
	name := fmt.Sprintf("inference-mesh-agent-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func testReleaseAssetName() string {
	if runtime.GOOS == "windows" {
		return fmt.Sprintf("inference-mesh-agent-%s-%s.zip", runtime.GOOS, runtime.GOARCH)
	}
	return fmt.Sprintf("inference-mesh-agent-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
}

func testReleaseFileURL(tag string, name string) string {
	return "https://github.com/" + testSelfUpdateRepo + "/releases/download/" + tag + "/" + name
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func buildTarGzArchive(t *testing.T, member string, contents []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: member, Mode: 0o755, Size: int64(len(contents))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func buildZipArchive(t *testing.T, member string, contents []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	writer, err := zw.Create(member)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func buildPlatformArchive(t *testing.T, contents []byte) []byte {
	t.Helper()
	if runtime.GOOS == "windows" {
		return buildZipArchive(t, testReleaseBinaryName(), contents)
	}
	return buildTarGzArchive(t, testReleaseBinaryName(), contents)
}

// testChecksums surrounds the platform entry with decoy entries so tests prove
// the correct entry is selected from a multi-line sha256sum file.
func testChecksums(assetName string, assetSHA string) []byte {
	lines := []string{
		strings.Repeat("a", 64) + "  inference-mesh-agent-decoy-one.tar.gz",
		assetSHA + "  " + assetName,
		strings.Repeat("b", 64) + "  inference-mesh-agent-decoy-two.zip",
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

type fakeSelfUpdateEnv struct {
	calls     []string
	errs      map[string]error
	responses map[string][]byte
	applied   []string
	applyHook func(stagedPath string) error
}

func (f *fakeSelfUpdateEnv) download(url string) ([]byte, error) {
	f.calls = append(f.calls, url)
	if err, ok := f.errs[url]; ok {
		return nil, err
	}
	if data, ok := f.responses[url]; ok {
		return data, nil
	}
	return nil, fmt.Errorf("unexpected download url %s", url)
}

func (f *fakeSelfUpdateEnv) apply(stagedPath string) error {
	f.applied = append(f.applied, stagedPath)
	if f.applyHook != nil {
		return f.applyHook(stagedPath)
	}
	return nil
}

func newSelfUpdateFixture(t *testing.T, currentVersion string, tag string, opts ...SelfUpdateOption) (*SelfUpdater, *fakeSelfUpdateEnv, []byte, string) {
	t.Helper()
	binary := []byte("agent-binary-" + tag)
	archive := buildPlatformArchive(t, binary)
	env := &fakeSelfUpdateEnv{responses: map[string][]byte{
		testReleaseFileURL(tag, "checksums.txt"):        testChecksums(testReleaseAssetName(), sha256Hex(archive)),
		testReleaseFileURL(tag, testReleaseAssetName()): archive,
	}}
	dataDir := t.TempDir()
	options := append([]SelfUpdateOption{WithSelfUpdateDownload(env.download), WithSelfUpdateApply(env.apply)}, opts...)
	return NewSelfUpdater(currentVersion, testSelfUpdateRepo, dataDir, options...), env, binary, dataDir
}

func TestREQNODE005DesiredVersionMismatchTriggersUpdate(t *testing.T) {
	t.Run("REQ-NODE-005", func(t *testing.T) {
		now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

		t.Run("matching or empty desired version is a no-op", func(t *testing.T) {
			updater, env, _, _ := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
			for _, desired := range []string{"v1.0.0", ""} {
				applied, err := updater.Maybe(desired, now)
				if err != nil || applied {
					t.Fatalf("desired %q should be a no-op, applied=%v err=%v", desired, applied, err)
				}
			}
			if len(env.calls) != 0 || len(env.applied) != 0 {
				t.Fatalf("no-op must not download or apply: calls=%v applied=%v", env.calls, env.applied)
			}
		})

		t.Run("newer desired version triggers the update flow", func(t *testing.T) {
			updater, env, _, _ := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
			applied, err := updater.Maybe("v1.1.0", now)
			if err != nil {
				t.Fatal(err)
			}
			if !applied || len(env.calls) == 0 || len(env.applied) != 1 {
				t.Fatalf("version mismatch should trigger the update flow: applied=%v calls=%v applies=%d", applied, env.calls, len(env.applied))
			}
		})

		t.Run("older desired version triggers the same flow", func(t *testing.T) {
			updater, env, _, _ := newSelfUpdateFixture(t, "v2.0.0", "v1.0.0")
			applied, err := updater.Maybe("v1.0.0", now)
			if err != nil {
				t.Fatal(err)
			}
			if !applied || len(env.applied) != 1 {
				t.Fatalf("downgrade should apply via the same mechanism: applied=%v applies=%d", applied, len(env.applied))
			}
			for _, call := range env.calls {
				if !strings.Contains(call, "/releases/download/v1.0.0/") {
					t.Fatalf("downgrade should download from the older release tag, got %s", call)
				}
			}
		})
	})
}

func TestREQNODE005DownloadsArtifactAndChecksumsFromReleaseTag(t *testing.T) {
	t.Run("REQ-NODE-005", func(t *testing.T) {
		now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
		updater, env, binary, dataDir := newSelfUpdateFixture(t, "v1.0.0", "v1.2.3")
		downloadsWhenApplied := 0
		env.applyHook = func(stagedPath string) error {
			downloadsWhenApplied = len(env.calls)
			staged, err := os.ReadFile(stagedPath)
			if err != nil {
				t.Fatalf("apply ran before the update was staged: %v", err)
			}
			if !bytes.Equal(staged, binary) {
				t.Fatal("staged binary does not match the release archive member")
			}
			return nil
		}

		applied, err := updater.Maybe("v1.2.3", now)
		if err != nil {
			t.Fatal(err)
		}
		if !applied {
			t.Fatal("expected the update to apply")
		}
		wantChecksums := testReleaseFileURL("v1.2.3", "checksums.txt")
		wantAsset := testReleaseFileURL("v1.2.3", testReleaseAssetName())
		if !containsEnv(env.calls, wantChecksums) || !containsEnv(env.calls, wantAsset) {
			t.Fatalf("expected downloads of %s and %s, got %v", wantChecksums, wantAsset, env.calls)
		}
		if len(env.calls) != 2 || downloadsWhenApplied != 2 || len(env.applied) != 1 {
			t.Fatalf("both downloads must complete before the single apply: calls=%d whenApplied=%d applies=%d", len(env.calls), downloadsWhenApplied, len(env.applied))
		}
		if !strings.HasPrefix(env.applied[0], dataDir) {
			t.Fatalf("update must stage inside the agent data dir, staged at %s", env.applied[0])
		}
		if got := filepath.Base(env.applied[0]); got != testReleaseBinaryName() {
			t.Fatalf("staged binary must keep the release binary name, got %s", got)
		}

		t.Run("extracts the platform binary from tar.gz and zip archives", func(t *testing.T) {
			contents := []byte("member-bytes")
			tarMember := "inference-mesh-agent-linux-amd64"
			got, err := extractArchiveMember("inference-mesh-agent-linux-amd64.tar.gz", buildTarGzArchive(t, tarMember, contents), tarMember)
			if err != nil || !bytes.Equal(got, contents) {
				t.Fatalf("tar.gz extraction failed: err=%v", err)
			}
			zipMember := "inference-mesh-agent-windows-amd64.exe"
			got, err = extractArchiveMember("inference-mesh-agent-windows-amd64.zip", buildZipArchive(t, zipMember, contents), zipMember)
			if err != nil || !bytes.Equal(got, contents) {
				t.Fatalf("zip extraction failed: err=%v", err)
			}
			if _, err := extractArchiveMember("inference-mesh-agent-linux-amd64.tar.gz", buildTarGzArchive(t, "unrelated-file", contents), tarMember); err == nil {
				t.Fatal("archives without the platform binary must fail extraction")
			}
		})
	})
}

func TestREQNODE009AppliesUpdateByAtomicSwapThenExits(t *testing.T) {
	t.Run("REQ-NODE-009", func(t *testing.T) {
		now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
		updater, env, binary, _ := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
		targetPath := filepath.Join(t.TempDir(), "inference-mesh-agent")
		if err := os.WriteFile(targetPath, []byte("running-binary-v1.0.0"), 0o700); err != nil {
			t.Fatal(err)
		}
		env.applyHook = func(stagedPath string) error { return atomicSwap(stagedPath, targetPath) }

		applied, err := updater.Maybe("v1.1.0", now)
		if err != nil {
			t.Fatal(err)
		}
		if !applied {
			t.Fatal("Maybe must report applied=true so the caller exits for the service-manager restart")
		}
		swapped, err := os.ReadFile(targetPath)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(swapped, binary) {
			t.Fatal("running binary was not swapped with the staged update")
		}
		if len(env.applied) != 1 {
			t.Fatalf("expected exactly one apply, got %d", len(env.applied))
		}
		if _, err := os.Stat(env.applied[0]); !os.IsNotExist(err) {
			t.Fatalf("staged binary should be renamed into place, stat err=%v", err)
		}
	})
}

func TestREQNODE009FailureReportsLastErrorAndKeepsCurrentVersion(t *testing.T) {
	t.Run("REQ-NODE-009", func(t *testing.T) {
		now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

		stagedEntries := func(t *testing.T, dataDir string) []string {
			t.Helper()
			entries, err := filepath.Glob(filepath.Join(dataDir, "updates", "*"))
			if err != nil {
				t.Fatal(err)
			}
			return entries
		}

		t.Run("checksum mismatch stops before staging and apply", func(t *testing.T) {
			updater, env, _, dataDir := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
			env.responses[testReleaseFileURL("v1.1.0", "checksums.txt")] = testChecksums(testReleaseAssetName(), strings.Repeat("c", 64))
			applied, err := updater.Maybe("v1.1.0", now)
			if err == nil || applied {
				t.Fatalf("checksum mismatch must fail the update, applied=%v err=%v", applied, err)
			}
			if !strings.Contains(err.Error(), "checksum") {
				t.Fatalf("error must surface the checksum failure for lastError reporting, got %v", err)
			}
			if len(env.applied) != 0 {
				t.Fatal("checksum mismatch must not apply an update")
			}
			if entries := stagedEntries(t, dataDir); len(entries) != 0 {
				t.Fatalf("checksum mismatch must not stage a binary, found %v", entries)
			}
		})

		t.Run("download failure keeps the current binary running", func(t *testing.T) {
			updater, env, _, dataDir := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
			env.errs = map[string]error{testReleaseFileURL("v1.1.0", testReleaseAssetName()): fmt.Errorf("boom")}
			targetPath := filepath.Join(t.TempDir(), "inference-mesh-agent")
			if err := os.WriteFile(targetPath, []byte("running-binary-v1.0.0"), 0o700); err != nil {
				t.Fatal(err)
			}
			env.applyHook = func(stagedPath string) error { return atomicSwap(stagedPath, targetPath) }
			applied, err := updater.Maybe("v1.1.0", now)
			if err == nil || applied {
				t.Fatalf("download failure must fail the update, applied=%v err=%v", applied, err)
			}
			if len(env.applied) != 0 || len(stagedEntries(t, dataDir)) != 0 {
				t.Fatal("download failure must not stage or apply")
			}
			current, readErr := os.ReadFile(targetPath)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if string(current) != "running-binary-v1.0.0" {
				t.Fatal("running binary must stay on the current version after a failure")
			}
		})

		t.Run("missing checksum entry fails the update", func(t *testing.T) {
			updater, env, _, _ := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
			env.responses[testReleaseFileURL("v1.1.0", "checksums.txt")] = []byte(strings.Repeat("a", 64) + "  inference-mesh-agent-other-platform.tar.gz\n")
			applied, err := updater.Maybe("v1.1.0", now)
			if err == nil || applied || len(env.applied) != 0 {
				t.Fatalf("missing checksum entry must fail the update, applied=%v err=%v", applied, err)
			}
		})

		t.Run("apply failure surfaces the error", func(t *testing.T) {
			updater, env, _, _ := newSelfUpdateFixture(t, "v1.0.0", "v1.1.0")
			env.applyHook = func(string) error { return fmt.Errorf("swap refused") }
			applied, err := updater.Maybe("v1.1.0", now)
			if err == nil || applied {
				t.Fatalf("apply failure must fail the update, applied=%v err=%v", applied, err)
			}
		})
	})
}

func TestREQNODE009RetriesOnlyOnVersionChangeOrAfterOneHour(t *testing.T) {
	t.Run("REQ-NODE-009", func(t *testing.T) {
		start := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

		t.Run("same desired version backs off for one hour", func(t *testing.T) {
			updater, env, _, _ := newSelfUpdateFixture(t, "v1.0.0", "v2.0.0")
			env.errs = map[string]error{testReleaseFileURL("v2.0.0", "checksums.txt"): fmt.Errorf("release unavailable")}

			if _, err := updater.Maybe("v2.0.0", start); err == nil {
				t.Fatal("expected the first attempt to fail")
			}
			attempts := len(env.calls)
			if attempts == 0 {
				t.Fatal("the first attempt must download")
			}

			applied, err := updater.Maybe("v2.0.0", start.Add(30*time.Minute))
			if err != nil || applied || len(env.calls) != attempts {
				t.Fatalf("no re-attempt within one hour of a failure: applied=%v err=%v calls=%d", applied, err, len(env.calls))
			}

			if _, err := updater.Maybe("v2.0.0", start.Add(time.Hour)); err == nil {
				t.Fatal("expected the re-attempt after one hour to run and fail")
			}
			if len(env.calls) <= attempts {
				t.Fatal("expected a re-attempt after one hour")
			}
			afterRetry := len(env.calls)

			if _, err := updater.Maybe("v3.0.0", start.Add(time.Hour+time.Minute)); err == nil {
				t.Fatal("expected the changed-version attempt to run and fail")
			}
			if len(env.calls) <= afterRetry {
				t.Fatal("a changed desired version must re-attempt immediately")
			}
		})

		t.Run("zero now falls back to the injected clock", func(t *testing.T) {
			clockNow := start
			updater, env, _, _ := newSelfUpdateFixture(t, "v1.0.0", "v2.0.0", WithSelfUpdateClock(func() time.Time { return clockNow }))
			env.errs = map[string]error{testReleaseFileURL("v2.0.0", "checksums.txt"): fmt.Errorf("release unavailable")}

			if _, err := updater.Maybe("v2.0.0", time.Time{}); err == nil {
				t.Fatal("expected the first attempt to fail")
			}
			attempts := len(env.calls)

			clockNow = start.Add(30 * time.Minute)
			applied, err := updater.Maybe("v2.0.0", time.Time{})
			if err != nil || applied || len(env.calls) != attempts {
				t.Fatalf("clock-injected skip failed: applied=%v err=%v calls=%d", applied, err, len(env.calls))
			}

			clockNow = start.Add(2 * time.Hour)
			if _, err := updater.Maybe("v2.0.0", time.Time{}); err == nil {
				t.Fatal("expected the clocked re-attempt to run and fail")
			}
			if len(env.calls) <= attempts {
				t.Fatal("expected a clock-driven re-attempt after the retry window")
			}
		})
	})
}
