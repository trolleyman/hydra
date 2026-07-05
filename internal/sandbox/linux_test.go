//go:build linux

package sandbox

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// argIndex returns the index of the first occurrence of want in args, or -1.
func argIndex(args []string, want string) int {
	for i, a := range args {
		if a == want {
			return i
		}
	}
	return -1
}

// hasPair reports whether args contains flag followed immediately by a, then b.
func hasPair(args []string, flag, a, b string) bool {
	for i := 0; i+2 < len(args); i++ {
		if args[i] == flag && args[i+1] == a && args[i+2] == b {
			return true
		}
	}
	return false
}

func TestBuildSpecLinux(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	cache := filepath.Join(home, ".cache")
	secret := filepath.Join(home, ".ssh")
	gitcfg := filepath.Join(home, ".config", "git")
	for _, d := range []string{work, cache, secret, gitcfg} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	opts := Options{
		AgentType:     AgentTypeClaude,
		WorktreePath:  work,
		Home:          home,
		WritablePaths: []string{"~/.cache", "~/.does-not-exist"},
		MaskedPaths:   []string{"~/.ssh", "~/.config"},
		RestoreRO:     []string{"~/.config/git"},
		Network:       NetworkPolicy{Enabled: false},
		HardenGUI:     true,
		Seccomp:       false,
		Argv:          []string{"claude", "--dangerously-skip-permissions"},
	}

	spec, err := BuildSpec(opts)
	if err != nil {
		t.Fatalf("BuildSpec: %v", err)
	}
	defer spec.Cleanup()
	args := spec.Args

	if !strings.HasSuffix(spec.Path, "bwrap") {
		t.Errorf("Path = %q, want .../bwrap", spec.Path)
	}
	if !hasPair(args, "--ro-bind", "/", "/") {
		t.Error("missing --ro-bind / /")
	}
	// Worktree must be writable.
	if !hasPair(args, "--bind", work, work) {
		t.Error("worktree not bound writable")
	}
	// Existing writable path bound; non-existent one skipped.
	if !hasPair(args, "--bind", cache, cache) {
		t.Error("~/.cache not bound writable")
	}
	if argIndex(args, filepath.Join(home, ".does-not-exist")) != -1 {
		t.Error("non-existent writable path should be skipped")
	}
	// Masked dir -> tmpfs.
	if !hasPair2(args, "--tmpfs", secret) {
		t.Error("~/.ssh not masked with tmpfs")
	}
	// Restore RO applied after mask.
	maskIdx := pairIndex(args, "--tmpfs", filepath.Join(home, ".config"))
	restoreIdx := pairIndex(args, "--ro-bind", gitcfg)
	if maskIdx == -1 || restoreIdx == -1 {
		t.Fatalf("expected mask(%d) and restore(%d) present", maskIdx, restoreIdx)
	}
	if restoreIdx < maskIdx {
		t.Error("restore must come after mask")
	}
	// Network disabled.
	if argIndex(args, "--unshare-net") == -1 {
		t.Error("expected --unshare-net when network disabled")
	}
	// chdir to worktree.
	if !hasPair2(args, "--chdir", work) {
		t.Error("missing --chdir worktree")
	}
	// Argv after --.
	dashIdx := argIndex(args, "--")
	if dashIdx == -1 || args[len(args)-1] != "--dangerously-skip-permissions" {
		t.Error("argv not appended after --")
	}
	// GUI hardening unsets DISPLAY.
	if !hasPair2(args, "--unsetenv", "DISPLAY") {
		t.Error("expected --unsetenv DISPLAY with HardenGUI")
	}
	// The sandbox is pinned to the host uid/gid so hard mode's pasta userns (which
	// maps the host user to uid 0) can't make the agent appear as root - which
	// would trip Claude's "cannot be used with root/sudo privileges" refusal.
	// --uid requires an explicit --unshare-user.
	if argIndex(args, "--unshare-user") == -1 {
		t.Error("expected --unshare-user (required for --uid)")
	}
	if !hasPair2(args, "--uid", strconv.Itoa(os.Getuid())) {
		t.Errorf("expected --uid %d to pin the host user", os.Getuid())
	}
	if !hasPair2(args, "--gid", strconv.Itoa(os.Getgid())) {
		t.Errorf("expected --gid %d to pin the host group", os.Getgid())
	}
}

