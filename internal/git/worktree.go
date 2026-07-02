package git

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/common"
	"github.com/trolleyman/hydra/internal/paths"
)

// ValidateRef checks that a git ref name cannot be mistaken for a command-line
// flag, which would allow option injection into git even when using exec.Command
// with separate arguments.
func ValidateRef(ref string) error {
	if ref == "" {
		return errtrace.Wrap(fmt.Errorf("empty ref name"))
	}
	if strings.HasPrefix(ref, "-") {
		return errtrace.Wrap(fmt.Errorf("invalid ref name %q: must not start with '-'", ref))
	}
	return nil
}

// GetCurrentBranch returns the name of the currently checked-out branch.
// Returns the commit hash if in detached HEAD state.
func GetCurrentBranch(projectRoot string) (string, error) {
	return errtrace.Wrap2(gitOutput(projectRoot, "rev-parse", "--abbrev-ref", "HEAD"))
}

// ListHydraBranches returns all branches matching hydra/*.
func ListHydraBranches(projectRoot string) ([]string, error) {
	out, err := gitOutput(projectRoot, "branch", "--list", "hydra/*", "--format=%(refname:short)")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var branches []string
	for _, b := range strings.Split(out, "\n") {
		if b != "" {
			branches = append(branches, b)
		}
	}
	return branches, nil
}

// ListBranches returns all local branch names, sorted by most recent commit
// first (`git branch --sort=-committerdate`).
func ListBranches(projectRoot string) ([]string, error) {
	out, err := gitOutput(projectRoot, "branch", "--sort=-committerdate", "--format=%(refname:short)")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var branches []string
	for _, b := range strings.Split(out, "\n") {
		if b != "" {
			branches = append(branches, b)
		}
	}
	return branches, nil
}

// CreateWorktree runs `git worktree add -b <branchName> <path> <baseBranch>`.
func CreateWorktree(projectRoot, worktreePath, branchName, baseBranch string) error {
	if err := ValidateRef(branchName); err != nil {
		return errtrace.Wrap(fmt.Errorf("branch name: %w", err))
	}
	if err := ValidateRef(baseBranch); err != nil {
		return errtrace.Wrap(fmt.Errorf("base branch: %w", err))
	}
	worktreesDir := filepath.Dir(worktreePath)
	if err := paths.CreateGitignoreAllInDir(worktreesDir); err != nil {
		return errtrace.Wrap(err)
	}

	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "add", "-b", branchName, worktreePath, baseBranch)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree add: %w", err))
	}
	return nil
}

// ResolveRef resolves a commit-ish ref to its full commit SHA.
func ResolveRef(projectRoot, ref string) (string, error) {
	if err := ValidateRef(ref); err != nil {
		return "", errtrace.Wrap(err)
	}
	return errtrace.Wrap2(gitOutput(projectRoot, "rev-parse", ref+"^{commit}"))
}

// ShowFile returns the contents of a repo-relative path as it exists at ref
// (`git show ref:path`). It returns (nil, nil) when the path does not exist at
// that ref, so callers can distinguish "absent" from a genuine git error.
func ShowFile(projectRoot, ref, path string) ([]byte, error) {
	if err := ValidateRef(ref); err != nil {
		return nil, errtrace.Wrap(err)
	}
	out, err := exec.Command("git", "-C", projectRoot, "show", ref+":"+path).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr := string(exitErr.Stderr)
			// git reports a path missing from the tree (vs only present on disk) as
			// one of these; both mean "absent at this ref", not a real failure.
			if strings.Contains(stderr, "does not exist") ||
				strings.Contains(stderr, "exists on disk, but not in") {
				return nil, nil
			}
			return nil, errtrace.Wrap(fmt.Errorf("git show %s:%s: %w: %s", ref, path, err, stderr))
		}
		return nil, errtrace.Wrap(err)
	}
	return out, nil
}

// LsTreeEntryMode returns the git tree mode of the entry at p under ref —
// "100644"/"100755" for a regular/executable file, "120000" for a symbolic
// link, "040000" for a directory — or "" when no entry exists at that path.
// The "--" guards p against being read as a git option.
func LsTreeEntryMode(projectRoot, ref, p string) (string, error) {
	if err := ValidateRef(ref); err != nil {
		return "", errtrace.Wrap(err)
	}
	out, err := gitOutput(projectRoot, "ls-tree", ref, "--", p)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if out == "" {
		return "", nil
	}
	// Format: "<mode> <type> <object>\t<path>"; the mode is the first field.
	mode, _, ok := strings.Cut(out, " ")
	if !ok {
		return "", nil
	}
	return mode, nil
}

// ListTreeFiles returns the repo-relative paths of every file tracked at ref
// (`git ls-tree -r --name-only <ref>`), sorted by git's default ordering. Paths
// use forward slashes regardless of platform.
func ListTreeFiles(projectRoot, ref string) ([]string, error) {
	if err := ValidateRef(ref); err != nil {
		return nil, errtrace.Wrap(err)
	}
	out, err := gitOutput(projectRoot, "ls-tree", "-r", "--name-only", ref)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if out == "" {
		return nil, nil
	}
	return strings.Split(out, "\n"), nil
}

// AddDetachedWorktree checks out ref into a new detached-HEAD worktree at path.
// The parent directory is created and marked gitignored. Use RemoveWorktree to
// clean it up afterwards.
func AddDetachedWorktree(projectRoot, worktreePath, ref string) error {
	if err := ValidateRef(ref); err != nil {
		return errtrace.Wrap(fmt.Errorf("ref: %w", err))
	}
	if err := paths.CreateGitignoreAllInDir(filepath.Dir(worktreePath)); err != nil {
		return errtrace.Wrap(err)
	}
	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "add", "--detach", worktreePath, ref)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree add --detach: %w", err))
	}
	return nil
}

