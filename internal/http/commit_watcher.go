package http

import (
	"context"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/commitq"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// commitPollInterval is how often the daemon drains pending host-mediated commit
// requests. Commits are interactive (an agent is blocked waiting), so this is
// far tighter than the review watcher's 30s; it only does a cheap readdir per
// project when no head has a request pending.
const commitPollInterval = 1 * time.Second

// RunCommitWatcher performs commits on behalf of sandboxed heads whose
// git_isolation locks refs (refs/readonly), where an in-sandbox commit can't
// update a ref. The in-sandbox git_commit tool drops a request into the head's
// commitq dir (.hydra/local/commits/<id>); this loop runs the commit host-side
// against the real writable .git and writes the result back. Heads that aren't
// host-mediated have no commit dir, so they cost nothing here. Iterates all
// projects, like the other daemon background loops.
func (s *Server) RunCommitWatcher(ctx context.Context, roots func() []string) {
	t := time.NewTicker(commitPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, root := range roots() {
				s.drainCommitRequests(root)
			}
		}
	}
}

// drainCommitRequests processes every pending commit request under projectRoot.
func (s *Server) drainCommitRequests(projectRoot string) {
	entries, err := os.ReadDir(paths.GetCommitsDirFromProjectRoot(projectRoot))
	if err != nil {
		return // no commits dir (no host-mediated heads here) - nothing to do
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		dir := paths.GetCommitDirFromProjectRoot(projectRoot, id)
		reqs, err := commitq.ListRequests(dir)
		if err != nil || len(reqs) == 0 {
			continue
		}
		// The head's worktree + its own branch. GuardedCommit re-checks that the
		// worktree is actually on this branch, so a commit can never land elsewhere.
		worktree := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
		branch := git.BranchName(id)
		var committed bool
		for _, r := range reqs {
			ok, summary := git.GuardedCommit(worktree, branch, r.Message, r.Paths, r.Amend)
			if err := commitq.WriteResult(dir, r.ReqID, commitq.Result{OK: ok, Message: summary}); err != nil {
				continue
			}
			committed = committed || ok
		}
		if committed {
			// A new commit changes the head's diff/verdict; nudge the UI to refresh.
			s.notifyAgentsChanged(projectRoot, false)
		}
	}
}
