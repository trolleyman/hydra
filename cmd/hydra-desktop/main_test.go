package main

import (
	"os"
	"testing"
)

func TestProductionEnvironmentClearsInheritedDevelopmentState(t *testing.T) {
	keys := []string{
		"HYDRA_DB_PATH",
		"HYDRA_RUNTIME_NAMESPACE",
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
	t.Setenv("HYDRA_DB_PATH", "/checkout/db.sqlite3")
	t.Setenv("HYDRA_RUNTIME_NAMESPACE", "checkout-dev:test")

	useProductionEnvironmentByDefault()

	if got := os.Getenv("HYDRA_DB_PATH"); got != "/checkout/db.sqlite3" {
		t.Fatalf("HYDRA_DB_PATH = %q", got)
	}
	if got := os.Getenv("HYDRA_RUNTIME_NAMESPACE"); got != "checkout-dev:test" {
		t.Fatalf("HYDRA_RUNTIME_NAMESPACE = %q", got)
	}
}
