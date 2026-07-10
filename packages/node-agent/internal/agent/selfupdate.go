package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// selfUpdateRetryInterval is how long a failed update for an unchanged desired
// version backs off before it is re-attempted.
const selfUpdateRetryInterval = time.Hour

const checksumsFileName = "checksums.txt"

// SelfUpdater converges the running agent onto the router's desired version:
// any desired version that differs from the running one (newer or older —
// inequality, not ordering) is downloaded from the GitHub release with that
// tag, checksum-verified, staged, and applied by atomically swapping the
// running binary. After an applied update the caller must exit so the service
// manager restarts the new binary. Not safe for concurrent use; call it from
// the single heartbeat loop.
type SelfUpdater struct {
	currentVersion string
	repo           string
	dataDir        string
	download       func(url string) ([]byte, error)
	clock          func() time.Time
	apply          func(stagedPath string) error
	lastDesired    string
	lastAttempt    time.Time
}

// SelfUpdateOption customizes a SelfUpdater; tests use these to fake the
// network, the clock, and the binary swap.
type SelfUpdateOption func(*SelfUpdater)

func WithSelfUpdateDownload(download func(url string) ([]byte, error)) SelfUpdateOption {
	return func(u *SelfUpdater) { u.download = download }
}

func WithSelfUpdateClock(clock func() time.Time) SelfUpdateOption {
	return func(u *SelfUpdater) { u.clock = clock }
}

func WithSelfUpdateApply(apply func(stagedPath string) error) SelfUpdateOption {
	return func(u *SelfUpdater) { u.apply = apply }
}

// NewSelfUpdater builds a SelfUpdater for the compiled-in currentVersion.
// repo is the GitHub "<owner>/<name>" repository whose releases carry the
// agent artifacts; dataDir hosts the protected staging directory.
func NewSelfUpdater(currentVersion string, repo string, dataDir string, opts ...SelfUpdateOption) *SelfUpdater {
	updater := &SelfUpdater{
		currentVersion: currentVersion,
		repo:           repo,
		dataDir:        dataDir,
		download:       downloadReleaseFile,
		clock:          time.Now,
		apply:          applyStagedBinary,
	}
	for _, opt := range opts {
		opt(updater)
	}
	return updater
}

// Maybe runs one update pass for the heartbeat-delivered desired version. It
// returns applied=true after the staged binary has been swapped in; the caller
// must then exit(0) so the service manager restarts the new binary. A zero now
// falls back to the configured clock. A failure at any step returns the error
// (the caller reports it as the node's last error) and the same desired
// version is re-attempted only after one hour; a changed desired version
// re-attempts immediately. The backoff skip itself is silent.
func (u *SelfUpdater) Maybe(desired string, now time.Time) (bool, error) {
	if desired == "" || desired == u.currentVersion {
		return false, nil
	}
	if now.IsZero() {
		now = u.clock()
	}
	if desired == u.lastDesired && now.Sub(u.lastAttempt) < selfUpdateRetryInterval {
		return false, nil
	}
	u.lastDesired = desired
	u.lastAttempt = now
	if err := u.attempt(desired); err != nil {
		return false, fmt.Errorf("self-update to %s: %w", desired, err)
	}
	return true, nil
}

func (u *SelfUpdater) attempt(desired string) error {
	assetName := releaseAssetName(runtime.GOOS, runtime.GOARCH)
	binaryName := releaseBinaryName(runtime.GOOS, runtime.GOARCH)
	checksums, err := u.download(u.releaseFileURL(desired, checksumsFileName))
	if err != nil {
		return fmt.Errorf("download %s: %w", checksumsFileName, err)
	}
	expected, err := checksumEntry(checksums, assetName)
	if err != nil {
		return err
	}
	archive, err := u.download(u.releaseFileURL(desired, assetName))
	if err != nil {
		return fmt.Errorf("download %s: %w", assetName, err)
	}
	if !VerifyBytesSHA256(archive, expected) {
		return fmt.Errorf("checksum mismatch for %s", assetName)
	}
	binary, err := extractArchiveMember(assetName, archive, binaryName)
	if err != nil {
		return err
	}
	binarySHA := sha256.Sum256(binary)
	staged, err := StageUpdate(bytes.NewReader(binary), hex.EncodeToString(binarySHA[:]), filepath.Join(u.dataDir, "updates"), binaryName)
	if err != nil {
		return fmt.Errorf("stage update: %w", err)
	}
	if err := u.apply(staged); err != nil {
		return fmt.Errorf("apply staged update: %w", err)
	}
	return nil
}

