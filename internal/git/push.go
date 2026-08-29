package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"

	"braces.dev/errtrace"
)

// RemoteStatus describes how the currently checked-out branch relates to the
// remote it would be pushed to, so the UI can decide whether a push is useful.
//
// Both counts are measured against the last-known remote-tracking refs and do
// NOT contact the network, mirroring `git status`. Ahead (local commits) is
// therefore always current; Behind only reflects what a prior fetch learned, so
// callers wanting an accurate Behind should Fetch first.
type RemoteStatus struct {
	Branch    string // current branch; "" when HEAD is detached
	Remote    string // remote a push would target (e.g. "origin"); "" if none
	HasRemote bool   // whether a remote exists to push to
	Ahead     int    // commits reachable from HEAD but not present on the remote
	Behind    int    // commits on the remote-tracking branch not in HEAD
}

// CanPush reports whether pushing the current branch would send any commits.
func (s RemoteStatus) CanPush() bool {
	return s.HasRemote && s.Branch != "" && s.Ahead > 0
}

// GetRemoteStatus inspects the repository at projectRoot and reports the push
// state of its currently checked-out branch. It never fetches from the network:
// "ahead" is measured against the last-known remote-tracking refs, mirroring how
// `git status` reports ahead/behind without contacting the remote.
func GetRemoteStatus(projectRoot string) (RemoteStatus, error) {
	var st RemoteStatus

	branch, err := GetCurrentBranch(projectRoot)
	if err != nil {
		return st, errtrace.Wrap(err)
	}
	// `git rev-parse --abbrev-ref HEAD` yields "HEAD" in a detached checkout.
	if branch == "HEAD" {
		branch = ""
	}
	st.Branch = branch

	st.Remote = resolveRemote(projectRoot, branch)
	st.HasRemote = st.Remote != ""

	if st.Branch == "" || st.Remote == "" {
		return st, nil
	}

	// Commits on HEAD not reachable from any of the remote's tracking refs -
	// exactly what a push would add, whether or not an upstream is configured
	// and whether or not the branch exists on the remote yet.
	ahead, err := revListCount(projectRoot, "HEAD", "--not", "--remotes="+st.Remote)
	if err != nil {
		return st, errtrace.Wrap(err)
	}
	st.Ahead = ahead

	// Commits the remote-tracking branch has that HEAD doesn't (how far behind we
	// are). Only meaningful for a branch that exists on the remote; for a branch
	// not yet pushed there is no tracking ref and Behind stays 0.
	if track := TrackingRef(projectRoot, st.Remote, st.Branch); track != "" {
		behind, err := revListCount(projectRoot, "HEAD.."+track)
		if err != nil {
			return st, errtrace.Wrap(err)
		}
		st.Behind = behind
	}
	return st, nil
}

// revListCount runs `git rev-list --count <args...>` and parses the result.
func revListCount(projectRoot string, args ...string) (int, error) {
	out, err := gitOutput(projectRoot, append([]string{"rev-list", "--count"}, args...)...)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, errtrace.Wrap(fmt.Errorf("parse rev-list count %q: %w", out, err))
	}
	return n, nil
}

