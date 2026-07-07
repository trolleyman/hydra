package config

import "testing"

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

func TestExtractTicket(t *testing.T) {
	if got := ExtractTicket("implement PROJ-1234 rate limit", defaultJiraTicketPattern); got != "PROJ-1234" {
		t.Errorf("ExtractTicket = %q, want PROJ-1234", got)
	}
	if got := ExtractTicket("no ticket here", defaultJiraTicketPattern); got != "" {
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

func TestRenderReviewExampleWhenAbsent(t *testing.T) {
	out := renderConfig(nil, Config{})
	if !contains(out, "# [review]") {
		t.Errorf("expected commented [review] example; output tail:\n%s", out)
	}
}
