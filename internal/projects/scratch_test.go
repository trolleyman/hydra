package projects

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/git"
)

// newTestManager returns a Manager persisting to a temp file, with XDG_DATA_HOME
// pointed at a temp dir so ScratchPath resolves inside the test sandbox.
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	return &Manager{filePath: filepath.Join(t.TempDir(), "projects.json")}
}

func TestEnsureScratchProjectCreatesUsableRepo(t *testing.T) {
	m := newTestManager(t)

	p, err := m.EnsureScratchProject()
	if err != nil {
		t.Fatalf("EnsureScratchProject: %v", err)
	}
	if p.ID != ScratchProjectID {
		t.Errorf("ID = %q, want %q", p.ID, ScratchProjectID)
	}
	if !p.Builtin {
		t.Error("Builtin = false, want true")
	}

	// The whole point of the initial commit: `git worktree add` cannot branch
	// from an unborn HEAD, so without it no head could ever spawn here.
	if !git.HasCommits(p.Path) {
		t.Fatal("scratch repo has no commits, so no head could spawn in it")
	}
	if _, err := os.Stat(filepath.Join(p.Path, "README.md")); err != nil {
		t.Errorf("README.md not created: %v", err)
	}

	// It must be resolvable by ID - every route and endpoint goes through this.
	if got := m.GetByID(ScratchProjectID); got == nil {
		t.Fatal("GetByID(_scratch) = nil, want the scratch project")
	}
}

func TestEnsureScratchProjectIsIdempotent(t *testing.T) {
	m := newTestManager(t)

	first, err := m.EnsureScratchProject()
	if err != nil {
		t.Fatalf("first EnsureScratchProject: %v", err)
	}
	// Stand in for a user's own commit, to prove a re-run doesn't clobber it.
	marker := filepath.Join(first.Path, "note.md")
	if err := os.WriteFile(marker, []byte("mine\n"), 0644); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	if err := git.CommitAll(first.Path, "user commit"); err != nil {
		t.Fatalf("commit marker: %v", err)
	}

	second, err := m.EnsureScratchProject()
	if err != nil {
		t.Fatalf("second EnsureScratchProject: %v", err)
	}
	if second.Path != first.Path {
		t.Errorf("path moved: %q -> %q", first.Path, second.Path)
	}
	if got := len(m.ListProjects()); got != 1 {
		t.Errorf("len(projects) = %d, want 1 (re-run must not duplicate)", got)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("re-run clobbered the user's file: %v", err)
	}
}

// A user project must never be able to take the reserved ID, and must never be
// pushed off its own natural ID by the built-in.
func TestScratchIDIsUnreachableByGenerator(t *testing.T) {
	m := newTestManager(t)
	if _, err := m.EnsureScratchProject(); err != nil {
		t.Fatalf("EnsureScratchProject: %v", err)
	}

	// A folder literally named "scratch" - the closest a user can get.
	dir := filepath.Join(t.TempDir(), "scratch")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	user, err := m.AddProject(dir)
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if user.ID == ScratchProjectID {
		t.Fatalf("user project took the reserved ID %q", ScratchProjectID)
	}
	// It should also keep the clean "scratch" ID rather than being deduped to
	// "scratch2" - that is the reason the built-in uses an underscore prefix.
	if user.ID != "scratch" {
		t.Errorf("user project ID = %q, want %q (built-in must not squat it)", user.ID, "scratch")
	}
	if user.Builtin {
		t.Error("user project marked Builtin")
	}
}

func TestHasUserProjectsIgnoresBuiltins(t *testing.T) {
	m := newTestManager(t)
	if _, err := m.EnsureScratchProject(); err != nil {
		t.Fatalf("EnsureScratchProject: %v", err)
	}
	if m.HasUserProjects() {
		t.Error("HasUserProjects = true with only the built-in registered")
	}

	dir := t.TempDir()
	if _, err := m.AddProject(dir); err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if !m.HasUserProjects() {
		t.Error("HasUserProjects = false after registering a real project")
	}
}