// AheadBehind reports how many commits `ours` has that `theirs` lacks (ahead) and
// how many `theirs` has that `ours` lacks (behind), from the last-known refs (no
// fetch). ok is false when either ref can't be resolved - e.g. the remote
// downstream branch doesn't exist yet - so callers can distinguish "unpublished"
// from "in sync". Used for the Push to MR / Pull from MR affordances.
func AheadBehind(projectRoot, ours, theirs string) (ahead, behind int, ok bool) {
	for _, ref := range []string{ours, theirs} {
		if _, err := gitOutput(projectRoot, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err != nil {
			return 0, 0, false
		}
	}
	// `--left-right --count theirs...ours` prints "<left>\t<right>": left = commits
	// in theirs not ours (behind), right = commits in ours not theirs (ahead).
	out, err := gitOutput(projectRoot, "rev-list", "--left-right", "--count", theirs+"..."+ours)
	if err != nil {
		return 0, 0, false
	}
	fields := strings.Fields(out)
	if len(fields) != 2 {
		return 0, 0, false
	}
	behind, err1 := strconv.Atoi(fields[0])
	ahead, err2 := strconv.Atoi(fields[1])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return ahead, behind, true
}

// TrackingRef returns the remote-tracking ref a push/pull compares against: the
// configured upstream if any, else "<remote>/<branch>" when that ref exists,
// else "" (the branch isn't on the remote yet).
func TrackingRef(projectRoot, remote, branch string) string {
	if up, err := gitOutput(projectRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil && up != "" {
		return up
	}
	ref := remote + "/" + branch
	if _, err := gitOutput(projectRoot, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err == nil {
		return ref
	}
	return ""
}

// Fetch updates the remote-tracking refs for the given remote without merging,
// so a subsequent GetRemoteStatus reports an accurate Behind count. It never
// prompts for credentials (GIT_TERMINAL_PROMPT=0) and honours ctx's deadline, so
// a slow or unauthenticated remote fails fast rather than hanging.
func Fetch(ctx context.Context, projectRoot, remote string) error {
	if err := ValidateRef(remote); err != nil {
		return errtrace.Wrap(err)
	}
	cmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "fetch", "--quiet", remote)
	cmd.Env = nonInteractiveGitEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		return errtrace.Wrap(classifyGitNetworkError("fetch "+remote, err, string(out)))
	}
	return nil
}

// TrackRemoteName is the local git remote Hydra configures so a user can follow
// head branches (hydra/*) as remote-tracking refs and `git pull` them. Named to
// avoid colliding with the hydra/* branch namespace: a remote literally named
// "hydra" would make the shorthand "hydra/<id>" ambiguous (refs/heads vs
// refs/remotes). See docs/git-isolation.md.
const TrackRemoteName = "hydra-agents"

// EnsureTrackRemote idempotently configures the TrackRemoteName remote in the
// project's repo - url "." (the repo itself, so no network) with a fetch refspec
// mapping refs/heads/hydra/* into refs/remotes/hydra-agents/* - and fetches once so
// the refs exist immediately. The user can then `git checkout -t hydra-agents/<id>`
// and `git pull` to follow a head's branch. Returns the remote name.
func EnsureTrackRemote(ctx context.Context, projectRoot string) (string, error) {
	if out, err := gitCombined(projectRoot, "config", "remote."+TrackRemoteName+".url", "."); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("set %s url: %s", TrackRemoteName, firstNonEmpty(strings.TrimSpace(out), err.Error())))
	}
	refspec := "+refs/heads/hydra/*:refs/remotes/" + TrackRemoteName + "/*"
	if out, err := gitCombined(projectRoot, "config", "remote."+TrackRemoteName+".fetch", refspec); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("set %s fetch: %s", TrackRemoteName, firstNonEmpty(strings.TrimSpace(out), err.Error())))
	}
	if err := Fetch(ctx, projectRoot, TrackRemoteName); err != nil {
		return "", errtrace.Wrap(err)
	}
	return TrackRemoteName, nil
}

