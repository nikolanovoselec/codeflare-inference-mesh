package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestREQNODE013LlamaCppReleaseDigestSelectsHostAsset(t *testing.T) {
	asset, err := LlamaCppAssetFor("b9912", "linux", "amd64", func(version string) ([]LlamaCppReleaseAsset, error) {
		if version != "b9912" {
			t.Fatalf("release lookup version = %q", version)
		}
		return []LlamaCppReleaseAsset{
			{Name: "llama-b9912-bin-macos-arm64.tar.gz", Digest: "sha256:" + strings.Repeat("1", 64), BrowserDownloadURL: "https://example.invalid/macos"},
			{Name: "llama-b9912-bin-ubuntu-x64.tar.gz", Digest: "sha256:" + strings.Repeat("a", 64), BrowserDownloadURL: "https://example.invalid/linux"},
		}, nil
	})
	if err != nil {
		t.Fatalf("LlamaCppAssetFor returned error: %v", err)
	}
	if asset.AssetName != "llama-b9912-bin-ubuntu-x64.tar.gz" {
		t.Fatalf("asset name = %q", asset.AssetName)
	}
	if asset.SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("asset checksum = %q", asset.SHA256)
	}
	if asset.URL != "https://example.invalid/linux" {
		t.Fatalf("asset URL = %q", asset.URL)
	}
}

func TestREQNODE013EnsureLlamaCppInstallsManagedBinary(t *testing.T) {
	payload := []byte("fake llama-server")
	archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{{name: "llama-b1234/bin/llama-server", body: payload, mode: 0o755}, {name: "llama-b1234/bin/libllama-server-impl.so", body: []byte("fake shared lib"), mode: 0o644}})
	dataDir := t.TempDir()
	path, err := EnsureLlamaCpp(dataDir, "b1234",
		WithLlamaCppPlatform("linux", "amd64"),
		WithLlamaCppLookPath(lookPathWith(map[string]string{})),
		WithLlamaCppVersionQuery(func(binaryPath string) (string, error) { return "", errors.New("not installed") }),
		WithLlamaCppReleaseFetcher(func(version string) ([]LlamaCppReleaseAsset, error) {
			return []LlamaCppReleaseAsset{{Name: "llama-b1234-bin-ubuntu-x64.tar.gz", Digest: "sha256:" + meshLLMSHA256Hex(archive), BrowserDownloadURL: "https://example.invalid/llama.tar.gz"}}, nil
		}),
		WithLlamaCppDownload(func(assetURL string) ([]byte, error) {
			if assetURL != "https://example.invalid/llama.tar.gz" {
				t.Fatalf("download URL = %q", assetURL)
			}
			return archive, nil
		}))
	if err != nil {
		t.Fatalf("EnsureLlamaCpp returned error: %v", err)
	}
	wantPath := filepath.Join(dataDir, "bin", "llama-server")
	if path != wantPath {
		t.Fatalf("installed path = %q, want %q", path, wantPath)
	}
	installed, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if string(installed) != string(payload) {
		t.Fatalf("installed payload = %q", installed)
	}
	lib, err := os.ReadFile(filepath.Join(dataDir, "bin", "libllama-server-impl.so"))
	if err != nil {
		t.Fatalf("read installed shared library: %v", err)
	}
	if string(lib) != "fake shared lib" {
		t.Fatalf("installed shared library payload = %q", lib)
	}
}

func TestREQNODE013EnsureLlamaCppRejectsChecksumMismatch(t *testing.T) {
	archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{{name: "llama-b1234/bin/llama-server", body: []byte("fake"), mode: 0o755}})
	dataDir := t.TempDir()
	_, err := EnsureLlamaCpp(dataDir, "b1234",
		WithLlamaCppPlatform("linux", "amd64"),
		WithLlamaCppLookPath(lookPathWith(map[string]string{})),
		WithLlamaCppVersionQuery(func(binaryPath string) (string, error) { return "", errors.New("not installed") }),
		WithLlamaCppReleaseFetcher(func(version string) ([]LlamaCppReleaseAsset, error) {
			return []LlamaCppReleaseAsset{{Name: "llama-b1234-bin-ubuntu-x64.tar.gz", Digest: "sha256:" + strings.Repeat("0", 64), BrowserDownloadURL: "https://example.invalid/llama.tar.gz"}}, nil
		}),
		WithLlamaCppDownload(func(assetURL string) ([]byte, error) { return archive, nil }))
	if !errors.Is(err, ErrRuntimeDependencyMissing) {
		t.Fatalf("error = %v, want ErrRuntimeDependencyMissing", err)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "bin", "llama-server")); !os.IsNotExist(statErr) {
		t.Fatalf("managed binary should not be installed after checksum failure, stat err = %v", statErr)
	}
}

func TestREQNODE013EnsureLlamaCppReusesMatchingPathBinary(t *testing.T) {
	downloaded := false
	path, err := EnsureLlamaCpp(t.TempDir(), "b9912",
		WithLlamaCppPlatform("linux", "amd64"),
		WithLlamaCppLookPath(lookPathWith(map[string]string{"llama-server": "/usr/local/bin/llama-server"})),
		WithLlamaCppVersionQuery(func(binaryPath string) (string, error) {
			if binaryPath != "/usr/local/bin/llama-server" {
				t.Fatalf("queried binary = %q", binaryPath)
			}
			return "llama.cpp build 9912", nil
		}),
		WithLlamaCppDownload(func(assetURL string) ([]byte, error) { downloaded = true; return nil, nil }))
	if err != nil {
		t.Fatalf("EnsureLlamaCpp returned error: %v", err)
	}
	if path != "/usr/local/bin/llama-server" {
		t.Fatalf("path = %q", path)
	}
	if downloaded {
		t.Fatalf("matching PATH binary should not trigger a download")
	}
}

func TestREQNODE013SelectedMeshLLMVersionDownloadsChecksumSidecar(t *testing.T) {
	payload := []byte("fake mesh-llm")
	archive := buildFakeMeshLLMTarGz(t, []fakeArchiveEntry{{name: "mesh-llm-v0.73.0/bin/mesh-llm", body: payload, mode: 0o755}})
	var requested []string
	path, err := EnsureMeshLLMVersion(t.TempDir(), "cpu", false, "v0.73.0",
		WithMeshLLMPlatform("linux", "amd64"),
		WithMeshLLMLookPath(lookPathWith(map[string]string{})),
		WithMeshLLMVersionQuery(func(binaryPath string) (string, error) { return "", errors.New("not installed") }),
		WithMeshLLMDownload(func(assetURL string) ([]byte, error) {
			requested = append(requested, assetURL)
			if strings.HasSuffix(assetURL, ".sha256") {
				return []byte(meshLLMSHA256Hex(archive) + "  mesh-llm-v0.73.0-x86_64-unknown-linux-gnu.tar.gz\n"), nil
			}
			return archive, nil
		}))
	if err != nil {
		t.Fatalf("EnsureMeshLLMVersion returned error: %v", err)
	}
	if filepath.Base(path) != "mesh-llm" {
		t.Fatalf("installed binary path = %q", path)
	}
	if len(requested) != 2 || !strings.Contains(requested[0], "/v0.73.0/") || !strings.HasSuffix(requested[1], ".sha256") {
		t.Fatalf("requested downloads = %v", requested)
	}
	installed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if string(installed) != string(payload) {
		t.Fatalf("installed payload = %q", installed)
	}
}
