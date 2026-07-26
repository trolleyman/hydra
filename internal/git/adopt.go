package git

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
)

// Fetching the head commit of an existing PR/MR, so a head can be spawned ON it
// (docs/pr-adoption.md). The trick is the forge's read-only pseudo-ref on the
// TARGET repo, which resolves the PR head even for a PR raised from a fork - so
// this is a plain fetch from the configured remote and never needs a remote
// added for the fork.

// PRHeadRefspec returns the fetch refspec that copies a PR/MR's head commit into
// a private local ref. remoteRef is the forge's pseudo-ref (read-only); localRef
// is a ref under refs/hydra/pr/ so it never shows up in branch pickers or
// hydra/* globs. provider is "github" | "gitlab" (default: github's scheme).
func PRHeadRefspec(provider, id string) (localRef, refspec string) {
	local := PRLocalRef(provider, id)
	var remote string
	switch provider {
	case "gitlab":
		remote = "refs/merge-requests/" + id + "/head"
	default:
		remote = "refs/pull/" + id + "/head"
	}
	return local, remote + ":" + local
}

// PRLocalRef is the private local ref an adopted PR/MR's head is fetched into.
// It is deliberately outside refs/heads and the hydra/ branch namespace.
func PRLocalRef(provider, id string) string {
	if provider == "" {
		provider = "github"
	}
	return "refs/hydra/pr/" + provider + "/" + id
}

// FetchRefspec fetches a single refspec from remote into projectRoot, host-side
// and strictly non-interactively (see nonInteractiveGitEnv) so an auth prompt
// fails fast as an *AuthError instead of hanging the daemon. remote may be a
// remote name or a URL. Used to pull a PR/MR head into a local ref before
// basing a worktree on it (docs/pr-adoption.md).
func FetchRefspec(ctx context.Context, projectRoot, remote, refspec string) error {
	if err := ValidateRef(remote); err != nil {
		return errtrace.Wrap(err)
	}
	if refspec == "" || strings.HasPrefix(refspec, "-") {
		return errtrace.Wrap(fmt.Errorf("invalid refspec %q", refspec))
	}
	cmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "fetch", "--quiet", remote, refspec)
	cmd.Env = nonInteractiveGitEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		return errtrace.Wrap(classifyGitNetworkError("fetch "+refspec, err, string(out)))
	}
	return nil
}
