package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/common"
	"github.com/trolleyman/hydra/internal/paths"
)

// CreateCloneWorktree creates a head's worktree as a standalone `git clone
// --shared` of the main repo - its OWN .git that borrows the main repo's objects
// read-only via objects/info/alternates - checked out on a fresh branchName based
// on baseBranch. Used for git_isolation=clone (GIT_ISOLATION.md): the agent gets
// full native git in an isolated repo, so a rogue agent can only damage its own
// private object store, never the main repo's history or a sibling head. The head
// branch is mirrored back into the main repo (MirrorCloneBranch) so the rest of
// Hydra - diffs, merge, tests, artifacts - keeps seeing refs/heads/<branchName>.
func CreateCloneWorktree(projectRoot, worktreePath, branchName, baseBranch string) error {
	if err := ValidateRef(branchName); err != nil {
		return errtrace.Wrap(fmt.Errorf("branch name: %w", err))
	}
	if err := ValidateRef(baseBranch); err != nil {
		return errtrace.Wrap(fmt.Errorf("base branch: %w", err))
	}
	if err := paths.EnsureHydraLocalIgnored(filepath.Dir(worktreePath)); err != nil {
		return errtrace.Wrap(err)
	}
	// Resolve the base to a commit in the MAIN repo; the clone borrows that commit's
	// objects through its alternate, so we can check the branch out from the SHA
	// without depending on how `git clone` names the base branch locally.
	baseSHA, err := ResolveRef(projectRoot, baseBranch)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("resolve base %q: %w", baseBranch, err))
	}
	// --shared: don't copy objects, borrow the main repo's via alternates.
	// --no-checkout: we create + check out the head branch ourselves below.
	clone := exec.Command("git", "clone", "--shared", "--no-checkout", projectRoot, worktreePath)
	common.PrintExecCmd(clone)
	clone.Stdout = os.Stdout
	clone.Stderr = os.Stderr
	if err := clone.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git clone --shared: %w", err))
	}
	// Create + check out the head branch at the base commit (objects borrowed).
	co := exec.Command("git", "-C", worktreePath, "checkout", "-b", branchName, baseSHA)
	common.PrintExecCmd(co)
	co.Stdout = os.Stdout
	co.Stderr = os.Stderr
	if err := co.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git checkout -b %q: %w", branchName, err))
	}
	// Establish the mirror ref in the main repo so existence/diff checks resolve
	// refs/heads/<branchName> even before the first commit.
	if err := MirrorCloneBranch(projectRoot, worktreePath, branchName); err != nil {
		return errtrace.Wrap(fmt.Errorf("mirror new branch: %w", err))
	}
	return nil
}

// IsCloneWorktree reports whether worktreePath is a standalone clone (its .git is
// a real directory) rather than a linked git worktree (whose .git is a FILE
// holding a `gitdir:` pointer). Lets teardown and the mirror branch on the actual
// on-disk layout without threading the git_isolation mode around.
func IsCloneWorktree(worktreePath string) bool {
	fi, err := os.Stat(filepath.Join(worktreePath, ".git"))
	return err == nil && fi.IsDir()
}

// RemoveWorktreeTree removes a head's worktree for either layout: a linked
// worktree via `git worktree remove`, or a standalone clone (git_isolation=clone)
// via os.RemoveAll, since `git worktree remove` would reject a clone as "not a
// working tree of this repository".
func RemoveWorktreeTree(projectRoot, worktreePath string) error {
	if IsCloneWorktree(worktreePath) {
		return errtrace.Wrap(os.RemoveAll(worktreePath))
	}
	return errtrace.Wrap(RemoveWorktree(projectRoot, worktreePath))
}

// MirrorCloneBranch force-updates refs/heads/<branchName> in the main repo to
// match the head's standalone clone (fetching its new objects), so main's view of
// the branch - which diffs, merge, tests and artifacts all read - reflects the
// agent's latest commits. It is a no-op for a linked worktree (shared .git, so the
// branch is already live in main) and when the head repo's tip already matches
// main's, making it cheap to call on a hot path or a poll.
//
// The refspec is forced (+): the head OWNS the branch and main's copy is purely a
// mirror, so an amend/rebase in the head is honored rather than rejected.
func MirrorCloneBranch(projectRoot, worktreePath, branchName string) error {
	if !IsCloneWorktree(worktreePath) {
		return nil
	}
	if err := ValidateRef(branchName); err != nil {
		return errtrace.Wrap(err)
	}
	headTip, err := gitOutput(worktreePath, "rev-parse", "--verify", "--quiet", "refs/heads/"+branchName)
	if err != nil || headTip == "" {
		return nil // branch not created in the head repo yet
	}
	// Already mirrored? Skip the fetch (the common case on a poll).
	if mainTip, err := gitOutput(projectRoot, "rev-parse", "--verify", "--quiet", "refs/heads/"+branchName); err == nil && mainTip == headTip {
		return nil
	}
	refspec := "+refs/heads/" + branchName + ":refs/heads/" + branchName
	_, err = gitOutput(projectRoot, "fetch", "--no-tags", worktreePath, refspec)
	return errtrace.Wrap(err)
}

// FetchOrigin updates a clone worktree's remote-tracking refs from its origin (the
// main repo). A clone head's local/remote base branch is a snapshot taken at clone
// time; refreshing origin lets "update from base" merge the main repo's latest base
// (as origin/<base>). Objects mostly resolve through the clone's alternate, so this
// only moves refs and is cheap.
func FetchOrigin(worktreePath string) error {
	_, err := gitOutput(worktreePath, "fetch", "--no-tags", "origin")
	return errtrace.Wrap(err)
}
