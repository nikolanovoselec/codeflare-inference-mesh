package agent

import (
	"net"
	"testing"
)

type fuzzAddr string

func (a fuzzAddr) Network() string { return "ip" }
func (a fuzzAddr) String() string  { return string(a) }

func FuzzDetectMeshIP(f *testing.F) {
	for _, seed := range []string{"100.64.1.10/32", "10.0.0.1/32", "8.8.8.8/32", "127.0.0.1/32", "bad"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		ip, ok := DetectMeshIP([]net.Addr{fuzzAddr(raw)})
		if !ok {
			return
		}
		parsed := net.ParseIP(ip)
		if parsed == nil || parsed.IsLoopback() || parsed.To4() == nil {
			t.Fatalf("accepted invalid mesh ip %q from %q", ip, raw)
		}
	})
}
