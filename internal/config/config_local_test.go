package config

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

// writeProjectConfig writes .hydra/<name> under root, creating .hydra.
func writeProjectConfig(t *testing.T, root, name, content string) {
	t.Helper()
	dir := filepath.Join(root, ".hydra")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

// TestConfigLocalOverrideLayer verifies config.local.toml is merged as a fourth
// layer that wins over the committed project config, with the same union
// semantics for list fields (allowed_hosts).
func TestConfigLocalOverrideLayer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // isolate user config
	root := t.TempDir()

	writeProjectConfig(t, root, "config.toml", `
[review]
provider = "github"
push_branch_template = "{id}"

[sandbox.network]
allowed_hosts = ["committed.example.com"]
`)
	// The local layer overrides scalar review fields and unions the host list.
	writeProjectConfig(t, root, "config.local.toml", `
[review]
push_branch_template = "feat/{id}"

[sandbox.network]
allowed_hosts = ["local.example.com"]
`)

	cfg, err := Load(root)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Review == nil {
		t.Fatal("Review section nil")
	}
	if got := derefStr(cfg.Review.Provider); got != "github" {
		t.Errorf("provider = %q, want github (from committed config)", got)
	}
	if got := derefStr(cfg.Review.PushBranchTemplate); got != "feat/{id}" {
		t.Errorf("push_branch_template = %q, want feat/{id} (local override wins)", got)
	}

	sb := cfg.GetResolvedConfig("claude").Sandbox
	if sb == nil || sb.Network == nil {
		t.Fatal("resolved network nil")
	}
	hosts := sb.Network.AllowedHosts
	if !sliceHas(hosts, "committed.example.com") || !sliceHas(hosts, "local.example.com") {
		t.Errorf("allowed_hosts = %v, want union of committed + local", hosts)
	}
}

// TestConfigLocalAbsentIsNoError verifies a missing config.local.toml is not an
// error and leaves the committed config intact.
func TestConfigLocalAbsentIsNoError(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	root := t.TempDir()
	writeProjectConfig(t, root, "config.toml", "[review]\nprovider = \"gitlab\"\n")

	if _, err := os.Stat(paths.GetProjectConfigLocalPath(root)); !os.IsNotExist(err) {
		t.Fatalf("expected no local config file, stat err = %v", err)
	}
	cfg, err := Load(root)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Review == nil || derefStr(cfg.Review.Provider) != "gitlab" {
		t.Errorf("Review = %+v, want provider gitlab", cfg.Review)
	}
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func sliceHas(xs []string, v string) bool {
	return slices.Contains(xs, v)
}
