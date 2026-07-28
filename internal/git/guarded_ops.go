package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/gitq"
)

// RunGuardedOp dispatches a gitq.Request to the matching own-branch-guarded git
// helper, run in worktree. Every op refuses unless the operation stays on the
// head's OWN branch (expectedBranch, or a hydra/* branch when empty), so a
// sandboxed agent can never rewrite main or a sibling head through these tools.
// Used both in-sandbox (git_isolation off) and host-side by the gitops watcher
// (git_isolation readonly). Returns ok plus an agent-readable summary/explanation.
func RunGuardedOp(worktree, expectedBranch string, req gitq.Request) (ok bool, summary string) {
	switch req.Op {
	case "", gitq.OpCommit:
		return GuardedCommit(worktree, expectedBranch, req.Message, req.Paths, req.Amend, req.Staged)
	case gitq.OpReset:
		return GuardedReset(worktree, expectedBranch, req.Mode, req.To, req.Unstage, req.Confirm)
	case gitq.OpRevert:
		return GuardedRevert(worktree, expectedBranch, req.Commit)
	case gitq.OpCherryPick:
		return GuardedCherryPick(worktree, expectedBranch, req.Commit)
	case gitq.OpAdd:
		return GuardedAdd(worktree, expectedBranch, req.Add)
	case gitq.OpRebase:
		return GuardedRebase(worktree, expectedBranch, req.Base, req.Plan)
	case gitq.OpRebaseContinue:
		return GuardedRebaseContinue(worktree, expectedBranch)
	case gitq.OpRebaseAbort:
		return GuardedRebaseAbort(worktree, expectedBranch)
	default:
		return false, fmt.Sprintf("Unknown git operation %q.", req.Op)
	}
}

