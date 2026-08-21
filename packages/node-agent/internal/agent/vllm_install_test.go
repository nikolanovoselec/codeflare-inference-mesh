package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The install fakes below stand in for the network, the disk probe, and the uv
// subprocess; EnsureVllm's own sequencing (capability gate, preflight, checksum,
// marker, symlink swap) is always the real code under test. REQ-NODE-017.

func vllmTestOptions(dataDir string, runner *fakeVllmRunner, probeVersion string) []VllmInstallOption {
	return []VllmInstallOption{
		WithVllmPlatform("linux"),
		WithVllmCudaProbe(func() bool { return true }),
		WithVllmDiskFree(func(path string) (uint64, error) { return 64 << 30, nil }),
		WithVllmUvDownload(func(assetURL string) ([]byte, error) {
			return nil, errors.New("uv download must not run when a managed uv is present")
		}),
		WithVllmRunner(runner.run),
		WithVllmVersionProbe(func(binary string) (string, error) {
			runner.probed = append(runner.probed, binary)
			if probeVersion == "" {
				return "", errors.New("vllm --version failed")
			}
			return probeVersion, nil
		}),
	}
}

type fakeVllmRunner struct {
	dataDir string
	calls   [][]string
	probed  []string
}

// run records each uv invocation and materialises the venv binary the way a
// real `uv venv` would, so the completion probe has a file to point at.
func (f *fakeVllmRunner) run(uvPath string, args ...string) error {
	f.calls = append(f.calls, append([]string{uvPath}, args...))
	joined := strings.Join(args, " ")
	if strings.HasPrefix(joined, "venv") {
		for _, arg := range args {
			if strings.HasPrefix(arg, f.dataDir) {
				binDir := filepath.Join(arg, "bin")
				if err := os.MkdirAll(binDir, 0o700); err != nil {
					return err
				}
				return os.WriteFile(filepath.Join(binDir, "vllm"), []byte("#!/bin/sh\n"), 0o700)
			}
		}
	}
	return nil
}

func (f *fakeVllmRunner) joinedCalls() []string {
	joined := make([]string, 0, len(f.calls))
	for _, call := range f.calls {
		joined = append(joined, strings.Join(call, " "))
	}
	return joined
}

func seedManagedUv(t *testing.T, dataDir string) string {
	t.Helper()
	binDir := filepath.Join(dataDir, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatalf("create managed bin dir: %v", err)
	}
	uvPath := filepath.Join(binDir, "uv")
	if err := os.WriteFile(uvPath, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatalf("write managed uv: %v", err)
	}
	if err := os.WriteFile(filepath.Join(binDir, ".uv-version"), []byte(UvPinnedVersion+"\n"), 0o600); err != nil {
		t.Fatalf("write managed uv stamp: %v", err)
	}
	return uvPath
}

func TestREQNODE017EnsureVllmFailsClosedOffLinux(t *testing.T) {
	dataDir := t.TempDir()
	runner := &fakeVllmRunner{dataDir: dataDir}
	_, err := EnsureVllm(dataDir, "",
		WithVllmPlatform("darwin"),
		WithVllmCudaProbe(func() bool { return true }),
		WithVllmRunner(runner.run))
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if !strings.Contains(err.Error(), "vLLM requires Linux + NVIDIA CUDA") {
		t.Fatalf("error must name the capability requirement, got %q", err.Error())
	}
	if len(runner.calls) != 0 {
		t.Fatalf("no install step may run on an unsupported platform, got %v", runner.joinedCalls())
	}
}

func TestREQNODE017EnsureVllmFailsClosedWithoutCuda(t *testing.T) {
	dataDir := t.TempDir()
	runner := &fakeVllmRunner{dataDir: dataDir}
	_, err := EnsureVllm(dataDir, "",
		WithVllmPlatform("linux"),
		WithVllmCudaProbe(func() bool { return false }),
		WithVllmRunner(runner.run))
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if !strings.Contains(err.Error(), "vLLM requires Linux + NVIDIA CUDA") {
		t.Fatalf("error must name the capability requirement, got %q", err.Error())
	}
	if len(runner.calls) != 0 {
		t.Fatalf("no install step may run without CUDA, got %v", runner.joinedCalls())
	}
}

func TestREQNODE017EnsureVllmRefusesLowDisk(t *testing.T) {
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	opts := vllmTestOptions(dataDir, runner, "0.27.1")
	opts = append(opts, WithVllmDiskFree(func(path string) (uint64, error) { return 5 << 30, nil }))
	_, err := EnsureVllm(dataDir, "", opts...)
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if !strings.Contains(err.Error(), "disk") {
		t.Fatalf("preflight refusal must name the disk shortfall, got %q", err.Error())
	}
	if len(runner.calls) != 0 {
		t.Fatalf("venv install must not start below the disk floor, got %v", runner.joinedCalls())
	}
}

