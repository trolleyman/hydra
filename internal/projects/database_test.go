package projects

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/db"
)

func TestDatabaseManagerImportsLegacyCatalogue(t *testing.T) {
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	legacy := filepath.Join(t.TempDir(), "projects.json")
	if err := os.WriteFile(legacy, []byte(`[{"id":"stable","path":"/repo","name":"Friendly"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	m := &Manager{filePath: legacy, store: store}
	if err := m.load(); err != nil {
		t.Fatal(err)
	}
	if got := m.GetByID("stable"); got == nil || got.Name != "Friendly" {
		t.Fatalf("imported project = %#v", got)
	}

	if err := os.Remove(legacy); err != nil {
		t.Fatal(err)
	}
	reloaded := &Manager{filePath: legacy, store: store}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.GetByID("stable"); got == nil || got.Path != "/repo" {
		t.Fatalf("reloaded project = %#v", got)
	}
}
