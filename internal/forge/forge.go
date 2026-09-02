// Package forge is Hydra's thin abstraction over a code-review forge (GitHub /
// GitLab) for the non-local integration flow (docs/non-local-integration.md).
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
	RepoDir      string // dir to run the CLI in (the project root)
	Remote       string // git remote name, for repo resolution
	SourceBranch string // the pushed downstream branch (MR source)
	TargetBranch string // MR target
	Title        string
	Description  string
	// UpdateExistingMetadata asks the provider to apply title/body to an existing
	// PR. Graphite creates the PR first, then Hydra uses this to preserve its
	// tracker-aware title and prompt-derived description.
	UpdateExistingMetadata bool
	Draft                  bool
	Squash                 bool // request squash-on-merge
	RemoveSourceBranch     bool // tell the forge to delete the source branch on merge
}

// MergeOptions controls a forge-side merge.
type MergeOptions struct {
	RepoDir            string
	Remote             string
	Squash             bool
	RemoveSourceBranch bool
	// Auto enables the forge's own auto-merge (merge-when-pipeline-succeeds /
	// GitHub auto-merge) instead of merging immediately - preferred where available
	// because it respects merge trains and protected-branch rules.
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
// agent to act on (get_review_comments / the "respond to review" prompt).
type Discussion struct {
	// ID is the THREAD handle - what a reply attaches to. NoteID identifies the
	// individual comment inside it, which is what Hydra numbers, so "#7" can name
	// one person's remark rather than the whole conversation.
	ID     string
	NoteID string
	Author string
	Body   string
	Path   string
	Line   int
	URL    string
}

// Thread is one review conversation on an MR, anchored to a file and line, with
// its notes in order. It is the full shape behind Discussion - the diff viewer
// renders threads inline, while the agent-facing tools flatten the unresolved
// ones to Discussions (see UnresolvedDiscussions).
type Thread struct {
	// ID identifies the thread for replies. GitHub: the root review comment's
	// numeric id (what the replies endpoint takes). GitLab: the discussion id.
	ID   string
	Path string
	Line int
	// StartLine is the first new-side line covered by a multi-line comment.
	// Zero means the comment covers only Line.
	StartLine int
	Resolved  bool
	// Outdated marks a thread whose anchor line no longer exists in the diff
	// (GitHub reports this; GitLab position simply goes null).
	Outdated bool
	URL      string
	Notes    []Note
}

// Note is one comment inside a Thread.
type Note struct {
	ID     string
	Author string
	// AvatarURL is the author's picture, hosted BY THE FORGE. Hydra stores no
	// images and proxies nothing: the browser loads this URL directly, and a
	// failure (offline, a private instance, an avatar that has moved) falls back
	// to a monogram rather than showing a broken frame.
	AvatarURL string
	Body      string
	URL       string
	CreatedAt string // RFC3339, as reported by the forge
	// DiffHunk is GitHub's source context for this note. It lets suggestion
	// application verify that the anchored lines have not changed underneath it.
	DiffHunk string
	// Suggestion is GitLab's structured suggestion payload. GitHub carries the
	// replacement in Body instead, with source context in DiffHunk.
	Suggestion *Suggestion
}

// Suggestion is the provider's structured replacement metadata when available.
type Suggestion struct {
	FromLine    int
	ToLine      int
	FromContent string
	ToContent   string
	Appliable   bool
	Applied     bool
}

// NewLineComment starts a new review thread on a line of the MR's diff.
type NewLineComment struct {
	Path string
	Line int
	Body string
}

// UnresolvedDiscussions flattens threads to the agent-facing Discussion shape:
// one entry per note in each unresolved thread, in thread order. Shared so the
// review file and the diff viewer never disagree about what "unresolved" means.
func UnresolvedDiscussions(threads []Thread) []Discussion {
	var out []Discussion
	for _, t := range threads {
		if t.Resolved {
			continue
		}
		for _, n := range t.Notes {
			out = append(out, Discussion{
				ID: t.ID, NoteID: n.ID, Author: n.Author, Body: n.Body,
				Path: t.Path, Line: t.Line, URL: firstNonEmptyStr(n.URL, t.URL),
			})
		}
	}
	return out
}

// Provider is a forge Hydra can publish to and track. All methods run host-side.
type Provider interface {
	// Name is the provider identifier ("github" | "gitlab").
	Name() string
	// EnsureMR creates the MR/PR for opts.SourceBranch if none exists, else returns
	// the existing one - idempotent, so re-publish is safe.
	EnsureMR(ctx context.Context, opts EnsureMROptions) (MR, error)
	// Status returns the normalized state of the MR identified by id.
	Status(ctx context.Context, repoDir, remote, id string) (Status, error)
	// Merge merges (or arms auto-merge for) the MR identified by id.
	Merge(ctx context.Context, repoDir, remote, id string, o MergeOptions) error
	// Close closes the MR/PR identified by id without deleting its source branch.
	Close(ctx context.Context, repoDir, remote, id string) error
	// Threads returns the MR's review conversations (resolved ones included, so
	// the caller decides what to show), each anchored to a file/line where the
	// forge reports one.
	Threads(ctx context.Context, repoDir, remote, id string) ([]Thread, error)
	// ReplyToThread posts a reply into an existing thread, AS THE USER. Hydra's
	// own writes to a forge are always explicit user actions - an agent never
	// reaches this (its replies are local-only, see internal/reviewnotes).
	ReplyToThread(ctx context.Context, repoDir, remote, id, threadID, body string) error
	// CommentOnLine starts a new review thread on a line of the MR's diff, as the
	// user. The line is a NEW-side line number, matching how the diff viewer
	// anchors comments.
	CommentOnLine(ctx context.Context, repoDir, remote, id string, c NewLineComment) error
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
