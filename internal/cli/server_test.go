package cli

import (
	"testing"

	"github.com/trolleyman/hydra/internal/config"
)

func TestIsLoopbackBind(t *testing.T) {
	cases := map[string]bool{
		"localhost:8080": true,
		"127.0.0.1:8080": true,
		"[::1]:8080":     true,
		"0.0.0.0:8080":   false,
		"[::]:8080":      false,
		":8080":          false, // all interfaces
		"192.168.1.5:80": false,
	}
	for addr, want := range cases {
		if got := isLoopbackBind(addr); got != want {
			t.Errorf("isLoopbackBind(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestResolveWebAddrRefusesExposedWithoutKey(t *testing.T) {
	t.Setenv("HYDRA_API_ADDR", "0.0.0.0:8080")

	// No key + exposed bind → refused.
	if _, err := resolveWebAddr(config.DeployConfig{}); err == nil {
		t.Fatal("expected refusal binding 0.0.0.0 without an auth key")
	}

	// Key present → allowed.
	addr, err := resolveWebAddr(config.DeployConfig{AuthKey: "k"})
	if err != nil {
		t.Fatalf("unexpected error with key set: %v", err)
	}
	if addr != "0.0.0.0:8080" {
		t.Errorf("addr = %q, want 0.0.0.0:8080", addr)
	}
}

func TestResolveWebAddrDefaultsToLocalhost(t *testing.T) {
	t.Setenv("HYDRA_API_ADDR", "")
	// No env, no key: localhost bind is fine (the default, local-only behaviour).
	addr, err := resolveWebAddr(config.DeployConfig{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addr != defaultWebAddr {
		t.Errorf("addr = %q, want localhost:26600", addr)
	}
}
