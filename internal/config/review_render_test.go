package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bptr(b bool) *bool { return &b }

// TestRenderConfigEmitsReview verifies renderConfig writes a real [review] table
// from cfg.Review (only the set fields) and that it reloads to the same values -
// the round-trip the Settings Review editor relies on.
func TestRenderConfigEmitsReview(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	cfg := Config{Review: &ReviewConfig{
		Provider:      ptr("github"),
		TargetBranch:  ptr("develop"),
		DefaultAction: ptr("create_mr"),
		Draft:         bptr(false),
	}}
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "[review]") || !strings.Contains(got, `provider = "github"`) {
		t.Fatalf("expected a real [review] table, got:\n%s", got)
	}
	// A field left nil must not be written (so it keeps inheriting the layer below).
	if strings.Contains(got, "squash =") {
		t.Errorf("unset field squash should not be emitted:\n%s", got)
	}

	reload, err := LoadFile(path)
	if err != nil || reload == nil || reload.Review == nil {
		t.Fatalf("reload: cfg=%v err=%v", reload, err)
	}
	if reload.Review.GetProvider() != "github" || reload.Review.GetTargetBranch() != "develop" {
		t.Errorf("reloaded review = %+v", reload.Review)
	}
	if reload.Review.IsDraft() {
		t.Error("draft should have reloaded false")
	}
}

// TestRenderConfigReviewEditRoundTrip simulates the Settings save: load a file,
// change one review field, save, and confirm only that field changed on disk.
func TestRenderConfigReviewEditRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.local.toml")
	initial := "[review]\nprovider = \"gitlab\"\ntarget_branch = \"main\"\n"
	if err := os.WriteFile(path, []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile(path)
	if err != nil || cfg == nil || cfg.Review == nil {
		t.Fatalf("load: %v %v", cfg, err)
	}
	// Edit default_action, then save the whole config back (the SaveConfig flow).
	cfg.Review.DefaultAction = ptr("create_mr")
	if err := SaveToFile(path, *cfg); err != nil {
		t.Fatal(err)
	}
	reload, err := LoadFile(path)
	if err != nil || reload == nil || reload.Review == nil {
		t.Fatal(err)
	}
	if reload.Review.GetProvider() != "gitlab" || reload.Review.GetTargetBranch() != "main" {
		t.Errorf("preserved fields lost: %+v", reload.Review)
	}
	if reload.Review.GetDefaultAction() != "create_mr" {
		t.Errorf("edit not applied: %+v", reload.Review)
	}
}
