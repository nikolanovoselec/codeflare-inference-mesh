package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
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

// MeshLLMPinnedVersion is the default MeshLLM release used until the router
// sends an operator-selected version. Re-pinning the default means updating
// this tag and every checksum in meshLLMAssets together.
const MeshLLMPinnedVersion = "v0.72.2"

// MeshLLMAsset names one pinned release artifact and its expected SHA-256.
type MeshLLMAsset struct {
	AssetName string
	SHA256    string
}

// meshLLMAssets is the build-time pin map, keyed goos/goarch/flavor. Checksums
// are the upstream per-asset .sha256 values for MeshLLMPinnedVersion. Flavor
// keys use the agent's canonical vocabulary (cpu, cuda-12, cuda-13, metal) as
// produced by DetectMeshLLMFlavor; the windows CUDA build maps to upstream's
// single unversioned "-cuda" asset.
var meshLLMAssets = map[string]MeshLLMAsset{
	"linux/amd64/cpu":       {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu.tar.gz", SHA256: "ab941e2402fa4a8d9ec52926d3aaea9b44d67ad35e600a16f117420782dff33d"},
	"linux/amd64/cuda-12":   {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu-cuda-12.tar.gz", SHA256: "01df88c87717e734babe079a9455bdb3c1dd713fff5f7eed0b1e990192adfa98"},
	"linux/amd64/cuda-13":   {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-unknown-linux-gnu-cuda-13.tar.gz", SHA256: "654df6a5a114954062eaa10b469bf84353562a766d82fb8b738e45a440f87210"},
	"linux/arm64/cpu":       {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-aarch64-unknown-linux-gnu.tar.gz", SHA256: "ed7c1a4b6af87a4283ba128a5cc3d6539ba17f2d83da873ce5a693b4b7d65399"},
	"linux/arm64/cuda-12":   {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-aarch64-unknown-linux-gnu-cuda-12.tar.gz", SHA256: "5a9b794802cc8c18e2f2f1d7bd765659df169a640dadd62b8c477165197ff7c8"},
	"linux/arm64/cuda-13":   {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-aarch64-unknown-linux-gnu-cuda-13.tar.gz", SHA256: "9dbc883dc7497f24dd2062ebf6e3d602f3052fa5d03269cda5f834c68b6a96d5"},
	"windows/amd64/cpu":     {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-pc-windows-msvc.zip", SHA256: "c09903fc7e693972299cf518fc5c68fc5f77787a876c8724c7751b0cdd279bb2"},
	"windows/amd64/cuda-12": {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-x86_64-pc-windows-msvc-cuda.zip", SHA256: "339dbc8cecd734c29c371b4b9461fd870f2d046342b42dfb5da14304afc62ad2"},
	"darwin/arm64/metal":    {AssetName: "mesh-llm-" + MeshLLMPinnedVersion + "-aarch64-apple-darwin.tar.gz", SHA256: "5068494934df975a30c97f37f72e543e940dac81ecae795daf62b9b91b96ac72"},
}

// MeshLLMAssetFor resolves the pinned release artifact for a platform and
// flavor, or errors when the agent ships no MeshLLM build for it.
func MeshLLMAssetFor(goos, goarch, flavor string) (MeshLLMAsset, error) {
	return MeshLLMAssetForVersion(goos, goarch, flavor, MeshLLMPinnedVersion)
}

func MeshLLMAssetForVersion(goos, goarch, flavor, version string) (MeshLLMAsset, error) {
	if version == "" || version == MeshLLMPinnedVersion {
		asset, ok := meshLLMAssets[goos+"/"+goarch+"/"+flavor]
		if !ok {
			return MeshLLMAsset{}, fmt.Errorf("no pinned mesh-llm asset for %s/%s flavor %q", goos, goarch, flavor)
		}
		return asset, nil
	}
	target := ""
	switch goos + "/" + goarch + "/" + flavor {
	case "linux/amd64/cpu":
		target = "x86_64-unknown-linux-gnu.tar.gz"
	case "linux/amd64/cuda-12":
		target = "x86_64-unknown-linux-gnu-cuda-12.tar.gz"
	case "linux/amd64/cuda-13":
		target = "x86_64-unknown-linux-gnu-cuda-13.tar.gz"
	case "linux/arm64/cpu":
		target = "aarch64-unknown-linux-gnu.tar.gz"
	case "linux/arm64/cuda-12":
		target = "aarch64-unknown-linux-gnu-cuda-12.tar.gz"
	case "linux/arm64/cuda-13":
		target = "aarch64-unknown-linux-gnu-cuda-13.tar.gz"
	case "windows/amd64/cpu":
		target = "x86_64-pc-windows-msvc.zip"
	case "windows/amd64/cuda-12", "windows/amd64/cuda-13":
		target = "x86_64-pc-windows-msvc-cuda.zip"
	case "darwin/arm64/metal":
		target = "aarch64-apple-darwin.tar.gz"
	default:
		return MeshLLMAsset{}, fmt.Errorf("no mesh-llm asset for %s/%s flavor %q", goos, goarch, flavor)
	}
	return MeshLLMAsset{AssetName: "mesh-llm-" + version + "-" + target}, nil
}

func meshLLMReleaseBaseURLFor(version string) string {
	if version == "" {
		version = MeshLLMPinnedVersion
	}
	return "https://github.com/Mesh-LLM/mesh-llm/releases/download/" + version
}

func parseSHA256File(data []byte) string {
	for _, field := range strings.Fields(string(data)) {
		if len(field) == 64 {
			ok := true
			for _, r := range field {
				if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
					ok = false
					break
				}
			}
			if ok {
				return strings.ToLower(field)
			}
		}
	}
	return ""
}

// DetectMeshLLMFlavor picks the MeshLLM build flavor for a platform: the Metal
// asset on darwin/arm64; on an NVIDIA host the CUDA build matching the installed
// CUDA runtime major — cuda-13 on Linux when the host carries CUDA 13 runtime
// libraries, cuda-12 otherwise (including when the version is undeterminable, so
// existing CUDA 12 fleets are unaffected); cpu when no NVIDIA GPU is present.
// The distinction is load-bearing: the CUDA build dlopens libcudart.so.<major>,
// so a cuda-12 binary on a CUDA-13-only host fails at library load. A configured
// flavor override bypasses detection.
func DetectMeshLLMFlavor(goos, goarch string, hasNvidiaSMI func() bool, cudaMajor func() int) string {
	if goos == "darwin" && goarch == "arm64" {
		return "metal"
	}
	if hasNvidiaSMI != nil && hasNvidiaSMI() {
		if goos == "linux" && cudaMajor != nil && cudaMajor() >= 13 {
			return "cuda-13"
		}
		return "cuda-12"
	}
	return "cpu"
}

// DetectHostCUDAMajor reports the highest CUDA runtime major version whose
// libcudart shared object the dynamic loader can resolve on this host (13 or 12),
// or 0 when none is found. It is the signal that decides whether the cuda-13 or
// cuda-12 MeshLLM build will actually dlopen its CUDA runtime at startup.
func DetectHostCUDAMajor() int {
	// Highest major wins so a host carrying both prefers the newer runtime.
	if hostHasLibcudartMajor(13) {
		return 13
	}
	if hostHasLibcudartMajor(12) {
		return 12
	}
	return 0
}

// hostHasLibcudartMajor reports whether libcudart.so.<major> is resolvable via
// the loader cache or a well-known CUDA toolkit lib directory outside it.
func hostHasLibcudartMajor(major int) bool {
	soname := fmt.Sprintf("libcudart.so.%d", major)
	if out, err := exec.Command("ldconfig", "-p").Output(); err == nil {
		if strings.Contains(string(out), soname) {
			return true
		}
	}
	for _, dir := range []string{
		"/opt/cuda/lib64",
		"/opt/cuda/targets/x86_64-linux/lib",
		"/usr/local/cuda/lib64",
		"/usr/lib/x86_64-linux-gnu",
		"/usr/lib64",
		"/usr/lib",
	} {
		if matches, _ := filepath.Glob(filepath.Join(dir, soname+"*")); len(matches) > 0 {
			return true
		}
	}
	return false
}

type meshLLMInstallOptions struct {
	goos         string
	goarch       string
	asset        *MeshLLMAsset
	lookPath     func(file string) (string, error)
	queryVersion func(binaryPath string) (string, error)
	download     func(assetURL string) ([]byte, error)
	cudaMajor    func() int
}

// MeshLLMInstallOption customizes EnsureMeshLLM, primarily for test injection.
type MeshLLMInstallOption func(*meshLLMInstallOptions)

// WithMeshLLMPlatform overrides the platform the install resolves assets for.
func WithMeshLLMPlatform(goos, goarch string) MeshLLMInstallOption {
	return func(options *meshLLMInstallOptions) {
		options.goos = goos
		options.goarch = goarch
	}
}

// WithMeshLLMAssetOverride bypasses the embedded pin map with an explicit
// asset, so tests can serve archives whose checksums they control.
func WithMeshLLMAssetOverride(asset MeshLLMAsset) MeshLLMInstallOption {
	return func(options *meshLLMInstallOptions) {
		options.asset = &asset
	}
}

// WithMeshLLMLookPath overrides PATH resolution (also used to probe nvidia-smi).
func WithMeshLLMLookPath(lookPath func(file string) (string, error)) MeshLLMInstallOption {
	return func(options *meshLLMInstallOptions) {
		options.lookPath = lookPath
	}
}

// WithMeshLLMVersionQuery overrides how a candidate binary's version is read.
func WithMeshLLMVersionQuery(queryVersion func(binaryPath string) (string, error)) MeshLLMInstallOption {
	return func(options *meshLLMInstallOptions) {
		options.queryVersion = queryVersion
	}
}

// WithMeshLLMDownload overrides how release asset bytes are fetched.
func WithMeshLLMDownload(download func(assetURL string) ([]byte, error)) MeshLLMInstallOption {
	return func(options *meshLLMInstallOptions) {
		options.download = download
	}
}

// WithMeshLLMCUDAMajor overrides the host CUDA-runtime major probe used by
// flavor detection, so tests can select the cuda-12 vs cuda-13 path.
func WithMeshLLMCUDAMajor(major int) MeshLLMInstallOption {
	return func(options *meshLLMInstallOptions) {
		options.cudaMajor = func() int { return major }
	}
}

// EnsureMeshLLM returns the path of a MeshLLM binary matching the default
// pinned release. The agent release never bundles MeshLLM; it bootstraps the
// selected runtime binary into <dataDir>/bin.
func EnsureMeshLLM(dataDir, flavorOverride string, allowUnpinned bool, opts ...MeshLLMInstallOption) (string, error) {
	return EnsureMeshLLMVersion(dataDir, flavorOverride, allowUnpinned, MeshLLMPinnedVersion, opts...)
}

// EnsureMeshLLMVersion returns the path of a MeshLLM binary matching the
// operator-selected release, installing it when necessary. A mesh-llm binary on
// PATH is accepted only when its version output matches the selected version
// (allowUnpinned accepts it regardless); otherwise the selected release asset is
// downloaded from GitHub releases into <dataDir>/bin, SHA-256 verified, extracted,
// and installed by atomic rename. The agent supervises the binary itself and
// never installs MeshLLM's upstream service units. Any failure wraps
// ErrRuntimeDependencyMissing so the node stays up but never eligible.
func EnsureMeshLLMVersion(dataDir, flavorOverride string, allowUnpinned bool, version string, opts ...MeshLLMInstallOption) (string, error) {
	if version == "" {
		version = MeshLLMPinnedVersion
	}
	options := meshLLMInstallOptions{
		goos:         runtime.GOOS,
		goarch:       runtime.GOARCH,
		lookPath:     exec.LookPath,
		queryVersion: queryMeshLLMVersion,
		download:     downloadMeshLLMAsset,
		cudaMajor:    DetectHostCUDAMajor,
	}
	for _, opt := range opts {
		opt(&options)
	}

	if pathBinary, err := options.lookPath("mesh-llm"); err == nil {
		if allowUnpinned {
			return pathBinary, nil
		}
		if output, versionErr := options.queryVersion(pathBinary); versionErr == nil && meshLLMVersionMatches(output, version) {
			return pathBinary, nil
		}
	}

	binaryName := meshLLMBinaryName(options.goos)
	target := filepath.Join(dataDir, "bin", binaryName)
	if _, err := os.Stat(target); err == nil {
		if output, versionErr := options.queryVersion(target); versionErr == nil && meshLLMVersionMatches(output, version) {
			return target, nil
		}
	}

	asset := MeshLLMAsset{}
	if options.asset != nil {
		asset = *options.asset
	} else {
		flavor := flavorOverride
		if flavor == "" {
			flavor = DetectMeshLLMFlavor(options.goos, options.goarch, func() bool {
				_, err := options.lookPath("nvidia-smi")
				return err == nil
			}, options.cudaMajor)
		}
		resolved, err := MeshLLMAssetForVersion(options.goos, options.goarch, flavor, version)
		if err != nil {
			return "", fmt.Errorf("%w: %v", ErrRuntimeDependencyMissing, err)
		}
		asset = resolved
	}

	assetURL := meshLLMReleaseBaseURLFor(version) + "/" + asset.AssetName
	data, err := options.download(assetURL)
	if err != nil {
		return "", fmt.Errorf("%w: download %s: %v", ErrRuntimeDependencyMissing, asset.AssetName, err)
	}
	sha := asset.SHA256
	if sha == "" {
		checksum, checksumErr := options.download(assetURL + ".sha256")
		if checksumErr != nil {
			return "", fmt.Errorf("%w: download %s.sha256: %v", ErrRuntimeDependencyMissing, asset.AssetName, checksumErr)
		}
		sha = parseSHA256File(checksum)
		if sha == "" {
			return "", fmt.Errorf("%w: invalid checksum file for %s", ErrRuntimeDependencyMissing, asset.AssetName)
		}
	}
	if !VerifyBytesSHA256(data, sha) {
		return "", fmt.Errorf("%w: checksum mismatch for %s", ErrRuntimeDependencyMissing, asset.AssetName)
	}
	binary, err := extractMeshLLMBinary(data, asset.AssetName, binaryName)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRuntimeDependencyMissing, err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", fmt.Errorf("%w: create bin dir: %v", ErrRuntimeDependencyMissing, err)
	}
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, binary, 0o700); err != nil {
		return "", fmt.Errorf("%w: stage mesh-llm binary: %v", ErrRuntimeDependencyMissing, err)
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("%w: install mesh-llm binary: %v", ErrRuntimeDependencyMissing, err)
	}
	return target, nil
}

func meshLLMBinaryName(goos string) string {
	if goos == "windows" {
		return "mesh-llm.exe"
	}
	return "mesh-llm"
}

// meshLLMVersionMatches reports whether a --version output names exactly the
// pinned release, comparing whitespace-separated tokens with an optional
// leading "v" so "mesh-llm 0.72.2" matches pin "v0.72.2" but "0.72.21" never does.
func meshLLMVersionMatches(output, pinned string) bool {
	want := strings.TrimPrefix(pinned, "v")
	for _, field := range strings.Fields(output) {
		if strings.TrimPrefix(field, "v") == want {
			return true
		}
	}
	return false
}

// extractMeshLLMBinary pulls only the mesh-llm binary entry out of a release
// archive; upstream service units and other bundle files are never extracted.
func extractMeshLLMBinary(archive []byte, assetName, binaryName string) ([]byte, error) {
	switch {
	case strings.HasSuffix(assetName, ".tar.gz"):
		return extractMeshLLMTarGz(archive, binaryName)
	case strings.HasSuffix(assetName, ".zip"):
		return extractMeshLLMZip(archive, binaryName)
	default:
		return nil, fmt.Errorf("unsupported mesh-llm archive type: %s", assetName)
	}
}

func extractMeshLLMTarGz(archive []byte, binaryName string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open mesh-llm archive: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read mesh-llm archive: %w", err)
		}
		if header.Typeflag != tar.TypeReg || archiveEntryBase(header.Name) != binaryName {
			continue
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			return nil, fmt.Errorf("read mesh-llm binary entry: %w", err)
		}
		return data, nil
	}
	return nil, fmt.Errorf("binary %s not found in mesh-llm archive", binaryName)
}

func extractMeshLLMZip(archive []byte, binaryName string) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open mesh-llm archive: %w", err)
	}
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || archiveEntryBase(file.Name) != binaryName {
			continue
		}
		entry, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("open mesh-llm binary entry: %w", err)
		}
		data, err := io.ReadAll(entry)
		closeErr := entry.Close()
		if err != nil {
			return nil, fmt.Errorf("read mesh-llm binary entry: %w", err)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close mesh-llm binary entry: %w", closeErr)
		}
		return data, nil
	}
	return nil, fmt.Errorf("binary %s not found in mesh-llm archive", binaryName)
}

