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
	asset          *LlamaCppAsset
	lookPath       func(file string) (string, error)
	queryVersion   func(binaryPath string) (string, error)
	download       func(assetURL string) ([]byte, error)
	fetchRelease   func(version string) ([]LlamaCppReleaseAsset, error)
	backend        string
	hostCandidates []string
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

func WithLlamaCppBackend(backend string) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.backend = backend
	}
}

func WithLlamaCppHostCandidates(paths ...string) LlamaCppInstallOption {
	return func(options *llamaCppInstallOptions) {
		options.hostCandidates = append([]string(nil), paths...)
	}
}

func EnsureLlamaCpp(dataDir, version string, opts ...LlamaCppInstallOption) (string, error) {
	if version == "" {
		version = LlamaCppDefaultVersion
	}
	options := llamaCppInstallOptions{
		goos:           runtime.GOOS,
		goarch:         runtime.GOARCH,
		lookPath:       exec.LookPath,
		queryVersion:   queryLlamaCppVersion,
		download:       downloadLlamaCppAsset,
		fetchRelease:   fetchLlamaCppReleaseAssets,
		backend:        detectLlamaCppBackend(runtime.GOOS),
		hostCandidates: llamaCppHostCandidates(runtime.GOOS),
	}
	for _, opt := range opts {
		opt(&options)
	}

	binaryName := llamaCppBinaryName(options.goos)
	if pathBinary, ok := findUsableLlamaCppHostBinary(binaryName, version, options); ok {
		return pathBinary, nil
	}

	target := llamaCppManagedTarget(dataDir, binaryName, options.backend)
	if _, err := os.Stat(target); err == nil {
		if out, versionErr := options.queryVersion(target); versionErr == nil && llamaCppVersionMatches(out, version) {
			return target, nil
		}
	}

	asset := LlamaCppAsset{}
	if options.asset != nil {
		asset = *options.asset
	} else {
		resolved, err := LlamaCppAssetForBackend(version, options.goos, options.goarch, options.backend, options.fetchRelease)
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
		safeName, err := safeArchiveEntryBase(name)
		if err != nil || safeName != name {
			if err == nil {
				err = fmt.Errorf("path changed during sanitization")
			}
			return "", fmt.Errorf("%w: unsafe llama.cpp runtime file %s: %v", ErrRuntimeDependencyMissing, name, err)
		}
		mode := os.FileMode(0o600)
		if safeName == binaryName {
			mode = 0o700
		}
		dest, err := safeRuntimeFilePath(binDir, safeName)
		if err != nil {
			return "", fmt.Errorf("%w: unsafe llama.cpp runtime file %s: %v", ErrRuntimeDependencyMissing, safeName, err)
		}
		tmp, err := safeRuntimeFilePath(binDir, safeName+".tmp")
		if err != nil {
			return "", fmt.Errorf("%w: unsafe llama.cpp runtime stage file %s: %v", ErrRuntimeDependencyMissing, safeName, err)
		}
		if err := os.WriteFile(tmp, file, mode); err != nil {
			return "", fmt.Errorf("%w: stage llama.cpp runtime file %s: %v", ErrRuntimeDependencyMissing, safeName, err)
		}
		if err := os.Rename(tmp, dest); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("%w: install llama.cpp runtime file %s: %v", ErrRuntimeDependencyMissing, safeName, err)
		}
	}
	return target, nil
}

func LlamaCppAssetFor(version, goos, goarch string, fetchRelease func(version string) ([]LlamaCppReleaseAsset, error)) (LlamaCppAsset, error) {
	return LlamaCppAssetForBackend(version, goos, goarch, "cpu", fetchRelease)
}

