package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// WindowsMeshFirewallRule is the display name of the inbound rule the agent
// provisions on Windows; exported so tests assert the exact idempotency probe.
const WindowsMeshFirewallRule = "Codeflare Mesh Inference"

// EnsureInboundRule best-effort opens an inbound port for WARP traffic on the host
// firewall, so a default-deny policy cannot silently drop peer traffic (the original
// "handshake timeout" symptom). `proto` is "tcp" (the reverse-proxy data plane) or
// "udp" (iroh's QUIC mesh-peer transport, the `--bind-port`); the two are distinct
// rules and both must exist for a multi-node mesh to form. It is idempotent where the
// platform tool supports it and must never fail startup: the caller logs a returned
// error and continues, so an operator can add the rule by hand from the documented
// fallback.
func EnsureInboundRule(ctx context.Context, run CommandRunner, goos string, iface string, port int, proto string) error {
	if port <= 0 {
		return fmt.Errorf("firewall: invalid port %d", port)
	}
	proto = strings.ToLower(proto)
	if proto != "tcp" && proto != "udp" {
		return fmt.Errorf("firewall: invalid proto %q", proto)
	}
	portText := strconv.Itoa(port)
	switch goos {
	case "windows":
		return ensureWindowsRule(ctx, run, portText, proto)
	case "darwin":
		// macOS's application firewall is app-scoped, not port-scoped; there is
		// nothing portable to provision by port, so this is a documented no-op and
		// the operator opens inbound access per the manual fallback if needed.
		return nil
	default:
		return ensureLinuxRule(ctx, run, iface, portText, proto)
	}
}

func ensureLinuxRule(ctx context.Context, run CommandRunner, iface string, port string, proto string) error {
	if iface == "" {
		return fmt.Errorf("firewall: no WARP interface to scope the inbound rule")
	}
	// Only act when ufw is present, so a host that manages its firewall another
	// way is never touched. `ufw allow` is itself idempotent (it skips a duplicate
	// rule), matching the manual rule an operator would add.
	if _, err := run(ctx, "ufw", "status"); err != nil {
		return fmt.Errorf("firewall: ufw not available: %w", err)
	}
	if _, err := run(ctx, "ufw", "allow", "in", "on", iface, "to", "any", "port", port, "proto", proto); err != nil {
		return fmt.Errorf("firewall: ufw allow failed: %w", err)
	}
	return nil
}

func ensureWindowsRule(ctx context.Context, run CommandRunner, port string, proto string) error {
	// The display name carries proto and port so the TCP data-plane rule and the UDP
	// mesh-peer rule are distinct and neither idempotency probe hides the other.
	rule := fmt.Sprintf("%s %s %s", WindowsMeshFirewallRule, strings.ToUpper(proto), port)
	// Existing rule -> no-op, so repeated starts do not stack duplicate rules.
	if _, err := run(ctx, "powershell", "-NoProfile", "-Command", fmt.Sprintf("Get-NetFirewallRule -DisplayName '%s'", rule)); err == nil {
		return nil
	}
	if _, err := run(ctx, "powershell", "-NoProfile", "-Command", fmt.Sprintf("New-NetFirewallRule -DisplayName '%s' -Direction Inbound -Action Allow -Protocol %s -LocalPort %s", rule, strings.ToUpper(proto), port)); err != nil {
		return fmt.Errorf("firewall: New-NetFirewallRule failed: %w", err)
	}
	return nil
}
