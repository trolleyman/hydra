package projects

import (
	"path/filepath"
	"testing"
)

func TestSetHidden(t *testing.T) {
	m := seed(t, "a", "b")

	found, err := m.SetHidden("b", true)
	if err != nil {
		t.Fatalf("SetHidden: %v", err)
	}
	if !found {
		t.Fatal("SetHidden reported the project missing")
	}
	if got := m.GetByID("b"); got == nil || !got.Hidden {
		t.Errorf("b Hidden = %v, want true", got != nil && got.Hidden)
	}
	// Hiding one project must not touch the others.
	if got := m.GetByID("a"); got == nil || got.Hidden {
		t.Error("a became hidden")
	}

	// A hide has to survive a daemon restart, or the project comes back on the
	// next boot.
	reloaded := &Manager{filePath: m.filePath}
	if err := reloaded.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.GetByID("b"); got == nil || !got.Hidden {
		t.Error("reloaded b is not hidden")
	}

	if _, err := m.SetHidden("b", false); err != nil {
		t.Fatalf("SetHidden(false): %v", err)
	}
	if got := m.GetByID("b"); got == nil || got.Hidden {
		t.Error("b stayed hidden after being shown again")
	}
}

func TestSetHiddenUnknownProject(t *testing.T) {
	m := seed(t, "a")
	found, err := m.SetHidden("nope", true)
	if err != nil {
		t.Fatalf("SetHidden: %v", err)
	}
	if found {
		t.Error("found = true for an unknown project")
	}
}

// Re-adding a folder you had hidden brings it back: the add flow selects the
// project afterwards, so leaving it out of the list would look like a no-op.
func TestAddProjectUnhides(t *testing.T) {
	dir := t.TempDir()
	m := &Manager{filePath: filepath.Join(t.TempDir(), "projects.json")}
	p, err := m.AddProject(dir)
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if _, err := m.SetHidden(p.ID, true); err != nil {
		t.Fatalf("SetHidden: %v", err)
	}
	again, err := m.AddProject(dir)
	if err != nil {
		t.Fatalf("AddProject (again): %v", err)
	}
	if again.ID != p.ID {
		t.Errorf("re-add created a new project %q, want %q", again.ID, p.ID)
	}
	if again.Hidden {
		t.Error("re-added project is still hidden")
	}
	if got := m.GetByID(p.ID); got == nil || got.Hidden {
		t.Error("stored project is still hidden")
	}
}
