package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// LlamaCppDefaultVersion is the llama.cpp release selected when the router has
// not yet sent an operator choice. Nodes still bootstrap the binary from the
// release at runtime; the agent release never bundles llama.cpp.
const LlamaCppDefaultVersion = "b9912"

const llamaCppRepository = "ggml-org/llama.cpp"

type LlamaCppAsset struct {
	AssetName string
	URL       string
	SHA256    string
}

type llamaCppInstallOptions struct {
	goos         string
	goarch       string
	asset        *LlamaCppAsset
	lookPath     func(file string) (string, error)
	queryVersion func(binaryPath string) (string, error)
	download     func(assetURL string) ([]byte, error)
	fetchRelease func(version string) ([]LlamaCppReleaseAsset, error)
}

type LlamaCppReleaseAsset struct {
	Name               string `json:"name"`
	Digest             string `json:"digest"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type llamaCppReleaseResponse struct {
	Assets []LlamaCppReleaseAsset `json:"assets"`
}

type LlamaCppInstallOption func(*llamaCppInstallOptions)

func WithLlamaCppPlatform(goos, goarch string) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.goos = goos
		options.goarch = goarch
	}
}

func WithLlamaCppAssetOverride(asset LlamaCppAsset) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.asset = &asset
	}
}

func WithLlamaCppLookPath(lookPath func(file string) (string, error)) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.lookPath = lookPath
	}
}

func WithLlamaCppVersionQuery(queryVersion func(binaryPath string) (string, error)) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.queryVersion = queryVersion
	}
}

func WithLlamaCppDownload(download func(assetURL string) ([]byte, error)) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.download = download
	}
}

func WithLlamaCppReleaseFetcher(fetchRelease func(version string) ([]LlamaCppReleaseAsset, error)) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.fetchRelease = fetchRelease
	}
}

func EnsureLlamaCpp(dataDir, version string, opts ...LlamaCppInstallOption) (string, error) {
	if version == "" {
		version = LlamaCppDefaultVersion
	}
	options := llamaCppInstallOptions{
		goos:         runtime.GOOS,
		goarch:       runtime.GOARCH,
		lookPath:     exec.LookPath,
		queryVersion: queryLlamaCppVersion,
		download:     downloadLlamaCppAsset,
		fetchRelease: fetchLlamaCppReleaseAssets,
	}
	for _, opt := range opts {
		opt(&options)
	}

	binaryName := llamaCppBinaryName(options.goos)
	if pathBinary, err := options.lookPath(binaryName); err == nil {
		if out, versionErr := options.queryVersion(pathBinary); versionErr == nil && llamaCppVersionMatches(out, version) {
			return pathBinary, nil
		}
	}

	target := filepath.Join(dataDir, "bin", binaryName)
	if _, err := os.Stat(target); err == nil {
		if out, versionErr := options.queryVersion(target); versionErr == nil && llamaCppVersionMatches(out, version) {
			return target, nil
		}
	}

	asset := LlamaCppAsset{}
	if options.asset != nil {
		asset = *options.asset
	} else {
		resolved, err := LlamaCppAssetFor(version, options.goos, options.goarch, options.fetchRelease)
		if err != nil {
			return "", fmt.Errorf("%w: %v", ErrRuntimeDependencyMissing, err)
		}
		asset = resolved
	}
	data, err := options.download(asset.URL)
	if err != nil {
		return "", fmt.Errorf("%w: download %s: %v", ErrRuntimeDependencyMissing, asset.AssetName, err)
	}
	if !VerifyBytesSHA256(data, asset.SHA256) {
		return "", fmt.Errorf("%w: checksum mismatch for %s", ErrRuntimeDependencyMissing, asset.AssetName)
	}
	runtimeFiles, err := extractLlamaCppRuntime(data, asset.AssetName, binaryName)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRuntimeDependencyMissing, err)
	}
	binDir := filepath.Dir(target)
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return "", fmt.Errorf("%w: create bin dir: %v", ErrRuntimeDependencyMissing, err)
	}
	for name, file := range runtimeFiles {
		mode := os.FileMode(0o600)
		if name == binaryName {
			mode = 0o700
		}
		dest := filepath.Join(binDir, name)
		tmp := dest + ".tmp"
		if err := os.WriteFile(tmp, file, mode); err != nil {
			return "", fmt.Errorf("%w: stage llama.cpp runtime file %s: %v", ErrRuntimeDependencyMissing, name, err)
		}
		if err := os.Rename(tmp, dest); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("%w: install llama.cpp runtime file %s: %v", ErrRuntimeDependencyMissing, name, err)
		}
	}
	return target, nil
}

func LlamaCppAssetFor(version, goos, goarch string, fetchRelease func(version string) ([]LlamaCppReleaseAsset, error)) (LlamaCppAsset, error) {
	name, err := llamaCppAssetName(version, goos, goarch)
	if err != nil {
		return LlamaCppAsset{}, err
	}
	assets, err := fetchRelease(version)
	if err != nil {
		return LlamaCppAsset{}, err
	}
	for _, asset := range assets {
		if asset.Name != name {
			continue
		}
		sha := strings.TrimPrefix(asset.Digest, "sha256:")
		if sha == asset.Digest || len(sha) != 64 || asset.BrowserDownloadURL == "" {
			return LlamaCppAsset{}, fmt.Errorf("release asset %s has no usable sha256 digest", name)
		}
		return LlamaCppAsset{AssetName: name, URL: asset.BrowserDownloadURL, SHA256: sha}, nil
	}
	return LlamaCppAsset{}, fmt.Errorf("no llama.cpp asset %s in %s", name, version)
}

func llamaCppAssetName(version, goos, goarch string) (string, error) {
	suffix := ""
	switch goos + "/" + goarch {
	case "linux/amd64":
		suffix = "ubuntu-x64.tar.gz"
	case "linux/arm64":
		suffix = "ubuntu-arm64.tar.gz"
	case "darwin/amd64":
		suffix = "macos-x64.tar.gz"
	case "darwin/arm64":
		suffix = "macos-arm64.tar.gz"
	case "windows/amd64":
		suffix = "win-cpu-x64.zip"
	case "windows/arm64":
		suffix = "win-cpu-arm64.zip"
	default:
		return "", fmt.Errorf("no llama.cpp asset for %s/%s", goos, goarch)
	}
	return fmt.Sprintf("llama-%s-bin-%s", version, suffix), nil
}

func llamaCppBinaryName(goos string) string {
	if goos == "windows" {
		return "llama-server.exe"
	}
	return "llama-server"
}

func llamaCppVersionMatches(output, version string) bool {
	want := strings.TrimPrefix(version, "b")
	for _, field := range strings.FieldsFunc(output, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == ':' || r == ',' || r == '(' || r == ')' }) {
		field = strings.TrimPrefix(field, "b")
		if field == want || field == version {
			return true
		}
	}
	return false
}

func fetchLlamaCppReleaseAssets(version string) ([]LlamaCppReleaseAsset, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	request, err := http.NewRequest("GET", fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", llamaCppRepository, version), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/vnd.github+json")
	request.Header.Set("user-agent", "codeflare-inference-mesh-agent")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("release lookup returned %d", response.StatusCode)
	}
	var body llamaCppReleaseResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Assets, nil
}

func downloadLlamaCppAsset(assetURL string) ([]byte, error) {
	client := &http.Client{Timeout: 30 * time.Minute}
	response, err := client.Get(assetURL)
	if err != nil {
		return nil, fmt.Errorf("download llama.cpp asset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download llama.cpp asset returned %d", response.StatusCode)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read llama.cpp asset: %w", err)
	}
	return data, nil
}

func queryLlamaCppVersion(binaryPath string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binaryPath, "--version")
	cmd.Env = llamaCppRuntimeEnv(os.Environ(), binaryPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("query llama.cpp version: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

func extractLlamaCppRuntime(archive []byte, assetName, binaryName string) (map[string][]byte, error) {
	var files map[string][]byte
	var err error
	switch {
	case strings.HasSuffix(assetName, ".tar.gz"):
		files, err = extractLlamaCppTarGz(archive, binaryName)
	case strings.HasSuffix(assetName, ".zip"):
		files, err = extractLlamaCppZip(archive, binaryName)
	default:
		return nil, fmt.Errorf("unsupported llama.cpp archive type: %s", assetName)
	}
	if err != nil {
		return nil, err
	}
	if _, ok := files[binaryName]; !ok {
		return nil, fmt.Errorf("binary %s not found in llama.cpp archive", binaryName)
	}
	return files, nil
}

func extractLlamaCppTarGz(archive []byte, binaryName string) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open llama.cpp archive: %w", err)
	}
	defer gz.Close()
	files := map[string][]byte{}
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read llama.cpp archive: %w", err)
		}
		base := archiveEntryBase(header.Name)
		if header.Typeflag != tar.TypeReg || !isLlamaCppRuntimeFile(base, binaryName) {
			continue
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			return nil, fmt.Errorf("read llama.cpp runtime entry %s: %w", base, err)
		}
		files[base] = data
	}
	return files, nil
}

func extractLlamaCppZip(archive []byte, binaryName string) (map[string][]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open llama.cpp archive: %w", err)
	}
	files := map[string][]byte{}
	for _, file := range reader.File {
		base := path.Base(strings.ReplaceAll(file.Name, `\`, "/"))
		if file.FileInfo().IsDir() || !isLlamaCppRuntimeFile(base, binaryName) {
			continue
		}
		entry, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("open llama.cpp runtime entry %s: %w", base, err)
		}
		data, err := io.ReadAll(entry)
		closeErr := entry.Close()
		if err != nil {
			return nil, fmt.Errorf("read llama.cpp runtime entry %s: %w", base, err)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close llama.cpp runtime entry %s: %w", base, closeErr)
		}
		files[base] = data
	}
	return files, nil
}

func isLlamaCppRuntimeFile(base, binaryName string) bool {
	if base == binaryName {
		return true
	}
	lower := strings.ToLower(base)
	return strings.HasPrefix(lower, "lib") && (strings.Contains(lower, ".so") || strings.HasSuffix(lower, ".dylib") || strings.HasSuffix(lower, ".dll"))
}

const LlamaCppInstallAnchors = "REQ-NODE-013"
