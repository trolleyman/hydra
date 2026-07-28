package config

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"braces.dev/errtrace"
)

// isEmpty reports whether no field is set at this layer (all pointers nil / no
// protected branches). Used by renderConfig to fall back to the commented
// example rather than emitting an empty [review] table.
func (r ReviewConfig) isEmpty() bool {
	return r.Provider == nil && r.Remote == nil && r.Auth == nil &&
		r.DefaultAction == nil && r.PushBranchTemplate == nil && r.Draft == nil && r.Squash == nil &&
		r.DeleteRemoteBranch == nil && r.RequireLocalTests == nil && r.PublishWhenGreen == nil &&
		len(r.ProtectedBranches) == 0
}

// reviewFieldLines renders the [review] table for renderConfig, emitting only the
// fields set at this layer (a nil pointer is left out so it keeps inheriting the
// layer below). Mirrors artifactFieldLines / testFieldLines.
func reviewFieldLines(r ReviewConfig) []string {
	out := []string{"[review]"}
	addStr := func(key string, v *string) {
		if v != nil {
			out = append(out, key+" = "+tomlStringValue(*v))
		}
	}
	addBool := func(key string, v *bool) {
		if v != nil {
			out = append(out, key+" = "+strconv.FormatBool(*v))
		}
	}
	addStr("provider", r.Provider)
	addStr("remote", r.Remote)
	addStr("auth", r.Auth)
	addStr("default_action", r.DefaultAction)
	addStr("push_branch_template", r.PushBranchTemplate)
	addBool("draft", r.Draft)
	addBool("squash", r.Squash)
	addBool("delete_remote_branch", r.DeleteRemoteBranch)
	addBool("require_local_tests", r.RequireLocalTests)
	addBool("publish_when_green", r.PublishWhenGreen)
	if len(r.ProtectedBranches) > 0 {
		quoted := make([]string, len(r.ProtectedBranches))
		for i, b := range r.ProtectedBranches {
			quoted[i] = tomlStringValue(b)
		}
		out = append(out, "protected_branches = ["+strings.Join(quoted, ", ")+"]")
	}
	return out
}

// Review provider / auth / action constants. The string values are the config
// spellings (see docs/non-local-integration.md).
const (
	ReviewProviderAuto   = "auto"
	ReviewProviderGitHub = "github"
	ReviewProviderGitLab = "gitlab"

	ReviewAuthCLI   = "cli"
	ReviewAuthToken = "token"

	ReviewActionMerge    = "merge"
	ReviewActionCreateMR = "create_mr"
)

// Review* defaults applied by the ReviewConfig accessors when a field is unset
// (nil), following the nil-means-default pointer convention.
const (
	defaultReviewProvider           = ReviewProviderAuto
	defaultReviewRemote             = "origin"
	defaultReviewAuth               = ReviewAuthCLI
	defaultReviewDefaultAction      = ReviewActionMerge
	defaultReviewPushBranchTemplate = "{id}"
	defaultJiraTicketPattern        = "[A-Z]+-[0-9]+"
)

// ReviewConfig configures how Hydra talks to a forge (GitHub/GitLab) and supplies
// defaults for the Create MR dialog. There is deliberately no "mode" switch: the
// head<->MR link is per-head, so this section only supplies defaults and forge
// connection details (docs/non-local-integration.md). All fields follow the
// nil-means-default pointer convention so an unset value inherits the built-in
// default and a lower config layer's value.
type ReviewConfig struct {
	// Provider is the forge type: "auto" (detect from the remote URL), "github", or
	// "gitlab". nil/"" = auto.
	Provider *string `toml:"provider"`
	// Remote is the git remote a publish targets (default "origin").
	Remote *string `toml:"remote"`
	// Auth is how Hydra talks to the forge: "cli" (shell out to gh/glab) or "token"
	// (REST with a token from the secrets file / HYDRA_FORGE_TOKEN). Default "cli".
	Auth *string `toml:"auth"`
	// DefaultAction picks the primary button on a head: "merge" (local, as today) or
	// "create_mr". The other action stays one click away. Default "merge".
	DefaultAction *string `toml:"default_action"`
	// PublishWhenGreen arms new heads to auto-create/update a DRAFT MR once local
	// tests pass and the agent has finished (the publish analog of merge-when-green).
	// Per-head overridable in the spawn form. nil = off.
	PublishWhenGreen *bool `toml:"publish_when_green"`
	// ProtectedBranches, when a direct LOCAL merge targets one of these, triggers a
	// warning (the server would reject the push anyway). nil/empty = no warning.
	ProtectedBranches []string `toml:"protected_branches"`
	// PushBranchTemplate is the default downstream branch name template the head
	// branch is pushed AS (the local branch stays hydra/<id>). Placeholders {id},
	// {ticket}, {base}; empty placeholders collapse adjacent separators. Default "{id}".
	PushBranchTemplate *string `toml:"push_branch_template"`
	// Draft opens MRs as draft by default. Default true.
	Draft *bool `toml:"draft"`
	// Squash requests squash-on-merge. Default true.
	Squash *bool `toml:"squash"`
	// DeleteRemoteBranch tells the forge to delete the source branch on merge.
	// Default true.
	DeleteRemoteBranch *bool `toml:"delete_remote_branch"`
	// RequireLocalTests gates the Publish action on local [[tests]] like merge is
	// gated today. Default true.
	RequireLocalTests *bool `toml:"require_local_tests"`
}

