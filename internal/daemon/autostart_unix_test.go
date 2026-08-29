//go:build !windows

package daemon

import (
	"slices"
	"testing"
)

func TestDesktopDaemonUsesAssignedLoopbackPort(t *testing.T) {
	env := desktopDaemonEnv()
	if !slices.Contains(env, "HYDRA_DESKTOP_SERVICE=1") {
		t.Fatal("desktop daemon is not marked as desktop-owned")
	}
	if !slices.Contains(env, "HYDRA_API_ADDR=127.0.0.1:0") {
		t.Fatalf("desktop daemon environment = %v, want OS-assigned loopback port", env)
	}
}
