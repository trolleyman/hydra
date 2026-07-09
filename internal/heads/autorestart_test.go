package heads

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// The budget is a sliding window: autoRestartBurst restarts per
// autoRestartWindow, with denied attempts not consuming budget and old
// attempts aging out.
func TestRestartHistoryAllow(t *testing.T) {
	h := &restartHistory{byHead: map[string][]time.Time{}}
	base := time.Now()

	for i := range autoRestartBurst {
		if !h.allow("a", base.Add(time.Duration(i)*time.Second)) {
			t.Fatalf("restart %d should be allowed", i+1)
		}
	}
	if h.allow("a", base.Add(3*time.Second)) {
		t.Fatal("4th restart inside the window should be denied")
	}
	// Another head has its own budget.
	if !h.allow("b", base.Add(3*time.Second)) {
		t.Fatal("a different head should not share the budget")
	}
	// Once the earliest restarts age out, the head may restart again.
	if !h.allow("a", base.Add(autoRestartWindow+time.Second)) {
		t.Fatal("restart after the window should be allowed again")
	}
}

// restartCapture swaps the resume seam for a recorder.
type restartCapture struct {
	mu    sync.Mutex
	calls []Head
}

func captureRestarts(t *testing.T) *restartCapture {
	t.Helper()
	c := &restartCapture{}
	prev := autoRestartResume
	prevDelay := autoRestartDelay
	autoRestartDelay = 10 * time.Millisecond
	autoRestartResume = func(_ *session.Registry, _ *db.Store, _ string, head Head, _, _ uint16) error {
		c.mu.Lock()
		c.calls = append(c.calls, head)
		c.mu.Unlock()
		return nil
	}
	t.Cleanup(func() {
		autoRestartResume = prev
		autoRestartDelay = prevDelay
	})
	return c
}

func (c *restartCapture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.calls)
}

// autoRestartFixture builds a store with one agent row (and its worktree dir,
// so ListHeads reports a resumable head).
func autoRestartFixture(t *testing.T, id string) (*session.Registry, *db.Store, string) {
	t.Helper()
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.CreateAgent(&db.Agent{ID: id, ProjectPath: root, AgentType: "claude"}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(paths.GetWorktreesDirFromProjectRoot(root), id), 0o755); err != nil {
		t.Fatalf("mkdir worktree: %v", err)
	}
	return session.NewRegistry(), store, root
}

func waitForRestarts(t *testing.T, c *restartCapture, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.count() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected %d restarts, got %d", want, c.count())
}

func TestMaybeAutoRestartHead(t *testing.T) {
	t.Run("unexpected exit restarts", func(t *testing.T) {
		reg, store, root := autoRestartFixture(t, "head-restart")
		c := captureRestarts(t)
		MaybeAutoRestartHead(reg, store, session.Info{ID: "head-restart"})
		waitForRestarts(t, c, 1)
		c.mu.Lock()
		head := c.calls[0]
		c.mu.Unlock()
		if head.ID != "head-restart" || head.ProjectPath != root || head.Worktree == nil {
			t.Fatalf("restarted with wrong head: %+v", head)
		}
	})

	t.Run("requested stop does not restart", func(t *testing.T) {
		reg, store, _ := autoRestartFixture(t, "head-stopped")
		c := captureRestarts(t)
		MaybeAutoRestartHead(reg, store, session.Info{ID: "head-stopped", StopRequested: true})
		MaybeAutoRestartHead(reg, store, session.Info{ID: "head-stopped", Ephemeral: true})
		time.Sleep(100 * time.Millisecond)
		if c.count() != 0 {
			t.Fatalf("expected no restarts, got %d", c.count())
		}
	})

	t.Run("unknown head does not restart", func(t *testing.T) {
		reg, store, _ := autoRestartFixture(t, "head-other")
		c := captureRestarts(t)
		MaybeAutoRestartHead(reg, store, session.Info{ID: "no-such-head"})
		time.Sleep(100 * time.Millisecond)
		if c.count() != 0 {
			t.Fatalf("expected no restarts, got %d", c.count())
		}
	})

	t.Run("crash loop is capped", func(t *testing.T) {
		reg, store, _ := autoRestartFixture(t, "head-loop")
		c := captureRestarts(t)
		for range autoRestartBurst + 2 {
			MaybeAutoRestartHead(reg, store, session.Info{ID: "head-loop"})
		}
		waitForRestarts(t, c, autoRestartBurst)
		time.Sleep(150 * time.Millisecond)
		if c.count() != autoRestartBurst {
			t.Fatalf("expected exactly %d restarts, got %d", autoRestartBurst, c.count())
		}
	})
}
