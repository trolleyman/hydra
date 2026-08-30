//go:build mage

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTemporarilyUnsetEnvRestoresValues(t *testing.T) {
	const setKey = "HYDRA_RESET_TEST_SET"
	const missingKey = "HYDRA_RESET_TEST_MISSING"
	t.Setenv(setKey, "before")
	_ = os.Unsetenv(missingKey)

	restore := temporarilyUnsetEnv(setKey, missingKey)
	if _, ok := os.LookupEnv(setKey); ok {
		t.Fatal("set variable remained present")
	}
	if _, ok := os.LookupEnv(missingKey); ok {
		t.Fatal("missing variable became present")
	}
	restore()

	if got := os.Getenv(setKey); got != "before" {
		t.Fatalf("restored set variable = %q, want before", got)
	}
	if _, ok := os.LookupEnv(missingKey); ok {
		t.Fatal("restored missing variable became present")
	}
}

func TestRemoveProductionRuntimeFilesPreservesDevelopmentNamespaces(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"daemon.sock", "daemon.pid", "daemon.web"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("stale"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	devDir := filepath.Join(dir, "instance-1234")
	if err := os.MkdirAll(devDir, 0o700); err != nil {
		t.Fatal(err)
	}
	devSocket := filepath.Join(devDir, "daemon.sock")
	if err := os.WriteFile(devSocket, []byte("dev"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := removeProductionRuntimeFiles(dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"daemon.sock", "daemon.pid", "daemon.web"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("production runtime file %s remains (err=%v)", name, err)
		}
	}
	if got, err := os.ReadFile(devSocket); err != nil || string(got) != "dev" {
		t.Fatalf("development runtime was changed: content=%q err=%v", got, err)
	}
}
