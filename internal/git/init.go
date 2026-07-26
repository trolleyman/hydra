package git

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
)

// InitRepo initialises a git repository at dir, creating dir (and any missing
// parents) first. It is a no-op when dir already holds a repository, so callers
// can invoke it unconditionally on every boot.
func InitRepo(dir string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create repo dir: %w", err))
	}
	if IsRepo(dir) {
		return nil
	}
	if out, err := exec.Command("git", "init", "-q", dir).CombinedOutput(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git init: %w: %s", err, strings.TrimSpace(string(out))))
	}
	return nil
}

// IsRepo reports whether dir is inside a git working tree.
func IsRepo(dir string) bool {
	out, err := gitOutput(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

// HasCommits reports whether dir's repository has a resolvable HEAD. A freshly
// initialised repo has an *unborn* HEAD, which `git worktree add` cannot branch
// from - so a Hydra-created repo needs an initial commit before it can host any
// heads.
func HasCommits(dir string) bool {
	return exec.Command("git", "-C", dir, "rev-parse", "--verify", "--quiet", "HEAD").Run() == nil
}

// CommitAll stages everything under dir and commits it with the given message.
//
// Unlike CommitFiles, the Hydra identity is only a *fallback*: it is applied
// when the host has no user.email configured, and skipped otherwise so the
// user's own name lands on commits in a repo they will go on to write in.
func CommitAll(dir, message string) error {
	if strings.TrimSpace(message) == "" {
		return errtrace.Wrap(fmt.Errorf("commit message must not be empty"))
	}
	if _, err := gitOutput(dir, "add", "-A"); err != nil {
		return errtrace.Wrap(err)
	}
	cmd := exec.Command("git", "-C", dir, "commit", "-q", "-m", message)
	if !hasGitIdentity(dir) {
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Hydra",
			"GIT_AUTHOR_EMAIL=hydra@trolleyman.org",
			"GIT_COMMITTER_NAME=Hydra",
			"GIT_COMMITTER_EMAIL=hydra@trolleyman.org",
		)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git commit: %w: %s", err, strings.TrimSpace(string(out))))
	}
	return nil
}

// hasGitIdentity reports whether a committer identity is resolvable for dir.
func hasGitIdentity(dir string) bool {
	email, err := gitOutput(dir, "config", "--get", "user.email")
	return err == nil && strings.TrimSpace(email) != ""
}