// LocalBranchExists reports whether name is an exact local branch. It uses the
// full ref namespace so a same-named tag or remote-tracking ref cannot match.
func LocalBranchExists(projectRoot, name string) bool {
	if ValidateRef(name) != nil {
		return false
	}
	_, err := gitOutput(projectRoot, "show-ref", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}

// RemoteURL returns the fetch URL configured for remote, or "" if it has none.
func RemoteURL(projectRoot, remote string) string {
	if remote == "" {
		return ""
	}
	out, err := gitOutput(projectRoot, "remote", "get-url", remote)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// RemoteNames lists the configured remote names.
func RemoteNames(projectRoot string) []string {
	out, err := gitOutput(projectRoot, "remote")
	if err != nil {
		return nil
	}
	return strings.Fields(out)
}

// resolveRemote picks the remote a push should target: the upstream's remote if
// the branch tracks one, else "origin" when present, else the first configured
// remote. Returns "" when the repository has no remotes.
func resolveRemote(projectRoot, branch string) string {
	if branch != "" {
		if up, err := gitOutput(projectRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil && up != "" {
			if i := strings.IndexByte(up, '/'); i > 0 {
				return up[:i]
			}
		}
	}
	out, err := gitOutput(projectRoot, "remote")
	if err != nil {
		return ""
	}
	remotes := strings.Fields(out)
	for _, r := range remotes {
		if r == "origin" {
			return "origin"
		}
	}
	if len(remotes) > 0 {
		return remotes[0]
	}
	return ""
}

// nonInteractiveGitEnv returns os.Environ() augmented with the settings that make
// git and ssh fail fast rather than block on a credential or key-passphrase
// prompt. The daemon runs push/fetch with no controlling terminal, so an
// interactive prompt would hang it forever (see docs/non-local-integration.md);
// GIT_TERMINAL_PROMPT=0 disables git's own prompts and
// GIT_SSH_COMMAND="ssh -oBatchMode=yes" stops ssh asking for a passphrase - the
// answer to a passphrase-protected key is ssh-agent, never a Hydra prompt.
func nonInteractiveGitEnv() []string {
	return append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_SSH_COMMAND=ssh -oBatchMode=yes",
	)
}

// AuthError reports that a git network operation (push/fetch) failed because it
// could not authenticate - or would have needed an interactive credential /
// passphrase prompt, which the daemon runs with disabled. Its message is
// actionable so the UI can tell the user what to fix rather than surfacing raw
// git stderr. Output holds the trimmed git output for detail.
type AuthError struct{ Output string }

func (e *AuthError) Error() string {
	return "push authentication failed - add your key to ssh-agent (`ssh-add`) or switch to HTTPS + a credential helper"
}

// classifyGitNetworkError maps a failed push/fetch to an *AuthError when the
// combined output looks like an authentication or non-interactive-prompt
// failure, so callers can surface an actionable hint. Anything else is returned
// as a plain wrapped error. err is the exec error; out is the combined output.
func classifyGitNetworkError(op string, err error, out string) error {
	if looksLikeAuthFailure(out) {
		return errtrace.Wrap(&AuthError{Output: strings.TrimSpace(out)})
	}
	return errtrace.Wrap(fmt.Errorf("git %s: %w: %s", op, err, strings.TrimSpace(out)))
}

// authFailureMarkers are substrings of git/ssh output that indicate an
// authentication or non-interactive-prompt failure rather than an ordinary
// rejection (e.g. non-fast-forward), so the caller can hint at ssh-agent/creds.
var authFailureMarkers = []string{
	"authentication failed",
	"permission denied",
	"could not read from remote repository",
	"terminal prompts disabled",
	"host key verification failed",
	"no such identity",
	"could not read username",
	"could not read password",
	"batchmode", // ssh -oBatchMode refused an interactive prompt
}

// looksLikeAuthFailure reports whether git/ssh output matches a known auth marker.
func looksLikeAuthFailure(out string) bool {
	low := strings.ToLower(out)
	return slices.ContainsFunc(authFailureMarkers, func(m string) bool {
		return strings.Contains(low, m)
	})
}

// Push pushes the currently checked-out branch of projectRoot to its remote,
// setting upstream tracking so subsequent pushes need no arguments. It returns
// the combined git output (useful as an error detail on failure). Network access
// is required, so this must run outside the agent sandbox (the daemon does). It
// runs strictly non-interactively (see nonInteractiveGitEnv) so a credential
// prompt fails fast as an *AuthError instead of hanging the daemon.
func Push(projectRoot string) (string, error) {
	st, err := GetRemoteStatus(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if st.Branch == "" {
		return "", errtrace.Wrap(fmt.Errorf("cannot push: HEAD is detached"))
	}
	if st.Remote == "" {
		return "", errtrace.Wrap(fmt.Errorf("cannot push: repository has no remote configured"))
	}
	if err := ValidateRef(st.Branch); err != nil {
		return "", errtrace.Wrap(err)
	}

	cmd := exec.Command("git", "-C", projectRoot, "push", "--set-upstream", st.Remote, st.Branch)
	cmd.Env = nonInteractiveGitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), errtrace.Wrap(classifyGitNetworkError("push", err, string(out)))
	}
	return string(out), nil
}

// PushRefspec pushes a single refspec (e.g. "hydra/<id>:refs/heads/<downstream>")
// to remote, host-side, strictly non-interactively. It is the publish primitive
// (docs/non-local-integration.md): the local branch is untouched - only the
// named refspec is sent. When forceWithLease is non-nil it pushes with
// --force-with-lease=<forceWithLease> (the one safe force case, see
// docs/non-local-integration.md: the head
// rewrote its own history and the remote tip still matches what it last pushed);
// otherwise the push is a plain fast-forward-only push that fails cleanly if the
// downstream branch diverged. Returns combined git output; an auth failure is an
// *AuthError. ctx bounds the network wait.
func PushRefspec(ctx context.Context, projectRoot, remote, refspec string, forceWithLease *string) (string, error) {
	if err := ValidateRef(remote); err != nil {
		return "", errtrace.Wrap(err)
	}
	args := []string{"-C", projectRoot, "push"}
	if forceWithLease != nil {
		if *forceWithLease == "" {
			args = append(args, "--force-with-lease")
		} else {
			args = append(args, "--force-with-lease="+*forceWithLease)
		}
	}
	args = append(args, remote, refspec)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = nonInteractiveGitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), errtrace.Wrap(classifyGitNetworkError("push "+refspec, err, string(out)))
	}
	return string(out), nil
}

