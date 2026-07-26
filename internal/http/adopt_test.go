package http

import (
	"context"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/heads"
)

func TestReviewPushTarget(t *testing.T) {
	root := t.TempDir() // no [review] config -> default remote "origin"
	// A fork PR carries its own clone URL; that is the push target.
	fork := heads.Head{ReviewAdopted: true, ReviewPushURL: "https://github.com/c/r.git"}
	if got := reviewPushTarget(root, fork); got != "https://github.com/c/r.git" {
		t.Errorf("fork push target = %q, want the clone URL", got)
	}
	// A same-repo PR (no push URL) falls back to the configured remote.
	same := heads.Head{ReviewAdopted: true}
	if got := reviewPushTarget(root, same); got != "origin" {
		t.Errorf("same-repo push target = %q, want origin", got)
	}
}

// TestPushHeadToMRReadOnly checks a read-only adopted PR is rejected before any
// git push is attempted, with an actionable message.
func TestPushHeadToMRReadOnly(t *testing.T) {
	s := &Server{}
	branch := "hydra/x"
	head := heads.Head{
		ID: "x", Branch: &branch, DownstreamBranch: "contributor:feat",
		ReviewAdopted: true, ReviewCanPush: false,
	}
	err := s.pushHeadToMR(context.Background(), t.TempDir(), head)
	if err == nil {
		t.Fatal("expected read-only PR push to be rejected")
	}
	if !strings.Contains(err.Error(), "read-only") {
		t.Errorf("error = %q, want a read-only hint", err)
	}
}

func TestMRRefToAPI(t *testing.T) {
	ref := mrRefToAPI(forge.MRRef{
		ID: "7", URL: "u", Title: "t", Author: "a", State: forge.StateOpen,
		Draft: false, HeadRef: "feat", HeadRepoURL: "https://x/fork.git",
		TargetBranch: "main", CrossRepo: true, CanPush: false,
	})
	if ref.Id != "7" || ref.HeadRef != "feat" || ref.TargetBranch != "main" {
		t.Errorf("core fields wrong: %+v", ref)
	}
	if !ref.CrossRepo || ref.CanPush {
		t.Errorf("cross/canPush wrong: cross=%v canPush=%v", ref.CrossRepo, ref.CanPush)
	}
	if ref.Author == nil || *ref.Author != "a" {
		t.Errorf("author not mapped: %+v", ref.Author)
	}
	if ref.HeadRepoUrl == nil || *ref.HeadRepoUrl != "https://x/fork.git" {
		t.Errorf("head repo url not mapped: %+v", ref.HeadRepoUrl)
	}
}