func (u *SelfUpdater) releaseFileURL(tag string, name string) string {
	return fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", u.repo, tag, name)
}

// releaseBinaryName is the per-platform binary the deploy release step builds:
// inference-mesh-agent-<GOOS>-<GOARCH> with .exe appended on Windows.
func releaseBinaryName(goos string, goarch string) string {
	name := fmt.Sprintf("inference-mesh-agent-%s-%s", goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// releaseAssetName is the uploaded release archive that checksums.txt covers:
// the Windows binary ships zipped, every other platform as tar.gz.
func releaseAssetName(goos string, goarch string) string {
	if goos == "windows" {
		return fmt.Sprintf("inference-mesh-agent-%s-%s.zip", goos, goarch)
	}
	return fmt.Sprintf("inference-mesh-agent-%s-%s.tar.gz", goos, goarch)
}

// checksumEntry returns the SHA-256 recorded for name in sha256sum-formatted
// checksums data.
func checksumEntry(checksums []byte, name string) (string, error) {
	for _, line := range strings.Split(string(checksums), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if strings.TrimPrefix(fields[len(fields)-1], "*") == name {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("%s has no entry for %s", checksumsFileName, name)
}

func extractArchiveMember(assetName string, archive []byte, member string) ([]byte, error) {
	if strings.HasSuffix(assetName, ".zip") {
		return extractZipMember(archive, member)
	}
	return extractTarGzMember(archive, member)
}

func extractTarGzMember(archive []byte, member string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open release archive: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read release archive: %w", err)
		}
		if strings.TrimPrefix(header.Name, "./") != member {
			continue
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			return nil, fmt.Errorf("extract %s: %w", member, err)
		}
		return data, nil
	}
	return nil, fmt.Errorf("release archive is missing %s", member)
}

func extractZipMember(archive []byte, member string) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open release archive: %w", err)
	}
	for _, file := range reader.File {
		if strings.TrimPrefix(file.Name, "./") != member {
			continue
		}
		open, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("extract %s: %w", member, err)
		}
		data, readErr := io.ReadAll(open)
		_ = open.Close()
		if readErr != nil {
			return nil, fmt.Errorf("extract %s: %w", member, readErr)
		}
		return data, nil
	}
	return nil, fmt.Errorf("release archive is missing %s", member)
}

func downloadReleaseFile(url string) ([]byte, error) {
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("request %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("request %s: status %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", url, err)
	}
	return data, nil
}

// applyStagedBinary is the default apply seam: atomically swap the running
// binary with the staged update. Exiting afterwards is deliberately left to
// the caller of Maybe.
func applyStagedBinary(stagedPath string) error {
	target, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running binary: %w", err)
	}
	return atomicSwap(stagedPath, target)
}

// atomicSwap renames stagedPath over targetPath. Where the running binary
// cannot be replaced in place (Windows), the current binary is moved aside
// first and restored if the swap fails.
func atomicSwap(stagedPath string, targetPath string) error {
	if err := os.Rename(stagedPath, targetPath); err == nil {
		return nil
	}
	aside := targetPath + ".old"
	_ = os.Remove(aside)
	if err := os.Rename(targetPath, aside); err != nil {
		return fmt.Errorf("move current binary aside: %w", err)
	}
	if err := os.Rename(stagedPath, targetPath); err != nil {
		_ = os.Rename(aside, targetPath)
		return fmt.Errorf("swap staged binary: %w", err)
	}
	_ = os.Remove(aside)
	return nil
}

const SelfUpdateAnchors = "REQ-NODE-005"
