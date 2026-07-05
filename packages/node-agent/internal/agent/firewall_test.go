package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestREQNODE010EnsureInboundRule(t *testing.T) {
	ctx := context.Background()

	t.Run("REQ-NODE-010 linux scopes a ufw rule to the WARP interface and port", func(t *testing.T) {
		var calls [][]string
		run := func(_ context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, append([]string{name}, args...))
			return nil, nil
		}
		if err := EnsureInboundRule(ctx, run, "linux", "CloudflareWARP", 8080); err != nil {
			t.Fatalf("linux ufw rule: %v", err)
		}
		if len(calls) != 2 {
			t.Fatalf("expected ufw status then allow, got %v", calls)
		}
		if allow := strings.Join(calls[1], " "); allow != "ufw allow in on CloudflareWARP to any port 8080 proto tcp" {
			t.Fatalf("unexpected ufw allow command: %q", allow)
		}
	})

	t.Run("REQ-NODE-010 linux without ufw returns an error for logging", func(t *testing.T) {
		run := func(_ context.Context, _ string, _ ...string) ([]byte, error) { return nil, errors.New("ufw: not found") }
		if err := EnsureInboundRule(ctx, run, "linux", "CloudflareWARP", 8080); err == nil {
			t.Fatalf("missing ufw must return an error")
		}
	})

	t.Run("REQ-NODE-010 linux without a WARP interface refuses an unscoped rule", func(t *testing.T) {
		called := false
		run := func(_ context.Context, _ string, _ ...string) ([]byte, error) { called = true; return nil, nil }
		if err := EnsureInboundRule(ctx, run, "linux", "", 8080); err == nil {
			t.Fatalf("empty iface must return an error")
		}
		if called {
			t.Fatalf("no firewall command should run without a WARP interface")
		}
	})

	t.Run("REQ-NODE-010 windows creates the inbound rule only when absent", func(t *testing.T) {
		created := false
		absent := func(_ context.Context, _ string, args ...string) ([]byte, error) {
			cmd := strings.Join(args, " ")
			if strings.Contains(cmd, "Get-NetFirewallRule") {
				return nil, errors.New("no rule")
			}
			if strings.Contains(cmd, "New-NetFirewallRule") {
				created = true
				if !strings.Contains(cmd, "-LocalPort 8080") || !strings.Contains(cmd, WindowsMeshFirewallRule) {
					t.Fatalf("New rule missing port/name: %q", cmd)
				}
			}
			return nil, nil
		}
		if err := EnsureInboundRule(ctx, absent, "windows", "", 8080); err != nil || !created {
			t.Fatalf("absent rule must be created: err=%v created=%v", err, created)
		}

		present := func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if strings.Contains(strings.Join(args, " "), "New-NetFirewallRule") {
				t.Fatalf("existing rule must not be recreated")
			}
			return nil, nil
		}
		if err := EnsureInboundRule(ctx, present, "windows", "", 8080); err != nil {
			t.Fatalf("idempotent windows path: %v", err)
		}
	})

	t.Run("REQ-NODE-010 macOS is a no-op that never shells out", func(t *testing.T) {
		called := false
		run := func(_ context.Context, _ string, _ ...string) ([]byte, error) { called = true; return nil, nil }
		if err := EnsureInboundRule(ctx, run, "darwin", "", 8080); err != nil {
			t.Fatalf("darwin must be a no-op, got %v", err)
		}
		if called {
			t.Fatalf("darwin must not shell out")
		}
	})

	t.Run("REQ-NODE-010 rejects a non-positive port", func(t *testing.T) {
		run := func(_ context.Context, _ string, _ ...string) ([]byte, error) { return nil, nil }
		if err := EnsureInboundRule(ctx, run, "linux", "CloudflareWARP", 0); err == nil {
			t.Fatalf("port 0 must error")
		}
	})
}
