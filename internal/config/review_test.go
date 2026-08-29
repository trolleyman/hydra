package config

import (
	"strings"
	"testing"
)

func TestDetectProvider(t *testing.T) {
	cases := []struct {
		url  string
		want string
	}{
		{"git@github.com:org/repo.git", ReviewProviderGitHub},
		{"https://github.com/org/repo.git", ReviewProviderGitHub},
		{"https://gitlab.com/org/repo", ReviewProviderGitLab},
		{"git@gitlab.corp.com:group/repo.git", ReviewProviderGitLab},
		{"ssh://git@github.corp.com:22/org/repo.git", ReviewProviderGitHub},
		{"https://bitbucket.org/org/repo.git", ""},
		{"git@self-hosted.example.com:org/repo.git", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := DetectProvider(c.url); got != c.want {
			t.Errorf("DetectProvider(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

func TestResolveProviderExplicitWins(t *testing.T) {
	gl := ReviewProviderGitLab
	r := &ReviewConfig{Provider: &gl}
	// Explicit provider overrides a github-looking URL.
	if got := r.ResolveProvider("git@github.com:org/repo.git"); got != ReviewProviderGitLab {
		t.Errorf("ResolveProvider explicit = %q, want gitlab", got)
	}
	// auto falls back to detection.
	auto := &ReviewConfig{}
	if got := auto.ResolveProvider("git@github.com:org/repo.git"); got != ReviewProviderGitHub {
		t.Errorf("ResolveProvider auto = %q, want github", got)
	}
}

func TestReviewAutoPushDefaultsOnAndCanBeDisabled(t *testing.T) {
	if !(&ReviewConfig{}).IsAutoPush() {
		t.Fatal("automatic pushes should default on for newly linked MRs")
	}
	off := false
	if (&ReviewConfig{AutoPush: &off}).IsAutoPush() {
		t.Fatal("explicit auto_push=false should disable automatic pushes")
	}
	if (&ReviewConfig{PublishWhenGreen: &off}).IsAutoPush() {
		t.Fatal("legacy publish_when_green=false should remain compatible")
	}
	lines := strings.Join(reviewFieldLines(ReviewConfig{PublishWhenGreen: &off}), "\n")
	if !strings.Contains(lines, "auto_push = false") || strings.Contains(lines, "publish_when_green") {
		t.Fatalf("legacy setting should render canonically as auto_push, got:\n%s", lines)
	}
}

func TestBrowseURL(t *testing.T) {
	cases := []struct {
		url, want string
	}{
		{"git@github.com:org/repo.git", "https://github.com/org/repo"},
		{"https://gitlab.corp.com/group/sub/repo.git", "https://gitlab.corp.com/group/sub/repo"},
		{"ssh://git@github.com/org/repo.git", "https://github.com/org/repo"},
		{"not a url", ""},
	}
	for _, c := range cases {
		if got := BrowseURL(c.url); got != c.want {
			t.Errorf("BrowseURL(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

func TestExpandBranchTemplate(t *testing.T) {
	cases := []struct {
		tmpl string
		vals map[string]string
		want string
	}{
		{"{id}", map[string]string{"id": "cool-head"}, "cool-head"},
		{"feat/{issue}-{id}", map[string]string{"issue": "ENG-1", "id": "abc"}, "feat/ENG-1-abc"},
		// {ticket} remains a template-only compatibility alias.
		{"feat/{ticket}-{id}", map[string]string{"ticket": "PROJ-1", "id": "abc"}, "feat/PROJ-1-abc"},
		// Empty ticket collapses the adjacent '-' separator.
		{"feat/{ticket}-{id}", map[string]string{"ticket": "", "id": "abc"}, "feat/abc"},
		// Empty ticket path segment is dropped.
		{"feat/{ticket}/{id}", map[string]string{"ticket": "", "id": "abc"}, "feat/abc"},
		// Trailing empty placeholder trims the separator.
		{"{id}_{ticket}", map[string]string{"id": "x", "ticket": ""}, "x"},
		// Unknown placeholder dropped.
		{"{id}-{unknown}", map[string]string{"id": "x"}, "x"},
	}
	for _, c := range cases {
		if got := ExpandBranchTemplate(c.tmpl, c.vals); got != c.want {
			t.Errorf("ExpandBranchTemplate(%q, %v) = %q, want %q", c.tmpl, c.vals, got, c.want)
		}
	}
}

func TestReviewValidate(t *testing.T) {
	bad := "nope"
	if err := (&ReviewConfig{Provider: &bad}).Validate(); err == nil {
		t.Error("expected error for bad provider")
	}
	if err := (&ReviewConfig{Auth: &bad}).Validate(); err == nil {
		t.Error("expected error for bad auth")
	}
	if err := (&ReviewConfig{DefaultAction: &bad}).Validate(); err == nil {
		t.Error("expected error for bad default_action")
	}
	if err := (&ReviewConfig{Publisher: &bad}).Validate(); err == nil {
		t.Error("expected error for bad publisher")
	}
	badPattern := "["
	if err := (&ReviewConfig{IssuePattern: &badPattern}).Validate(); err == nil {
		t.Error("expected error for invalid issue_pattern")
	}
	graphite := ReviewPublisherGraphite
	gitlab := ReviewProviderGitLab
	if err := (&ReviewConfig{Provider: &gitlab, Publisher: &graphite}).Validate(); err == nil {
		t.Error("expected Graphite with GitLab to fail")
	}
	good := ReviewProviderGitHub
	if err := (&ReviewConfig{Provider: &good}).Validate(); err != nil {
		t.Errorf("unexpected error for good config: %v", err)
	}
	// nil receiver is valid.
	var nilR *ReviewConfig
	if err := nilR.Validate(); err != nil {
		t.Errorf("nil Validate: %v", err)
	}
}

func TestIssuePatternPrefersReviewAndFallsBackToJira(t *testing.T) {
	legacyPattern := "J-[0-9]+"
	linearPattern := "ENG-[0-9]+"
	cfg := Config{
		Review: &ReviewConfig{IssuePattern: &linearPattern},
		Jira:   &JiraConfig{TicketPattern: &legacyPattern},
	}
	if got := cfg.GetIssuePattern(); got != linearPattern {
		t.Fatalf("GetIssuePattern = %q, want %q", got, linearPattern)
	}
	cfg.Review.IssuePattern = nil
	if got := cfg.GetIssuePattern(); got != legacyPattern {
		t.Fatalf("legacy GetIssuePattern = %q, want %q", got, legacyPattern)
	}
}

func TestExtractTicket(t *testing.T) {
	if got := ExtractTicket("implement PROJ-1234 rate limit", defaultIssuePattern); got != "PROJ-1234" {
		t.Errorf("ExtractTicket = %q, want PROJ-1234", got)
	}
	if got := ExtractTicket("no ticket here", defaultIssuePattern); got != "" {
		t.Errorf("ExtractTicket = %q, want empty", got)
	}
}

func TestRenderPreservesReviewBlock(t *testing.T) {
	existing := []byte(`[review]
provider = "gitlab"
target_branch = "develop"

[jira]
url = "https://x.atlassian.net"
`)
	// A defaults-only save (Config{}) must not drop the hand-written tables.
	out := renderConfig(existing, Config{})
	for _, want := range []string{`provider = "gitlab"`, `target_branch = "develop"`, `url = "https://x.atlassian.net"`} {
		if !contains(out, want) {
			t.Errorf("renderConfig dropped %q; output:\n%s", want, out)
		}
	}
	// The preserved content must still parse back.
	cfg, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	if cfg.Review == nil || derefStr(cfg.Review.Provider) != "gitlab" {
		t.Errorf("round-trip Review = %+v", cfg.Review)
	}
}

func TestRemovedTicketsBlockHasNoEffectAndIsDropped(t *testing.T) {
	existing := []byte("[tickets]\nticket_pattern = \"ENG-[0-9]+\"\n")
	out := renderConfig(existing, Config{})
	if contains(out, "[tickets]") || contains(out, `ticket_pattern = "ENG-[0-9]+"`) {
		t.Fatalf("removed [tickets] table survived render:\n%s", out)
	}
	cfg, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GetIssuePattern() != defaultIssuePattern {
		t.Fatalf("removed [tickets] changed issue pattern to %q", cfg.GetIssuePattern())
	}
}

func TestRenderReviewExampleWhenAbsent(t *testing.T) {
	out := renderConfig(nil, Config{})
	if !contains(out, "# [review]") {
		t.Errorf("expected commented [review] example; output tail:\n%s", out)
	}
	// Prose lines of the example are Hydra docs and must carry the docPrefix,
	// per the file banner's stated convention (## = Hydra-owned, # = user's).
	if !contains(out, "\n"+docPrefix+" [review] configures how Hydra talks to a forge") {
		t.Errorf("review example prose is not a managed doc line; output tail:\n%s", out)
	}
	if contains(out, "\n# [review] configures how Hydra talks to a forge") {
		t.Errorf("review example prose still rendered as a plain user comment:\n%s", out)
	}
}

// TestRenderReviewExampleStable guards that re-rendering on top of a previous
// render keeps exactly one copy of the [review]/[jira] example, and that a real
// table appearing below the example does not glue the example's commented lines
// to itself as preserved user comments (they are regenerated, not user-owned).
func TestRenderReviewExampleStable(t *testing.T) {
	out1 := renderConfig(nil, Config{})
	out2 := renderConfig([]byte(out1), Config{})
	if got := strings.Count(out2, "\n# [review]\n"); got != 1 {
		t.Errorf("re-render has %d '# [review]' example headers, want 1:\n%s", got, out2)
	}

	// A hand-written [jira] table below the example: the example lines land in
	// the gap before it and must be dropped, not preserved as user comments.
	withJira := out1 + "\n[jira]\nurl = \"https://x.atlassian.net\"\n"
	out3 := renderConfig([]byte(withJira), Config{})
	if got := strings.Count(out3, `# provider = "auto"`); got != 1 {
		t.Errorf("example body duplicated/preserved as user comments (%d copies):\n%s", got, out3)
	}
	if !contains(out3, "url = \"https://x.atlassian.net\"") {
		t.Errorf("hand-written [jira] table dropped:\n%s", out3)
	}
}
