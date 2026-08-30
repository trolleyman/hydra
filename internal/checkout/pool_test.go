package checkout

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// gitRun runs a git command in dir, failing the test on error.
func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// initRepo makes a temp git repo with a single commit and returns its path.
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-q", "-m", "init")
	return dir
}

// commitFile writes name=content, commits it, and returns the new commit SHA.
func commitFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-q", "-m", "c")
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-parse: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func newTestPool(t *testing.T, repo string, max int) *Pool {
	t.Helper()
	return NewPool(repo, filepath.Join(repo, ".hydra", "local", "artifacts", "slots"), max)
}

// TestSlotPoolAffinityAndReuse covers the three reuse paths: a fresh create, an
// affinity hit (same SHA, zero git work, same slot), and an incremental checkout
// (different SHA, same slot, content actually switched).
func TestSlotPoolAffinityAndReuse(t *testing.T) {
	repo := initRepo(t)
	shaA := commitFile(t, repo, "marker.txt", "A")
	shaB := commitFile(t, repo, "marker.txt", "B")

	p := newTestPool(t, repo, maxSlots)

	// 1. Fresh acquire creates one slot, checked out at A.
	s1, err := p.Acquire(shaA, false)
	if err != nil {
		t.Fatalf("acquire A: %v", err)
	}
	if got := readMarker(t, s1.Path()); got != "A" {
		t.Fatalf("slot content = %q, want A", got)
	}
	if len(p.all) != 1 {
		t.Fatalf("len(all) = %d, want 1", len(p.all))
	}
	p.Release(s1)

	// 2. Re-acquire the same SHA -> affinity hit: same slot, no new slot.
	s2, err := p.Acquire(shaA, false)
	if err != nil {
		t.Fatalf("re-acquire A: %v", err)
	}
	if s2 != s1 {
		t.Errorf("affinity miss: got a different slot for the same SHA")
	}
	if len(p.all) != 1 {
		t.Errorf("affinity created a new slot: len(all) = %d", len(p.all))
	}
	p.Release(s2)

	// 3. Acquire a different SHA -> reuse the slot via incremental checkout, no growth.
	s3, err := p.Acquire(shaB, false)
	if err != nil {
		t.Fatalf("acquire B: %v", err)
	}
	if s3 != s1 {
		t.Errorf("expected slot reuse, got a new slot")
	}
	if len(p.all) != 1 {
		t.Errorf("checkout grew the pool: len(all) = %d", len(p.all))
	}
	if got := readMarker(t, s3.Path()); got != "B" {
		t.Errorf("slot content after checkout = %q, want B", got)
	}
	p.Release(s3)
}

func TestSlotPoolRecreatesMissingFreeSlot(t *testing.T) {
	repo := initRepo(t)
	sha := commitFile(t, repo, "marker.txt", "A")
	p := newTestPool(t, repo, maxSlots)

	s1, err := p.Acquire(sha, false)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	p.Release(s1)
	if err := os.RemoveAll(s1.Path()); err != nil {
		t.Fatal(err)
	}

	s2, err := p.Acquire(sha, false)
	if err != nil {
		t.Fatalf("acquire after external slot removal: %v", err)
	}
	if s2 != s1 {
		t.Fatalf("missing slot was replaced in memory instead of repaired")
	}
	if got := readMarker(t, s2.Path()); got != "A" {
		t.Fatalf("recreated slot content = %q, want A", got)
	}
	p.Release(s2)
}