// AddWorktreeForBranch runs `git worktree add <path> <branch>`, checking out an
// EXISTING branch (no -b) so that commits made in the worktree advance that
// branch. It is used to merge into a base branch that is not currently checked
// out anywhere; pair it with RemoveWorktree once done. Fails if the branch is
// already checked out in another worktree (git's own guard).
func AddWorktreeForBranch(projectRoot, worktreePath, branch string) error {
	if err := ValidateRef(branch); err != nil {
		return errtrace.Wrap(fmt.Errorf("branch: %w", err))
	}
	if err := paths.CreateGitignoreAllInDir(filepath.Dir(worktreePath)); err != nil {
		return errtrace.Wrap(err)
	}
	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "add", worktreePath, branch)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree add: %w", err))
	}
	return nil
}

// CheckoutDetached switches an existing worktree to ref in detached-HEAD state,
// discarding any tracked local changes (`git checkout --detach --force`). Only
// files that differ between the worktree's current commit and ref are rewritten,
// so switching between nearby commits is far cheaper than recreating the worktree
// from scratch. It does NOT remove untracked/ignored files — pair it with
// CleanWorktree when reusing a worktree across refs.
func CheckoutDetached(worktreeDir, ref string) error {
	if err := ValidateRef(ref); err != nil {
		return errtrace.Wrap(fmt.Errorf("ref: %w", err))
	}
	cmd := exec.Command("git", "-C", worktreeDir, "checkout", "--detach", "--force", ref)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git checkout --detach: %w", err))
	}
	return nil
}

// CleanWorktree removes untracked files and directories from a worktree
// (`git clean -fd`). By default it LEAVES git-ignored files in place — so a reused
// checkout keeps warm dependency/build caches (e.g. node_modules) rather than
// re-fetching them on every ref switch. When includeIgnored is true it adds `-x`
// (`git clean -fdx`), wiping ignored files too for a fully pristine tree — slower,
// but safe against stale ignored output leaking between commits.
func CleanWorktree(worktreeDir string, includeIgnored bool) error {
	args := []string{"-C", worktreeDir, "clean", "-fd"}
	if includeIgnored {
		args = append(args, "-x")
	}
	cmd := exec.Command("git", args...)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git clean: %w", err))
	}
	return nil
}

// PruneWorktrees runs `git worktree prune`, dropping the admin entries git keeps
// for worktree directories that no longer exist on disk (e.g. ones removed by a
// crash or an external `rm -rf`). Best-effort cleanup, safe to call on boot.
func PruneWorktrees(projectRoot string) error {
	_, err := gitOutput(projectRoot, "worktree", "prune")
	return errtrace.Wrap(err)
}

// WorktreeStateHash returns a hex digest that changes whenever the working-tree
// content of dir changes: it folds in HEAD, the porcelain status, the tracked
// diff against HEAD, and the names+sizes of untracked files.
func WorktreeStateHash(dir string) (string, error) {
	h := sha256.New()
	add := func(label, s string) {
		_, _ = io.WriteString(h, label)
		_, _ = io.WriteString(h, "\x00")
		_, _ = io.WriteString(h, s)
		_, _ = io.WriteString(h, "\x00")
	}

	head, err := gitOutput(dir, "rev-parse", "HEAD")
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	add("head", head)

	status, err := gitOutput(dir, "status", "--porcelain=v1")
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	add("status", status)

	// Tracked changes (staged + unstaged) relative to HEAD.
	diff, err := gitOutput(dir, "diff", "HEAD")
	if err == nil {
		add("diff", diff)
	}

	// Untracked files: fold in name + size so new/edited untracked files bust the cache.
	others, err := gitOutput(dir, "ls-files", "--others", "--exclude-standard")
	if err == nil {
		for _, p := range strings.Split(others, "\n") {
			if p == "" {
				continue
			}
			size := int64(-1)
			if fi, err := os.Stat(filepath.Join(dir, p)); err == nil {
				size = fi.Size()
			}
			add("untracked", fmt.Sprintf("%s:%d", p, size))
		}
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

// GetCommonDir returns the absolute path to the repository's shared git
// directory — the main repo's `.git`, where the index, refs, objects and logs
// for every linked worktree actually live. The sandbox must bind this writable
// for an agent to `git commit` from its worktree.
func GetCommonDir(projectRoot string) (string, error) {
	// --path-format=absolute (git 2.31+) gives an absolute path directly.
	out, err := gitOutput(projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err == nil && filepath.IsAbs(out) {
		return out, nil
	}
	// Fallback for older git: --git-common-dir may be relative to projectRoot.
	out, err = gitOutput(projectRoot, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if !filepath.IsAbs(out) {
		out = filepath.Join(projectRoot, out)
	}
	return out, nil
}

// RemoveWorktree runs `git worktree remove --force <path>`.
func RemoveWorktree(projectRoot, worktreePath string) error {
	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "remove", "--force", worktreePath)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree remove: %w", err))
	}
	return nil
}

// DeleteBranch deletes a git branch.
func DeleteBranch(projectRoot, branchName string) error {
	if err := ValidateRef(branchName); err != nil {
		return errtrace.Wrap(fmt.Errorf("branch name: %w", err))
	}
	_, err := gitOutput(projectRoot, "branch", "-D", branchName)
	return errtrace.Wrap(err)
}
