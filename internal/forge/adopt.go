package forge

import "strings"

// Adoption support: enumerating existing PRs/MRs and resolving one in enough
// detail to check it out as a head and (later) push back to it. This is the
// inbound half of the forge integration - the outbound publish flow only ever
// creates a *new* MR (see docs/pr-adoption.md).

// MRRef is everything needed to adopt an existing PR/MR as a head: enough to
// list it in the picker, fetch its head commit, base a worktree on it, and work
// out where a push should go (which, for a fork PR, is NOT the configured
// review remote).
type MRRef struct {
	ID           string // PR number / MR iid, as a string
	URL          string
	Title        string
	Author       string // login / username of the PR author
	State        string // normalized State* (draft | open | merged | closed)
	Draft        bool
	HeadRef      string // source branch name on the head repo
	HeadRepoURL  string // clone URL of the repo hosting HeadRef ("" when same-repo)
	TargetBranch string // the branch the PR merges into (the head's BaseBranch)
	CrossRepo    bool   // head repo != base repo (a PR raised from a fork)
	// CanPush reports whether we can push commits to the PR's head branch: always
	// true for a same-repo PR, and for a fork PR only when the author enabled
	// "allow edits by maintainers" (GitHub) / "allow collaboration" (GitLab).
	// Surfaced in the picker so a head is never spawned that cannot push back.
	CanPush bool
}

// firstNonEmptyStr returns the first non-empty string of its arguments.
func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// urlSchemeHost returns "<scheme>://<host>" from a URL like
// "https://github.com/o/r/pull/1", or "" if it can't be parsed. Used to build a
// fork's clone URL on the same host as the PR (handles github.com and GHES).
func urlSchemeHost(rawURL string) string {
	scheme, rest, ok := strings.Cut(rawURL, "://")
	if !ok {
		return ""
	}
	host, _, _ := strings.Cut(rest, "/")
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// ListMROptions filters an MR/PR enumeration for the adoption picker.
type ListMROptions struct {
	State  string // "" / "open" (default) | "all" | "merged" | "closed"
	Author string // "" (anyone) | "@me" (the authenticated user's own PRs)
	Search string // free-text search, forge-native syntax
	Limit  int    // 0 = provider default
}
