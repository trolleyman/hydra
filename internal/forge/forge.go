// Package forge is Hydra's thin abstraction over a code-review forge (GitHub /
// GitLab) for the non-local integration flow (NON_LOCAL_INTEGRATION.md 3.3-3.5).
// It is CLI-first: the default implementations shell out to `gh` / `glab` on the
// host (which own auth, including self-hosted via their multi-host config), so
// Hydra needs no OAuth code and no token in-sandbox. Everything here runs
// host-side in the daemon with the user's own credentials - never inside an agent
// sandbox.
package forge

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
)

// Provider names (match config.ReviewProvider* spellings).
const (
	ProviderGitHub = "github"
	ProviderGitLab = "gitlab"
)

// MR state values, normalized across forges.
const (
	StateDraft  = "draft"
	StateOpen   = "open"
	StateMerged = "merged"
	StateClosed = "closed"
)

// CI status values, normalized across forges.
const (
	CISuccess = "success"
	CIFailed  = "failed"
	CIRunning = "running"
	CIPending = "pending"
	CINone    = "none"
)

// EnsureMROptions describes the MR/PR to create-or-update. The source branch must
// already be pushed to the remote (publish step 3 precedes EnsureMR).
type EnsureMROptions struct {
	RepoDir            string // dir to run the CLI in (the project root)
	Remote             string // git remote name, for repo resolution
	SourceBranch       string // the pushed downstream branch (MR source)
	TargetBranch       string // MR target
	Title              string
	Description        string
	Draft              bool
	Squash             bool // request squash-on-merge
	RemoveSourceBranch bool // tell the forge to delete the source branch on merge
}

// MergeOptions controls a forge-side merge.
type MergeOptions struct {
	RepoDir            string
	Remote             string
	Squash             bool
	RemoveSourceBranch bool
	// Auto enables the forge's own auto-merge (merge-when-pipeline-succeeds /
	// GitHub auto-merge) instead of merging immediately - preferred where available
	// because it respects merge trains and protected-branch rules (3.5).
	Auto bool
}

// MR identifies a created/looked-up merge request.
type MR struct {
	ID  string // GitLab IID / GitHub PR number, as a string
	URL string
}

// Status is the normalized MR state the watcher/UI consume.
type Status struct {
	ID                    string
	URL                   string
	State                 string // draft | open | merged | closed
	CIStatus              string // success | failed | running | pending | none
	Approvals             int
	ApprovalsRequired     int
	UnresolvedDiscussions int
	Mergeable             bool
}

// Discussion is one unresolved review thread with file/line context, ready for an
// agent to act on (get_review_comments / the "respond to review" prompt, 3.5a).
type Discussion struct {
	ID     string
	Author string
	Body   string
	Path   string
	Line   int
	URL    string
}

// Provider is a forge Hydra can publish to and track. All methods run host-side.
type Provider interface {
	// Name is the provider identifier ("github" | "gitlab").
	Name() string
	// EnsureMR creates the MR/PR for opts.SourceBranch if none exists, else returns
	// the existing one - idempotent, so re-publish is safe (3.3 step 6).
	EnsureMR(ctx context.Context, opts EnsureMROptions) (MR, error)
	// Status returns the normalized state of the MR identified by id.
	Status(ctx context.Context, repoDir, remote, id string) (Status, error)
	// Merge merges (or arms auto-merge for) the MR identified by id.
	Merge(ctx context.Context, repoDir, remote, id string, o MergeOptions) error
	// Discussions returns the unresolved review threads on the MR.
	Discussions(ctx context.Context, repoDir, remote, id string) ([]Discussion, error)
	// ListMRs enumerates existing MRs/PRs for the adoption picker (open by
	// default). It returns light MRRefs - the per-PR detail that needs an extra
	// round trip (a fork's clone URL) is filled by GetMR on selection.
	ListMRs(ctx context.Context, repoDir, remote string, o ListMROptions) ([]MRRef, error)
	// GetMR resolves a single MR/PR by id in full, including the head repo's
	// clone URL for a fork PR - everything needed to adopt it as a head.
	GetMR(ctx context.Context, repoDir, remote, id string) (MRRef, error)
}

