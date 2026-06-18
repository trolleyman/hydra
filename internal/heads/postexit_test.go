package heads

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// TestRunPostExitScript checks the host-side hook runs the configured script
// from the project root with the HYDRA_* head-context env exported.
func TestRunPostExitScript(t *testing.T) {
	dir := t.TempDir()
	cfgPath := config.GetProjectConfigPath(dir)
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
		t.Fatal(err)
	}
	// The script writes its env to a file in cwd (the project root), so the test
	// can assert both that it ran and that the variables propagated.
	body := "[sandbox]\n" +
		`post_exit_script = "printf '%s|%s|%s' \"$HYDRA_HEAD_ID\" \"$HYDRA_END_STATE\" \"$HYDRA_BRANCH\" > exit.out"` + "\n"
	if err := os.WriteFile(cfgPath, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}

	branch := "hydra/abc123"
	head := Head{
		ID:          "abc123",
		ProjectPath: dir,
		AgentType:   sandbox.AgentTypeClaude,
		Branch:      &branch,
		BaseBranch:  "main",
	}
	runPostExitScript(context.Background(), head, "merged")

	got, err := os.ReadFile(filepath.Join(dir, "exit.out"))
	if err != nil {
		t.Fatalf("post_exit_script did not write its marker: %v", err)
	}
	if want := "abc123|merged|hydra/abc123"; string(got) != want {
		t.Fatalf("env mismatch: got %q want %q", got, want)
	}
}

// TestRunPostExitScriptNoConfig is a no-op when no script is configured.
func TestRunPostExitScriptNoConfig(t *testing.T) {
	dir := t.TempDir()
	head := Head{ID: "x", ProjectPath: dir, AgentType: sandbox.AgentTypeClaude}
	runPostExitScript(context.Background(), head, "killed") // must not panic or error
	if _, err := os.Stat(filepath.Join(dir, "exit.out")); !os.IsNotExist(err) {
		t.Fatalf("unexpected side effect with no script configured")
	}
}
