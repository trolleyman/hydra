package git

import (
	"braces.dev/errtrace"
	"fmt"
	"os/exec"
	"strings"
)

// GuardedCommit stages and commits changes in worktree onto its OWN branch. It
// refuses unless the worktree is checked out on expectedBranch (or, when
// expectedBranch is empty, on a hydra/* branch), so a commit can never land on
// main or a sibling head's branch. paths (repo-relative) stage only those files;
// empty stages all changes (tracked + untracked, like `git add -A`). staged
// skips staging entirely and commits the index as it already stands, which is
// the only way to preserve a partial index built by GuardedAdd's line ranges -
// both other modes re-stage whole files and would silently widen the commit.
// amend rewrites the head's last commit instead of adding one.
//
// This is the single guardrail behind the mcp__hydra__git_commit tool, used both
// in-sandbox (git_isolation off) and host-side by the daemon's commit watcher
// (git_isolation readonly, where .git is read-only in the sandbox). It
// returns ok plus an agent-readable summary or error explanation.
func GuardedCommit(worktree, expectedBranch, message string, paths []string, amend, staged bool) (ok bool, summary string) {
	if worktree == "" {
		return false, "Cannot determine the worktree, so I won't commit."
	}
	if strings.TrimSpace(message) == "" {
		return false, "A non-empty commit message is required."
	}
	if staged && len(paths) > 0 {
		return false, "Pass either `staged` (commit the index as it stands) or `paths` (stage those files first), not both."
	}
	// The commit must land on this head's OWN branch, not main or a sibling head.
	cur, err := gitOutput(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || cur == "" {
		return false, "Your worktree is not on a branch (detached HEAD). Do not switch branches; check out your head's branch before committing."
	}
	switch {
	case expectedBranch != "" && cur != expectedBranch:
		return false, fmt.Sprintf("Refusing to commit: your worktree is on %q but your head's branch is %q. Do not switch branches - check out %q (or ask the user) before committing.", cur, expectedBranch, expectedBranch)
	case expectedBranch == "" && !strings.HasPrefix(cur, "hydra/"):
		return false, fmt.Sprintf("Refusing to commit: %q is not a Hydra head branch (expected hydra/*). Do not commit onto shared branches.", cur)
	}
	// Stage. `staged` skips this entirely so a partial index survives; without
	// that escape hatch the add below would re-stage whole files and quietly
	// swallow the line-range split the caller just built with GuardedAdd.
	switch {
	case staged:
		// An empty index here means the caller expected a stage that never
		// happened; git's bare "nothing to commit" does not explain that.
		if out, _ := gitOutput(worktree, "diff", "--cached", "--name-only"); strings.TrimSpace(out) == "" && !amend {
			return false, "Nothing is staged, so `staged` has nothing to commit. Stage with git_add first, or drop `staged` to commit all your changes."
		}
	case len(paths) > 0:
		if out, err := gitCombined(worktree, append([]string{"add", "--"}, paths...)...); err != nil {
			return false, "git add failed: " + firstNonEmpty(strings.TrimSpace(out), err.Error())
		}
	default:
		if out, err := gitCombined(worktree, "add", "-A"); err != nil {
			return false, "git add failed: " + firstNonEmpty(strings.TrimSpace(out), err.Error())
		}
	}
	// Commit onto the current (own) branch.
	commitArgs := []string{"commit", "-m", message}
	if amend {
		commitArgs = []string{"commit", "--amend", "-m", message}
	}
	if out, err := gitCombined(worktree, commitArgs...); err != nil {
		return false, "Commit failed: " + firstNonEmpty(strings.TrimSpace(out), err.Error())
	}
	hash, _ := gitOutput(worktree, "rev-parse", "--short", "HEAD")
	subject, _ := gitOutput(worktree, "log", "-1", "--pretty=%s")
	return true, fmt.Sprintf("Committed %s on %s: %s", hash, cur, subject)
}

// gitCombined runs `git -C dir <args>` and returns combined stdout+stderr, so a
// failure's diagnostic can be surfaced to the agent.
func gitCombined(dir string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	return string(out), errtrace.Wrap(err)
}

// firstNonEmpty returns a if non-empty, else b.
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
