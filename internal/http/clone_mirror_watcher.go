package http

import (
	"context"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// cloneMirrorInterval is how often the daemon mirrors clone-mode heads' branches
// back into the main repo. A commit in a clone head is invisible to main (its own
// .git) until fetched, and diffs/tests/artifacts read the branch from main, so
// this keeps main within one tick of the head. Merge does its own synchronous
// mirror (heads.MirrorCloneHead) since it can't tolerate the lag.
const cloneMirrorInterval = 1 * time.Second

// RunCloneMirrorWatcher fetches each git_isolation=clone head's branch from its
// standalone worktree into the main repo (MirrorCloneBranch), so the head's
// commits show up in diffs, tests and merge. It scans the per-project worktrees
// dir and no-ops on linked worktrees (shared .git - already visible in main) and
// when a head's tip already matches main's, so a project with no clone heads costs
// only a readdir per tick. Iterates all projects, like the other daemon loops.
func (s *Server) RunCloneMirrorWatcher(ctx context.Context, roots func() []string) {
	t := time.NewTicker(cloneMirrorInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, root := range roots() {
				mirrorCloneHeads(root)
			}
		}
	}
}

// mirrorCloneHeads mirrors every clone-mode head worktree under projectRoot.
func mirrorCloneHeads(projectRoot string) {
	entries, err := os.ReadDir(paths.GetWorktreesDirFromProjectRoot(projectRoot))
	if err != nil {
		return // no worktrees dir yet
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		wt := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
		// MirrorCloneBranch itself skips linked worktrees and already-current tips.
		_ = git.MirrorCloneBranch(projectRoot, wt, git.BranchName(id))
	}
}
