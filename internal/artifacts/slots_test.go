package artifacts

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

func newTestPool(t *testing.T, repo string, max int) *slotPool {
	t.Helper()
	return newSlotPool(repo, filepath.Join(repo, ".hydra", "local", "artifacts", "slots"), max)
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
	s1, err := p.acquire(shaA)
	if err != nil {
		t.Fatalf("acquire A: %v", err)
	}
	if got := readMarker(t, s1.path); got != "A" {
		t.Fatalf("slot content = %q, want A", got)
	}
	if len(p.all) != 1 {
		t.Fatalf("len(all) = %d, want 1", len(p.all))
	}
	p.release(s1)

	// 2. Re-acquire the same SHA → affinity hit: same slot, no new slot.
	s2, err := p.acquire(shaA)
	if err != nil {
		t.Fatalf("re-acquire A: %v", err)
	}
	if s2 != s1 {
		t.Errorf("affinity miss: got a different slot for the same SHA")
	}
	if len(p.all) != 1 {
		t.Errorf("affinity created a new slot: len(all) = %d", len(p.all))
	}
	p.release(s2)

	// 3. Acquire a different SHA → reuse the slot via incremental checkout, no growth.
	s3, err := p.acquire(shaB)
	if err != nil {
		t.Fatalf("acquire B: %v", err)
	}
	if s3 != s1 {
		t.Errorf("expected slot reuse, got a new slot")
	}
	if len(p.all) != 1 {
		t.Errorf("checkout grew the pool: len(all) = %d", len(p.all))
	}
	if got := readMarker(t, s3.path); got != "B" {
		t.Errorf("slot content after checkout = %q, want B", got)
	}
	p.release(s3)
}

// TestSlotPoolCap verifies the pool never exceeds its cap and that a blocked
// acquire unblocks once a slot is released.
func TestSlotPoolCap(t *testing.T) {
	repo := initRepo(t)
	sha := commitFile(t, repo, "marker.txt", "A")

	p := newTestPool(t, repo, 2)

	// Hold both slots (same SHA, none free, so each forces a create up to the cap).
	a, err := p.acquire(sha)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	b, err := p.acquire(sha)
	if err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	if len(p.all) != 2 {
		t.Fatalf("len(all) = %d, want 2", len(p.all))
	}

	// A third acquire must block until a slot is released.
	got := make(chan *slot, 1)
	go func() {
		s, err := p.acquire(sha)
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

	p.release(a)
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
	p.release(b)
}

// TestSlotPoolCleanCrashRecovery simulates a crash: slot worktrees exist on disk
// and are registered with git, but a fresh pool (empty in-memory state, as on
// boot) has no record of them. clean() must still wipe the dirs and prune the
// dangling git worktree registrations.
func TestSlotPoolCleanCrashRecovery(t *testing.T) {
	repo := initRepo(t)
	sha := commitFile(t, repo, "marker.txt", "A")

	// First pool creates a slot, then we drop the pool WITHOUT cleaning — mimicking
	// a process that died mid-generation, leaving a registered worktree behind.
	p1 := newTestPool(t, repo, maxSlots)
	s, err := p1.acquire(sha)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := os.Stat(s.path); err != nil {
		t.Fatalf("slot dir missing: %v", err)
	}
	if !worktreeRegistered(t, repo, s.path) {
		t.Fatal("slot worktree not registered with git")
	}

	// A new pool (fresh boot) knows nothing of the leftover slot; clean() recovers.
	p2 := newTestPool(t, repo, maxSlots)
	p2.clean()

	if _, err := os.Stat(p2.dir); !os.IsNotExist(err) {
		t.Errorf("slots dir not removed: err=%v", err)
	}
	if worktreeRegistered(t, repo, s.path) {
		t.Error("dangling worktree registration not pruned")
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
