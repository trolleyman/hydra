package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

// TestWrapPreSpawnExecutes runs the production pre-spawn wrapper as a real
// process to verify the runtime behavior the manual resume check exercises:
// the script runs, the real command execs after it, a non-zero exit gates the
// launch, and re-running it re-creates a deleted marker (the "marker reappears
// on resume" property — every launch, spawn or resume, re-runs the script). It
// uses WrapPreSpawn directly, the same wrapper startAgentSession applies on both
// the spawn and the resume path. (The bwrap confinement around it can't run
// nested in CI, so this exercises the wrapper itself, not the full sandbox.)
func TestWrapPreSpawnExecutes(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")     // written by the pre-spawn script
	execMarker := filepath.Join(dir, "execed") // written by the "real" command

	// Single-quote the temp paths so the embedded script is shell-safe.
	q := func(p string) string { return "'" + p + "'" }
	script := "echo spawned > " + q(marker)
	argv := []string{"/bin/sh", "-c", "echo ran > " + q(execMarker)}

	run := func(t *testing.T, wrapped []string) error {
		t.Helper()
		cmd := exec.Command(wrapped[0], wrapped[1:]...) //errtrace:skip
		out, err := cmd.CombinedOutput()
		if len(out) > 0 {
			t.Logf("output: %s", out)
		}
		return err
	}

	wrapped := WrapPreSpawn(script, argv)
	if err := run(t, wrapped); err != nil {
		t.Fatalf("run wrapped pre-spawn: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("pre-spawn script did not run (no marker): %v", err)
	}
	if _, err := os.Stat(execMarker); err != nil {
		t.Fatalf("real command did not exec after the script: %v", err)
	}

	// Resume analog: delete the marker and launch again — the script re-runs and
	// the marker reappears (so a script added/changed after a head exists reaches
	// it on the next launch, and idempotent scripts converge).
	if err := os.Remove(marker); err != nil {
		t.Fatalf("remove marker: %v", err)
	}
	if err := run(t, wrapped); err != nil {
		t.Fatalf("re-run wrapped pre-spawn: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("marker did not reappear on the second launch: %v", err)
	}

	// A non-zero exit gates the launch: the real command must NOT exec. This is
	// the failure semantics the change extends to resume — a failing script
	// aborts resume too, so scripts must be robust.
	gate := filepath.Join(dir, "should-not-exist")
	gateArgv := []string{"/bin/sh", "-c", "echo leaked > " + q(gate)}
	if err := run(t, WrapPreSpawn("exit 3", gateArgv)); err == nil {
		t.Fatal("expected non-zero exit from a failing pre-spawn script")
	}
	if _, err := os.Stat(gate); err == nil {
		t.Fatal("real command ran despite a failing pre-spawn script (launch not gated)")
	}
}

func TestWithPreSpawn(t *testing.T) {
	argv := []string{"claude", "--dangerously-skip-permissions"}

	// No script: argv is returned unchanged.
	if got := withPreSpawn("", argv); !reflect.DeepEqual(got, argv) {
		t.Errorf("empty script: got %v, want %v", got, argv)
	}
	if got := withPreSpawn("   \n\t ", argv); !reflect.DeepEqual(got, argv) {
		t.Errorf("blank script: got %v, want %v", got, argv)
	}

	// Empty argv: nothing to wrap.
	if got := withPreSpawn("echo hi", nil); got != nil {
		t.Errorf("empty argv: got %v, want nil", got)
	}

	// Script set, no shebang: defaults to /bin/bash -c, exec'ing argv via "$@".
	got := withPreSpawn("mise trust", argv)
	want := []string{"/bin/bash", "-c", "mise trust\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wrapped argv:\n got %#v\nwant %#v", got, want)
	}

	// A shebang selects the interpreter (here zsh); the script body, shebang line
	// included, is passed verbatim to `-c`.
	body := "#!/bin/zsh\nset -o pipefail\nmise trust"
	got = withPreSpawn(body, argv)
	want = []string{"/bin/zsh", "-c", body + "\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("zsh shebang:\n got %#v\nwant %#v", got, want)
	}

	// `#!/usr/bin/env bash` keeps both fields, so it runs as `env bash -c …`.
	got = withPreSpawn("#!/usr/bin/env bash\necho hi", argv)
	if len(got) < 3 || got[0] != "/usr/bin/env" || got[1] != "bash" || got[2] != "-c" {
		t.Errorf("env shebang: got %#v", got)
	}
}

func TestPreSpawnInterp(t *testing.T) {
	cases := []struct {
		script string
		want   []string
	}{
		{"mise trust", []string{"/bin/bash"}},
		{"\n\n  echo hi", []string{"/bin/bash"}},                              // leading blank lines, no shebang
		{"#!/bin/zsh\necho hi", []string{"/bin/zsh"}},                         // simple shebang
		{"  \n#!/bin/sh", []string{"/bin/sh"}},                                // leading blank lines before #! are tolerated
		{"# a comment\n#!/bin/sh", []string{"/bin/bash"}},                     // #! after a real line → not a shebang
		{"#!/usr/bin/env bash -e\nx", []string{"/usr/bin/env", "bash", "-e"}}, // args preserved
		{"#!\nx", []string{"/bin/bash"}},                                      // empty shebang → default
	}
	for _, c := range cases {
		if got := preSpawnInterp(c.script); !reflect.DeepEqual(got, c.want) {
			t.Errorf("preSpawnInterp(%q) = %#v, want %#v", c.script, got, c.want)
		}
	}
}
