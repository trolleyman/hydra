package db

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/paths"
	"gorm.io/gorm"
)

func TestImportLegacyPreservesRecordsAndSource(t *testing.T) {
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	root := t.TempDir()
	source, err := Open(root)
	if err != nil {
		t.Fatalf("Open legacy: %v", err)
	}
	deletedAt := time.Date(2025, 4, 3, 2, 1, 0, 0, time.UTC)
	agents := []Agent{
		{ID: "active", ProjectPath: root, AgentType: "codex", Title: "Active", CreatedAt: deletedAt.Add(-time.Hour)},
		{ID: "archived", ProjectPath: root, AgentType: "claude", Title: "Archived", CreatedAt: deletedAt.Add(-2 * time.Hour), DeletedAt: gorm.DeletedAt{Time: deletedAt, Valid: true}},
	}
	if err := source.db.Unscoped().Create(&agents).Error; err != nil {
		t.Fatalf("seed legacy: %v", err)
	}
	if err := source.Close(); err != nil {
		t.Fatalf("close legacy: %v", err)
	}
	legacyPath := paths.GetDBPathFromProjectRoot(root)
	before, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("read legacy before import: %v", err)
	}

	globalPath, err := GlobalPath()
	if err != nil {
		t.Fatalf("GlobalPath: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(globalPath), 0o700); err != nil {
		t.Fatalf("create state dir: %v", err)
	}
	global, err := openPath(globalPath)
	if err != nil {
		t.Fatalf("open global: %v", err)
	}
	defer global.Close()
	if err := global.ImportLegacy([]string{root, root}); err != nil {
		t.Fatalf("ImportLegacy: %v", err)
	}
	if err := global.ImportLegacy([]string{root}); err != nil {
		t.Fatalf("idempotent ImportLegacy: %v", err)
	}

	var got []Agent
	if err := global.db.Unscoped().Order("id").Find(&got).Error; err != nil {
		t.Fatalf("read imported agents: %v", err)
	}
	if len(got) != 2 || got[0].ID != "active" || got[1].ID != "archived" || !got[1].DeletedAt.Valid {
		t.Fatalf("imported agents = %#v", got)
	}
	var markers int64
	if err := global.db.Model(&LegacyImport{}).Count(&markers).Error; err != nil || markers != 1 {
		t.Fatalf("legacy import markers = %d, err %v", markers, err)
	}

	after, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("read legacy after import: %v", err)
	}
	if string(after) != string(before) {
		t.Fatal("legacy database changed during import")
	}
}

func TestImportLegacyQualifiesCrossProjectAgentID(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	rootA := seedLegacyAgent(t, "same-id", "First")
	rootB := seedLegacyAgent(t, "same-id", "Different")
	globalPath, _ := GlobalPath()
	if err := os.MkdirAll(filepath.Dir(globalPath), 0o700); err != nil {
		t.Fatal(err)
	}
	global, err := openPath(globalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer global.Close()
	if err := global.ImportLegacy([]string{rootA, rootB}); err != nil {
		t.Fatalf("ImportLegacy: %v", err)
	}
	if err := global.ImportLegacy([]string{rootA, rootB}); err != nil {
		t.Fatalf("idempotent ImportLegacy: %v", err)
	}
	var agents []Agent
	if err := global.db.Unscoped().Find(&agents).Error; err != nil {
		t.Fatal(err)
	}
	if len(agents) != 2 {
		t.Fatalf("agents = %#v, want both project-local records", agents)
	}
	byProject := make(map[string]Agent, len(agents))
	for _, agent := range agents {
		byProject[agent.ProjectPath] = agent
	}
	if agent := byProject[rootA]; agent.ID != "same-id" {
		t.Fatalf("first agent = %#v", agent)
	}
	wantQualified := collisionImportID("same-id", rootB)
	if agent := byProject[rootB]; agent.ID != wantQualified {
		t.Fatalf("second agent = %#v, want ID %q in %q", agent, wantQualified, rootB)
	}
	var markers int64
	global.db.Model(&LegacyImport{}).Count(&markers)
	if markers != 2 {
		t.Fatalf("markers = %d, want 2", markers)
	}
}

func TestImportLegacyProjectImportsNewlyRegisteredProject(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	root := seedLegacyAgent(t, "late-agent", "Registered later")
	globalPath, _ := GlobalPath()
	if err := os.MkdirAll(filepath.Dir(globalPath), 0o700); err != nil {
		t.Fatal(err)
	}
	global, err := openPath(globalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer global.Close()
	global.importLegacyOnAdd = true

	if err := global.ImportLegacyProject(root); err != nil {
		t.Fatalf("ImportLegacyProject: %v", err)
	}
	var agent Agent
	if err := global.db.First(&agent, "id = ?", "late-agent").Error; err != nil {
		t.Fatalf("find imported agent: %v", err)
	}
	if agent.ProjectPath != root {
		t.Fatalf("ProjectPath = %q, want %q", agent.ProjectPath, root)
	}
}

func TestOpenGlobalImportsBootProject(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	root := seedLegacyAgent(t, "boot-agent", "From boot project")

	store, err := OpenGlobal(root)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer store.Close()
	var agent Agent
	if err := store.db.First(&agent, "id = ?", "boot-agent").Error; err != nil {
		t.Fatalf("find imported agent: %v", err)
	}
	if agent.ProjectPath != root {
		t.Fatalf("ProjectPath = %q, want %q", agent.ProjectPath, root)
	}
}

func seedLegacyAgent(t *testing.T, id, title string) string {
	t.Helper()
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	agent := Agent{ID: id, ProjectPath: root, AgentType: "codex", Title: title, CreatedAt: time.Now().UTC()}
	if err := store.db.Create(&agent).Error; err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	return root
}