func LlamaCppAssetForBackend(version, goos, goarch string, backend string, fetchRelease func(version string) ([]LlamaCppReleaseAsset, error)) (LlamaCppAsset, error) {
	names, err := llamaCppAssetNames(version, goos, goarch, backend)
	if err != nil {
		return LlamaCppAsset{}, err
	}
	assets, err := fetchRelease(version)
	if err != nil {
		return LlamaCppAsset{}, err
	}
	byName := map[string]LlamaCppReleaseAsset{}
	for _, asset := range assets {
		byName[asset.Name] = asset
	}
	for _, name := range names {
		asset, ok := byName[name]
		if !ok {
			continue
		}
		sha := strings.TrimPrefix(asset.Digest, "sha256:")
		if sha == asset.Digest || len(sha) != 64 || asset.BrowserDownloadURL == "" {
			return LlamaCppAsset{}, fmt.Errorf("release asset %s has no usable sha256 digest", name)
		}
		return LlamaCppAsset{AssetName: name, URL: asset.BrowserDownloadURL, SHA256: sha}, nil
	}
	return LlamaCppAsset{}, fmt.Errorf("no llama.cpp asset among %s in %s", strings.Join(names, ", "), version)
}

func llamaCppAssetNames(version, goos, goarch string, backend string) ([]string, error) {
	name := func(suffix string) string { return fmt.Sprintf("llama-%s-bin-%s", version, suffix) }
	switch goos + "/" + goarch {
	case "linux/amd64":
		base := []string{name("ubuntu-x64.tar.gz")}
		switch backend {
		case "rocm":
			return append([]string{name("ubuntu-rocm-7.2-x64.tar.gz")}, base...), nil
		case "vulkan", "nvidia":
			return append([]string{name("ubuntu-vulkan-x64.tar.gz")}, base...), nil
		case "sycl":
			return append([]string{name("ubuntu-sycl-fp16-x64.tar.gz")}, base...), nil
		default:
			return base, nil
		}
	case "linux/arm64":
		base := []string{name("ubuntu-arm64.tar.gz")}
		if backend == "vulkan" || backend == "nvidia" {
			return append([]string{name("ubuntu-vulkan-arm64.tar.gz")}, base...), nil
		}
		return base, nil
	case "darwin/amd64":
		return []string{name("macos-x64.tar.gz")}, nil
	case "darwin/arm64":
		return []string{name("macos-arm64.tar.gz")}, nil
	case "windows/amd64":
		base := []string{name("win-cpu-x64.zip")}
		switch backend {
		case "cuda13":
			return append([]string{name("win-cuda-13.3-x64.zip")}, base...), nil
		case "cuda12", "nvidia":
			return append([]string{name("win-cuda-12.4-x64.zip")}, base...), nil
		case "vulkan":
			return append([]string{name("win-vulkan-x64.zip")}, base...), nil
		default:
			return base, nil
		}
	case "windows/arm64":
		return []string{name("win-cpu-arm64.zip")}, nil
	default:
		return nil, fmt.Errorf("no llama.cpp asset for %s/%s", goos, goarch)
	}
}

func llamaCppManagedTarget(dataDir string, binaryName string, backend string) string {
	backend = strings.TrimSpace(strings.ToLower(backend))
	if backend == "" || backend == "cpu" || backend == "metal" {
		return filepath.Join(dataDir, "bin", binaryName)
	}
	backend = strings.NewReplacer("/", "-", "\\", "-", ":", "-", " ", "-").Replace(backend)
	return filepath.Join(dataDir, "bin", "llamacpp-"+backend, binaryName)
}

func findUsableLlamaCppHostBinary(binaryName string, version string, options llamaCppInstallOptions) (string, bool) {
	seen := map[string]bool{}
	usableFallback := ""
	try := func(candidate string) (string, bool) {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || seen[candidate] {
			return "", false
		}
		seen[candidate] = true
		out, versionErr := options.queryVersion(candidate)
		if versionErr != nil {
			return "", false
		}
		if llamaCppVersionMatches(out, version) {
			return candidate, true
		}
		if usableFallback == "" && strings.TrimSpace(out) != "" {
			usableFallback = candidate
		}
		return "", false
	}
	if pathBinary, err := options.lookPath(binaryName); err == nil {
		if candidate, ok := try(pathBinary); ok {
			return candidate, true
		}
	}
	for _, candidate := range options.hostCandidates {
		if candidate, ok := try(candidate); ok {
			return candidate, true
		}
	}
	if usableFallback != "" && shouldPreferUsableHostLlama(options.backend) {
		return usableFallback, true
	}
	return "", false
}

