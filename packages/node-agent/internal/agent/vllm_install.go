package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// VllmPinnedVersion is the default vLLM release installed until the router
// sends an operator-selected version. It is the bare pip version; router-side
// tags carry a leading v that EnsureVllm strips.
const VllmPinnedVersion = "0.27.1"

// UvPinnedVersion is the only uv the agent installs. Re-pinning means updating
// this tag and every checksum in uvAssets together, exactly like MeshLLMPinnedVersion.
const UvPinnedVersion = "0.12.5"

// UvAsset names one pinned uv release artifact and its expected SHA-256.
type UvAsset struct {
	AssetName string
	SHA256    string
}

// uvAssets is the build-time pin map, keyed goos/goarch. Checksums are the
// upstream per-asset .sha256 values for UvPinnedVersion. Only the platforms
// vLLM itself supports (Linux + NVIDIA) are pinned.
var uvAssets = map[string]UvAsset{
	"linux/amd64": {AssetName: "uv-x86_64-unknown-linux-gnu.tar.gz", SHA256: "68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2"},
	"linux/arm64": {AssetName: "uv-aarch64-unknown-linux-gnu.tar.gz", SHA256: "9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31"},
}

// UvAssetFor resolves the pinned uv artifact for a platform, or errors when the
// agent ships no vLLM tier for it.
func UvAssetFor(goos, goarch string) (UvAsset, error) {
	asset, ok := uvAssets[goos+"/"+goarch]
	if !ok {
		return UvAsset{}, fmt.Errorf("no pinned uv asset for %s/%s", goos, goarch)
	}
	return asset, nil
}

// vllmMinFreeBytes is the conservative disk preflight floor: the aggregate
// download approaches ~2 GB and an installed venv realistically runs 5-10+ GB,
// before the model weights land in the HF cache on the same volume.
const vllmMinFreeBytes = 15 << 30

// vllmInstallTimeout bounds the whole venv build. The pip step pulls multi-GB
// CUDA torch wheels, so the bound is generous — its job is to stop a stalled
// index or hung download from wedging the launch path forever, not to race a
// slow link.
const vllmInstallTimeout = 45 * time.Minute

type vllmInstallOptions struct {
	goos         string
	goarch       string
	cudaProbe    func() bool
	diskFree     func(path string) (uint64, error)
	uvDownload   func(assetURL string) ([]byte, error)
	runner       func(ctx context.Context, uvPath string, args ...string) error
	versionProbe func(vllmBinary string) (string, error)
}

type VllmInstallOption func(*vllmInstallOptions)

func WithVllmPlatform(goos string) VllmInstallOption {
	return func(o *vllmInstallOptions) { o.goos = goos }
}

func WithVllmCudaProbe(probe func() bool) VllmInstallOption {
	return func(o *vllmInstallOptions) { o.cudaProbe = probe }
}

func WithVllmDiskFree(free func(path string) (uint64, error)) VllmInstallOption {
	return func(o *vllmInstallOptions) { o.diskFree = free }
}

func WithVllmUvDownload(download func(assetURL string) ([]byte, error)) VllmInstallOption {
	return func(o *vllmInstallOptions) { o.uvDownload = download }
}

func WithVllmRunner(runner func(ctx context.Context, uvPath string, args ...string) error) VllmInstallOption {
	return func(o *vllmInstallOptions) { o.runner = runner }
}

func WithVllmVersionProbe(probe func(vllmBinary string) (string, error)) VllmInstallOption {
	return func(o *vllmInstallOptions) { o.versionProbe = probe }
}

func vllmInstallDefaults() vllmInstallOptions {
	return vllmInstallOptions{
		goos:   runtime.GOOS,
		goarch: runtime.GOARCH,
		cudaProbe: func() bool {
			_, err := exec.LookPath("nvidia-smi")
			return err == nil
		},
		diskFree:     vllmDiskFree,
		uvDownload:   downloadUvAsset,
		runner:       runUvCommand,
		versionProbe: queryVllmVersion,
	}
}

