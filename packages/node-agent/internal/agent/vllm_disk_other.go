//go:build !linux

package agent

import "errors"

// vllmDiskFree is unreachable off Linux: EnsureVllm's capability gate fails
// closed before the disk preflight. The stub keeps non-Linux agent builds compiling.
func vllmDiskFree(string) (uint64, error) {
	return 0, errors.New("vllm disk preflight is linux-only")
}
