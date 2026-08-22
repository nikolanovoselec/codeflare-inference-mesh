//go:build linux

package agent

import "syscall"

// vllmDiskFree reports the free bytes on the volume holding path. vLLM installs
// are Linux-only (capability gate), so only Linux needs a real implementation.
func vllmDiskFree(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}
