//go:build linux

package sandbox

import (
	"fmt"
	"os"
	"os/exec"

	"braces.dev/errtrace"
)

// Available reports whether bubblewrap can run on this host. It actually
// executes a trivial bwrap to detect the common failure mode where the kernel
// forbids unprivileged user namespaces (containers, hardened kernels, some WSL).
func Available() (bool, string) {
	path, err := exec.LookPath("bwrap")
	if err != nil {
		return false, "bubblewrap (bwrap) is not installed or not on PATH; install it (e.g. `sudo apt install bubblewrap` / `brew install bubblewrap`)"
	}
	// Probe: a no-op bwrap that still needs a user namespace.
	cmd := exec.Command(path, "--ro-bind", "/", "/", "--", "true")
	if out, err := cmd.CombinedOutput(); err != nil {
		return false, fmt.Sprintf("bwrap cannot create a sandbox (unprivileged user namespaces may be disabled): %s", trimOutput(out))
	}
	return true, ""
}

func trimOutput(b []byte) string {
	s := string(b)
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// BuildSpec assembles a bwrap command line from opts. It translates the helper
// functions in sandbox-demo/linux/claude-sandboxed into Go: a read-only view of
// the whole filesystem, a curated set of writable binds, masked credential
// locations, optional network isolation and a seccomp syscall filter.
func BuildSpec(opts Options) (*Spec, error) {
	if opts.NoSandbox {
		return rawSpec(opts)
	}

	bwrap, err := exec.LookPath("bwrap")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("bwrap not found on PATH: %w", err))
	}

	home := opts.Home
	args := []string{
		bwrap,
		// Read-only view of the entire host filesystem.
		"--ro-bind", "/", "/",
		// Fresh pseudo-filesystems.
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		// Isolate everything except the network (shared unless disabled below).
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--die-with-parent",
	}

	// --new-session calls setsid(), which drops the PTY as the controlling
	// terminal and so breaks job control ("no job control in this shell"). It's
	// a defence against TIOCSTI input-injection into a shared terminal, but each
	// session here has its own dedicated PTY, so there's nothing to escape to.
	// Keep it for agents; omit it for interactive shells that need job control.
	if !opts.Interactive {
		args = append(args, "--new-session")
	}

	// Writable: the worktree is always writable; then config-driven paths.
	addRWDir := func(p string) {
		if p == "" {
			return
		}
		if _, err := os.Stat(p); err == nil {
			args = append(args, "--bind", p, p)
		}
	}
	addRWDir(opts.WorktreePath)
	// The worktree's git metadata lives in the main repo's common dir; bind it
	// writable so the agent can commit (index.lock, refs, objects, logs).
	addRWDir(opts.GitCommonDir)
	for _, p := range expandAll(opts.WritablePaths, home) {
		addRWDir(p)
	}

	// Mask credential/secret locations (dirs -> empty tmpfs, files -> /dev/null).
	for _, p := range expandAll(opts.MaskedPaths, home) {
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		if info.IsDir() {
			args = append(args, "--tmpfs", p)
		} else {
			args = append(args, "--ro-bind", "/dev/null", p)
		}
	}

	// Restore read-only access to specific paths under masked dirs. Applied
	// after the masks so they win.
	for _, p := range expandAll(opts.RestoreRO, home) {
		if _, err := os.Stat(p); err == nil {
			args = append(args, "--ro-bind", p, p)
		}
	}

	// Overlay writable tmpfs on requested dirs (e.g. $HOME/.hydra) so per-head
	// files can be bind-mounted into otherwise read-only locations. The bind
	// sources below are real host files, so writes still reach the host.
	for _, d := range expandAll(opts.TmpfsDirs, home) {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			args = append(args, "--tmpfs", d)
		}
	}

	// Per-head config seeding binds.
	for _, b := range opts.Binds {
		if b.Source == "" || b.Target == "" {
			continue
		}
		if _, err := os.Stat(b.Source); err != nil {
			continue
		}
		if b.ReadOnly {
			args = append(args, "--ro-bind", b.Source, b.Target)
		} else {
			args = append(args, "--bind", b.Source, b.Target)
		}
	}

	// Network isolation.
	if !opts.Network.Enabled {
		args = append(args, "--unshare-net")
	}

	// GUI/session hardening: hide the per-user runtime dir (live gpg-agent,
	// D-Bus, Pulse sockets) and drop the GUI/session credentials.
	if opts.HardenGUI {
		if rt := runtimeDir(); rt != "" {
			if info, err := os.Stat(rt); err == nil && info.IsDir() {
				args = append(args, "--tmpfs", rt)
			}
		}
		if xauth := expandPath("~/.Xauthority", home); xauth != "" {
			if _, err := os.Stat(xauth); err == nil {
				args = append(args, "--ro-bind", "/dev/null", xauth)
			}
		}
		args = append(args,
			"--unsetenv", "DISPLAY",
			"--unsetenv", "WAYLAND_DISPLAY",
			"--unsetenv", "XAUTHORITY",
			"--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
		)
	}

	// Working directory inside the sandbox.
	if opts.WorktreePath != "" {
		args = append(args, "--chdir", opts.WorktreePath)
	}

	// Seccomp syscall filter (best-effort). The blob is passed on an inherited
	// fd; bwrap reads it via --seccomp <fd>.
	var extraFiles []*os.File
	cleanup := func() {}
	if opts.Seccomp {
		if f, err := seccompFile(); err != nil {
			// Non-fatal: continue without the filter, like the demo.
			fmt.Fprintf(os.Stderr, "hydra: seccomp filter unavailable, continuing without it: %v\n", err)
		} else if f != nil {
			// ExtraFiles[i] becomes fd 3+i in the child.
			childFD := 3 + len(extraFiles)
			extraFiles = append(extraFiles, f)
			args = append(args, "--seccomp", fmt.Sprintf("%d", childFD))
			cleanup = func() { _ = f.Close() }
		}
	}

	// The command to run inside the sandbox (optionally preceded by the
	// configured pre-spawn script, which execs into Argv when it falls through).
	args = append(args, "--")
	args = append(args, withPreSpawn(opts.PreSpawnScript, opts.Argv)...)

	return &Spec{
		Path:       bwrap,
		Args:       args,
		Env:        opts.Env,
		Dir:        opts.WorktreePath,
		ExtraFiles: extraFiles,
		Cleanup:    cleanup,
	}, nil
}

// runtimeDir returns XDG_RUNTIME_DIR or the conventional /run/user/<uid>.
func runtimeDir() string {
	if rt := os.Getenv("XDG_RUNTIME_DIR"); rt != "" {
		return rt
	}
	return fmt.Sprintf("/run/user/%d", os.Getuid())
}
