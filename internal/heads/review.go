package heads

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/mcpserver"
	"github.com/trolleyman/hydra/internal/paths"
)

// WriteReviewSnapshot writes the per-head review file the in-sandbox `hydra mcp`
// server reads for get_review_status / get_review_comments (the MR link, its
// cached forge state and its unresolved discussions).
//
// Two writers share it: the MR lifecycle watcher on every poll, and the spawn of
// an ADOPTED head - which writes it before the agent launches, so a head spawned
// onto an existing PR can read its review comments from its very first tool call
// instead of seeing "not linked" until the watcher's first tick
// (docs/pr-adoption.md).
func WriteReviewSnapshot(projectRoot, id string, rf mcpserver.ReviewFile) error {
	data, err := json.Marshal(rf)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if err := paths.EnsureHydraLocalIgnored(paths.GetReviewDirFromProjectRoot(projectRoot)); err != nil {
		return errtrace.Wrap(err)
	}
	// Truncate-in-place (not write-and-rename): the file is bind-mounted into the
	// head's sandbox by inode, so replacing it would leave the agent reading the
	// old one forever.
	path := paths.GetReviewJsonFromProjectRoot(projectRoot, id)
	return errtrace.Wrap(os.WriteFile(path, data, 0644))
}

// adoptedPrePromptNote is the standing instruction appended to an adopted head's
// system prompt, so the agent knows it is sitting on someone else's PR and where
// to read its review comments. `gh`/`glab` are unauthenticated inside the sandbox
// (all forge calls run host-side in the daemon), so pointing the agent at the MCP
// tools up front saves it a dead end.
func adoptedPrePromptNote(a AdoptSpec) string {
	var b strings.Builder
	b.WriteString("\n\nThis head was spawned on an EXISTING pull/merge request - you are working on someone else's PR, not a fresh branch:\n")
	fmt.Fprintf(&b, "- %s (#%s on %s), targeting `%s`.\n", a.ReviewURL, a.ReviewID, a.Provider, a.TargetBranch)
	b.WriteString("- Your worktree starts at the PR head, so the diff is the whole PR plus your own edits.\n")
	b.WriteString("- Read its review comments with the `mcp__hydra__get_review_comments` and `mcp__hydra__get_review_status` tools. `gh`/`glab` are NOT authenticated inside the sandbox - those tools are the only way to reach the forge. Hydra refreshes them every ~30s, so re-run them after a push if you are waiting on new feedback.\n")
	if a.CanPush {
		b.WriteString("- Commit as usual; the user pushes your commits back to the PR from Hydra's UI.\n")
	} else {
		b.WriteString("- This PR is READ-ONLY for us (its author has not enabled maintainer edits), so commits cannot be pushed back to it. Say so if you are asked to push.\n")
	}
	return b.String()
}
