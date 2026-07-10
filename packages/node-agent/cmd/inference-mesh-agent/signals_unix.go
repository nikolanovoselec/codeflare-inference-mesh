//go:build !windows

package main

import (
	"os"
	"syscall"
)

func serviceSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM}
}
