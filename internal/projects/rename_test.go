package projects

import "testing"

func TestRename(t *testing.T) {
	m := seed(t, "a", "b")

	found, err := m.Rename("b", "  Friendly name  ")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if !found {
		t.Fatal("Rename reported the project missing")
	}
	if got := m.GetByID("b"); got == nil || got.Name != "Friendly name" {
		t.Fatalf("renamed project = %#v", got)
	}
	if got := m.GetByID("a"); got == nil || got.Name != "a" {
		t.Fatalf("other project changed = %#v", got)
	}

	reloaded := &Manager{filePath: m.filePath}
	if err := reloaded.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.GetByID("b"); got == nil || got.Name != "Friendly name" {
		t.Fatalf("reloaded project = %#v", got)
	}
}

func TestRenameRejectsInvalidProjects(t *testing.T) {
	m := seed(t, "a")
	if found, err := m.Rename("missing", "Name"); err != nil || found {
		t.Fatalf("Rename(missing) = (%v, %v), want (false, nil)", found, err)
	}
	if _, err := m.Rename("a", "   "); err == nil {
		t.Fatal("Rename accepted an empty name")
	}

	m.projects[0].Builtin = true
	if _, err := m.Rename("a", "New name"); err == nil {
		t.Fatal("Rename accepted a built-in project")
	}
}
