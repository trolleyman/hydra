package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
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

	// Commits on HEAD not reachable from any of the remote's tracking refs —
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
	if track := trackingRef(projectRoot, st.Remote, st.Branch); track != "" {
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

// trackingRef returns the remote-tracking ref a push/pull compares against: the
// configured upstream if any, else "<remote>/<branch>" when that ref exists,
// else "" (the branch isn't on the remote yet).
func trackingRef(projectRoot, remote, branch string) string {
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
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git fetch %s: %w: %s", remote, err, strings.TrimSpace(string(out))))
	}
	return nil
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

// Push pushes the currently checked-out branch of projectRoot to its remote,
// setting upstream tracking so subsequent pushes need no arguments. It returns
// the combined git output (useful as an error detail on failure). Network access
// is required, so this must run outside the agent sandbox (the daemon does).
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
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), errtrace.Wrap(fmt.Errorf("git push: %w: %s", err, strings.TrimSpace(string(out))))
	}
	return string(out), nil
}