// ensureOwnBranch verifies the worktree is checked out on the head's OWN branch
// (expectedBranch, or a hydra/* branch when expectedBranch is empty), so an
// operation can never land on main or a sibling. Returns the current branch.
func ensureOwnBranch(worktree, expectedBranch string) (cur string, ok bool, msg string) {
	if worktree == "" {
		return "", false, "Cannot determine the worktree, so I won't touch git."
	}
	cur, err := gitOutput(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || cur == "" {
		return "", false, "Your worktree is not on a branch (detached HEAD). Do not switch branches; check out your head's branch first."
	}
	switch {
	case expectedBranch != "" && cur != expectedBranch:
		return cur, false, fmt.Sprintf("Refusing: your worktree is on %q but your head's branch is %q. Do not switch branches - check out %q first.", cur, expectedBranch, expectedBranch)
	case expectedBranch == "" && !strings.HasPrefix(cur, "hydra/"):
		return cur, false, fmt.Sprintf("Refusing: %q is not a Hydra head branch (expected hydra/*). Do not operate on shared branches.", cur)
	}
	return cur, true, ""
}

// GuardedReset moves the head's own branch (soft/mixed/hard) to `to`, or unstages
// `unstage` paths (a `reset -- <paths>`, no HEAD move). A hard reset discards
// uncommitted worktree changes, so it requires confirm=true. Because the guard
// pins HEAD to the head's own branch, a reset only ever repoints that branch.
func GuardedReset(worktree, expectedBranch, mode, to string, unstage []string, confirm bool) (ok bool, summary string) {
	cur, ok, msg := ensureOwnBranch(worktree, expectedBranch)
	if !ok {
		return false, msg
	}
	if len(unstage) > 0 {
		args := append([]string{"reset", "--quiet", "HEAD", "--"}, unstage...)
		if out, err := gitCombined(worktree, args...); err != nil {
			return false, "Unstage failed: " + firstNonEmpty(strings.TrimSpace(out), err.Error())
		}
		return true, "Unstaged: " + strings.Join(unstage, ", ")
	}
	m := strings.ToLower(strings.TrimSpace(mode))
	if m == "" {
		m = "soft"
	}
	switch m {
	case "soft", "mixed", "hard":
	default:
		return false, fmt.Sprintf("reset mode %q is invalid - use soft, mixed, or hard.", mode)
	}
	if m == "hard" && !confirm {
		return false, "A hard reset discards uncommitted changes in your worktree. Pass confirm=true if you really mean it (soft/mixed keep your changes)."
	}
	target := strings.TrimSpace(to)
	if target == "" {
		target = "HEAD"
	}
	if out, err := gitCombined(worktree, "reset", "--"+m, target); err != nil {
		return false, "Reset failed: " + firstNonEmpty(strings.TrimSpace(out), err.Error())
	}
	newHash, _ := gitOutput(worktree, "rev-parse", "--short", "HEAD")
	return true, fmt.Sprintf("Reset (%s) %s to %s (%s).", m, cur, target, newHash)
}

// GuardedRevert reverts `commit` on the head's own branch, creating a new commit.
// On conflict it aborts so the branch is never left half-reverted.
func GuardedRevert(worktree, expectedBranch, commit string) (ok bool, summary string) {
	return applyOntoHead(worktree, expectedBranch, "revert", commit)
}

// GuardedCherryPick applies `commit` onto the head's own branch as a new commit.
// On conflict it aborts.
func GuardedCherryPick(worktree, expectedBranch, commit string) (ok bool, summary string) {
	return applyOntoHead(worktree, expectedBranch, "cherry-pick", commit)
}

// applyOntoHead runs `git <op> <commit>` (revert or cherry-pick) on the head's
// own branch, aborting on conflict so nothing is left half-applied.
func applyOntoHead(worktree, expectedBranch, op, commit string) (ok bool, summary string) {
	cur, ok, msg := ensureOwnBranch(worktree, expectedBranch)
	if !ok {
		return false, msg
	}
	if strings.TrimSpace(commit) == "" {
		return false, fmt.Sprintf("%s requires a commit to apply.", op)
	}
	args := []string{op}
	if op == "revert" {
		args = append(args, "--no-edit")
	}
	args = append(args, commit)
	if out, err := gitCombined(worktree, args...); err != nil {
		_, _ = gitCombined(worktree, op, "--abort") // leave the branch clean
		files, detail := summarizeConflict(firstNonEmpty(strings.TrimSpace(out), err.Error()))
		where := ""
		if len(files) > 0 {
			where = " in " + strings.Join(files, ", ")
		}
		return false, fmt.Sprintf("%s of %s hit conflicts%s and was aborted - your branch is unchanged.\n%s", op, commit, where, detail)
	}
	hash, _ := gitOutput(worktree, "rev-parse", "--short", "HEAD")
	subject, _ := gitOutput(worktree, "log", "-1", "--pretty=%s")
	return true, fmt.Sprintf("%s of %s -> new commit %s on %s: %s", op, commit, hash, cur, subject)
}

// conflictNoiseRe matches git output lines that are actively wrong once we have
// aborted the operation. Git's "hint:" block tells the reader to resolve the
// files and run `git cherry-pick --continue`, but by the time they see it the
// abort has already rolled the operation back, so there is nothing to continue -
// and raw git is gate-denied for sandboxed heads anyway. "Recorded preimage" is
// rerere bookkeeping that means nothing to the reader. Both render as
// instructions in the chat card, so they are dropped from the summary.
var conflictNoiseRe = regexp.MustCompile(`(?m)^(?:hint:.*|Recorded preimage for .*)$\n?`)

// conflictContentRe and conflictModifyDeleteRe pull the conflicting paths out of
// git's two CONFLICT spellings, so the summary can name the files up front
// instead of making the reader parse a wall of merge output.
var conflictContentRe = regexp.MustCompile(`(?m)^CONFLICT \([^)]*\): Merge conflict in (.+?)\s*$`)
var conflictModifyDeleteRe = regexp.MustCompile(`(?m)^CONFLICT \([^)]*\): (\S+) deleted in `)

// summarizeConflict returns the conflicting paths plus the git output with the
// post-abort noise stripped (see conflictNoiseRe).
func summarizeConflict(out string) (files []string, cleaned string) {
	seen := map[string]bool{}
	for _, re := range []*regexp.Regexp{conflictContentRe, conflictModifyDeleteRe} {
		for _, m := range re.FindAllStringSubmatch(out, -1) {
			if path := strings.TrimSpace(m[1]); path != "" && !seen[path] {
				seen[path] = true
				files = append(files, path)
			}
		}
	}
	return files, strings.TrimSpace(conflictNoiseRe.ReplaceAllString(out, ""))
}

// GuardedAdd stages files into the index on the head's own branch. An AddSpec
// with no Ranges stages the whole file; with Ranges it stages only the changed
// hunks that overlap those (new-file) line ranges, by applying a filtered patch
// to the index. Staging alone changes no refs; a later git_commit records it.
func GuardedAdd(worktree, expectedBranch string, specs []gitq.AddSpec) (ok bool, summary string) {
	if _, ok, msg := ensureOwnBranch(worktree, expectedBranch); !ok {
		return false, msg
	}
	if len(specs) == 0 {
		return false, "add requires at least one file."
	}
	var staged []string
	for _, s := range specs {
		if strings.TrimSpace(s.Path) == "" {
			return false, "each add entry needs a path."
		}
		if len(s.Ranges) == 0 {
			if out, err := gitCombined(worktree, "add", "--", s.Path); err != nil {
				return false, "git add failed for " + s.Path + ": " + firstNonEmpty(strings.TrimSpace(out), err.Error())
			}
			staged = append(staged, s.Path)
			continue
		}
		patch, err := buildRangePatch(worktree, s.Path, s.Ranges)
		if err != nil {
			return false, "Could not build a line-range patch for " + s.Path + ": " + err.Error()
		}
		if patch == "" {
			continue // no unstaged change overlaps the requested ranges
		}
		if err := gitApplyCached(worktree, patch); err != nil {
			return false, "Staging line ranges of " + s.Path + " failed: " + err.Error()
		}
		staged = append(staged, fmt.Sprintf("%s (lines %s)", s.Path, rangesString(s.Ranges)))
	}
	if len(staged) == 0 {
		return true, "Nothing to stage - the requested lines have no unstaged changes."
	}
	return true, "Staged: " + strings.Join(staged, ", ")
}

var hunkHeaderRe = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@`)

// buildRangePatch produces a unified diff containing only the unstaged hunks of
// `path` whose new-file lines overlap `ranges`, suitable for `git apply --cached
// --unidiff-zero`. Returns "" when nothing overlaps. Uses -U0 so each hunk is a
// minimal, independently-appliable change.
func buildRangePatch(worktree, path string, ranges [][2]int) (string, error) {
	out, err := gitStdout(worktree, "diff", "-U0", "--", path)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if strings.TrimSpace(out) == "" {
		return "", nil // no unstaged changes to this file
	}
	lines := strings.Split(out, "\n")
	// The header is every line before the first hunk (@@).
	var header []string
	i := 0
	for ; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "@@") {
			break
		}
		header = append(header, lines[i])
	}
	var kept []string
	for i < len(lines) {
		if !strings.HasPrefix(lines[i], "@@") {
			i++
			continue
		}
		start := i
		i++
		for i < len(lines) && !strings.HasPrefix(lines[i], "@@") {
			i++
		}
		hunk := lines[start:i]
		m := hunkHeaderRe.FindStringSubmatch(hunk[0])
		if m == nil {
			return "", errtrace.Wrap(fmt.Errorf("unparsable hunk header %q", hunk[0]))
		}
		ns, _ := strconv.Atoi(m[1])
		nl := 1
		if m[2] != "" {
			nl, _ = strconv.Atoi(m[2])
		}
		lo := ns
		hi := ns + max(nl, 1) - 1
		if rangesOverlap(ranges, lo, hi) {
			kept = append(kept, hunk...)
		}
	}
	if len(kept) == 0 {
		return "", nil
	}
	return strings.Join(header, "\n") + "\n" + strings.Join(kept, "\n") + "\n", nil
}