// JiraConfig configures ticket-key extraction and the JIRA base URL, used for
// {ticket} templating and (later) spawn-from-ticket (docs/non-local-integration.md).
type JiraConfig struct {
	// URL is the JIRA base URL, e.g. "https://mycorp.atlassian.net". nil/"" = unset.
	URL *string `toml:"url"`
	// TicketPattern is a regex to pull a ticket key out of the spawn prompt / branch.
	// Default "[A-Z]+-[0-9]+".
	TicketPattern *string `toml:"ticket_pattern"`
}

// GetProvider returns the configured provider or the "auto" default. This is the
// raw setting; use ResolveProvider to run auto-detection against a remote URL.
func (r *ReviewConfig) GetProvider() string {
	if r == nil || r.Provider == nil || *r.Provider == "" {
		return defaultReviewProvider
	}
	return *r.Provider
}

// GetRemote returns the configured remote or "origin".
func (r *ReviewConfig) GetRemote() string {
	if r == nil || r.Remote == nil || *r.Remote == "" {
		return defaultReviewRemote
	}
	return *r.Remote
}

// GetAuth returns the configured auth method or "cli".
func (r *ReviewConfig) GetAuth() string {
	if r == nil || r.Auth == nil || *r.Auth == "" {
		return defaultReviewAuth
	}
	return *r.Auth
}

// GetDefaultAction returns the configured primary action or "merge".
func (r *ReviewConfig) GetDefaultAction() string {
	if r == nil || r.DefaultAction == nil || *r.DefaultAction == "" {
		return defaultReviewDefaultAction
	}
	return *r.DefaultAction
}

// GetPushBranchTemplate returns the configured downstream-branch template or "{id}".
func (r *ReviewConfig) GetPushBranchTemplate() string {
	if r == nil || r.PushBranchTemplate == nil || *r.PushBranchTemplate == "" {
		return defaultReviewPushBranchTemplate
	}
	return *r.PushBranchTemplate
}

// IsPublishWhenGreen reports whether new heads are armed to publish-when-green.
func (r *ReviewConfig) IsPublishWhenGreen() bool {
	return r != nil && r.PublishWhenGreen != nil && *r.PublishWhenGreen
}

// IsDraft reports whether MRs open as draft by default (default true).
func (r *ReviewConfig) IsDraft() bool {
	return r == nil || r.Draft == nil || *r.Draft
}

// IsSquash reports whether squash-on-merge is requested by default (default true).
func (r *ReviewConfig) IsSquash() bool {
	return r == nil || r.Squash == nil || *r.Squash
}

// IsDeleteRemoteBranch reports whether the forge is told to delete the source
// branch on merge (default true).
func (r *ReviewConfig) IsDeleteRemoteBranch() bool {
	return r == nil || r.DeleteRemoteBranch == nil || *r.DeleteRemoteBranch
}

// IsRequireLocalTests reports whether Publish is gated on local tests (default true).
func (r *ReviewConfig) IsRequireLocalTests() bool {
	return r == nil || r.RequireLocalTests == nil || *r.RequireLocalTests
}

// GetTicketPattern returns the configured ticket regex or the default.
func (j *JiraConfig) GetTicketPattern() string {
	if j == nil || j.TicketPattern == nil || *j.TicketPattern == "" {
		return defaultJiraTicketPattern
	}
	return *j.TicketPattern
}

