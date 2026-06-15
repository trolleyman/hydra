package artifacts

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/config"
)

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return dir
}

// waitReady polls Get until the entry leaves the generating state.
func waitReady(t *testing.T, m *Manager, spec config.ArtifactScript, v Version) Meta {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		meta, err := m.Get(spec, v)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if meta.Status != StatusGenerating {
			return meta
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for artifact generation")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestGenerateAndCache(t *testing.T) {
	repo := initRepo(t)
	m := NewManager(repo)
	spec := config.ArtifactScript{
		Name:    "shots",
		Command: `printf 'PNGDATA' > "$HYDRA_ARTIFACT_OUTPUT/home.png"`,
	}

	meta := waitReady(t, m, spec, Version{Ref: "HEAD"})
	if meta.Status != StatusReady {
		t.Fatalf("status = %s, error = %s", meta.Status, meta.Error)
	}
	if len(meta.Files) != 1 || meta.Files[0].Name != "home.png" {
		t.Fatalf("files = %+v", meta.Files)
	}
	if meta.Files[0].Hash == "" || meta.Files[0].Size != 7 {
		t.Fatalf("file meta = %+v", meta.Files[0])
	}

	// Second call is a cache hit (ready immediately, no generation).
	again, err := m.Get(spec, Version{Ref: "HEAD"})
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != StatusReady {
		t.Fatalf("expected cache hit ready, got %s", again.Status)
	}

	// The ephemeral checkout subdir must be cleaned up (the .gitignore stays).
	entries, _ := os.ReadDir(m.checkoutsDir())
	for _, e := range entries {
		if e.IsDir() {
			t.Errorf("checkout not cleaned: %s", e.Name())
		}
	}
}

func TestGenerateError(t *testing.T) {
	repo := initRepo(t)
	m := NewManager(repo)
	spec := config.ArtifactScript{Name: "broken", Command: "echo boom >&2; exit 3"}

	meta := waitReady(t, m, spec, Version{Ref: "HEAD"})
	if meta.Status != StatusError {
		t.Fatalf("expected error status, got %s", meta.Status)
	}
	if meta.Error == "" {
		t.Error("expected error message")
	}
}

func TestBlobPath(t *testing.T) {
	m := NewManager(t.TempDir())

	// Valid request resolves to a path inside the entry dir.
	got, ct, err := m.BlobPath("shots", "cabc123", "sub/home.png")
	if err != nil {
		t.Fatalf("valid blob path rejected: %v", err)
	}
	if ct != "image/png" {
		t.Errorf("content type = %q", ct)
	}
	base := m.entryDir("shots", "cabc123")
	if rel, _ := filepath.Rel(base, got); rel != filepath.FromSlash("sub/home.png") {
		t.Errorf("resolved outside base: %q", got)
	}

	// Rejections.
	if _, _, err := m.BlobPath("shots", "nothex!", "home.png"); err == nil {
		t.Error("expected bad-key rejection")
	}
	if _, _, err := m.BlobPath("shots", "cabc123", "home.txt"); err == nil {
		t.Error("expected unsupported-type rejection")
	}

	// Traversal attempts must stay contained within the entry dir (rooted, not escaping).
	for _, file := range []string{"../../etc/passwd.png", "/etc/passwd.png", "a/../../b.png"} {
		p, _, err := m.BlobPath("shots", "cabc123", file)
		if err != nil {
			continue // rejected outright is also fine
		}
		if rel, _ := filepath.Rel(base, p); rel == ".." || filepath.IsAbs(rel) || hasDotDotPrefix(rel) {
			t.Errorf("traversal %q escaped base: %q", file, p)
		}
	}
}

func hasDotDotPrefix(rel string) bool {
	return rel == ".." || (len(rel) >= 3 && rel[:3] == ".."+string(filepath.Separator))
}

func TestCompare(t *testing.T) {
	left := []FileMeta{
		{Name: "a.png", Hash: "1"},
		{Name: "b.png", Hash: "2"},
		{Name: "c.png", Hash: "3"},
	}
	right := []FileMeta{
		{Name: "a.png", Hash: "1"}, // unchanged
		{Name: "b.png", Hash: "9"}, // modified
		{Name: "d.png", Hash: "4"}, // added (c removed)
	}
	deltas := Compare(left, right)
	got := map[string]ChangeType{}
	for _, d := range deltas {
		got[d.Name] = d.Change
	}
	want := map[string]ChangeType{
		"a.png": ChangeUnchanged,
		"b.png": ChangeModified,
		"c.png": ChangeRemoved,
		"d.png": ChangeAdded,
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s: got %s want %s", name, got[name], w)
		}
	}
	if !AnyChanged(deltas) {
		t.Error("expected AnyChanged true")
	}
	if AnyChanged(Compare(left, left)) {
		t.Error("expected AnyChanged false for identical lists")
	}
}
