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
