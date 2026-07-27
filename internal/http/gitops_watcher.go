package http

import (
	"context"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
	"github.com/trolleyman/hydra/internal/paths"
)

// gitopsPollInterval is how often the daemon drains pending host-mediated git
// requests. They're interactive (an agent is blocked waiting), so this is far
// tighter than the review watcher's 30s; it only does a cheap readdir per project
// when no head has a request pending.
const gitopsPollInterval = 1 * time.Second

// RunGitopsWatcher performs git write-operations (commit/reset/revert/add/rebase/
// cherry-pick) on behalf of sandboxed heads whose git_isolation is readonly,
// where .git is read-only in the sandbox and the in-sandbox git tools can't write
// it. Each tool drops a request into the head's gitops dir
// (.hydra/local/gitops/<id>); this loop runs it host-side against the real
// writable .git - through the same own-branch guard as in-sandbox - and writes
// the result back. Heads that aren't host-mediated have no gitops dir, so they
// cost nothing here. Iterates all projects, like the other daemon loops.
func (s *Server) RunGitopsWatcher(ctx context.Context, roots func() []string) {
	t := time.NewTicker(gitopsPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, root := range roots() {
				s.drainGitopsRequests(root)
			}
		}
	}
}

// drainGitopsRequests processes every pending git-op request under projectRoot.
func (s *Server) drainGitopsRequests(projectRoot string) {
	entries, err := os.ReadDir(paths.GetGitopsRootDir(projectRoot))
	if err != nil {
		return // no gitops dir (no host-mediated heads here) - nothing to do
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		dir := paths.GetGitopsDir(projectRoot, id)
		reqs, err := gitq.ListRequests(dir)
		if err != nil || len(reqs) == 0 {
			continue
		}
		// The head's worktree + its own branch. RunGuardedOp re-checks that the
		// worktree is on this branch, so an op can never touch main or a sibling.
		worktree := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
		branch := git.BranchName(id)
		var changed bool
		for _, r := range reqs {
			ok, summary := git.RunGuardedOp(worktree, branch, r)
			if err := gitq.WriteResult(dir, r.ReqID, gitq.Result{OK: ok, Message: summary}); err != nil {
				continue
			}
			changed = changed || ok
		}
		if changed {
			// A history change alters the head's diff/verdict; nudge the UI to refresh.
			s.notifyAgentsChanged(projectRoot, false)
		}
	}
}
