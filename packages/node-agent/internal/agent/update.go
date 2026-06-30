package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type UpdateAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	SHA256 string `json:"sha256"`
}

type UpdatePlan struct {
	CurrentVersion string      `json:"currentVersion"`
	NextVersion    string      `json:"nextVersion"`
	Asset          UpdateAsset `json:"asset"`
}

func VerifyBytesSHA256(data []byte, expected string) bool {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]) == expected
}

func StageUpdate(reader io.Reader, expectedSHA256 string, dir string, filename string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create update dir: %w", err)
	}
	path := filepath.Join(dir, filename)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return "", fmt.Errorf("create update file: %w", err)
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, hash), reader); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("write update file: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close update file: %w", err)
	}
	if hex.EncodeToString(hash.Sum(nil)) != expectedSHA256 {
		return "", fmt.Errorf("checksum mismatch")
	}
	return path, nil
}

const UpdateAnchors = "REQ-NODE-005 REQ-REL-003"
