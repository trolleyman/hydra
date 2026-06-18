package heads

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// TestRunPreExitScript checks the sandboxed teardown hook runs the configured
// script from the worktree with the HYDRA_* head-context env exported. It needs a
// working sandbox (bwrap), so it skips where one isn't available (e.g. a nested
// dev sandbox without unprivileged userns).
func TestRunPreExitScript(t *testing.T) {
	if ok, reason := sandbox.Available(); !ok {
		t.Skipf("sandbox unavailable: %s", reason)
	}

	dir := t.TempDir()
	// A real git repo so gitCommonDir resolves and the worktree binds cleanly.
	if out, err := exec.Command("git", "-C", dir, "init").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}

	cfgPath := config.GetProjectConfigPath(dir)
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
		t.Fatal(err)
	}
	// The script writes its env to a file in cwd (the worktree), so the test can
	// assert both that it ran and that the variables propagated. pre_exit_script
	// is a [sandbox] key.
	body := "[sandbox]\n" +
		`pre_exit_script = "printf '%s|%s|%s' \"$HYDRA_HEAD_ID\" \"$HYDRA_END_STATE\" \"$HYDRA_BRANCH\" > exit.out"` + "\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}

	branch := "hydra/abc123"
	head := Head{
		ID:          "abc123",
		ProjectPath: dir,
		Worktree:    &dir,
		AgentType:   sandbox.AgentTypeClaude,
		Branch:      &branch,
		BaseBranch:  "main",
	}
	runPreExitScript(context.Background(), head, "merged")

	got, err := os.ReadFile(filepath.Join(dir, "exit.out"))
	if err != nil {
		t.Fatalf("pre_exit_script did not write its marker: %v", err)
	}
	if want := "abc123|merged|hydra/abc123"; string(got) != want {
		t.Fatalf("env mismatch: got %q want %q", got, want)
	}
}

// TestRunPreExitScriptNoConfig is a no-op when no script is configured (and must
// not attempt to build a sandbox). Runs everywhere.
func TestRunPreExitScriptNoConfig(t *testing.T) {
	dir := t.TempDir()
	head := Head{ID: "x", ProjectPath: dir, Worktree: &dir, AgentType: sandbox.AgentTypeClaude}
	runPreExitScript(context.Background(), head, "killed") // must not panic or error
	if _, err := os.Stat(filepath.Join(dir, "exit.out")); !os.IsNotExist(err) {
		t.Fatalf("unexpected side effect with no script configured")
	}
}
