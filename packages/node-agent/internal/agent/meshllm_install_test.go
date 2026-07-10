package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

type fakeArchiveEntry struct {
	name     string
	body     []byte
	mode     int64
	linkName string
}

func buildFakeMeshLLMTarGz(t *testing.T, entries []fakeArchiveEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: entry.mode, Typeflag: tar.TypeReg, Size: int64(len(entry.body))}
		if entry.linkName != "" {
			header.Typeflag = tar.TypeSymlink
			header.Linkname = entry.linkName
			header.Size = 0
		} else if strings.HasSuffix(entry.name, "/") {
			header.Typeflag = tar.TypeDir
			header.Size = 0
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatalf("write tar header %s: %v", entry.name, err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := tw.Write(entry.body); err != nil {
				t.Fatalf("write tar entry %s: %v", entry.name, err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	return buf.Bytes()
}

func buildFakeMeshLLMZip(t *testing.T, entries []fakeArchiveEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, entry := range entries {
		writer, err := zw.Create(entry.name)
		if err != nil {
			t.Fatalf("create zip entry %s: %v", entry.name, err)
		}
		if _, err := writer.Write(entry.body); err != nil {
			t.Fatalf("write zip entry %s: %v", entry.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip writer: %v", err)
	}
	return buf.Bytes()
}

func meshLLMSHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func lookPathWith(found map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if resolved, ok := found[name]; ok {
			return resolved, nil
		}
		return "", errors.New(name + " not found on PATH")
	}
}

func pinnedVersionOutput() string {
	return "mesh-llm " + strings.TrimPrefix(MeshLLMPinnedVersion, "v")
}

func assertNoMeshLLMInstalled(t *testing.T, dataDir string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataDir, "bin"))
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatalf("read bin dir: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("expected no installed files after failure, found %v", names)
	}
}

var meshLLMShippedCombos = []struct {
	goos, goarch, flavor, wantSuffix string
}{
	{"linux", "amd64", "cpu", ".tar.gz"},
	{"linux", "amd64", "cuda-12", ".tar.gz"},
	{"linux", "amd64", "cuda-13", ".tar.gz"},
	{"linux", "arm64", "cpu", ".tar.gz"},
	{"linux", "arm64", "cuda-12", ".tar.gz"},
	{"linux", "arm64", "cuda-13", ".tar.gz"},
	{"windows", "amd64", "cpu", ".zip"},
	{"windows", "amd64", "cuda-12", ".zip"},
	{"darwin", "arm64", "metal", ".tar.gz"},
}

func TestREQNODE006PinnedVersionAndChecksumMapEmbedded(t *testing.T) {
	t.Run("REQ-NODE-006 resolves pinned MeshLLM release assets", func(t *testing.T) {
		asset, err := MeshLLMAssetFor("linux", "amd64", "cpu")
		if err != nil {
			t.Fatalf("expected linux/amd64 cpu asset: %v", err)
		}
		if !strings.Contains(asset.AssetName, MeshLLMPinnedVersion) || asset.SHA256 == "" {
			t.Fatalf("asset missing pinned version or checksum: %+v", asset)
		}
	})
	if !regexp.MustCompile(`^v\d+\.\d+\.\d+$`).MatchString(MeshLLMPinnedVersion) {
		t.Fatalf("pinned version %q is not a release tag", MeshLLMPinnedVersion)
	}
	shaPattern := regexp.MustCompile(`^[0-9a-f]{64}$`)
	seenSHA := map[string]string{}
	seenAsset := map[string]string{}
	for _, combo := range meshLLMShippedCombos {
		key := combo.goos + "/" + combo.goarch + "/" + combo.flavor
		asset, err := MeshLLMAssetFor(combo.goos, combo.goarch, combo.flavor)
		if err != nil {
			t.Fatalf("expected pinned asset for %s: %v", key, err)
		}
		if !strings.Contains(asset.AssetName, MeshLLMPinnedVersion) {
			t.Errorf("%s: asset %q does not carry pinned version %s", key, asset.AssetName, MeshLLMPinnedVersion)
		}
		if !strings.HasSuffix(asset.AssetName, combo.wantSuffix) {
			t.Errorf("%s: asset %q does not end in %s", key, asset.AssetName, combo.wantSuffix)
		}
		if !shaPattern.MatchString(asset.SHA256) {
			t.Errorf("%s: checksum %q is not 64 lowercase hex chars", key, asset.SHA256)
		}
		if previous, duplicate := seenSHA[asset.SHA256]; duplicate {
			t.Errorf("%s: checksum duplicates %s", key, previous)
		}
		if previous, duplicate := seenAsset[asset.AssetName]; duplicate {
			t.Errorf("%s: asset name duplicates %s", key, previous)
		}
		seenSHA[asset.SHA256] = key
		seenAsset[asset.AssetName] = key
	}
	unknown := []struct{ goos, goarch, flavor string }{
		{"darwin", "amd64", "metal"},
		{"darwin", "arm64", "cpu"},
		{"windows", "arm64", "cpu"},
		{"linux", "amd64", "rocm"},
		{"linux", "amd64", "metal"},
		{"plan9", "386", "cpu"},
	}
	for _, combo := range unknown {
		if _, err := MeshLLMAssetFor(combo.goos, combo.goarch, combo.flavor); err == nil {
			t.Errorf("expected error for unmapped %s/%s flavor %q", combo.goos, combo.goarch, combo.flavor)
		}
	}
}

func TestREQNODE006FlavorDetectionAndConfigOverride(t *testing.T) {
	cases := []struct {
		goos, goarch string
		hasNvidia    bool
		cudaMajor    int
		want         string
	}{
		{"linux", "amd64", true, 12, "cuda-12"},
		{"linux", "amd64", true, 13, "cuda-13"},
		{"linux", "amd64", true, 0, "cuda-12"}, // undeterminable CUDA major keeps cuda-12
		{"linux", "amd64", false, 13, "cpu"},   // no NVIDIA GPU stays cpu regardless
		{"linux", "arm64", true, 12, "cuda-12"},
		{"linux", "arm64", true, 13, "cuda-13"},
		{"linux", "arm64", false, 0, "cpu"},
		{"windows", "amd64", true, 13, "cuda-12"}, // no windows cuda-13 build; stays cuda-12
		{"windows", "amd64", false, 0, "cpu"},
		{"darwin", "arm64", true, 13, "metal"},
		{"darwin", "arm64", false, 0, "metal"},
	}
	for _, testCase := range cases {
		hasNvidia := testCase.hasNvidia
		cudaMajor := testCase.cudaMajor
		got := DetectMeshLLMFlavor(testCase.goos, testCase.goarch, func() bool { return hasNvidia }, func() int { return cudaMajor })
		if got != testCase.want {
			t.Errorf("DetectMeshLLMFlavor(%s, %s, nvidia=%v, cuda=%d) = %q, want %q", testCase.goos, testCase.goarch, testCase.hasNvidia, testCase.cudaMajor, got, testCase.want)
		}
	}

	nvidiaOnPath := lookPathWith(map[string]string{"nvidia-smi": "/usr/bin/nvidia-smi"})
	requestedAsset := func(t *testing.T, flavorOverride string, cudaMajor int) string {
		t.Helper()
		var requested []string
		_, err := EnsureMeshLLM(t.TempDir(), flavorOverride, false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMLookPath(nvidiaOnPath),
			WithMeshLLMCUDAMajor(cudaMajor),
			WithMeshLLMDownload(func(assetURL string) ([]byte, error) {
				requested = append(requested, assetURL)
				return nil, errors.New("halt after url capture")
			}))
		if err == nil {
			t.Fatalf("expected install to halt at download")
		}
		if len(requested) != 1 {
			t.Fatalf("expected exactly one download request, got %v", requested)
		}
		return requested[0]
	}

	cuda12Asset, err := MeshLLMAssetFor("linux", "amd64", "cuda-12")
	if err != nil {
		t.Fatalf("resolve cuda-12 asset: %v", err)
	}
	cuda13Asset, err := MeshLLMAssetFor("linux", "amd64", "cuda-13")
	if err != nil {
		t.Fatalf("resolve cuda-13 asset: %v", err)
	}
	cpuAsset, err := MeshLLMAssetFor("linux", "amd64", "cpu")
	if err != nil {
		t.Fatalf("resolve cpu asset: %v", err)
	}

	detected12 := requestedAsset(t, "", 12)
	if !strings.HasSuffix(detected12, "/"+cuda12Asset.AssetName) {
		t.Errorf("nvidia-smi present, CUDA 12: requested %q, want cuda-12 asset %q", detected12, cuda12Asset.AssetName)
	}
	detected13 := requestedAsset(t, "", 13)
	if !strings.HasSuffix(detected13, "/"+cuda13Asset.AssetName) {
		t.Errorf("nvidia-smi present, CUDA 13: requested %q, want cuda-13 asset %q", detected13, cuda13Asset.AssetName)
	}
	overridden := requestedAsset(t, "cpu", 13)
	if !strings.HasSuffix(overridden, "/"+cpuAsset.AssetName) {
		t.Errorf("flavor override cpu: requested %q, want cpu asset %q", overridden, cpuAsset.AssetName)
	}
}

func TestREQNODE006DownloadVerifyAtomicInstall(t *testing.T) {
	binaryBody := []byte("#!/bin/sh\necho fake mesh-llm\n")
	archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{
		{name: "mesh-bundle/", mode: 0o755},
		{name: "mesh-bundle/mesh-llm", body: binaryBody, mode: 0o755},
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	downloads := 0
	download := func(assetURL string) ([]byte, error) {
		downloads++
		resp, err := http.Get(server.URL)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		return io.ReadAll(resp.Body)
	}
	asset := MeshLLMAsset{AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu.tar.gz", SHA256: meshLLMSHA256Hex(archive)}
	dataDir := t.TempDir()

	installed, err := EnsureMeshLLM(dataDir, "", false,
		WithMeshLLMPlatform("linux", "amd64"),
		WithMeshLLMAssetOverride(asset),
		WithMeshLLMLookPath(lookPathWith(nil)),
		WithMeshLLMDownload(download))
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	want := filepath.Join(dataDir, "bin", "mesh-llm")
	if installed != want {
		t.Fatalf("installed at %q, want %q", installed, want)
	}
	info, err := os.Stat(installed)
	if err != nil {
		t.Fatalf("stat installed binary: %v", err)
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("installed binary is not a regular file: %v", info.Mode())
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("installed binary is not executable: %v", info.Mode())
	}
	content, err := os.ReadFile(installed)
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if !bytes.Equal(content, binaryBody) {
		t.Fatalf("installed binary content differs from archive entry")
	}
	entries, err := os.ReadDir(filepath.Join(dataDir, "bin"))
	if err != nil {
		t.Fatalf("read bin dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "mesh-llm" {
		t.Fatalf("expected only the atomic final binary in bin dir, found %d entries", len(entries))
	}

	again, err := EnsureMeshLLM(dataDir, "", false,
		WithMeshLLMPlatform("linux", "amd64"),
		WithMeshLLMAssetOverride(asset),
		WithMeshLLMLookPath(lookPathWith(nil)),
		WithMeshLLMVersionQuery(func(binaryPath string) (string, error) {
			if binaryPath != want {
				return "", errors.New("unexpected binary queried: " + binaryPath)
			}
			return pinnedVersionOutput(), nil
		}),
		WithMeshLLMDownload(download))
	if err != nil {
		t.Fatalf("second ensure failed: %v", err)
	}
	if again != want {
		t.Fatalf("second ensure returned %q, want %q", again, want)
	}
	if downloads != 1 {
		t.Fatalf("expected pin-matching installed binary to be reused without redownload, downloads = %d", downloads)
	}

	t.Run("zip asset extracts windows exe", func(t *testing.T) {
		exeBody := []byte("MZ fake windows binary")
		zipArchive := buildFakeMeshLLMZip(t, []fakeArchiveEntry{
			{name: `mesh-bundle\mesh-llm.exe`, body: exeBody},
		})
		zipAsset := MeshLLMAsset{AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-pc-windows-msvc.zip", SHA256: meshLLMSHA256Hex(zipArchive)}
		zipDataDir := t.TempDir()
		zipInstalled, err := EnsureMeshLLM(zipDataDir, "", false,
			WithMeshLLMPlatform("windows", "amd64"),
			WithMeshLLMAssetOverride(zipAsset),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(func(string) ([]byte, error) { return zipArchive, nil }))
		if err != nil {
			t.Fatalf("zip install failed: %v", err)
		}
		wantExe := filepath.Join(zipDataDir, "bin", "mesh-llm.exe")
		if zipInstalled != wantExe {
			t.Fatalf("zip installed at %q, want %q", zipInstalled, wantExe)
		}
		exeContent, err := os.ReadFile(zipInstalled)
		if err != nil {
			t.Fatalf("read installed exe: %v", err)
		}
		if !bytes.Equal(exeContent, exeBody) {
			t.Fatalf("installed exe content differs from zip entry")
		}
	})
}

func TestREQNODE006PathBinaryAcceptedOnlyOnPinMatch(t *testing.T) {
	pathBinary := "/usr/local/bin/mesh-llm"
	onPath := lookPathWith(map[string]string{"mesh-llm": pathBinary})
	mustNotDownload := func(t *testing.T) func(string) ([]byte, error) {
		return func(assetURL string) ([]byte, error) {
			t.Errorf("unexpected download of %s", assetURL)
			return nil, errors.New("unexpected download")
		}
	}
	pinnedArchive := func(t *testing.T) (MeshLLMAsset, func(string) ([]byte, error), *int) {
		archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{
			{name: "mesh-bundle/mesh-llm", body: []byte("fresh pinned binary"), mode: 0o755},
		})
		asset := MeshLLMAsset{AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu.tar.gz", SHA256: meshLLMSHA256Hex(archive)}
		downloads := 0
		return asset, func(string) ([]byte, error) {
			downloads++
			return archive, nil
		}, &downloads
	}

	t.Run("pin match accepted without download", func(t *testing.T) {
		got, err := EnsureMeshLLM(t.TempDir(), "", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMLookPath(onPath),
			WithMeshLLMVersionQuery(func(binaryPath string) (string, error) {
				if binaryPath != pathBinary {
					t.Errorf("queried %q, want PATH binary %q", binaryPath, pathBinary)
				}
				return pinnedVersionOutput(), nil
			}),
			WithMeshLLMDownload(mustNotDownload(t)))
		if err != nil {
			t.Fatalf("expected PATH binary acceptance: %v", err)
		}
		if got != pathBinary {
			t.Fatalf("got %q, want PATH binary %q", got, pathBinary)
		}
	})

	t.Run("v-prefixed version output accepted", func(t *testing.T) {
		got, err := EnsureMeshLLM(t.TempDir(), "", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMLookPath(onPath),
			WithMeshLLMVersionQuery(func(string) (string, error) { return MeshLLMPinnedVersion, nil }),
			WithMeshLLMDownload(mustNotDownload(t)))
		if err != nil || got != pathBinary {
			t.Fatalf("got (%q, %v), want PATH binary accepted", got, err)
		}
	})

	t.Run("version mismatch rejected and pinned install proceeds", func(t *testing.T) {
		asset, download, downloads := pinnedArchive(t)
		dataDir := t.TempDir()
		got, err := EnsureMeshLLM(dataDir, "", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMAssetOverride(asset),
			WithMeshLLMLookPath(onPath),
			WithMeshLLMVersionQuery(func(string) (string, error) { return "mesh-llm 0.71.9", nil }),
			WithMeshLLMDownload(download))
		if err != nil {
			t.Fatalf("expected pinned install after rejection: %v", err)
		}
		if want := filepath.Join(dataDir, "bin", "mesh-llm"); got != want {
			t.Fatalf("got %q, want pinned install at %q", got, want)
		}
		if *downloads != 1 {
			t.Fatalf("expected one pinned download after rejection, got %d", *downloads)
		}
	})

	t.Run("near-match version token rejected", func(t *testing.T) {
		asset, download, downloads := pinnedArchive(t)
		got, err := EnsureMeshLLM(t.TempDir(), "", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMAssetOverride(asset),
			WithMeshLLMLookPath(onPath),
			WithMeshLLMVersionQuery(func(string) (string, error) {
				return "mesh-llm " + strings.TrimPrefix(MeshLLMPinnedVersion, "v") + "1", nil
			}),
			WithMeshLLMDownload(download))
		if err != nil {
			t.Fatalf("expected pinned install after near-match rejection: %v", err)
		}
		if got == pathBinary {
			t.Fatalf("near-match version token must not be accepted")
		}
		if *downloads != 1 {
			t.Fatalf("expected one pinned download after rejection, got %d", *downloads)
		}
	})

	t.Run("version query failure rejected", func(t *testing.T) {
		asset, download, downloads := pinnedArchive(t)
		got, err := EnsureMeshLLM(t.TempDir(), "", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMAssetOverride(asset),
			WithMeshLLMLookPath(onPath),
			WithMeshLLMVersionQuery(func(string) (string, error) { return "", errors.New("binary crashed") }),
			WithMeshLLMDownload(download))
		if err != nil {
			t.Fatalf("expected pinned install after query failure: %v", err)
		}
		if got == pathBinary {
			t.Fatalf("unverifiable PATH binary must not be accepted")
		}
		if *downloads != 1 {
			t.Fatalf("expected one pinned download after rejection, got %d", *downloads)
		}
	})

	t.Run("allowUnpinned accepts PATH binary even when version query fails", func(t *testing.T) {
		got, err := EnsureMeshLLM(t.TempDir(), "", true,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMLookPath(onPath),
			WithMeshLLMVersionQuery(func(string) (string, error) { return "", errors.New("binary crashed") }),
			WithMeshLLMDownload(mustNotDownload(t)))
		if err != nil {
			t.Fatalf("allowUnpinned must accept PATH binary: %v", err)
		}
		if got != pathBinary {
			t.Fatalf("got %q, want PATH binary %q", got, pathBinary)
		}
	})

	t.Run("allowUnpinned without PATH binary still installs pinned", func(t *testing.T) {
		asset, download, downloads := pinnedArchive(t)
		dataDir := t.TempDir()
		got, err := EnsureMeshLLM(dataDir, "", true,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMAssetOverride(asset),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(download))
		if err != nil {
			t.Fatalf("expected pinned install: %v", err)
		}
		if want := filepath.Join(dataDir, "bin", "mesh-llm"); got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
		if *downloads != 1 {
			t.Fatalf("expected one download, got %d", *downloads)
		}
	})
}

func TestREQNODE006InstallFailureReportsDependencyMissing(t *testing.T) {
	t.Run("checksum mismatch against embedded pin refused", func(t *testing.T) {
		junkArchive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{
			{name: "mesh-bundle/mesh-llm", body: []byte("bytes that cannot match the upstream pin"), mode: 0o755},
		})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(junkArchive)
		}))
		defer server.Close()
		dataDir := t.TempDir()
		_, err := EnsureMeshLLM(dataDir, "cpu", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(func(string) ([]byte, error) {
				resp, err := http.Get(server.URL)
				if err != nil {
					return nil, err
				}
				defer resp.Body.Close()
				return io.ReadAll(resp.Body)
			}))
		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("checksum mismatch must report dependency-missing, got %v", err)
		}
		assertNoMeshLLMInstalled(t, dataDir)
	})

	t.Run("download failure", func(t *testing.T) {
		dataDir := t.TempDir()
		_, err := EnsureMeshLLM(dataDir, "cpu", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(func(string) ([]byte, error) { return nil, errors.New("connection refused") }))
		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("download failure must report dependency-missing, got %v", err)
		}
		assertNoMeshLLMInstalled(t, dataDir)
	})

	t.Run("unmapped platform", func(t *testing.T) {
		dataDir := t.TempDir()
		_, err := EnsureMeshLLM(dataDir, "", false,
			WithMeshLLMPlatform("plan9", "386"),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(func(string) ([]byte, error) { return nil, errors.New("must not download") }))
		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("unmapped platform must report dependency-missing, got %v", err)
		}
		assertNoMeshLLMInstalled(t, dataDir)
	})

	t.Run("archive without binary refused", func(t *testing.T) {
		archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{
			{name: "mesh-bundle/README.md", body: []byte("no binary here"), mode: 0o644},
		})
		asset := MeshLLMAsset{AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu.tar.gz", SHA256: meshLLMSHA256Hex(archive)}
		dataDir := t.TempDir()
		_, err := EnsureMeshLLM(dataDir, "", false,
			WithMeshLLMPlatform("linux", "amd64"),
			WithMeshLLMAssetOverride(asset),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(func(string) ([]byte, error) { return archive, nil }))
		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("binary-less archive must report dependency-missing, got %v", err)
		}
		assertNoMeshLLMInstalled(t, dataDir)
	})
}

