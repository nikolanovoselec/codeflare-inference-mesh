// The runtime seam: the contract every managed runtime satisfies, the mesh-only
// coordination surface asserted where used, and the shared child-process plumbing
// all managers launch through.
package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
)

// ErrStopInProgress reports a Stop that found another Stop mid-shutdown of the
// same process. Restart paths propagate it as a failed restart so the heartbeat
// retries, instead of swapping render input over a process that never relaunched.
var ErrStopInProgress = errors.New("runtime stop already in progress")

// RuntimeManager is what the agent service loop needs from any managed runtime.
// Mesh coordination deliberately stays out of this contract: it lives on
// MeshCoordinator, which consumers assert for only where mesh behavior applies,
// so a non-mesh runtime never carries mesh stubs.
type RuntimeManager interface {
	RuntimeController
	Runtime() string
	TargetURL() string
	ReadyModels() []string
	APIReady() bool
	// Inflight reports the runtime's own in-flight request count so a drain can
	// wait on requests the local proxy has already released. Runtimes without
	// such a surface report 0.
	Inflight(ctx context.Context) int
	State() string
	LastError() string
	RuntimeErrorDetail() string
	SetState(state string)
	SetFailure(err error)
}

// MeshCoordinator is the mesh-llm coordination surface: per-tick console status,
// router-driven bootstrap application, and the mesh identity echoed on heartbeats.
// Only the MeshLLM manager implements it.
type MeshCoordinator interface {
	PollStatus(ctx context.Context) (MeshLLMStatus, bool)
	ApplyBootstrap(bootstrap *MeshBootstrap)
	NeedsRestart(bootstrap *MeshBootstrap) bool
	CurrentToken() string
	CurrentMeshID() string
}

var (
	_ RuntimeManager  = (*MeshLLMManager)(nil)
	_ RuntimeManager  = (*LlamaCppManager)(nil)
	_ RuntimeManager  = (*VllmManager)(nil)
	_ MeshCoordinator = (*MeshLLMManager)(nil)
)

// meshProcess abstracts the supervised runtime child process so tests can
// inject a fake in place of a real *exec.Cmd.
type meshProcess interface {
	Signal(sig os.Signal) error
	Kill() error
	Wait() error
}

// meshLauncher starts a runtime binary and returns a handle to the running
// process. The context is the process-lifetime context: cancelling it kills
// the child, and it is never derived from a caller's request context.
type meshLauncher func(ctx context.Context, binary string, args []string, env []string, stderr io.Writer) (meshProcess, error)

type execMeshProcess struct {
	cmd *exec.Cmd
}

func (p execMeshProcess) Signal(sig os.Signal) error { return p.cmd.Process.Signal(sig) }
func (p execMeshProcess) Kill() error                { return p.cmd.Process.Kill() }
func (p execMeshProcess) Wait() error                { return p.cmd.Wait() }

func launchMeshProcess(ctx context.Context, binary string, args []string, env []string, stderr io.Writer) (meshProcess, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.MultiWriter(os.Stderr, stderr)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return execMeshProcess{cmd: cmd}, nil
}