// GetURL returns the configured JIRA base URL (trailing slash trimmed) or "".
func (j *JiraConfig) GetURL() string {
	if j == nil || j.URL == nil {
		return ""
	}
	return strings.TrimRight(*j.URL, "/")
}

// Merge merges another ReviewConfig into this one: scalar pointer fields are
// overridden when the other sets them (non-nil); the ProtectedBranches list unions
// across layers like the sandbox path/host lists. nil leaves the existing value.
func (r *ReviewConfig) Merge(other ReviewConfig) {
	if other.Provider != nil {
		r.Provider = other.Provider
	}
	if other.Remote != nil {
		r.Remote = other.Remote
	}
	if other.Auth != nil {
		r.Auth = other.Auth
	}
	if other.DefaultAction != nil {
		r.DefaultAction = other.DefaultAction
	}
	if other.PublishWhenGreen != nil {
		r.PublishWhenGreen = other.PublishWhenGreen
	}
	if other.ProtectedBranches != nil {
		r.ProtectedBranches = unionStrings(r.ProtectedBranches, other.ProtectedBranches)
	}
	if other.PushBranchTemplate != nil {
		r.PushBranchTemplate = other.PushBranchTemplate
	}
	if other.Draft != nil {
		r.Draft = other.Draft
	}
	if other.Squash != nil {
		r.Squash = other.Squash
	}
	if other.DeleteRemoteBranch != nil {
		r.DeleteRemoteBranch = other.DeleteRemoteBranch
	}
	if other.RequireLocalTests != nil {
		r.RequireLocalTests = other.RequireLocalTests
	}
}

// Merge merges another JiraConfig into this one (scalar pointer override).
func (j *JiraConfig) Merge(other JiraConfig) {
	if other.URL != nil {
		j.URL = other.URL
	}
	if other.TicketPattern != nil {
		j.TicketPattern = other.TicketPattern
	}
}

// Validate checks the review/jira config for illegal enum values and a compilable
// ticket pattern. Called by decodeConfig so a bad value surfaces at load time.
func (r *ReviewConfig) Validate() error {
	if r == nil {
		return nil
	}
	switch r.GetProvider() {
	case ReviewProviderAuto, ReviewProviderGitHub, ReviewProviderGitLab:
	default:
		return errtrace.Wrap(fmt.Errorf("[review] provider = %q: must be auto, github, or gitlab", *r.Provider))
	}
	switch r.GetAuth() {
	case ReviewAuthCLI, ReviewAuthToken:
	default:
		return errtrace.Wrap(fmt.Errorf("[review] auth = %q: must be cli or token", *r.Auth))
	}
	switch r.GetDefaultAction() {
	case ReviewActionMerge, ReviewActionCreateMR:
	default:
		return errtrace.Wrap(fmt.Errorf("[review] default_action = %q: must be merge or create_mr", *r.DefaultAction))
	}
	return nil
}

// Validate checks the jira config's ticket pattern compiles.
func (j *JiraConfig) Validate() error {
	if j == nil {
		return nil
	}
	if _, err := regexp.Compile(j.GetTicketPattern()); err != nil {
		return errtrace.Wrap(fmt.Errorf("[jira] ticket_pattern %q: %w", j.GetTicketPattern(), err))
	}
	return nil
}

// ResolveProvider returns the concrete provider ("github" or "gitlab") for this
// config given the remote's URL. An explicit provider setting wins; "auto" (or
// unset) detects from the URL. Returns "" when auto-detection can't decide (an
// unrecognized self-hosted host) - callers then explain what to set.
func (r *ReviewConfig) ResolveProvider(remoteURL string) string {
	switch r.GetProvider() {
	case ReviewProviderGitHub:
		return ReviewProviderGitHub
	case ReviewProviderGitLab:
		return ReviewProviderGitLab
	default: // auto
		return DetectProvider(remoteURL)
	}
}

// DetectProvider guesses the forge provider from a git remote URL by its host:
// a host containing "github" -> github, "gitlab" -> gitlab, else "". It handles
// both SSH (git@github.com:org/repo.git) and HTTPS (https://gitlab.corp.com/...)
// forms. Self-hosted GitHub Enterprise / GitLab often carry the vendor name in
// the host (github.corp.com, gitlab.corp.com); anything else is unresolvable and
// must be set explicitly.
func DetectProvider(remoteURL string) string {
	host := RemoteHost(remoteURL)
	low := strings.ToLower(host)
	switch {
	case strings.Contains(low, "github"):
		return ReviewProviderGitHub
	case strings.Contains(low, "gitlab"):
		return ReviewProviderGitLab
	default:
		return ""
	}
}

