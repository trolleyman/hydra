package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

func TestDeployRoundTrip(t *testing.T) {
	root := t.TempDir()
	want := DeployConfig{AuthKey: "test-key-123"}
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

func TestSaveDeployWritesKey(t *testing.T) {
	root := t.TempDir()
	if err := SaveDeploy(root, DeployConfig{AuthKey: "k3y"}); err != nil {
		t.Fatalf("SaveDeploy: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".hydra", "deploy.toml"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(data), `auth_key = "k3y"`) {
		t.Errorf("deploy.toml missing auth_key; file:\n%s", data)
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