// DeleteRemoteBranch deletes a branch on remote (`git push <remote> --delete
// <branch>`), host-side and non-interactively. Used when tearing down a linked
// head that asked to close its MR and delete the remote branch. A branch
// that does not exist on the remote is treated as success (already gone).
func DeleteRemoteBranch(ctx context.Context, projectRoot, remote, branch string) error {
	if err := ValidateRef(remote); err != nil {
		return errtrace.Wrap(err)
	}
	if err := ValidateRef(branch); err != nil {
		return errtrace.Wrap(err)
	}
	cmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "push", remote, "--delete", branch)
	cmd.Env = nonInteractiveGitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(strings.ToLower(string(out)), "remote ref does not exist") {
			return nil // already gone
		}
		return errtrace.Wrap(classifyGitNetworkError("push --delete "+branch, err, string(out)))
	}
	return nil
}

// ConflictError reports that an integration (pull/merge) could not complete
// because the changes conflict. Files lists the conflicting paths.
type ConflictError struct{ Files []string }

func (e *ConflictError) Error() string {
	return fmt.Sprintf("merge conflict in files: %v", e.Files)
}

// Pull brings the current branch up to date with its remote (fetch + integrate
// the tracking ref), the equivalent of `git pull`. It is a no-op when the branch
// has no remote/tracking ref or is already current. Unlike Merge it never uses
// `reset --hard` for fast-forwards (which would discard uncommitted work in the
// user's real checkout): it uses `merge --ff-only`, which git refuses if local
// changes would be overwritten. A divergent integration that would conflict
// returns a *ConflictError without touching the working tree.
func Pull(ctx context.Context, projectRoot, authorName, authorEmail string) error {
	st, err := GetRemoteStatus(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if st.Branch == "" || st.Remote == "" {
		return nil
	}
	if err := Fetch(ctx, projectRoot, st.Remote); err != nil {
		return errtrace.Wrap(err)
	}
	track := TrackingRef(projectRoot, st.Remote, st.Branch)
	if track == "" {
		return nil // branch isn't on the remote yet - nothing to integrate
	}

	// Already up to date: the tracking ref is reachable from HEAD.
	if upToDate, err := gitIsAncestor(projectRoot, track, "HEAD"); err != nil {
		return errtrace.Wrap(err)
	} else if upToDate {
		return nil
	}

	// Fast-forward when HEAD is an ancestor of the tracking ref. --ff-only is
	// non-destructive: git aborts rather than clobber uncommitted changes.
	if canFF, err := gitIsAncestor(projectRoot, "HEAD", track); err != nil {
		return errtrace.Wrap(err)
	} else if canFF {
		if out, err := runMerge(projectRoot, authorName, authorEmail, "--ff-only", track); err != nil {
			return errtrace.Wrap(fmt.Errorf("git merge --ff-only %s: %w: %s", track, err, out))
		}
		return nil
	}

	// Diverged: refuse up front if the merge would conflict, so we never leave
	// the working tree mid-merge.
	conflicts, err := GetConflictingFiles(projectRoot, "HEAD", track)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if len(conflicts) > 0 {
		return errtrace.Wrap(&ConflictError{Files: conflicts})
	}
	if out, err := runMerge(projectRoot, authorName, authorEmail, "--no-edit", track); err != nil {
		// Leave a clean tree if git still couldn't merge for some other reason.
		_ = exec.Command("git", "-C", projectRoot, "merge", "--abort").Run()
		return errtrace.Wrap(fmt.Errorf("git merge %s: %w: %s", track, err, out))
	}
	return nil
}

// runMerge runs `git merge <args...>` with the given author/committer identity
// (defaults applied like Merge) and returns trimmed combined output on failure.
func runMerge(projectRoot, authorName, authorEmail string, args ...string) (string, error) {
	if authorName == "" {
		authorName = "Hydra Agent"
	}
	if authorEmail == "" {
		authorEmail = "hydra@trolleyman.org"
	}
	cmd := exec.Command("git", append([]string{"-C", projectRoot, "merge"}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME="+authorName,
		"GIT_AUTHOR_EMAIL="+authorEmail,
		"GIT_COMMITTER_NAME="+authorName,
		"GIT_COMMITTER_EMAIL="+authorEmail,
	)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), errtrace.Wrap(err)
}
