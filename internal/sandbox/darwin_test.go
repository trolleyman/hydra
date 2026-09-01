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

func TestBuildSpecDarwinPrivateTempPolicyAndEnvironment(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	home := filepath.Join(root, "home")
	tmpDir := filepath.Join(root, "state", "tmp", "head-one")
	controlDir := filepath.Join(root, "runtime", "head-control", "random-key")
	for _, dir := range []string{worktree, home, tmpDir, controlDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	spec, err := BuildSpec(Options{
		WorktreePath:   worktree,
		Home:           home,
		TmpDir:         tmpDir,
		WritablePaths:  []string{controlDir},
		Env:            []string{"PATH=/usr/bin", "TMPDIR=/shared", "TMP=/shared", "TEMP=/shared"},
		PreSpawnScript: `printf 'FROM_HOOK=1\n' >> "$HYDRA_ENV"`,
		Argv:           []string{"/bin/sh"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()

	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		want := key + "=" + tmpDir
		if !containsExact(spec.Env, want) {
			t.Errorf("spec.Env lacks %q: %v", want, spec.Env)
		}
	}
	if !strings.Contains(strings.Join(spec.Args, "\n"), filepath.Join(tmpDir, PreSpawnEnvFileName)) {
		t.Fatalf("pre-spawn wrapper does not persist under private temp: %v", spec.Args)
	}

	profileData, err := os.ReadFile(spec.Args[2])
	if err != nil {
		t.Fatal(err)
	}
	profile := string(profileData)
	tempDeny := `(deny file-read* file-write* ` + sbPathRule(os.TempDir()) + `)`
	ownAllow := `(allow file-read* file-write* ` + sbPathRule(tmpDir) + `)`
	controlAllow := `(allow file-read* file-write* ` + sbPathRule(controlDir) + `)`
	denyAt := strings.Index(profile, tempDeny)
	ownAt := strings.Index(profile, ownAllow)
	controlAt := strings.Index(profile, controlAllow)
	if denyAt < 0 || ownAt < 0 || controlAt < 0 {
		t.Fatalf("private temp profile rules missing:\n%s", profile)
	}
	if !(denyAt < ownAt && denyAt < controlAt) {
		t.Fatalf("narrow temp/control grants must follow shared-temp denial:\n%s", profile)
	}
}

func containsExact(entries []string, want string) bool {
	for _, entry := range entries {
		if entry == want {
			return true
		}
	}
	return false
}
