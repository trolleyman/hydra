package forge

import (
	"context"
	"fmt"

	"braces.dev/errtrace"
)

// SubmitGraphite tracks branch with parent and submits it through Graphite.
// Graphite remains a GitHub publication layer, so status, comments, and merge
// lifecycle continue through githubProvider after this returns.
func SubmitGraphite(ctx context.Context, worktree, branch, parent string, draft bool) error {
	if !cliAvailable("gt") {
		return errtrace.Wrap(&NotConfiguredError{Detail: "Graphite CLI `gt` not found on PATH - install it, run `gt auth`, and initialize this repository with `gt repo init`"})
	}
	return errtrace.Wrap(submitGraphite(ctx, worktree, branch, parent, draft, execRunner))
}

func submitGraphite(ctx context.Context, worktree, branch, parent string, draft bool, run runner) error {
	if worktree == "" {
		return errtrace.Wrap(fmt.Errorf("Graphite publishing requires the head worktree"))
	}
	// An info success means the branch is already tracked. Otherwise track it
	// explicitly against Hydra's BaseBranch, which is also the local stack edge.
	if _, err := run(ctx, worktree, "gt", "--no-interactive", "branch", "info", branch); err != nil {
		args := []string{"--no-interactive", "branch", "track", branch}
		if parent != "" {
			args = append(args, "--parent", parent)
		}
		if _, err := run(ctx, worktree, "gt", args...); err != nil {
			return errtrace.Wrap(fmt.Errorf("track Graphite branch %q on %q: %w", branch, parent, err))
		}
	}
	args := []string{"--no-interactive", "submit", "--no-edit", "--branch", branch}
	if draft {
		args = append(args, "--draft")
	}
	if _, err := run(ctx, worktree, "gt", args...); err != nil {
		return errtrace.Wrap(fmt.Errorf("submit Graphite branch %q: %w", branch, err))
	}
	return nil
}