// archiveEntryBase returns an archive entry's final path segment; upstream
// windows zips use backslash separators, so both separators are handled.
func archiveEntryBase(name string) string {
	return path.Base(strings.ReplaceAll(name, `\`, "/"))
}

func safeArchiveEntryBase(name string) (string, error) {
	normalized := strings.ReplaceAll(name, `\`, "/")
	if strings.TrimSpace(normalized) == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.Contains(normalized, "\x00") {
		return "", fmt.Errorf("nul byte in path")
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || cleaned == ".." || path.IsAbs(cleaned) || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return "", fmt.Errorf("path escapes archive root")
	}
	base := path.Base(cleaned)
	if base == "." || base == ".." || base == "" || strings.ContainsAny(base, `/\`) || strings.Contains(base, ":") {
		return "", fmt.Errorf("unsafe file name")
	}
	return base, nil
}

func safeRuntimeFilePath(root, name string) (string, error) {
	if _, err := safeArchiveEntryBase(name); err != nil {
		return "", err
	}
	dest := filepath.Join(root, name)
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve runtime root: %w", err)
	}
	cleanDest, err := filepath.Abs(dest)
	if err != nil {
		return "", fmt.Errorf("resolve runtime path: %w", err)
	}
	rootPrefix := cleanRoot + string(os.PathSeparator)
	if cleanDest == cleanRoot || !strings.HasPrefix(cleanDest, rootPrefix) {
		return "", fmt.Errorf("path escapes runtime root")
	}
	return cleanDest, nil
}

func downloadMeshLLMAsset(assetURL string) ([]byte, error) {
	client := &http.Client{Timeout: 30 * time.Minute}
	response, err := client.Get(assetURL)
	if err != nil {
		return nil, fmt.Errorf("download mesh-llm asset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download mesh-llm asset returned %d", response.StatusCode)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read mesh-llm asset: %w", err)
	}
	return data, nil
}

func queryMeshLLMVersion(binaryPath string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, binaryPath, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("query mesh-llm version: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

const MeshLLMInstallAnchors = "REQ-NODE-006"
