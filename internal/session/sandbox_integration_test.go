//go:build !windows

package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/sandbox"
)

// TestSandboxedSessionEndToEnd runs a real sandboxed command through the full
// Registry -> sandbox.BuildSpec -> PTY path. It is skipped automatically when
// the OS sandbox is unavailable (e.g. inside a nested sandbox or CI where
// unprivileged user namespaces are disabled), so it is a no-op here but
// exercises the real path on a developer's host.
func TestSandboxedSessionEndToEnd(t *testing.T) {
	if ok, reason := sandbox.Available(); !ok {
		t.Skipf("OS sandbox unavailable: %s", reason)
	}

	home, _ := os.UserHomeDir()
	work := t.TempDir()
	marker := filepath.Join(work, "written-in-worktree")

	reg := NewRegistry()
	exited := make(chan Info, 1)
	reg.SetOnExit(func(i Info) { exited <- i })

	def := sandbox.Defaults()
	_, err := reg.Start(StartOptions{
		ID:   "itest",
		Rows: 24, Cols: 80,
		Sandbox: sandbox.Options{
			AgentType:     sandbox.AgentTypeBash,
			WorktreePath:  work,
			Home:          home,
			WritablePaths: def.WritablePaths,
			MaskedPaths:   def.MaskedPaths,
			RestoreRO:     def.RestoreRO,
			Network:       sandbox.NetworkPolicy{Enabled: true},
			HardenGUI:     true,
			Seccomp:       true,
			Env:           os.Environ(),
			Argv: []string{"/bin/sh", "-c",
				"echo SANDBOX_OK; touch " + marker + " && echo WORKTREE_WRITABLE; " +
					"ls -A ~/.ssh 2>/dev/null | head -1 | grep -q . && echo SSH_VISIBLE || echo SSH_HIDDEN"},
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	att, err := reg.Attach("itest", 24, 80)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer att.Close()

	out := collect(att, 5*time.Second)
	t.Logf("sandbox output:\n%s", out)

	if !strings.Contains(out, "SANDBOX_OK") {
		t.Errorf("sandbox did not run command; output: %q", out)
	}
	if !strings.Contains(out, "WORKTREE_WRITABLE") {
		t.Error("worktree was not writable inside sandbox")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("worktree write did not land on host: %v", err)
	}
	if strings.Contains(out, "SSH_VISIBLE") {
		t.Error("~/.ssh contents were visible inside the sandbox (should be masked)")
	}

	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Error("session did not report exit")
	}
}

// TestSandboxStatusBind reproduces the bug where a per-head file is bind-mounted
// into $HOME/.hydra, which is read-only under `--ro-bind / /`. The fix overlays
// $HOME/.hydra with a writable tmpfs (Options.TmpfsDirs) so the bind target can
// be created; writes still reach the host bind source. Skipped without bwrap.
func TestSandboxStatusBind(t *testing.T) {
	if ok, reason := sandbox.Available(); !ok {
		t.Skipf("OS sandbox unavailable: %s", reason)
	}

	home := t.TempDir()
	work := t.TempDir()
	hydraHome := filepath.Join(home, ".hydra")
	if err := os.MkdirAll(hydraHome, 0o755); err != nil {
		t.Fatal(err)
	}
	hostStatus := filepath.Join(hydraHome, "status-host.json")
	if err := os.WriteFile(hostStatus, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	sandboxStatusPath := filepath.Join(hydraHome, "status.json") // $HOME/.hydra/status.json inside

	reg := NewRegistry()
	_, err := reg.Start(StartOptions{
		ID:   "statustest",
		Rows: 24, Cols: 80,
		Sandbox: sandbox.Options{
			AgentType:    sandbox.AgentTypeBash,
			WorktreePath: work,
			Home:         home,
			Network:      sandbox.NetworkPolicy{Enabled: true},
			HardenGUI:    true,
			Seccomp:      true,
			TmpfsDirs:    []string{hydraHome},
			Binds:        []sandbox.Bind{{Source: hostStatus, Target: sandboxStatusPath}},
			Env:          append(os.Environ(), "HOME="+home),
			Argv:         []string{"/bin/sh", "-c", `echo STATUS_OK > "$HOME/.hydra/status.json"; echo done`},
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	att, err := reg.Attach("statustest", 24, 80)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer att.Close()
	out := collect(att, 5*time.Second)
	t.Logf("output:\n%s", out)

	// The host bind source must have received the agent's write.
	data, err := os.ReadFile(hostStatus)
	if err != nil {
		t.Fatalf("read host status file: %v", err)
	}
	if !strings.Contains(string(data), "STATUS_OK") {
		t.Errorf("agent write to $HOME/.hydra/status.json did not reach host file; got %q", string(data))
	}
}