func TestREQNODE017EnsureVllmRefusesWhenDiskProbeFails(t *testing.T) {
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	opts := vllmTestOptions(dataDir, runner, "0.27.1")
	opts = append(opts, WithVllmDiskFree(func(path string) (uint64, error) { return 0, errors.New("statfs unavailable") }))
	_, err := EnsureVllm(dataDir, "", opts...)
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if !strings.Contains(err.Error(), "disk preflight") {
		t.Fatalf("a failed probe must fail closed naming the preflight, got %q", err.Error())
	}
	if len(runner.calls) != 0 {
		t.Fatalf("venv install must not start when the disk probe fails, got %v", runner.joinedCalls())
	}
}

func TestREQNODE017EnsureVllmRedownloadsUvOnStaleStamp(t *testing.T) {
	// A managed uv is reused only while its version stamp matches the pin, so a
	// re-pin reaches nodes that already hold a uv binary. The stale stamp must
	// force the download path, whose checksum gate then rejects the fake bytes —
	// proving the stat-only reuse fast path was not taken.
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	if err := os.WriteFile(filepath.Join(dataDir, "bin", ".uv-version"), []byte("0.11.0\n"), 0o600); err != nil {
		t.Fatalf("write stale uv stamp: %v", err)
	}
	runner := &fakeVllmRunner{dataDir: dataDir}
	var downloads []string
	_, err := EnsureVllm(dataDir, "",
		WithVllmPlatform("linux"),
		WithVllmCudaProbe(func() bool { return true }),
		WithVllmDiskFree(func(path string) (uint64, error) { return 64 << 30, nil }),
		WithVllmUvDownload(func(assetURL string) ([]byte, error) {
			downloads = append(downloads, assetURL)
			return []byte("not the pinned uv archive"), nil
		}),
		WithVllmRunner(runner.run))
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if len(downloads) != 1 || !strings.Contains(downloads[0], UvPinnedVersion) {
		t.Fatalf("a stale stamp must trigger one pinned re-download, got %v", downloads)
	}
	if !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("an unverifiable re-download must fail closed on checksum, got %q", err.Error())
	}
}

func TestREQNODE017UvAssetSelectionMapsPlatforms(t *testing.T) {
	amd, err := UvAssetFor("linux", "amd64")
	if err != nil {
		t.Fatalf("UvAssetFor linux/amd64: %v", err)
	}
	if amd.AssetName != "uv-x86_64-unknown-linux-gnu.tar.gz" {
		t.Fatalf("linux/amd64 asset = %q", amd.AssetName)
	}
	arm, err := UvAssetFor("linux", "arm64")
	if err != nil {
		t.Fatalf("UvAssetFor linux/arm64: %v", err)
	}
	if arm.AssetName != "uv-aarch64-unknown-linux-gnu.tar.gz" {
		t.Fatalf("linux/arm64 asset = %q", arm.AssetName)
	}
	if amd.SHA256 == arm.SHA256 || len(amd.SHA256) != 64 || len(arm.SHA256) != 64 {
		t.Fatalf("per-platform pins must carry distinct full checksums, got %q / %q", amd.SHA256, arm.SHA256)
	}
	if _, err := UvAssetFor("windows", "amd64"); err == nil {
		t.Fatal("platforms without a vLLM tier must not resolve a uv asset")
	}
}

func TestREQNODE017EnsureVllmRejectsUvChecksumMismatch(t *testing.T) {
	// No managed uv on disk forces the pinned download; bytes that do not hash to
	// the embedded pin must never be installed or executed. REQ-NODE-017 / REQ-SEC-013.
	dataDir := t.TempDir()
	runner := &fakeVllmRunner{dataDir: dataDir}
	_, err := EnsureVllm(dataDir, "",
		WithVllmPlatform("linux"),
		WithVllmCudaProbe(func() bool { return true }),
		WithVllmDiskFree(func(path string) (uint64, error) { return 64 << 30, nil }),
		WithVllmUvDownload(func(assetURL string) ([]byte, error) { return []byte("tampered payload"), nil }),
		WithVllmRunner(runner.run))
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "bin", "uv")); !os.IsNotExist(statErr) {
		t.Fatalf("uv must not be installed after a checksum mismatch, stat err = %v", statErr)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("an unverified uv must never run, got %v", runner.joinedCalls())
	}
}

