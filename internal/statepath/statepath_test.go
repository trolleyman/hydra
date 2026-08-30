package statepath

import (
	"path/filepath"
	"testing"
)

func TestProjectDirUsesChildProcessProjectID(t *testing.T) {
	stateRoot := t.TempDir()
	projectRoot := t.TempDir()
	t.Setenv(Environment, stateRoot)
	t.Setenv(ProjectEnvironment, "stable-id")
	t.Setenv(ProjectRootEnvironment, projectRoot)

	want := filepath.Join(stateRoot, "projects", "stable-id")
	if got := ProjectDir(projectRoot); got != want {
		t.Fatalf("ProjectDir = %q, want %q", got, want)
	}
}

func TestProjectDirRejectsUnsafeChildProcessProjectID(t *testing.T) {
	projectRoot := t.TempDir()
	t.Setenv(Environment, t.TempDir())
	t.Setenv(ProjectEnvironment, "../escape")
	t.Setenv(ProjectRootEnvironment, projectRoot)

	want := filepath.Join(projectRoot, ".hydra", "local")
	if got := ProjectDir(projectRoot); got != want {
		t.Fatalf("ProjectDir = %q, want legacy fallback %q", got, want)
	}
}

func TestRuntimeIsolationKeyComesFromExplicitStateRoot(t *testing.T) {
	t.Setenv(Environment, "")
	if got := RuntimeIsolationKey(); got != "" {
		t.Fatalf("production isolation key = %q", got)
	}
	override := filepath.Join(t.TempDir(), "state")
	t.Setenv(Environment, override)
	if got := RuntimeIsolationKey(); got != override {
		t.Fatalf("development isolation key = %q, want %q", got, override)
	}
}
