package cli

import (
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/statepath"
)

func TestDesktopProjectRootKeepsExplicitSelection(t *testing.T) {
	want := filepath.Join(t.TempDir(), "project")
	got, err := desktopProjectRoot(want)
	if err != nil {
		t.Fatalf("desktopProjectRoot: %v", err)
	}
	if got != want {
		t.Fatalf("desktopProjectRoot = %q, want %q", got, want)
	}
}

func TestDesktopProjectRootDefaultsToBuiltInChat(t *testing.T) {
	dataRoot := t.TempDir()
	t.Setenv(statepath.Environment, t.TempDir())
	t.Setenv("XDG_DATA_HOME", dataRoot)

	got, err := desktopProjectRoot("")
	if err != nil {
		t.Fatalf("desktopProjectRoot: %v", err)
	}
	want := filepath.Join(dataRoot, "hydra", "chat")
	if got != want {
		t.Fatalf("desktopProjectRoot = %q, want %q", got, want)
	}
}