// branchPlaceholderRe matches any {name} placeholder, used to strip unknown ones
// after expansion so they don't leak into a branch name.
var branchPlaceholderRe = regexp.MustCompile(`\{[a-zA-Z_]+\}`)

// ExpandBranchTemplate expands a push_branch_template (placeholders {id},
// {ticket}, {base}) into a concrete downstream branch name using vals. A
// placeholder that expands to nothing collapses its adjacent separator characters
// ('-', '_', '/') and empty path segments are dropped, so "feat/{ticket}-{id}"
// with no ticket yields "feat/<id>" (docs/non-local-integration.md). Unknown
// placeholders are treated as empty. There is deliberately no ${x:-fallback}
// syntax - the collapse rule covers the real cases.
func ExpandBranchTemplate(tmpl string, vals map[string]string) string {
	repl := tmpl
	for k, v := range vals {
		repl = strings.ReplaceAll(repl, "{"+k+"}", v)
	}
	repl = branchPlaceholderRe.ReplaceAllString(repl, "") // drop unknown placeholders
	segs := strings.Split(repl, "/")
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		if s = collapseSeparators(s); s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, "/")
}

// collapseSeparators collapses runs of '-'/'_' to a single character and trims
// leading/trailing separators - the within-segment half of the empty-expansion
// collapse rule.
func collapseSeparators(s string) string {
	var b strings.Builder
	prevSep := false
	for _, r := range s {
		sep := r == '-' || r == '_'
		if sep && prevSep {
			continue
		}
		b.WriteRune(r)
		prevSep = sep
	}
	return strings.Trim(b.String(), "-_")
}

// ExtractTicket returns the first ticket key matching pattern in text, or "".
// A pattern that fails to compile yields "" (Validate rejects such configs at
// load, so this is only a runtime safety net).
func ExtractTicket(text, pattern string) string {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return ""
	}
	return re.FindString(text)
}

// RemoteHost extracts the host from a git remote URL, handling scp-like SSH
// syntax (git@host:path), ssh:// URLs, and https:// URLs. Returns "" if it can't
// parse one. Kept dependency-free (no net/url) so it copes with the scp form url
// parsing rejects.
func RemoteHost(remoteURL string) string {
	u := strings.TrimSpace(remoteURL)
	if u == "" {
		return ""
	}
	// Strip a scheme like https:// or ssh://.
	if _, rest, ok := strings.Cut(u, "://"); ok {
		// Drop any user@ prefix.
		if at := strings.LastIndex(rest, "@"); at >= 0 {
			rest = rest[at+1:]
		}
		// Host ends at the first '/' or ':'.
		rest = strings.TrimPrefix(rest, "/")
		if j := strings.IndexAny(rest, "/:"); j >= 0 {
			return rest[:j]
		}
		return rest
	}
	// scp-like: [user@]host:path
	if at := strings.LastIndex(u, "@"); at >= 0 {
		u = u[at+1:]
	}
	if host, _, ok := strings.Cut(u, ":"); ok {
		return host
	}
	return ""
}

// BrowseURL derives the forge's https browse URL for a repository from its git
// remote URL, so the UI can link out to it with no forge API call. Returns
// "" when the URL can't be parsed. Both SSH and HTTPS forms map to
// "https://<host>/<org>/<repo>" with any trailing ".git" stripped.
func BrowseURL(remoteURL string) string {
	u := strings.TrimSpace(remoteURL)
	if u == "" {
		return ""
	}
	host := RemoteHost(u)
	if host == "" {
		return ""
	}
	var path string
	if _, rest, ok := strings.Cut(u, "://"); ok {
		if at := strings.LastIndex(rest, "@"); at >= 0 {
			rest = rest[at+1:]
		}
		if _, p, ok := strings.Cut(rest, "/"); ok {
			path = p
		}
	} else {
		// scp-like host:path
		s := u
		if at := strings.LastIndex(s, "@"); at >= 0 {
			s = s[at+1:]
		}
		if _, p, ok := strings.Cut(s, ":"); ok {
			path = p
		}
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	if path == "" {
		return ""
	}
	return "https://" + host + "/" + path
}