func TestBuildSpecNetworkEnabled(t *testing.T) {
	home := t.TempDir()
	opts := Options{Home: home, WorktreePath: home, Network: NetworkPolicy{Enabled: true}, Argv: []string{"true"}}
	spec, err := BuildSpec(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()
	if argIndex(spec.Args, "--unshare-net") != -1 {
		t.Error("should not unshare net when network enabled")
	}
}

// TestBuildSpecLinuxCowMount checks a CowMount is translated into either an
// overlayfs mount (when this bwrap supports overlay) or a read-only bind
// fallback, and that the read-only variant (empty Upper/Work) always binds.
func TestBuildSpecLinuxCowMount(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	lower := filepath.Join(home, "src", "out")
	upper := filepath.Join(home, "cow", "upper")
	cowWork := filepath.Join(home, "cow", "work")
	dest := filepath.Join(work, "pipeline", "out")
	for _, d := range []string{work, lower, upper, cowWork, dest} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	opts := Options{
		AgentType:    AgentTypeClaude,
		WorktreePath: work,
		Home:         home,
		CowMounts:    []CowMount{{Lower: lower, Upper: upper, Work: cowWork, Dest: dest}},
		Argv:         []string{"claude"},
	}
	spec, err := BuildSpec(opts)
	if err != nil {
		t.Fatalf("BuildSpec: %v", err)
	}
	defer spec.Cleanup()

	if bwrapSupportsOverlay(spec.Path) {
		// --overlay-src lower --overlay upper work dest
		i := pairIndex(spec.Args, "--overlay-src", lower)
		if i == -1 {
			t.Fatalf("missing --overlay-src %s in %v", lower, spec.Args)
		}
		if !(spec.Args[i+2] == "--overlay" && spec.Args[i+3] == upper && spec.Args[i+4] == cowWork && spec.Args[i+5] == dest) {
			t.Errorf("overlay args malformed near %v", spec.Args[i:])
		}
	} else if !hasPair(spec.Args, "--ro-bind", lower, dest) {
		t.Errorf("expected --ro-bind %s %s fallback in %v", lower, dest, spec.Args)
	}

	// A read-only COW mount (no Upper/Work) must always be a read-only bind.
	roOpts := opts
	roOpts.CowMounts = []CowMount{{Lower: lower, Dest: dest}}
	roSpec, err := BuildSpec(roOpts)
	if err != nil {
		t.Fatalf("BuildSpec ro: %v", err)
	}
	defer roSpec.Cleanup()
	if !hasPair(roSpec.Args, "--ro-bind", lower, dest) {
		t.Errorf("read-only cow mount should --ro-bind %s %s, got %v", lower, dest, roSpec.Args)
	}
}

// TestBuildSpecLinuxCowSupersedesWritableBind checks that a CowMount whose Dest
// equals a configured writable path (e.g. a home-anchored cow_paths entry like
// "~/.gradle") suppresses the plain writable --bind on that target: the overlay
// and a writable --bind cannot coexist, so only the overlay (or its read-only
// fallback) is emitted.
func TestBuildSpecLinuxCowSupersedesWritableBind(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	gradle := filepath.Join(home, ".gradle") // lower == dest for a home overlay
	upper := filepath.Join(home, "cow", "upper")
	cowWork := filepath.Join(home, "cow", "work")
	for _, d := range []string{work, gradle, upper, cowWork} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	opts := Options{
		AgentType:     AgentTypeClaude,
		WorktreePath:  work,
		Home:          home,
		WritablePaths: []string{"~/.gradle"},
		CowMounts:     []CowMount{{Lower: gradle, Upper: upper, Work: cowWork, Dest: gradle}},
		Argv:          []string{"claude"},
	}
	spec, err := BuildSpec(opts)
	if err != nil {
		t.Fatalf("BuildSpec: %v", err)
	}
	defer spec.Cleanup()

	// The writable --bind on the overlaid target must be suppressed.
	if hasPair(spec.Args, "--bind", gradle, gradle) {
		t.Errorf("writable --bind %s should be superseded by the overlay, got %v", gradle, spec.Args)
	}
	// The overlay (or its read-only bind fallback) must still be present.
	overlaid := pairIndex(spec.Args, "--overlay-src", gradle) != -1 || hasPair(spec.Args, "--ro-bind", gradle, gradle)
	if !overlaid {
		t.Errorf("expected an overlay or ro-bind on %s, got %v", gradle, spec.Args)
	}
}

// hasPair2 reports whether args contains flag immediately followed by a.
func hasPair2(args []string, flag, a string) bool {
	return pairIndex(args, flag, a) != -1
}

// pairIndex returns the index of flag where it is immediately followed by a.
func pairIndex(args []string, flag, a string) int {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == a {
			return i
		}
	}
	return -1
}