func TestREQNODE017EnsureVllmInstallsVenvAndWritesMarker(t *testing.T) {
	dataDir := t.TempDir()
	uvPath := seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	path, err := EnsureVllm(dataDir, "0.27.1", vllmTestOptions(dataDir, runner, "0.27.1")...)
	if err != nil {
		t.Fatalf("EnsureVllm returned error: %v", err)
	}
	versionDir := filepath.Join(dataDir, "runtimes", "vllm", "0.27.1")
	venvDir := filepath.Join(versionDir, "venv")
	joined := runner.joinedCalls()
	var sawVenv, sawInstall bool
	for _, call := range joined {
		if !strings.HasPrefix(call, uvPath+" ") {
			t.Fatalf("install steps must run the managed uv, got %q", call)
		}
		if strings.Contains(call, "venv") && strings.Contains(call, venvDir) && strings.Contains(call, "--python 3.12") && strings.Contains(call, "--seed") {
			sawVenv = true
		}
		if strings.Contains(call, "pip install") && strings.Contains(call, "vllm==0.27.1") && strings.Contains(call, "--torch-backend=auto") && strings.Contains(call, venvDir) {
			sawInstall = true
		}
	}
	if !sawVenv || !sawInstall {
		t.Fatalf("install must create a seeded 3.12 venv then pin-install vllm with auto torch backend, got %v", joined)
	}
	if len(runner.probed) == 0 || runner.probed[len(runner.probed)-1] != filepath.Join(venvDir, "bin", "vllm") {
		t.Fatalf("completion must probe the venv's own vllm binary, got %v", runner.probed)
	}
	want := filepath.Join(dataDir, "runtimes", "vllm", "current", "venv", "bin", "vllm")
	if path != want {
		t.Fatalf("path = %q, want the current-symlink binary %q", path, want)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("current symlink must resolve to the installed binary: %v", err)
	}
	marker, err := os.ReadFile(filepath.Join(versionDir, ".install-complete"))
	if err != nil {
		t.Fatalf("completion marker missing: %v", err)
	}
	if !strings.Contains(string(marker), "0.27.1") {
		t.Fatalf("marker must be version-stamped, got %q", marker)
	}
}

func TestREQNODE017EnsureVllmReinstallsWhenMarkerAbsent(t *testing.T) {
	// A venv directory without its completion marker is a partial install: it must
	// be deleted and rebuilt, never trusted on a bare dir-exists check. REQ-NODE-017.
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	staleVenvBin := filepath.Join(dataDir, "runtimes", "vllm", "0.27.1", "venv", "bin")
	if err := os.MkdirAll(staleVenvBin, 0o700); err != nil {
		t.Fatalf("create stale venv: %v", err)
	}
	staleFile := filepath.Join(staleVenvBin, "half-written-wheel")
	if err := os.WriteFile(staleFile, []byte("partial"), 0o600); err != nil {
		t.Fatalf("write stale file: %v", err)
	}
	runner := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "0.27.1", vllmTestOptions(dataDir, runner, "0.27.1")...); err != nil {
		t.Fatalf("EnsureVllm returned error: %v", err)
	}
	if len(runner.calls) == 0 {
		t.Fatal("a markerless venv must trigger a reinstall")
	}
	if _, err := os.Stat(staleFile); !os.IsNotExist(err) {
		t.Fatalf("reinstall must delete the partial venv first, stat err = %v", err)
	}
}

func TestREQNODE017EnsureVllmReinstallsOnMarkerVersionMismatch(t *testing.T) {
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	versionDir := filepath.Join(dataDir, "runtimes", "vllm", "0.27.1")
	if err := os.MkdirAll(filepath.Join(versionDir, "venv", "bin"), 0o700); err != nil {
		t.Fatalf("create venv: %v", err)
	}
	if err := os.WriteFile(filepath.Join(versionDir, ".install-complete"), []byte("0.26.0\n"), 0o600); err != nil {
		t.Fatalf("write mismatched marker: %v", err)
	}
	runner := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "0.27.1", vllmTestOptions(dataDir, runner, "0.27.1")...); err != nil {
		t.Fatalf("EnsureVllm returned error: %v", err)
	}
	if len(runner.calls) == 0 {
		t.Fatal("a marker stamped with a different version must trigger a reinstall")
	}
}

