package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
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

	// A non-zero exit gates the launch AND reports it: the real command must NOT
	// exec, and the failure must surface as a diagnostic (not a silent early exit).
	// This is the failure semantics the change extends to resume — a failing script
	// aborts resume too, so it must be visible.
	gate := filepath.Join(dir, "should-not-exist")
	gateArgv := []string{"/bin/sh", "-c", "echo leaked > " + q(gate)}
	gateWrapped := WrapPreSpawn("exit 3", gateArgv)
	gateOut, gateErr := exec.Command(gateWrapped[0], gateWrapped[1:]...).CombinedOutput() //errtrace:skip
	if gateErr == nil {
		t.Fatalf("expected non-zero exit from a failing pre-spawn script; output: %s", gateOut)
	}
	if _, err := os.Stat(gate); err == nil {
		t.Fatal("real command ran despite a failing pre-spawn script (launch not gated)")
	}
	if !strings.Contains(string(gateOut), "pre_spawn_script failed") {
		t.Fatalf("expected a pre-spawn failure diagnostic; got: %q", gateOut)
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

	// Script set, no shebang: defaults to /bin/bash -c, exec'ing argv via "$@"
	// after an EXIT trap that reports a gating failure. Being bash, the body also
	// runs under the strict preamble (set -eo pipefail).
	got := withPreSpawn("mise trust", argv)
	want := []string{"/bin/bash", "-c", preSpawnExitTrap + "\n" + StrictShellPreamble + "mise trust\ntrap - EXIT\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wrapped argv:\n got %#v\nwant %#v", got, want)
	}

	// A shebang selects the interpreter (here zsh); the script body, shebang line
	// included, is passed verbatim to `-c` — and a non-bash interpreter gets NO
	// strict preamble (set -o pipefail is a bashism).
	body := "#!/bin/zsh\nset -o pipefail\nmise trust"
	got = withPreSpawn(body, argv)
	want = []string{"/bin/zsh", "-c", preSpawnExitTrap + "\n" + body + "\ntrap - EXIT\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("zsh shebang:\n got %#v\nwant %#v", got, want)
	}

	// `#!/usr/bin/env bash` keeps both fields, so it runs as `env bash -c …`.
	got = withPreSpawn("#!/usr/bin/env bash\necho hi", argv)
	if len(got) < 3 || got[0] != "/usr/bin/env" || got[1] != "bash" || got[2] != "-c" {
		t.Errorf("env shebang: got %#v", got)
	}
}

// TestWithPreSpawnStrict asserts the strict preamble is applied iff the
// interpreter is bash (the default or an explicit bash shebang), and never for a
// non-bash interpreter.
func TestWithPreSpawnStrict(t *testing.T) {
	argv := []string{"claude"}
	body := func(script string) string {
		got := withPreSpawn(script, argv)
		// The script body is the argument right after `-c` (its index shifts with
		// the interpreter, e.g. `env bash -c <body>` vs `/bin/bash -c <body>`).
		for i, a := range got {
			if a == "-c" && i+1 < len(got) {
				return got[i+1]
			}
		}
		t.Fatalf("withPreSpawn(%q) has no -c body: %#v", script, got)
		return ""
	}
	cases := []struct {
		name       string
		script     string
		wantStrict bool
	}{
		{"no shebang defaults bash", "mise trust", true},
		{"explicit bash shebang", "#!/bin/bash\nmise trust", true},
		{"env bash shebang", "#!/usr/bin/env bash\nmise trust", true},
		{"zsh shebang", "#!/bin/zsh\nmise trust", false},
		{"sh shebang", "#!/bin/sh\nmise trust", false},
		{"env python shebang", "#!/usr/bin/env python3\nprint(1)", false},
	}
	for _, c := range cases {
		got := strings.Contains(body(c.script), StrictShellPreamble)
		if got != c.wantStrict {
			t.Errorf("%s: strict preamble present=%v, want %v (body=%q)", c.name, got, c.wantStrict, body(c.script))
		}
	}
}

func TestStrictScript(t *testing.T) {
	if got := StrictScript("bun run shots.ts"); got != "set -eo pipefail\nbun run shots.ts" {
		t.Errorf("StrictScript = %q", got)
	}
	// nounset is deliberately absent so optional-env-var reads don't abort.
	if strings.Contains(StrictShellPreamble, "-u") || strings.Contains(StrictShellPreamble, "nounset") {
		t.Errorf("strict preamble must not enable nounset: %q", StrictShellPreamble)
	}
}

func TestInterpIsBash(t *testing.T) {
	cases := []struct {
		interp []string
		want   bool
	}{
		{[]string{"/bin/bash"}, true},
		{[]string{"bash"}, true},
		{[]string{"/usr/local/bin/bash"}, true},
		{[]string{"/usr/bin/env", "bash"}, true},
		{[]string{"/usr/bin/env", "-S", "bash"}, true},
		{[]string{"/usr/bin/env", "FOO=bar", "bash"}, true},
		{[]string{"/bin/zsh"}, false},
		{[]string{"/bin/sh"}, false},
		{[]string{"/usr/bin/env", "python3"}, false},
		{nil, false},
	}
	for _, c := range cases {
		if got := interpIsBash(c.interp); got != c.want {
			t.Errorf("interpIsBash(%#v) = %v, want %v", c.interp, got, c.want)
		}
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
