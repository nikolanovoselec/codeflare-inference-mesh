//go:build windows

package main

import "os"

func serviceSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