func TestREQNODE006NeverInstallsUpstreamServiceUnits(t *testing.T) {
	binaryBody := []byte("#!/bin/sh\necho fake mesh-llm\n")
	archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{
		{name: "mesh-bundle/", mode: 0o755},
		{name: "mesh-bundle/mesh-llm", body: binaryBody, mode: 0o755},
		{name: "mesh-bundle/mesh-llm.service", body: []byte("[Unit]\nDescription=upstream unit\n"), mode: 0o644},
		{name: "mesh-bundle/com.mesh-llm.mesh-llm.plist", body: []byte("<plist></plist>"), mode: 0o644},
	})
	asset := MeshLLMAsset{AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu.tar.gz", SHA256: meshLLMSHA256Hex(archive)}
	dataDir := t.TempDir()
	var requested []string
	installed, err := EnsureMeshLLM(dataDir, "", false,
		WithMeshLLMPlatform("linux", "amd64"),
		WithMeshLLMAssetOverride(asset),
		WithMeshLLMLookPath(lookPathWith(nil)),
		WithMeshLLMDownload(func(assetURL string) ([]byte, error) {
			requested = append(requested, assetURL)
			return archive, nil
		}))
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	walkErr := filepath.WalkDir(dataDir, func(filePath string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(entry.Name(), ".service") || strings.HasSuffix(entry.Name(), ".plist") {
			t.Errorf("upstream service unit installed at %s", filePath)
		}
		if filePath != installed {
			t.Errorf("unexpected file installed at %s (only the binary may be written)", filePath)
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk data dir: %v", walkErr)
	}
	for _, assetURL := range requested {
		if strings.Contains(assetURL, ".service") || strings.Contains(assetURL, ".plist") {
			t.Errorf("upstream service unit requested: %s", assetURL)
		}
	}
}

func TestREQNODE006DownloadsOnlyPinnedReleaseURLs(t *testing.T) {
	for _, combo := range meshLLMShippedCombos {
		key := combo.goos + "/" + combo.goarch + "/" + combo.flavor
		var requested []string
		_, err := EnsureMeshLLM(t.TempDir(), combo.flavor, false,
			WithMeshLLMPlatform(combo.goos, combo.goarch),
			WithMeshLLMLookPath(lookPathWith(nil)),
			WithMeshLLMDownload(func(assetURL string) ([]byte, error) {
				requested = append(requested, assetURL)
				return nil, errors.New("halt after url capture")
			}))
		if !errors.Is(err, ErrRuntimeDependencyMissing) {
			t.Fatalf("%s: halted install must report dependency-missing, got %v", key, err)
		}
		if len(requested) != 1 {
			t.Fatalf("%s: expected exactly one download request, got %v", key, requested)
		}
		asset, assetErr := MeshLLMAssetFor(combo.goos, combo.goarch, combo.flavor)
		if assetErr != nil {
			t.Fatalf("%s: resolve asset: %v", key, assetErr)
		}
		want := "https://github.com/Mesh-LLM/mesh-llm/releases/download/" + MeshLLMPinnedVersion + "/" + asset.AssetName
		if requested[0] != want {
			t.Errorf("%s: requested %q, want pinned release URL %q", key, requested[0], want)
		}
		parsed, parseErr := url.Parse(requested[0])
		if parseErr != nil {
			t.Fatalf("%s: parse requested url: %v", key, parseErr)
		}
		if parsed.Scheme != "https" || parsed.Host != "github.com" {
			t.Errorf("%s: install-time egress must stay on https://github.com, got %s://%s", key, parsed.Scheme, parsed.Host)
		}
	}
}

func TestMeshLLMDefaultDownloadHonorsStatusCodes(t *testing.T) {
	body := []byte("release asset bytes")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()
	data, err := downloadMeshLLMAsset(server.URL + "/asset")
	if err != nil {
		t.Fatalf("expected 2xx download to succeed: %v", err)
	}
	if !bytes.Equal(data, body) {
		t.Fatalf("downloaded bytes differ from served body")
	}
	if _, err := downloadMeshLLMAsset(server.URL + "/missing"); err == nil {
		t.Fatalf("expected non-2xx download to fail")
	}
}

func TestMeshLLMDefaultVersionQueryRunsBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture requires a POSIX shell")
	}
	scriptPath := filepath.Join(t.TempDir(), "mesh-llm")
	script := "#!/bin/sh\necho mesh-llm 9.9.9\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		t.Fatalf("write fixture script: %v", err)
	}
	output, err := queryMeshLLMVersion(scriptPath)
	if err != nil {
		t.Fatalf("version query failed: %v", err)
	}
	if output != "mesh-llm 9.9.9" {
		t.Fatalf("version query output %q, want trimmed script output", output)
	}
}