func TestREQNODE017EnsureVllmSkipsReinstallWhenMarkerValid(t *testing.T) {
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "0.27.1", vllmTestOptions(dataDir, runner, "0.27.1")...); err != nil {
		t.Fatalf("first EnsureVllm returned error: %v", err)
	}
	again := &fakeVllmRunner{dataDir: dataDir}
	path, err := EnsureVllm(dataDir, "0.27.1", vllmTestOptions(dataDir, again, "0.27.1")...)
	if err != nil {
		t.Fatalf("second EnsureVllm returned error: %v", err)
	}
	if len(again.calls) != 0 {
		t.Fatalf("a completed install must not rebuild, got %v", again.joinedCalls())
	}
	if path != filepath.Join(dataDir, "runtimes", "vllm", "current", "venv", "bin", "vllm") {
		t.Fatalf("path = %q", path)
	}
}

func TestREQNODE017EnsureVllmKeepsCurrentUntilNewInstallCompletes(t *testing.T) {
	// A version switch must stage the new venv beside the old one and only swap
	// the current symlink after the new install's marker lands, so a failed
	// upgrade leaves the node serving the proven venv. REQ-NODE-017 / CON-REL-001.
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "0.27.1", vllmTestOptions(dataDir, runner, "0.27.1")...); err != nil {
		t.Fatalf("baseline install returned error: %v", err)
	}
	oldVersionDir := filepath.Join(dataDir, "runtimes", "vllm", "0.27.1")
	currentLink := filepath.Join(dataDir, "runtimes", "vllm", "current")

	// Failed upgrade: the probe never succeeds, so current must keep pointing at 0.27.1.
	failing := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "0.28.0", vllmTestOptions(dataDir, failing, "")...); err == nil {
		t.Fatal("an upgrade whose version probe fails must surface an error")
	}
	target, err := os.Readlink(currentLink)
	if err != nil {
		t.Fatalf("read current symlink: %v", err)
	}
	if filepath.Base(target) != "0.27.1" {
		t.Fatalf("failed upgrade must not move current, points at %q", target)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "runtimes", "vllm", "0.28.0", ".install-complete")); !os.IsNotExist(err) {
		t.Fatalf("no marker may exist for a failed install, stat err = %v", err)
	}

	// Successful upgrade: current swaps to 0.28.0 and the old venv stays for rollback.
	upgrading := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "0.28.0", vllmTestOptions(dataDir, upgrading, "0.28.0")...); err != nil {
		t.Fatalf("upgrade returned error: %v", err)
	}
	target, err = os.Readlink(currentLink)
	if err != nil {
		t.Fatalf("read current symlink after upgrade: %v", err)
	}
	if filepath.Base(target) != "0.28.0" {
		t.Fatalf("completed upgrade must swap current, points at %q", target)
	}
	if _, err := os.Stat(oldVersionDir); err != nil {
		t.Fatalf("previous venv must survive the swap for rollback: %v", err)
	}
}

func TestREQNODE017EnsureVllmStripsTagPrefixForPipPin(t *testing.T) {
	// The router's desired versions are GitHub release tags (v0.27.1); the pip
	// spec takes the bare version. The agent strips the leading v so a selected
	// tag never produces an unresolvable `vllm==v…` pin. REQ-NODE-017.
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "v0.27.1", vllmTestOptions(dataDir, runner, "0.27.1")...); err != nil {
		t.Fatalf("EnsureVllm returned error: %v", err)
	}
	for _, call := range runner.joinedCalls() {
		if strings.Contains(call, "pip install") {
			if !strings.Contains(call, "vllm==0.27.1") || strings.Contains(call, "vllm==v0.27.1") {
				t.Fatalf("tag-shaped desired version must pin the bare pip version, got %q", call)
			}
			return
		}
	}
	t.Fatalf("no pip install step recorded: %v", runner.joinedCalls())
}

func TestREQNODE017EnsureVllmDefaultsToPinnedVersion(t *testing.T) {
	dataDir := t.TempDir()
	seedManagedUv(t, dataDir)
	runner := &fakeVllmRunner{dataDir: dataDir}
	if _, err := EnsureVllm(dataDir, "", vllmTestOptions(dataDir, runner, VllmPinnedVersion)...); err != nil {
		t.Fatalf("EnsureVllm returned error: %v", err)
	}
	wantSpec := "vllm==" + VllmPinnedVersion
	for _, call := range runner.joinedCalls() {
		if strings.Contains(call, "pip install") {
			if !strings.Contains(call, wantSpec) {
				t.Fatalf("an empty desired version must install the pin %q, got %q", wantSpec, call)
			}
			return
		}
	}
	t.Fatalf("no pip install step recorded: %v", runner.joinedCalls())
}
