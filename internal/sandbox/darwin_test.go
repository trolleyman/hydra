//go:build darwin

package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildSpecDarwinImmutablePathOverridesWritableParent(t *testing.T) {
	worktree := t.TempDir()
	home := t.TempDir()
	immutable := filepath.Join(worktree, "policy.json")
	if err := os.WriteFile(immutable, []byte("seed"), 0o600); err != nil {
		t.Fatal(err)
	}

	spec, err := BuildSpec(Options{
		WorktreePath:   worktree,
		Home:           home,
		ImmutablePaths: []string{immutable},
		Env:            os.Environ(),
		Argv: []string{
			"/bin/sh", "-c",
			`test "$(cat "$1")" = seed || exit 41; printf changed >> "$1"`, "sh", immutable,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()

	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	output, runErr := cmd.CombinedOutput()
	if strings.Contains(string(output), "sandbox_apply: Operation not permitted") {
		t.Skip("sandbox-exec cannot nest inside the test runner's existing sandbox")
	}
	if runErr == nil {
		if profile, readErr := os.ReadFile(spec.Args[2]); readErr == nil {
			t.Logf("profile:\n%s", profile)
		}
		t.Fatal("sandboxed write to immutable input succeeded")
	}
	if data, err := os.ReadFile(immutable); err != nil {
		t.Fatal(err)
	} else if string(data) != "seed" {
		t.Fatalf("immutable input changed to %q", data)
	}
}

func TestCanonicalSBPathResolvesMacOSCompatibilityAliases(t *testing.T) {
	for input, want := range map[string]string{
		"/tmp": "/private/tmp",
		"/var": "/private/var",
	} {
		if got := canonicalSBPath(input); got != want {
			t.Errorf("canonicalSBPath(%q) = %q, want %q", input, got, want)
		}
	}
}
