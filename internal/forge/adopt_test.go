package forge

import (
	"context"
	"strings"
	"testing"
)

// TestGithubListMRs checks the open-PR enumeration parses and that a fork PR
// (isCrossRepository) without maintainerCanModify is marked not-pushable while a
// same-repo PR is pushable.
func TestGithubListMRs(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "pr list") {
			if !strings.Contains(cmd, "--state open") {
				t.Errorf("default list should be --state open: %s", cmd)
			}
			return `[
			  {"number":1,"url":"https://gh.example.com/o/r/pull/1","title":"same repo","state":"OPEN","isDraft":false,"headRefName":"feat/a","baseRefName":"main","isCrossRepository":false,"maintainerCanModify":false,"author":{"login":"alice"}},
			  {"number":2,"url":"https://gh.example.com/o/r/pull/2","title":"from fork","state":"OPEN","isDraft":true,"headRefName":"feat/b","baseRefName":"main","isCrossRepository":true,"maintainerCanModify":false,"author":{"login":"bob"},"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"bob"}}
			]`, nil
		}
		return "", nil
	}}
	p := &githubProvider{run: f.run}
	list, err := p.ListMRs(context.Background(), "/repo", "origin", ListMROptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d MRs, want 2", len(list))
	}
	same, fork := list[0], list[1]
	if same.HeadRef != "feat/a" || same.TargetBranch != "main" || same.Author != "alice" {
		t.Errorf("same-repo MR parsed wrong: %+v", same)
	}
	if !same.CanPush {
		t.Error("same-repo PR should be pushable")
	}
	if same.CrossRepo || same.HeadRepoURL != "" {
		t.Errorf("same-repo PR should not be cross-repo/have a clone URL: %+v", same)
	}
	if fork.State != StateDraft {
		t.Errorf("fork PR state = %q, want draft", fork.State)
	}
	if !fork.CrossRepo || fork.CanPush {
		t.Errorf("fork PR without maintainerCanModify: cross=%v canPush=%v", fork.CrossRepo, fork.CanPush)
	}
	// The clone URL is built on the same host as the PR (handles GHES).
	if want := "https://gh.example.com/bob/r.git"; fork.HeadRepoURL != want {
		t.Errorf("fork clone URL = %q, want %q", fork.HeadRepoURL, want)
	}
}

// TestGithubGetMRForkPushable checks a fork PR with maintainerCanModify is
// pushable.
func TestGithubGetMRForkPushable(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "pr view") {
			return `{"number":7,"url":"https://github.com/o/r/pull/7","title":"t","state":"OPEN","headRefName":"x","baseRefName":"main","isCrossRepository":true,"maintainerCanModify":true,"author":{"login":"c"},"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"c"}}`, nil
		}
		return "", nil
	}}
	p := &githubProvider{run: f.run}
	ref, err := p.GetMR(context.Background(), "/repo", "origin", "7")
	if err != nil {
		t.Fatal(err)
	}
	if !ref.CrossRepo || !ref.CanPush {
		t.Errorf("fork PR with maintainerCanModify should be pushable: %+v", ref)
	}
	if ref.HeadRepoURL != "https://github.com/c/r.git" {
		t.Errorf("clone URL = %q", ref.HeadRepoURL)
	}
}

// TestGitlabListMRs checks MR enumeration and fork detection via project ids.
func TestGitlabListMRs(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "mr list") {
			if !strings.Contains(cmd, "--opened") {
				t.Errorf("default list should be --opened: %s", cmd)
			}
			return `[
			  {"iid":10,"web_url":"https://gl/g/p/-/merge_requests/10","title":"same","state":"opened","draft":false,"source_branch":"feat/a","target_branch":"main","source_project_id":5,"target_project_id":5,"author":{"username":"alice"}},
			  {"iid":11,"web_url":"https://gl/g/p/-/merge_requests/11","title":"fork","state":"opened","draft":true,"source_branch":"feat/b","target_branch":"main","allow_collaboration":true,"source_project_id":9,"target_project_id":5,"author":{"username":"bob"}}
			]`, nil
		}
		return "", nil
	}}
	p := &gitlabProvider{run: f.run}
	list, err := p.ListMRs(context.Background(), "/repo", "origin", ListMROptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d MRs, want 2", len(list))
	}
	same, fork := list[0], list[1]
	if same.CrossRepo || !same.CanPush {
		t.Errorf("same-project MR: cross=%v canPush=%v", same.CrossRepo, same.CanPush)
	}
	if !fork.CrossRepo {
		t.Error("differing project ids should be cross-repo")
	}
	if !fork.CanPush {
		t.Error("fork MR with allow_collaboration should be pushable")
	}
	if fork.State != StateDraft || fork.HeadRef != "feat/b" {
		t.Errorf("fork MR parsed wrong: %+v", fork)
	}
}

func TestUrlSchemeHost(t *testing.T) {
	cases := map[string]string{
		"https://github.com/o/r/pull/1":     "https://github.com",
		"https://gh.example.com/o/r/pull/2": "https://gh.example.com",
		"http://localhost:3000/o/r/pull/3":  "http://localhost:3000",
		"not a url":                         "",
		"":                                  "",
	}
	for in, want := range cases {
		if got := urlSchemeHost(in); got != want {
			t.Errorf("urlSchemeHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPRHeadRefspecShape(t *testing.T) {
	// Cross-checks the forge provider names line up with the git pseudo-ref
	// scheme without importing the git package here (that mapping lives in
	// git.PRHeadRefspec); this just documents the expected provider spellings.
	if ProviderGitHub != "github" || ProviderGitLab != "gitlab" {
		t.Fatalf("provider names changed: %q/%q - update git.PRHeadRefspec", ProviderGitHub, ProviderGitLab)
	}
}