// rangesOverlap reports whether [lo,hi] intersects any inclusive [start,end] pair.
func rangesOverlap(ranges [][2]int, lo, hi int) bool {
	for _, r := range ranges {
		a, b := r[0], r[1]
		if b < a {
			a, b = b, a
		}
		if lo <= b && a <= hi {
			return true
		}
	}
	return false
}

func rangesString(ranges [][2]int) string {
	parts := make([]string, 0, len(ranges))
	for _, r := range ranges {
		if r[0] == r[1] {
			parts = append(parts, strconv.Itoa(r[0]))
		} else {
			parts = append(parts, fmt.Sprintf("%d-%d", r[0], r[1]))
		}
	}
	return strings.Join(parts, ",")
}

// gitApplyCached applies patch to the index of worktree (`git apply --cached`).
func gitApplyCached(worktree, patch string) error {
	cmd := exec.Command("git", "-C", worktree, "apply", "--cached", "--unidiff-zero", "-")
	cmd.Stdin = strings.NewReader(patch)
	if out, err := cmd.CombinedOutput(); err != nil {
		return errtrace.Wrap(fmt.Errorf("%s", firstNonEmpty(strings.TrimSpace(string(out)), err.Error())))
	}
	return nil
}

// GuardedRebase runs a non-interactive plan-based history edit of the commits
// above `base` on the head's own branch. The plan is translated into a rebase
// todo (pick/fixup/squash/drop, plus `exec git commit --amend -F` lines for
// reword / squash-with-new-message), so no interactive editor is needed. On
// conflict the rebase is LEFT in progress and the agent is told to resolve +
// git_rebase_continue (or git_rebase_abort).
func GuardedRebase(worktree, expectedBranch, base string, plan []gitq.RebaseStep) (ok bool, summary string) {
	cur, ok, msg := ensureOwnBranch(worktree, expectedBranch)
	if !ok {
		return false, msg
	}
	if strings.TrimSpace(base) == "" {
		return false, `rebase requires a base commit-ish (e.g. "HEAD~3", or the sha below the commits to edit).`
	}
	if len(plan) == 0 {
		return false, "rebase requires a non-empty plan."
	}
	if rebaseInProgress(worktree) {
		return false, "A rebase is already in progress. Finish it with git_rebase_continue, or cancel with git_rebase_abort, first."
	}
	tmp, err := os.MkdirTemp("", "hydra-rebase-")
	if err != nil {
		return false, "internal error creating a temp dir: " + err.Error()
	}
	defer os.RemoveAll(tmp)

	var todo []string
	for idx, s := range plan {
		sha := strings.TrimSpace(s.Commit)
		if sha == "" {
			return false, "each rebase step needs a commit sha."
		}
		amend := func() (bool, string) {
			p := filepath.Join(tmp, fmt.Sprintf("msg%d", idx))
			if err := os.WriteFile(p, []byte(s.Message), 0o644); err != nil {
				return false, ""
			}
			return true, "exec git commit --amend -F " + shellSingleQuote(p)
		}
		switch strings.ToLower(strings.TrimSpace(s.Action)) {
		case "pick", "":
			todo = append(todo, "pick "+sha)
			if s.Message != "" {
				if okw, line := amend(); okw {
					todo = append(todo, line)
				}
			}
		case "reword":
			if s.Message == "" {
				return false, fmt.Sprintf("reword of %s needs a message.", sha)
			}
			todo = append(todo, "pick "+sha)
			if okw, line := amend(); okw {
				todo = append(todo, line)
			}
		case "fixup":
			todo = append(todo, "fixup "+sha)
			if s.Message != "" {
				if okw, line := amend(); okw {
					todo = append(todo, line)
				}
			}
		case "squash":
			// squash-with-message = fixup (combine, drop) then set the new message;
			// squash-without-message keeps all messages (GIT_EDITOR=true accepts them).
			if s.Message != "" {
				todo = append(todo, "fixup "+sha)
				if okw, line := amend(); okw {
					todo = append(todo, line)
				}
			} else {
				todo = append(todo, "squash "+sha)
			}
		case "drop":
			todo = append(todo, "drop "+sha)
		default:
			return false, fmt.Sprintf("unknown rebase action %q (use pick, reword, squash, fixup, or drop).", s.Action)
		}
	}
	todoPath := filepath.Join(tmp, "todo")
	if err := os.WriteFile(todoPath, []byte(strings.Join(todo, "\n")+"\n"), 0o644); err != nil {
		return false, "internal error writing the rebase plan: " + err.Error()
	}

	cmd := exec.Command("git", "-C", worktree, "rebase", "-i", base)
	cmd.Env = append(os.Environ(),
		// Replace git's generated todo with ours; accept squash's combined message.
		"GIT_SEQUENCE_EDITOR=cp "+shellSingleQuote(todoPath),
		"GIT_EDITOR=true",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if rebaseInProgress(worktree) {
			return false, "Rebase stopped (likely a conflict):\n" + strings.TrimSpace(string(out)) + "\n\nResolve the conflicts in your worktree (edit the files), then call git_rebase_continue - or git_rebase_abort to cancel and restore your branch."
		}
		return false, "Rebase could not start: " + firstNonEmpty(strings.TrimSpace(string(out)), err.Error())
	}
	newHash, _ := gitOutput(worktree, "rev-parse", "--short", "HEAD")
	return true, fmt.Sprintf("Rebased %s onto %s; HEAD is now %s.", cur, base, newHash)
}

