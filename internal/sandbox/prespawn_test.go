package sandbox

import (
	"braces.dev/errtrace"
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
// on resume" property - every launch, spawn or resume, re-runs the script). It
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
		cmd := exec.Command(wrapped[0], wrapped[1:]...)
		out, err := cmd.CombinedOutput()
		if len(out) > 0 {
			t.Logf("output: %s", out)
		}
		return errtrace.Wrap(err)
	}

	wrapped := WrapPreSpawn(script, "", argv)
	if err := run(t, wrapped); err != nil {
		t.Fatalf("run wrapped pre-spawn: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("pre-spawn script did not run (no marker): %v", err)
	}
	if _, err := os.Stat(execMarker); err != nil {
		t.Fatalf("real command did not exec after the script: %v", err)
	}

	// Resume analog: delete the marker and launch again - the script re-runs and
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
	// This is the failure semantics the change extends to resume - a failing script
	// aborts resume too, so it must be visible.
	gate := filepath.Join(dir, "should-not-exist")
	gateArgv := []string{"/bin/sh", "-c", "echo leaked > " + q(gate)}
	gateWrapped := WrapPreSpawn("exit 3", "", gateArgv)
	gateOut, gateErr := exec.Command(gateWrapped[0], gateWrapped[1:]...).CombinedOutput()
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

// TestWrapPreSpawnHydraEnv runs the production wrapper as a real process to verify
// the $HYDRA_ENV contract end-to-end: a pre-spawn script that appends KEY=value
// lines to $HYDRA_ENV has those vars exported into the exec'd command's
// environment, values are taken literally (no shell evaluation), blanks/comments
// are skipped, and an injected var overrides one already present in the base env.
func TestWrapPreSpawnHydraEnv(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "env-dump")
	q := func(p string) string { return "'" + p + "'" }

	// The script writes several vars via $HYDRA_ENV, including a comment, a blank
	// line, a value with spaces, a literal that must NOT be command-substituted,
	// and an override of PRESET (exported into the base env below).
	script := strings.Join([]string{
		`printf '%s\n' 'FROM_ENV=hello' >> "$HYDRA_ENV"`,
		`printf '%s\n' '# a comment' >> "$HYDRA_ENV"`,
		`printf '%s\n' '' >> "$HYDRA_ENV"`,
		`printf '%s\n' 'WITH_SPACES=a b c' >> "$HYDRA_ENV"`,
		`printf '%s\n' 'LITERAL=$(echo pwned)' >> "$HYDRA_ENV"`,
		`printf '%s\n' 'PRESET=overridden' >> "$HYDRA_ENV"`,
	}, "\n")
	// The "real" command dumps the three vars it should see from its environment.
	argv := []string{"/bin/sh", "-c", "printf '%s\\n' \"$FROM_ENV\" \"$WITH_SPACES\" \"$LITERAL\" \"$PRESET\" > " + q(out)}

	wrapped := WrapPreSpawn(script, "", argv)
	cmd := exec.Command(wrapped[0], wrapped[1:]...)
	cmd.Env = append(os.Environ(), "PRESET=original")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("run wrapped pre-spawn: %v\noutput: %s", err, b)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read env dump: %v", err)
	}
	want := "hello\na b c\n$(echo pwned)\noverridden\n"
	if string(got) != want {
		t.Fatalf("injected env:\n got %q\nwant %q", got, want)
	}
}