func shouldPreferUsableHostLlama(backend string) bool {
	backend = strings.TrimSpace(strings.ToLower(backend))
	return backend != "" && backend != "cpu" && backend != "metal"
}

func llamaCppHostCandidates(goos string) []string {
	switch goos {
	case "linux":
		return []string{"/usr/local/bin/llama-server", "/usr/bin/llama-server", "/snap/bin/llama-server", "/opt/llama.cpp/bin/llama-server", "/opt/llama-cpp/bin/llama-server", "/opt/llama/bin/llama-server"}
	case "darwin":
		return []string{"/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"}
	case "windows":
		return []string{`C:\Program Files\llama.cpp\llama-server.exe`, `C:\llama.cpp\llama-server.exe`}
	default:
		return nil
	}
}

func detectLlamaCppBackend(goos string) string {
	if override := strings.TrimSpace(os.Getenv("INFERENCE_MESH_LLAMA_CPP_BACKEND")); override != "" {
		return strings.ToLower(override)
	}
	if goos == "darwin" {
		return "metal"
	}
	if _, err := exec.LookPath("rocminfo"); err == nil {
		return "rocm"
	}
	if _, err := exec.LookPath("rocm-smi"); err == nil {
		return "rocm"
	}
	if _, err := exec.LookPath("nvidia-smi"); err == nil {
		// Upstream release archives do not currently publish a Linux CUDA binary for every tag;
		// prefer the GPU-capable Vulkan archive when no host-installed CUDA llama-server was found.
		return "nvidia"
	}
	if _, err := exec.LookPath("vulkaninfo"); err == nil {
		return "vulkan"
	}
	return "cpu"
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
	links := map[string]string{}
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read llama.cpp archive: %w", err)
		}
		base, err := safeArchiveEntryBase(header.Name)
		if err != nil {
			return nil, fmt.Errorf("unsafe llama.cpp archive entry %q: %w", header.Name, err)
		}
		if !isLlamaCppRuntimeFile(base, binaryName) {
			continue
		}
		switch header.Typeflag {
		case tar.TypeReg:
			data, err := io.ReadAll(reader)
			if err != nil {
				return nil, fmt.Errorf("read llama.cpp runtime entry %s: %w", base, err)
			}
			files[base] = data
		case tar.TypeSymlink, tar.TypeLink:
			target, err := safeArchiveEntryBase(header.Linkname)
			if err != nil {
				return nil, fmt.Errorf("unsafe llama.cpp archive link %q -> %q: %w", header.Name, header.Linkname, err)
			}
			links[base] = target
		}
	}
	for link := range links {
		data, err := resolveLlamaCppRuntimeLink(link, files, links, map[string]bool{})
		if err != nil {
			return nil, err
		}
		files[link] = data
	}
	return files, nil
}

func resolveLlamaCppRuntimeLink(link string, files map[string][]byte, links map[string]string, seen map[string]bool) ([]byte, error) {
	if data, ok := files[link]; ok {
		return data, nil
	}
	if seen[link] {
		return nil, fmt.Errorf("shared library link cycle at %s in llama.cpp archive", link)
	}
	seen[link] = true
	target, ok := links[link]
	if !ok {
		return nil, fmt.Errorf("shared library link %s target not found in llama.cpp archive", link)
	}
	data, err := resolveLlamaCppRuntimeLink(target, files, links, seen)
	if err != nil {
		return nil, fmt.Errorf("shared library link %s target %s not found in llama.cpp archive: %w", link, target, err)
	}
	return data, nil
}

func extractLlamaCppZip(archive []byte, binaryName string) (map[string][]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open llama.cpp archive: %w", err)
	}
	files := map[string][]byte{}
	for _, file := range reader.File {
		base, err := safeArchiveEntryBase(file.Name)
		if err != nil {
			return nil, fmt.Errorf("unsafe llama.cpp archive entry %q: %w", file.Name, err)
		}
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
	return strings.Contains(lower, ".so") || strings.HasSuffix(lower, ".dylib") || strings.HasSuffix(lower, ".dll")
}

const LlamaCppInstallAnchors = "REQ-NODE-013"