// GuardedRebaseContinue resumes an in-progress rebase (after conflicts were
// resolved in the worktree). HEAD is detached mid-rebase, so it validates the
// rebase's own head-name is the head's branch instead of the usual HEAD check.
func GuardedRebaseContinue(worktree, expectedBranch string) (ok bool, summary string) {
	if !rebaseInProgress(worktree) {
		return false, "No rebase is in progress."
	}
	if okb, msg := ensureRebaseOwnBranch(worktree, expectedBranch); !okb {
		return false, msg
	}
	cmd := exec.Command("git", "-C", worktree, "rebase", "--continue")
	cmd.Env = append(os.Environ(), "GIT_EDITOR=true")
	out, err := cmd.CombinedOutput()
	if err != nil {
		if rebaseInProgress(worktree) {
			return false, "Rebase is still stopped (more conflicts, or nothing staged):\n" + strings.TrimSpace(string(out)) + "\n\nResolve and call git_rebase_continue again, or git_rebase_abort."
		}
		return false, "Rebase continue failed: " + firstNonEmpty(strings.TrimSpace(string(out)), err.Error())
	}
	if rebaseInProgress(worktree) {
		return true, "Advanced the rebase; it stopped again for the next step. Resolve any conflicts and call git_rebase_continue."
	}
	branch, _ := gitOutput(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
	newHash, _ := gitOutput(worktree, "rev-parse", "--short", "HEAD")
	return true, fmt.Sprintf("Rebase complete; %s is now at %s.", branch, newHash)
}

// GuardedRebaseAbort aborts an in-progress rebase, restoring the head's branch.
func GuardedRebaseAbort(worktree, expectedBranch string) (ok bool, summary string) {
	if !rebaseInProgress(worktree) {
		return false, "No rebase is in progress."
	}
	if okb, msg := ensureRebaseOwnBranch(worktree, expectedBranch); !okb {
		return false, msg
	}
	if out, err := gitCombined(worktree, "rebase", "--abort"); err != nil {
		return false, "Rebase abort failed: " + firstNonEmpty(strings.TrimSpace(out), err.Error())
	}
	branch, _ := gitOutput(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
	return true, fmt.Sprintf("Rebase aborted; %s restored.", branch)
}

// rebaseInProgress reports whether a rebase is underway in worktree (either the
// merge-based or apply-based layout), resolving the per-worktree gitdir path.
func rebaseInProgress(worktree string) bool {
	for _, p := range []string{"rebase-merge", "rebase-apply"} {
		dir := gitPath(worktree, p)
		if dir == "" {
			continue
		}
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return true
		}
	}
	return false
}

// ensureRebaseOwnBranch verifies the in-progress rebase is rebasing the head's
// OWN branch (from rebase-merge/head-name), for the continue/abort guard.
func ensureRebaseOwnBranch(worktree, expectedBranch string) (bool, string) {
	p := gitPath(worktree, "rebase-merge/head-name")
	data, err := os.ReadFile(p)
	if err != nil {
		return false, "Cannot read the rebase state to verify the branch. Use git_rebase_abort to cancel it."
	}
	short := strings.TrimPrefix(strings.TrimSpace(string(data)), "refs/heads/")
	switch {
	case expectedBranch != "" && short != expectedBranch:
		return false, fmt.Sprintf("Refusing: the in-progress rebase is on %q, not your head's branch %q.", short, expectedBranch)
	case expectedBranch == "" && !strings.HasPrefix(short, "hydra/"):
		return false, fmt.Sprintf("Refusing: the in-progress rebase is on %q, not a Hydra head branch.", short)
	}
	return true, ""
}

// gitPath resolves a path inside the (per-worktree) git dir, absolute.
func gitPath(worktree, rel string) string {
	p, err := gitOutput(worktree, "rev-parse", "--git-path", rel)
	if err != nil || p == "" {
		return ""
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(worktree, p)
	}
	return p
}

// gitStdout runs `git -C dir <args>` and returns raw stdout (untrimmed), so a
// diff's exact bytes are preserved for patch construction.
func gitStdout(dir string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	return string(out), errtrace.Wrap(err)
}

// shellSingleQuote wraps s in single quotes for safe use in a GIT_*_EDITOR / exec
// command line (git runs those via the shell). Embedded single quotes are escaped.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
