package main

import (
	"os"
	"testing"
)

func TestProductionEnvironmentClearsInheritedDevelopmentState(t *testing.T) {
	keys := []string{
		"HYDRA_STATE_DIR",
		"HYDRA_API_ADDR",
		"HYDRA_DESKTOP_SERVICE",
		"HYDRA_DESKTOP_READY_FILE",
	}
	for _, key := range keys {
		t.Setenv(key, "inherited")
	}
	t.Setenv(desktopLocalEnv, "")

	useProductionEnvironmentByDefault()

	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			t.Fatalf("%s was not cleared: %q", key, value)
		}
	}
}

func TestLocalEnvironmentPreservesDevelopmentState(t *testing.T) {
	t.Setenv(desktopLocalEnv, "1")
	t.Setenv("HYDRA_STATE_DIR", "/checkout/state")

	useProductionEnvironmentByDefault()

	if got := os.Getenv("HYDRA_STATE_DIR"); got != "/checkout/state" {
		t.Fatalf("HYDRA_STATE_DIR = %q", got)
	}
}

func TestIsBackendCommand(t *testing.T) {
	for _, command := range []string{
		"__daemon",
		"__sandbox-init",
		"__desktop-connect",
		"__desktop-active",
		"mcp",
		"gate",
		"trigger-hook",
		"host-run",
		"sandbox-remove",
	} {
		if !isBackendCommand(command) {
			t.Errorf("isBackendCommand(%q) = false", command)
		}
	}
	for _, command := range []string{"", "--url", "--project", "--diagnostics", "--devtools", "--compositing-indicators", "--disable-persistent-animations", "--hardware-acceleration", "--low-paint", "hydra://settings"} {
		if isBackendCommand(command) {
			t.Errorf("isBackendCommand(%q) = true", command)
		}
	}
}

func TestIsHeadEnvironment(t *testing.T) {
	t.Setenv("HYDRA_HEAD_ID", "")
	if isHeadEnvironment() {
		t.Fatal("ordinary desktop launch detected as a head environment")
	}
	t.Setenv("HYDRA_HEAD_ID", "head-1")
	if !isHeadEnvironment() {
		t.Fatal("HYDRA_HEAD_ID did not identify the head environment")
	}
}

func TestIsAutomationLaunch(t *testing.T) {
	for _, args := range [][]string{{"--automation"}, {"--automation=true", "--url", "http://127.0.0.1:1234"}} {
		if !isAutomationLaunch(args) {
			t.Errorf("isAutomationLaunch(%q) = false", args)
		}
	}
	for _, args := range [][]string{nil, {"--url", "http://127.0.0.1:1234", "--automation"}, {"--automation=false"}} {
		if isAutomationLaunch(args) {
			t.Errorf("isAutomationLaunch(%q) = true", args)
		}
	}
}