// TestSlotPoolCap verifies the pool never exceeds its cap and that a blocked
// acquire unblocks once a slot is released.
func TestSlotPoolCap(t *testing.T) {
	repo := initRepo(t)
	sha := commitFile(t, repo, "marker.txt", "A")

	p := newTestPool(t, repo, 2)

	// Hold both slots (same SHA, none free, so each forces a create up to the cap).
	a, err := p.Acquire(sha, false)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	b, err := p.Acquire(sha, false)
	if err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	if len(p.all) != 2 {
		t.Fatalf("len(all) = %d, want 2", len(p.all))
	}

	// A third acquire must block until a slot is released.
	got := make(chan *Slot, 1)
	go func() {
		s, err := p.Acquire(sha, false)
		if err != nil {
			t.Errorf("acquire 3: %v", err)
		}
		got <- s
	}()

	select {
	case <-got:
		t.Fatal("third acquire returned while the pool was full")
	case <-time.After(150 * time.Millisecond):
		// expected: still blocked
	}

	p.Release(a)
	select {
	case s := <-got:
		if s == nil {
			t.Fatal("third acquire returned nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("third acquire did not unblock after a release")
	}
	if len(p.all) != 2 {
		t.Errorf("pool exceeded cap: len(all) = %d", len(p.all))
	}
	p.Release(b)
}

// TestSlotPoolCleanCrashRecovery simulates a crash: slot worktrees exist on disk
// and are registered with git, but a fresh pool (empty in-memory state, as on
// boot) has no record of them. Clean must still wipe the dirs and prune the
// dangling git worktree registrations.
func TestSlotPoolCleanCrashRecovery(t *testing.T) {
	repo := initRepo(t)
	sha := commitFile(t, repo, "marker.txt", "A")

	// First pool creates a slot, then we drop the pool WITHOUT cleaning - mimicking
	// a process that died mid-generation, leaving a registered worktree behind.
	p1 := newTestPool(t, repo, maxSlots)
	s, err := p1.Acquire(sha, false)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := os.Stat(s.Path()); err != nil {
		t.Fatalf("slot dir missing: %v", err)
	}
	if !worktreeRegistered(t, repo, s.Path()) {
		t.Fatal("slot worktree not registered with git")
	}

	// A new pool (fresh boot) knows nothing of the leftover slot; Clean recovers.
	p2 := newTestPool(t, repo, maxSlots)
	p2.Clean()

	if _, err := os.Stat(p2.dir); !os.IsNotExist(err) {
		t.Errorf("slots dir not removed: err=%v", err)
	}
	if worktreeRegistered(t, repo, s.Path()) {
		t.Error("dangling worktree registration not pruned")
	}
}

// TestSlotPoolCleanIgnored verifies the clean policy: an ignored file left in a
// slot by a prior run survives a default (warm-cache) reuse but is wiped when the
// next acquire requests a pristine tree (cleanIgnored=true) - which also bypasses
// the affinity shortcut so the clean actually runs.
func TestSlotPoolCleanIgnored(t *testing.T) {
	repo := initRepo(t)
	// Ignore *.cache so a generated cache file is an *ignored* untracked file -
	// the only kind `git clean -fd` keeps and `-fdx` removes.
	gitRun(t, repo, "config", "core.excludesFile", "/dev/null") // be explicit: only .gitignore
	sha := commitFile(t, repo, ".gitignore", "*.cache\n")

	p := newTestPool(t, repo, maxSlots)

	// First run: acquire, drop an ignored cache file into the slot, release.
	s, err := p.Acquire(sha, false)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	cache := filepath.Join(s.Path(), "dep.cache")
	if err := os.WriteFile(cache, []byte("warm"), 0o644); err != nil {
		t.Fatal(err)
	}
	p.Release(s)

	// Default reuse (warm cache): affinity hit, no clean - the ignored file survives.
	s2, err := p.Acquire(sha, false)
	if err != nil {
		t.Fatalf("warm acquire: %v", err)
	}
	if _, err := os.Stat(cache); err != nil {
		t.Errorf("default reuse should keep ignored cache, but it was removed: %v", err)
	}
	p.Release(s2)

	// Pristine reuse: cleanIgnored skips affinity and runs `git clean -fdx`, so the
	// ignored file is wiped.
	s3, err := p.Acquire(sha, true)
	if err != nil {
		t.Fatalf("pristine acquire: %v", err)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Errorf("pristine reuse should remove ignored cache, but it remains: err=%v", err)
	}
	p.Release(s3)
}

// TestSlotsForConcurrency pins the sizing bridge between a consumer's generation
// concurrency and its pool cap: at least the warm-slot floor, always at least
// concurrency+2, and unbounded for unlimited concurrency.
func TestSlotsForConcurrency(t *testing.T) {
	cases := []struct{ concurrency, want int }{
		{0, 0}, // unlimited concurrency -> unbounded pool
		{-1, 0},
		{1, maxSlots},
		{2, maxSlots}, // floor wins: 2+2 == 4
		{3, 5},
		{8, 10},
	}
	for _, c := range cases {
		if got := SlotsForConcurrency(c.concurrency); got != c.want {
			t.Errorf("SlotsForConcurrency(%d) = %d, want %d", c.concurrency, got, c.want)
		}
	}
}

func readMarker(t *testing.T, slotPath string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(slotPath, "marker.txt"))
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	return string(b)
}

func worktreeRegistered(t *testing.T, repo, path string) bool {
	t.Helper()
	out, err := exec.Command("git", "-C", repo, "worktree", "list", "--porcelain").Output()
	if err != nil {
		t.Fatalf("worktree list: %v", err)
	}
	return strings.Contains(string(out), path)
}
