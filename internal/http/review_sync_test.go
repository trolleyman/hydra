package http

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/heads"
)

// syncFixture builds a project repo with an "origin" bare remote, a head branch
// already pushed as its downstream branch, and a DB row armed for
// publish/sync-when-green. It returns the project root and a git runner scoped
// to it.
func syncFixture(t *testing.T) (projectRoot string, store *db.Store, git func(args ...string) string) {
	t.Helper()
	projectRoot = t.TempDir()
	bare := t.TempDir()

	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e",
			"GIT_TERMINAL_PROMPT=0",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git = func(args ...string) string { return run(projectRoot, args...) }

	run(bare, "init", "-q", "--bare")
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(projectRoot, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-qm", "base")
	git("remote", "add", "origin", bare)
	git("checkout", "-qb", "hydra/h1")
	if err := os.WriteFile(filepath.Join(projectRoot, "a.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("commit", "-qam", "work")
	// Publish: the local branch keeps its name, the remote gets the downstream one.
	git("push", "-q", "origin", "hydra/h1:refs/heads/feat/h1")

	var err error
	store, err = db.Open(projectRoot)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	return projectRoot, store, git
}

func armedHead(projectRoot string) heads.Head {
	branch := "hydra/h1"
	return heads.Head{
		ID: "h1", ProjectPath: projectRoot, Branch: &branch,
		DownstreamBranch: "feat/h1",
		ReviewID:         "1", ReviewURL: "https://forge/mr/1", ReviewProvider: "github",
		PublishWhenGreen: true,
	}
}

// The arm is STICKY: a linked head that pushes successfully stays armed, so the
// NEXT commit is pushed too. Before this, one push consumed the arm and every
// later commit sat there unnoticed - the whole reason sync-when-green exists.
func TestAutoPublishKeepsArmAndPushesEachCommit(t *testing.T) {
	projectRoot, store, git := syncFixture(t)
	head := armedHead(projectRoot)
	if err := store.CreateAgent(&db.Agent{ID: "h1", ProjectPath: projectRoot, PublishWhenGreen: true}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	s := &Server{DB: store}

	// Already in sync: a no-op that must not disarm and must not touch the remote.
	before := git("rev-parse", "refs/remotes/origin/feat/h1")
	s.autoPublish(context.Background(), projectRoot, head)
	if a, _ := store.GetAgent("h1"); a == nil || !a.PublishWhenGreen {
		t.Fatalf("an in-sync head must stay armed, got %+v", a)
	}
	if after := git("rev-parse", "refs/remotes/origin/feat/h1"); after != before {
		t.Errorf("in-sync head pushed anyway: %s -> %s", before, after)
	}

	// A new commit: pushed, and STILL armed afterwards.
	if err := os.WriteFile(filepath.Join(projectRoot, "a.txt"), []byte("three\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("commit", "-qam", "more work")
	local := git("rev-parse", "HEAD")
	s.autoPublish(context.Background(), projectRoot, head)
	if got := git("rev-parse", "refs/remotes/origin/feat/h1"); got != local {
		t.Errorf("remote at %s, want the new local tip %s", got, local)
	}
	if a, _ := store.GetAgent("h1"); a == nil || !a.PublishWhenGreen {
		t.Fatalf("a successful push must NOT consume the arm, got %+v", a)
	}
}

// A push that can never succeed disarms, so a broken head doesn't retry every
// 30s forever.
func TestAutoPublishDisarmsOnFailure(t *testing.T) {
	projectRoot, store, _ := syncFixture(t)
	if err := store.CreateAgent(&db.Agent{ID: "h1", ProjectPath: projectRoot, PublishWhenGreen: true}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	head := armedHead(projectRoot)
	head.DownstreamBranch = "" // linked, but there is nowhere to push it
	(&Server{DB: store}).autoPublish(context.Background(), projectRoot, head)
	if a, _ := store.GetAgent("h1"); a == nil || a.PublishWhenGreen {
		t.Errorf("a failed push must disarm, got %+v", a)
	}
}

// Pushing into a PR Hydra did not create must always be a deliberate act, so an
// adopted head is disarmed rather than auto-pushed.
func TestAutoPublishNeverTouchesAdoptedPR(t *testing.T) {
	projectRoot, store, git := syncFixture(t)
	if err := store.CreateAgent(&db.Agent{ID: "h1", ProjectPath: projectRoot, PublishWhenGreen: true}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, "a.txt"), []byte("four\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("commit", "-qam", "unpushed work")
	before := git("rev-parse", "refs/remotes/origin/feat/h1")

	head := armedHead(projectRoot)
	head.ReviewAdopted = true
	head.ReviewCanPush = true
	(&Server{DB: store}).autoPublish(context.Background(), projectRoot, head)

	if after := git("rev-parse", "refs/remotes/origin/feat/h1"); after != before {
		t.Errorf("adopted PR was pushed to: %s -> %s", before, after)
	}
	if a, _ := store.GetAgent("h1"); a == nil || a.PublishWhenGreen {
		t.Errorf("adopted head should be disarmed, got %+v", a)
	}
}
