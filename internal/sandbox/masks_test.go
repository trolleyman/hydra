package sandbox

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestResolveMaskedPathsProjectRelative(t *testing.T) {
	root := t.TempDir()
	// Create files that project-relative masks/globs should resolve to.
	mkdirAll(t, filepath.Join(root, ".hydra"))
	writeFile(t, filepath.Join(root, ".hydra", "deploy.toml"), "secret")
	writeFile(t, filepath.Join(root, ".env"), "X=1")
	writeFile(t, filepath.Join(root, ".env.local"), "X=2")
	writeFile(t, filepath.Join(root, HydraignoreName), "# comment\n.env*\nsecrets/\n\n")
	mkdirAll(t, filepath.Join(root, "secrets"))

	// Config masks: a home-relative entry (passes through) and a project-relative one.
	got := ResolveMaskedPaths(root, "", []string{"~/.ssh", "config/private.key"})

	// Home/absolute entry passes through verbatim.
	if !slices.Contains(got, "~/.ssh") {
		t.Errorf("expected ~/.ssh passthrough, got %v", got)
	}
	// Shipped default resolves against the project root.
	wantDeploy := filepath.Join(root, ".hydra", "deploy.toml")
	if !slices.Contains(got, wantDeploy) {
		t.Errorf("expected shipped default %s in %v", wantDeploy, got)
	}
	// .hydraignore glob .env* expands to the existing files.
	for _, f := range []string{".env", ".env.local"} {
		if !slices.Contains(got, filepath.Join(root, f)) {
			t.Errorf("expected %s from .env* glob in %v", f, got)
		}
	}
	// secrets/ dir entry resolves.
	if !slices.Contains(got, filepath.Join(root, "secrets")) {
		t.Errorf("expected secrets/ in %v", got)
	}
	// Non-glob project-relative config entry resolves even though it doesn't exist
	// (the builder stats it later).
	if !slices.Contains(got, filepath.Join(root, "config", "private.key")) {
		t.Errorf("expected config/private.key in %v", got)
	}
}

func TestResolveMaskedPathsRejectsEscape(t *testing.T) {
	root := t.TempDir()
	got := ResolveMaskedPaths(root, "", []string{"../../etc/shadow"})
	for _, p := range got {
		if p == "/etc/shadow" || filepath.Base(p) == "shadow" {
			t.Errorf("escape not rejected: %v", got)
		}
	}
}

func mkdirAll(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}
