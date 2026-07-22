package tests

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
)

func TestBuildCommandSpecUsesSandboxTempDirectory(t *testing.T) {
	root := t.TempDir()
	output := t.TempDir()
	t.Setenv("TMPDIR", "/host/read-only/tmp")
	t.Setenv("TMP", "/host/read-only/tmp")
	t.Setenv("TEMP", "/host/read-only/tmp")
	m := NewManager(root)
	launch, err := m.buildCommandSpec(config.TestScript{Name: "env", Command: "true", UnsafeHost: true}, root, output, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	defer launch.Cleanup()
	joined := "\n" + strings.Join(launch.Env, "\n") + "\n"
	for _, want := range []string{"TMPDIR=/tmp", "TMP=/tmp", "TEMP=/tmp"} {
		if !strings.Contains(joined, "\n"+want+"\n") {
			t.Errorf("environment missing %q", want)
		}
	}
	if strings.Contains(joined, "/host/read-only/tmp") {
		t.Fatalf("inherited host temporary directory leaked into environment")
	}
}

// initGitRepo makes dir a git repo with a single commit, so WorktreeStateHash
// (git rev-parse HEAD + status) works for the worktree cache key.
func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "init")
}

// gitRun runs a git subcommand in dir, failing the test on error.
func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// runWorktree drives a single generation against a caller-supplied worktree dir
// (so it needs no git checkout) with UnsafeHost set (so it needs no bwrap, which
// is unavailable in CI/sandbox). It blocks until the run settles by subscribing
// to the settled event, then returns the cached report.
func runWorktree(t *testing.T, spec config.TestScript, workDir string) Report {
	t.Helper()
	initGitRepo(t, workDir)
	m := NewManager(t.TempDir())
	events, unsub := m.Subscribe()
	defer unsub()

	v := Version{WorktreeDir: workDir}
	first, err := m.Get(spec, v)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if first.Status != StatusRunning {
		// Already cached/settled synchronously - return it.
		return first
	}
	for ev := range events {
		if ev.Kind == "settled" {
			break
		}
	}
	rep, ok, err := m.Peek(spec.Name, v)
	if err != nil || !ok {
		t.Fatalf("Peek after settle: ok=%v err=%v", ok, err)
	}
	return rep
}

func TestGeneratePassingFromJUnit(t *testing.T) {
	work := t.TempDir()
	spec := config.TestScript{
		Name:       "go",
		UnsafeHost: true,
		Command: `cat > "$HYDRA_TEST_OUTPUT/r.xml" <<'EOF'
<testsuite name="s"><testcase name="ok" time="0.1"/></testsuite>
EOF`,
	}
	rep := runWorktree(t, spec, work)
	if rep.Status != StatusPassing {
		t.Fatalf("status = %q, want passing (%+v)", rep.Status, rep)
	}
	if rep.Passed != 1 || rep.Total != 1 || rep.Format != "junit" {
		t.Errorf("counts/format wrong: %+v", rep)
	}
	if rep.DurationMs < 0 {
		t.Errorf("duration not set: %+v", rep)
	}
}

func TestGenerateFailingFromJUnit(t *testing.T) {
	work := t.TempDir()
	spec := config.TestScript{
		Name:       "go",
		UnsafeHost: true,
		// The runner writes a failing report AND exits non-zero - the report must
		// win (failing verdict, not errored).
		Command: `cat > "$HYDRA_TEST_OUTPUT/r.xml" <<'EOF'
<testsuite name="s"><testcase name="bad"><failure message="nope">trace</failure></testcase></testsuite>
EOF
exit 1`,
	}
	rep := runWorktree(t, spec, work)
	if rep.Status != StatusFailing {
		t.Fatalf("status = %q, want failing (%+v)", rep.Status, rep)
	}
	if rep.Failed != 1 {
		t.Errorf("failed = %d, want 1", rep.Failed)
	}
}

func TestGenerateDegenerateExitCode(t *testing.T) {
	// No report written; exit code alone drives the verdict.
	pass := runWorktree(t, config.TestScript{Name: "t", UnsafeHost: true, Command: "true"}, t.TempDir())
	if pass.Status != StatusPassing || pass.Format != "exit" {
		t.Errorf("clean exit: status=%q format=%q", pass.Status, pass.Format)
	}
	fail := runWorktree(t, config.TestScript{Name: "t", UnsafeHost: true, Command: "echo boom >&2; exit 2"}, t.TempDir())
	if fail.Status != StatusFailing || fail.Failed != 1 {
		t.Errorf("nonzero exit: status=%q failed=%d", fail.Status, fail.Failed)
	}
}

func TestGenerateErroredOnExecFailure(t *testing.T) {
	// A command that can't start (bogus interpreter path via NoSandbox argv is
	// hard to force; instead use a timeout to exercise the errored path).
	spec := config.TestScript{Name: "t", UnsafeHost: true, TimeoutSec: 1, Command: "sleep 5"}
	rep := runWorktree(t, spec, t.TempDir())
	if rep.Status != StatusErrored {
		t.Fatalf("status = %q, want errored (%+v)", rep.Status, rep)
	}
}

func TestInvalidateAndCache(t *testing.T) {
	work := t.TempDir()
	initGitRepo(t, work)
	m := NewManager(t.TempDir())
	spec := config.TestScript{Name: "t", UnsafeHost: true, Command: "true"}
	v := Version{WorktreeDir: work}

	events, unsub := m.Subscribe()
	defer unsub()
	if _, err := m.Get(spec, v); err != nil {
		t.Fatal(err)
	}
	for ev := range events {
		if ev.Kind == "settled" {
			break
		}
	}
	// Now cached: a Peek returns it without StatusRunning.
	rep, ok, _ := m.Peek(spec.Name, v)
	if !ok || rep.Status != StatusPassing {
		t.Fatalf("expected cached passing, got ok=%v %+v", ok, rep)
	}
	// Invalidate drops it.
	if err := m.Invalidate(spec.Name, v); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := m.Peek(spec.Name, v); ok {
		t.Fatal("expected no cache after Invalidate")
	}
}
