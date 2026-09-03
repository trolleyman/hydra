package heads

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/statepath"
)

func TestBuildShellCommandSpecUsesHeadPolicy(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv(statepath.Environment, filepath.Join(home, "state"))
	root := t.TempDir()
	if out, err := exec.Command("git", "-C", root, "init", "-q", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	launch, cleanup, err := buildShellCommandSpec(root, root, "head-1", sandbox.AgentTypeCodex, ShellCommandPolicy{
		WorkingDirReadOnly: true,
		GitIsolation:       string(sandbox.GitIsolationReadonly),
	}, "true")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	args := strings.Join(launch.Args, "\x00")
	if !strings.Contains(args, "--ro-bind\x00"+root+"\x00"+root) {
		t.Fatalf("sandbox args do not make the working directory read-only: %q", args)
	}
	gitDir := filepath.Join(root, ".git")
	if !strings.Contains(args, "--ro-bind\x00"+gitDir+"\x00"+gitDir) {
		t.Fatalf("sandbox args do not preserve git isolation: %q", args)
	}
}