// EnsureVllm provisions the pinned vLLM venv under dataDir and returns the
// venv's vllm binary through the current symlink, so a completed version swap
// is picked up on the next launch. The flow fails closed: capability gate,
// disk preflight, checksum-verified uv, then venv + pin install completed only
// by a version-stamped marker after the venv's own `vllm --version` succeeds.
// A version switch stages the new venv beside the old one and swaps the
// current symlink only once the new marker lands (CON-REL-001 discipline). REQ-NODE-017.
func EnsureVllm(ctx context.Context, dataDir string, version string, opts ...VllmInstallOption) (string, error) {
	options := vllmInstallDefaults()
	for _, opt := range opts {
		opt(&options)
	}
	// The install dies with the agent and with this bound, so a hung wheel
	// download can never wedge the launch path indefinitely.
	ctx, cancelInstall := context.WithTimeout(ctx, vllmInstallTimeout)
	defer cancelInstall()
	if options.goos != "linux" || !options.cudaProbe() {
		return "", fmt.Errorf("%w: vLLM requires Linux + NVIDIA CUDA", ErrRuntimeDependencyMissing)
	}
	// Router-selected versions are GitHub release tags (v0.27.1); pip pins are bare.
	pipVersion := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if pipVersion == "" {
		pipVersion = VllmPinnedVersion
	}
	root := filepath.Join(dataDir, "runtimes", "vllm")
	versionDir := filepath.Join(root, pipVersion)
	venvDir := filepath.Join(versionDir, "venv")
	currentBinary := filepath.Join(root, "current", "venv", "bin", "vllm")

	if vllmMarkerValid(versionDir, pipVersion) {
		if err := swapVllmCurrent(root, versionDir); err != nil {
			return "", err
		}
		return currentBinary, nil
	}

	free, err := options.diskFree(dataDir)
	if err != nil {
		return "", fmt.Errorf("%w: disk preflight failed for vLLM install: %s", ErrRuntimeDependencyMissing, err)
	}
	if free < vllmMinFreeBytes {
		return "", fmt.Errorf("%w: insufficient free disk for vLLM install: %d GiB free, need ~%d GiB (venv + model cache)", ErrRuntimeDependencyMissing, free>>30, vllmMinFreeBytes>>30)
	}

	uvPath, err := ensureUv(dataDir, options)
	if err != nil {
		return "", err
	}

	// A venv without a matching marker is a partial install: delete and rebuild.
	// The rebuild happens in place, not staged-and-renamed: a Python venv bakes
	// absolute paths into its scripts, so it must be built at its final path.
	// The unlaunchable window this opens only exists while the marker is
	// already invalid (the env was never verified complete), a running process
	// keeps its open file handles, and the flow either completes or fails
	// closed to dependency-missing. Version *upgrades* stage beside the old
	// venv and swap `current` only after the new marker lands.
	if err := os.RemoveAll(versionDir); err != nil {
		return "", fmt.Errorf("clear stale vllm venv: %w", err)
	}
	if err := os.MkdirAll(versionDir, 0o700); err != nil {
		return "", fmt.Errorf("create vllm version dir: %w", err)
	}
	if err := options.runner(ctx, uvPath, "venv", venvDir, "--python", "3.12", "--seed"); err != nil {
		return "", fmt.Errorf("create vllm venv: %w", err)
	}
	// --torch-backend=auto lets uv match the torch wheel index to the installed
	// driver, so a too-old CUDA driver fails at install with a readable error
	// instead of a cryptic import error at launch.
	if err := options.runner(ctx, uvPath, "pip", "install", "--python", filepath.Join(venvDir, "bin", "python"), "vllm=="+pipVersion, "--torch-backend=auto"); err != nil {
		return "", fmt.Errorf("install vllm==%s: %w", pipVersion, err)
	}
	venvBinary := filepath.Join(venvDir, "bin", "vllm")
	probed, err := options.versionProbe(venvBinary)
	if err != nil {
		return "", fmt.Errorf("verify vllm install: %w", err)
	}
	if !strings.Contains(probed, pipVersion) {
		return "", fmt.Errorf("verify vllm install: probe reported %q, want %s", probed, pipVersion)
	}
	if err := os.WriteFile(filepath.Join(versionDir, ".install-complete"), []byte(pipVersion+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write vllm completion marker: %w", err)
	}
	if err := swapVllmCurrent(root, versionDir); err != nil {
		return "", err
	}
	return currentBinary, nil
}

// vllmMarkerValid reports whether versionDir holds a completed install: the
// version-stamped marker and the venv binary itself. A bare dir-exists check
// would trust partial installs.
func vllmMarkerValid(versionDir string, pipVersion string) bool {
	marker, err := os.ReadFile(filepath.Join(versionDir, ".install-complete"))
	if err != nil || strings.TrimSpace(string(marker)) != pipVersion {
		return false
	}
	_, err = os.Stat(filepath.Join(versionDir, "venv", "bin", "vllm"))
	return err == nil
}

// swapVllmCurrent atomically re-points the current symlink at versionDir. The
// previous version's venv stays on disk for rollback.
func swapVllmCurrent(root string, versionDir string) error {
	tmp := filepath.Join(root, ".current.tmp")
	_ = os.Remove(tmp)
	if err := os.Symlink(versionDir, tmp); err != nil {
		return fmt.Errorf("stage vllm current symlink: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(root, "current")); err != nil {
		return fmt.Errorf("swap vllm current symlink: %w", err)
	}
	return nil
}

// ensureUv reuses a managed uv only while its version stamp matches the pin,
// otherwise downloads the pinned release, verifies it against the embedded
// checksum, and installs it under dataDir/bin. The stamp is what lets a
// re-pin actually reach nodes that installed uv once. uv is deliberately not
// in the router's desired-versions wire contract — the pin here is the only source.
func ensureUv(dataDir string, options vllmInstallOptions) (string, error) {
	uvPath := filepath.Join(dataDir, "bin", "uv")
	stampPath := filepath.Join(dataDir, "bin", ".uv-version")
	if stamp, err := os.ReadFile(stampPath); err == nil && strings.TrimSpace(string(stamp)) == UvPinnedVersion {
		if _, err := os.Stat(uvPath); err == nil {
			return uvPath, nil
		}
	}
	asset, err := UvAssetFor(options.goos, options.goarch)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrRuntimeDependencyMissing, err)
	}
	data, err := options.uvDownload("https://github.com/astral-sh/uv/releases/download/" + UvPinnedVersion + "/" + asset.AssetName)
	if err != nil {
		return "", fmt.Errorf("%w: download uv: %s", ErrRuntimeDependencyMissing, err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != asset.SHA256 {
		return "", fmt.Errorf("%w: uv checksum mismatch for %s", ErrRuntimeDependencyMissing, asset.AssetName)
	}
	binary, err := extractMeshLLMTarGz(data, "uv")
	if err != nil {
		return "", fmt.Errorf("%w: extract uv: %s", ErrRuntimeDependencyMissing, err)
	}
	if err := os.MkdirAll(filepath.Dir(uvPath), 0o700); err != nil {
		return "", fmt.Errorf("create managed bin dir: %w", err)
	}
	if err := os.WriteFile(uvPath, binary, 0o700); err != nil {
		return "", fmt.Errorf("install uv: %w", err)
	}
	if err := os.WriteFile(stampPath, []byte(UvPinnedVersion+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write uv version stamp: %w", err)
	}
	return uvPath, nil
}

func downloadUvAsset(assetURL string) ([]byte, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(assetURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("uv download returned status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// InstalledVllmVersion reads the completed install the current symlink points
// at, or empty when no verified venv exists. This is the *installed* version —
// distinct from the router's desired selection — so the console's
// desired-vs-installed comparison can actually disagree. REQ-OBS-012 discipline.
func InstalledVllmVersion(dataDir string) string {
	marker, err := os.ReadFile(filepath.Join(dataDir, "runtimes", "vllm", "current", ".install-complete"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(marker))
}

// runUvCommand runs one uv step, folding the tail of its combined output into
// the error so install failures reach the console as something actionable.
func runUvCommand(ctx context.Context, uvPath string, args ...string) error {
	cmd := exec.CommandContext(ctx, uvPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(out))
		if len(detail) > 400 {
			detail = detail[len(detail)-400:]
		}
		return fmt.Errorf("uv %s: %w: %s", strings.Join(args[:min(len(args), 2)], " "), err, detail)
	}
	return nil
}

func queryVllmVersion(vllmBinary string) (string, error) {
	cmd := exec.Command(vllmBinary, "--version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("vllm --version: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}