// runner runs a CLI command in dir and returns combined stdout (for JSON parsing)
// plus a rich error carrying stderr. It is a field so tests can fake the CLI.
type runner func(ctx context.Context, dir, name string, args ...string) (stdout string, err error)

// execRunner is the production runner: it execs the real binary, non-interactively
// (the daemon has no TTY), and folds stderr into the error for actionable messages.
func execRunner(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	// gh/glab must never block on an interactive prompt in the daemon.
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1", "GLAB_CONFIG_DIR="+glabConfigDir())
	var out, errBuf strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return out.String(), errtrace.Wrap(&CLIError{Cmd: name + " " + strings.Join(args, " "), Stderr: strings.TrimSpace(errBuf.String()), Err: err})
	}
	return out.String(), nil
}

// glabConfigDir returns "" so glab uses its default; kept as a hook so a future
// config.local.toml pointer can redirect it. execRunner passes it through
// unconditionally, and an empty value is a no-op for glab.
func glabConfigDir() string { return "" }

// CLIError wraps a failed gh/glab invocation with its stderr, so callers can map
// it to an actionable UI message rather than a bare exit status.
type CLIError struct {
	Cmd    string
	Stderr string
	Err    error
}

func (e *CLIError) Error() string {
	if e.Stderr != "" {
		return fmt.Sprintf("%s: %s", e.Cmd, e.Stderr)
	}
	return fmt.Sprintf("%s: %v", e.Cmd, e.Err)
}

func (e *CLIError) Unwrap() error { return e.Err }

// NotConfiguredError reports that a provider could not be resolved (unknown
// self-hosted host with provider = "auto", or the CLI is missing/unauthenticated).
// The UI turns it into a "set [review] provider / run `gh auth login`" hint.
type NotConfiguredError struct{ Detail string }

func (e *NotConfiguredError) Error() string { return e.Detail }

// Resolve picks the concrete Provider for a review config and remote URL. It runs
// config auto-detection (or honors an explicit provider), then checks the backing
// CLI is present. auth = "token" is not yet implemented (REST fallback) and
// returns a NotConfiguredError pointing at CLI auth. Returns a *NotConfiguredError
// when the provider can't be determined.
func Resolve(review *config.ReviewConfig, remoteURL string) (Provider, error) {
	name := review.ResolveProvider(remoteURL)
	switch name {
	case config.ReviewProviderGitHub:
		if !cliAvailable("gh") {
			return nil, errtrace.Wrap(&NotConfiguredError{Detail: "GitHub CLI `gh` not found on PATH - install it and run `gh auth login`"})
		}
		return &githubProvider{run: execRunner}, nil
	case config.ReviewProviderGitLab:
		if !cliAvailable("glab") {
			return nil, errtrace.Wrap(&NotConfiguredError{Detail: "GitLab CLI `glab` not found on PATH - install it and run `glab auth login`"})
		}
		return &gitlabProvider{run: execRunner}, nil
	default:
		return nil, errtrace.Wrap(&NotConfiguredError{Detail: fmt.Sprintf("could not determine forge provider from remote %q - set [review] provider = \"github\" or \"gitlab\"", remoteURL)})
	}
}

// cliAvailable reports whether name is on PATH.
func cliAvailable(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// AuthStatus reports whether a forge CLI is authenticated, for the Settings page's
// live status line ("gh: logged in as X" / "glab: not authenticated"). It is
// best-effort and never blocks: a missing CLI yields (false, "", nil).
func AuthStatus(ctx context.Context, provider string) (loggedIn bool, detail string, err error) {
	switch provider {
	case config.ReviewProviderGitHub:
		return errtrace.Wrap3(ghAuthStatus(ctx))
	case config.ReviewProviderGitLab:
		return errtrace.Wrap3(glabAuthStatus(ctx))
	default:
		return false, "", nil
	}
}
