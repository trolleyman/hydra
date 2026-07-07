package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

func strptr(s string) *string { return &s }
func boolptr(b bool) *bool    { return &b }

// TestSaveReviewLocalCreates writes into a project with no config.local.toml and
// verifies the file is created and reloads with the saved values.
func TestSaveReviewLocalCreates(t *testing.T) {
	root := t.TempDir()
	upd := ReviewConfig{
		Provider:      strptr("github"),
		DefaultAction: strptr("create_mr"),
		Draft:         boolptr(false),
	}
	if err := SaveReviewLocal(root, upd); err != nil {
		t.Fatal(err)
	}
	path := paths.GetProjectConfigLocalPath(root)
	cfg, err := LoadFile(path)
	if err != nil || cfg == nil || cfg.Review == nil {
		t.Fatalf("reload: cfg=%v err=%v", cfg, err)
	}
	if cfg.Review.GetProvider() != "github" {
		t.Errorf("provider = %q, want github", cfg.Review.GetProvider())
	}
	if cfg.Review.GetDefaultAction() != "create_mr" {
		t.Errorf("default_action = %q, want create_mr", cfg.Review.GetDefaultAction())
	}
	if cfg.Review.IsDraft() {
		t.Error("draft = true, want false")
	}
}

// TestSaveReviewLocalPreservesOtherSections rewrites only [review], leaving an
// unrelated section untouched, and merges over the local file's own prior review
// values (an unedited field survives).
func TestSaveReviewLocalPreservesOtherSections(t *testing.T) {
	root := t.TempDir()
	path := paths.GetProjectConfigLocalPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	initial := "" +
		"[review]\n" +
		"provider = \"gitlab\"\n" +
		"target_branch = \"develop\"\n" +
		"\n" +
		"[claude.sandbox]\n" +
		"writable_paths = [\"/tmp/x\"]\n"
	if err := os.WriteFile(path, []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}

	// Edit only draft; target_branch (local-only) must survive the rewrite.
	if err := SaveReviewLocal(root, ReviewConfig{Draft: boolptr(false)}); err != nil {
		t.Fatal(err)
	}
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.Contains(got, "[claude.sandbox]") || !strings.Contains(got, "writable_paths") {
		t.Errorf("unrelated section not preserved:\n%s", got)
	}

	cfg, err := LoadFile(path)
	if err != nil || cfg == nil || cfg.Review == nil {
		t.Fatalf("reload: cfg=%v err=%v", cfg, err)
	}
	if cfg.Review.GetProvider() != "gitlab" {
		t.Errorf("provider = %q, want gitlab (preserved)", cfg.Review.GetProvider())
	}
	if cfg.Review.GetTargetBranch() != "develop" {
		t.Errorf("target_branch = %q, want develop (preserved)", cfg.Review.GetTargetBranch())
	}
	if cfg.Review.IsDraft() {
		t.Error("draft = true, want false (edited)")
	}
	// The [review] table must appear exactly once after the rewrite.
	if n := strings.Count(got, "[review]"); n != 1 {
		t.Errorf("[review] appears %d times, want 1:\n%s", n, got)
	}
}