// TestWrapPreSpawnPersist verifies the persist mode (non-empty envFile): the
// resolved env is written to that fixed path and left there (not removed) for the
// daemon to read back and share with sibling shells, and it is truncated fresh on
// each launch (a prior run's vars do not accumulate).
func TestWrapPreSpawnPersist(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, "hydra-pre-spawn.env")
	q := func(p string) string { return "'" + p + "'" }
	argv := []string{"/bin/sh", "-c", "true"}

	run := func(varLine string) {
		t.Helper()
		wrapped := WrapPreSpawn("printf '%s\\n' "+q(varLine)+` >> "$HYDRA_ENV"`, envFile, argv)
		if b, err := exec.Command(wrapped[0], wrapped[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("run: %v\noutput: %s", err, b)
		}
	}

	run("FOO=1")
	got, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatalf("persisted env file missing (should be kept, not removed): %v", err)
	}
	if string(got) != "FOO=1\n" {
		t.Fatalf("persisted content: got %q, want %q", got, "FOO=1\n")
	}

	// A second launch truncates fresh - the file holds only the new run's vars.
	run("BAR=2")
	got, err = os.ReadFile(envFile)
	if err != nil {
		t.Fatalf("read persisted env file after second run: %v", err)
	}
	if string(got) != "BAR=2\n" {
		t.Fatalf("second launch did not truncate: got %q, want %q", got, "BAR=2\n")
	}
}

func TestWithPreSpawn(t *testing.T) {
	argv := []string{"claude", "--dangerously-skip-permissions"}

	// No script: argv is returned unchanged.
	if got := withPreSpawn("", "", argv); !reflect.DeepEqual(got, argv) {
		t.Errorf("empty script: got %v, want %v", got, argv)
	}
	if got := withPreSpawn("   \n\t ", "", argv); !reflect.DeepEqual(got, argv) {
		t.Errorf("blank script: got %v, want %v", got, argv)
	}

	// Empty argv: nothing to wrap.
	if got := withPreSpawn("echo hi", "", nil); got != nil {
		t.Errorf("empty argv: got %v, want nil", got)
	}

	// wrap builds the expected `-c` body for a given (already interpreter-adjusted)
	// script body: the EXIT trap, the $HYDRA_ENV setup, the body, the env apply-back,
	// then the trap clear and exec. Here envFile is "" (ephemeral).
	wrap := func(body string) string {
		return strings.Join([]string{preSpawnExitTrap, preSpawnEnvSetup(""), body, preSpawnEnvApply(false), "trap - EXIT", `exec "$@"`}, "\n")
	}

	// Script set, no shebang: defaults to /bin/bash -c, exec'ing argv via "$@"
	// after an EXIT trap that reports a gating failure. Being bash, the body also
	// runs under the strict preamble (set -eo pipefail).
	got := withPreSpawn("mise trust", "", argv)
	want := []string{"/bin/bash", "-c", wrap(StrictShellPreamble + "mise trust"), "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wrapped argv:\n got %#v\nwant %#v", got, want)
	}

	// A shebang selects the interpreter (here zsh); the script body, shebang line
	// included, is passed verbatim to `-c` - and a non-bash interpreter gets NO
	// strict preamble (set -o pipefail is a bashism).
	body := "#!/bin/zsh\nset -o pipefail\nmise trust"
	got = withPreSpawn(body, "", argv)
	want = []string{"/bin/zsh", "-c", wrap(body), "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("zsh shebang:\n got %#v\nwant %#v", got, want)
	}

	// Persist mode (non-empty envFile): the setup assigns the fixed path and
	// truncates it, and the apply-back keeps the file rather than rm-ing it.
	gotPersist := withPreSpawn("mise trust", "/tmp/x.env", argv)
	wantBody := strings.Join([]string{preSpawnExitTrap, preSpawnEnvSetup("/tmp/x.env"), StrictShellPreamble + "mise trust", preSpawnEnvApply(true), "trap - EXIT", `exec "$@"`}, "\n")
	if len(gotPersist) < 3 || gotPersist[2] != wantBody {
		t.Errorf("persist body:\n got %#v\nwant %#v", gotPersist, wantBody)
	}
	if strings.Contains(preSpawnEnvApply(true), "rm -f") {
		t.Errorf("persist apply must not rm the env file: %q", preSpawnEnvApply(true))
	}
	if !strings.Contains(preSpawnEnvApply(false), "rm -f") {
		t.Errorf("ephemeral apply must rm the env file: %q", preSpawnEnvApply(false))
	}

	// `#!/usr/bin/env bash` keeps both fields, so it runs as `env bash -c ...`.
	got = withPreSpawn("#!/usr/bin/env bash\necho hi", "", argv)
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
		got := withPreSpawn(script, "", argv)
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
