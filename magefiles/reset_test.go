//go:build mage

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/desktop"
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

func TestRegisterLinuxDevelopmentDesktopIntegrationIsSeparateAndHidden(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	if err := desktop.SetLaunchConfig(desktop.LaunchConfig{State: "global", BackendLifetime: "command-owned", Build: "development"}); err != nil {
		t.Fatal(err)
	}
	t.Chdir("..")

	if err := registerLinuxDevelopmentDesktopIntegration(filepath.Join("dist", "linux", "hydra-desktop")); err != nil {
		t.Fatal(err)
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	entryPath := filepath.Join(dataHome, "applications", "org.trolleyman.hydra.Devel.desktop")
	entry, err := os.ReadFile(entryPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{
		"Icon=org.trolleyman.hydra.Devel",
		"NoDisplay=true",
		"StartupWMClass=org.trolleyman.hydra.Devel",
	} {
		if !strings.Contains(string(entry), "\n"+field+"\n") {
			t.Errorf("development desktop entry does not contain %q", field)
		}
	}
	if strings.Contains(string(entry), "MimeType=") {
		t.Error("development desktop entry claims a URL handler")
	}
	if _, err := os.Stat(filepath.Join(dataHome, "icons", "hicolor", "512x512", "apps", "org.trolleyman.hydra.Devel.png")); err != nil {
		t.Fatalf("development icon was not installed: %v", err)
	}
	for _, productionPath := range []string{
		filepath.Join(dataHome, "applications", "org.trolleyman.hydra.desktop"),
		filepath.Join(dataHome, "icons", "hicolor", "512x512", "apps", "org.trolleyman.hydra.png"),
	} {
		if _, err := os.Stat(productionPath); !os.IsNotExist(err) {
			t.Errorf("production integration path was changed: %s (err=%v)", productionPath, err)
		}
	}
}
