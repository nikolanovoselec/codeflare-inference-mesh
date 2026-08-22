// Helpers shared by the agent package tests.
package agent

import (
	"context"
)

func argvContains(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

func containsEnv(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

type fakeRuntimeController struct {
	starts   int
	stops    int
	restarts int
}

func (f *fakeRuntimeController) Start(context.Context) error {
	f.starts++
	return nil
}

func (f *fakeRuntimeController) Stop(context.Context) error {
	f.stops++
	return nil
}

func (f *fakeRuntimeController) Restart(context.Context) error {
	f.restarts++
	return nil
}

// stopBusyController simulates a manager whose shutdown is already owned by a
// concurrent Stop: the explicit operator stop must still report success.
type stopBusyController struct{ fakeRuntimeController }

func (c *stopBusyController) Stop(context.Context) error {
	c.stops++
	return ErrStopInProgress
}
