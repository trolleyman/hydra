package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

func TestDeployRoundTrip(t *testing.T) {
	root := t.TempDir()
	want := DeployConfig{AuthKey: "test-key-123", ListenAddr: "0.0.0.0:8080"}
	if err := SaveDeploy(root, want); err != nil {
		t.Fatalf("SaveDeploy: %v", err)
	}

	// File is written with 0600 (it holds a secret).
	info, err := os.Stat(paths.GetDeployConfigPath(root))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("deploy.toml perm = %o, want 600", perm)
	}

	got, err := LoadDeploy(root)
	if err != nil {
		t.Fatalf("LoadDeploy: %v", err)
	}
	if got != want {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
}

func TestLoadDeployMissingFileIsZero(t *testing.T) {
	got, err := LoadDeploy(t.TempDir())
	if err != nil {
		t.Fatalf("LoadDeploy on missing file: %v", err)
	}
	if got != (DeployConfig{}) {
		t.Errorf("missing deploy.toml = %+v, want zero value", got)
	}
}

func TestSaveDeployOmitsEmptyListenAddr(t *testing.T) {
	root := t.TempDir()
	if err := SaveDeploy(root, DeployConfig{AuthKey: "k"}); err != nil {
		t.Fatalf("SaveDeploy: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".hydra", "deploy.toml"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// An unset listen address is left commented (default localhost), so reloading
	// yields an empty ListenAddr rather than a stray active assignment.
	got, err := LoadDeploy(root)
	if err != nil {
		t.Fatalf("LoadDeploy: %v", err)
	}
	if got.ListenAddr != "" {
		t.Errorf("ListenAddr = %q, want empty; file:\n%s", got.ListenAddr, data)
	}
}

func TestGenerateAuthKeyUnique(t *testing.T) {
	a, err := GenerateAuthKey()
	if err != nil {
		t.Fatalf("GenerateAuthKey: %v", err)
	}
	b, err := GenerateAuthKey()
	if err != nil {
		t.Fatalf("GenerateAuthKey: %v", err)
	}
	if a == "" || a == b {
		t.Errorf("keys not unique/non-empty: %q, %q", a, b)
	}
}
