//go:build linux

package sandbox

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"braces.dev/errtrace"
)

// bwrapPath resolves the bwrap binary. HYDRA_BWRAP overrides PATH lookup so the
// daemon can be pointed at a specific build (e.g. an overlay-capable bwrap in
// ~/.local/bin when the distro's packaged bwrap has overlay support stripped).
func bwrapPath() (string, error) {
	if p := os.Getenv("HYDRA_BWRAP"); p != "" {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return errtrace.Wrap2(exec.LookPath("bwrap"))
}

// overlayCache memoises whether a given bwrap binary supports overlay mounts.
// Some distros (e.g. Ubuntu) ship bwrap with overlay support compiled out, so a
// COW mount has to fall back to a read-only bind there.
var (
	overlayMu    sync.Mutex
	overlayCache = map[string]bool{}
)

// bwrapSupportsOverlay reports whether the bwrap at the given path accepts the
// --overlay-src family of options (parsed once from its --help output).
func bwrapSupportsOverlay(bwrap string) bool {
	overlayMu.Lock()
	defer overlayMu.Unlock()
	if v, ok := overlayCache[bwrap]; ok {
		return v
	}
	out, _ := exec.Command(bwrap, "--help").CombinedOutput()
	ok := strings.Contains(string(out), "--overlay-src")
	overlayCache[bwrap] = ok
	if !ok {
		log.Printf("sandbox: %s lacks overlay support; copy-on-write mounts will fall back to read-only binds. "+
			"Install an overlay-capable bwrap and point HYDRA_BWRAP at it for true COW.", bwrap)
	}
	return ok
}

// Available reports whether bubblewrap can run on this host. It actually
// executes a trivial bwrap to detect the common failure mode where the kernel
// forbids unprivileged user namespaces (containers, hardened kernels, some WSL).
func Available() (bool, string) {
	path, err := bwrapPath()
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
		s = s[:300] + "..."
	}
	return s
}

// BuildSpec assembles a bwrap command line from opts. It translates the helper
// functions in sandbox-demo/linux/claude-sandboxed into Go: a read-only view of
// the whole filesystem, a curated set of writable binds, masked credential
// locations, optional network isolation and a seccomp syscall filter.
func BuildSpec(opts Options) (*Spec, error) {
	if opts.NoSandbox {
		return errtrace.Wrap2(rawSpec(opts))
	}

	bwrap, err := bwrapPath()
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
		// Pin the sandboxed process to the real host user. Without this bwrap keeps
		// whatever uid it was launched with - which is fine directly, but in hard
		// network mode pasta wraps bwrap in its own user namespace that maps the host
		// user to uid 0 (it needs CAP_NET_ADMIN to configure the netns). bwrap would
		// then inherit uid 0, the agent would run as root, and Claude refuses
		// `--dangerously-skip-permissions cannot be used with root/sudo privileges`.
		// Remapping back to the host uid/gid restores the "agent runs as the host
		// user" invariant in every mode (a no-op outside hard mode); on-disk file
		// ownership is unchanged because the inner uid maps back through pasta to the
		// same host uid. --unshare-user is required for --uid to be accepted: bwrap
		// otherwise creates its user namespace implicitly and rejects --uid with
		// "Specifying --uid requires --unshare-user or --userns".
		"--unshare-user",
		"--uid", strconv.Itoa(os.Getuid()),
		"--gid", strconv.Itoa(os.Getgid()),
	}

	// NOTE: we deliberately do NOT pass bwrap's --new-session. It calls setsid(),
	// which drops the PTY as the controlling terminal. creack/pty already starts
	// the sandbox with the slave as its controlling terminal (Setsid+Setctty), so
	// a second setsid detaches it - and a process with no controlling terminal
	// has no foreground process group for the kernel to signal. That breaks two
	// things that depend on the ctty:
	//   - job control in interactive shells ("no job control in this shell");
	//   - SIGWINCH delivery on resize: TIOCSWINSZ on the master signals the tty's
	//     foreground process group, so without a ctty the agent never learns it
	//     was resized and renders at a fixed width forever.
	// --new-session is only a defence against TIOCSTI input-injection into a
	// *shared* terminal, but every session here has its own dedicated PTY whose
	// master is read only by the daemon, so there is nothing to escape to.

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
	// A copy-on-write overlay (below) and a plain writable --bind cannot coexist on
	// the same target, and the overlay is what the user asked for. So skip any
	// writable path that a CowMount already covers - e.g. a home-anchored
	// cow_paths entry like "~/.gradle" supersedes the default writable bind on it.
	cowDests := make(map[string]struct{}, len(opts.CowMounts))
	for _, m := range opts.CowMounts {
		if m.Dest != "" {
			cowDests[filepath.Clean(m.Dest)] = struct{}{}
		}
	}
	for _, p := range expandAll(opts.WritablePaths, home) {
		if _, ok := cowDests[filepath.Clean(p)]; ok {
			continue
		}
		addRWDir(p)
	}

	// Per-head private /tmp: bind a host-backed scratch dir over the base /tmp
	// tmpfs so the agent's temp files (Claude's scratchpad, test-framework
	// extractions, build junk) are isolated per head and reclaimed when the head
	// is torn down, instead of piling up on the host's shared /tmp. Subsequent
	// binds (e.g. the seeded hydra binary at /tmp/hydra-internal) nest on top.
	// Empty leaves the fresh tmpfs from the base args.
	if opts.TmpDir != "" {
		args = append(args, "--bind", opts.TmpDir, "/tmp")
	}

	// Copy-on-write mounts: expose a read-only Lower dir at Dest, but redirect
	// writes to a per-head Upper via overlayfs. Applied after the worktree bind so
	// the mountpoint's parent is already writable. When this bwrap lacks overlay
	// support, fall back to a read-only bind (reads work; writes fail with EROFS
	// instead of corrupting the source).
	overlayOK := bwrapSupportsOverlay(bwrap)
	for _, m := range opts.CowMounts {
		if m.Lower == "" || m.Dest == "" {
			continue
		}
		if _, err := os.Stat(m.Lower); err != nil {
			continue
		}
		if overlayOK && m.Upper != "" && m.Work != "" {
			args = append(args,
				"--overlay-src", m.Lower,
				"--overlay", m.Upper, m.Work, m.Dest,
			)
		} else {
			args = append(args, "--ro-bind", m.Lower, m.Dest)
		}
	}

	// Read-only overlays expose per-head files under otherwise read-only system
	// dirs (e.g. /etc/claude-code/managed-settings.json under /etc) without needing
	// to mkdir a mountpoint beneath the read-only `/` bind. Each overlay unions the
	// real Dir (lower) with the per-head Upper layer (also a lower, so the result is
	// read-only) and mounts it back over the already-existing Dir. Needs overlay
	// support; without it the injected files are skipped (the caller degrades - e.g.
	// Claude's managed gate hooks won't load), logged so the cause is diagnosable.
	for _, o := range opts.ROOverlays {
		if o.Dir == "" || o.Upper == "" {
			continue
		}
		if _, err := os.Stat(o.Upper); err != nil {
			continue
		}
		if !overlayOK {
			log.Printf("sandbox: bwrap %s lacks overlay support; skipping read-only overlay on %s - per-head files under it will be absent. "+
				"Point HYDRA_BWRAP at an overlay-capable bwrap to restore them.", bwrap, o.Dir)
			continue
		}
		args = append(args,
			"--overlay-src", o.Upper,
			"--overlay-src", o.Dir,
			"--ro-overlay", o.Dir,
		)
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
		args = append(args, "--tmpfs", d)
	}

	// Per-head config seeding binds.
	for _, b := range opts.Binds {
		source := expandPath(b.Source, home)
		target := expandPath(b.Target, home)
		if source == "" || target == "" {
			continue
		}
		if _, err := os.Stat(source); err != nil {
			continue
		}
		if b.ReadOnly {
			args = append(args, "--ro-bind", source, target)
		} else {
			args = append(args, "--bind", source, target)
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

	// Seccomp syscall filter (best-effort). bwrap reads the blob via --seccomp
	// <fd>. Without an egress wrapper bwrap is our immediate child, so Go's
	// inherited fd works directly. With one (hard egress), pasta sits between us
	// and bwrap and does not preserve the inherited fd across its re-exec + netns
	// fork, so we instead have the wrapper's innermost shell reopen the blob by
	// path onto the same fd (see EgressWrap preExec).
	var extraFiles []*os.File
	var seccompPreExec string
	cleanup := func() {}
	if opts.Seccomp {
		if f, path, err := seccompFile(); err != nil {
			// Non-fatal: continue without the filter, like the demo.
			fmt.Fprintf(os.Stderr, "hydra: seccomp filter unavailable, continuing without it: %v\n", err)
		} else if f != nil {
			// ExtraFiles[i] becomes fd 3+i in the immediate child.
			childFD := 3 + len(extraFiles)
			args = append(args, "--seccomp", fmt.Sprintf("%d", childFD))
			if opts.EgressWrap != nil {
				// Hard egress: reopen by path in the netns shell right before it
				// execs bwrap, then unlink. Immune to whatever pasta does to fd 3.
				_ = f.Close()
				seccompPreExec = fmt.Sprintf("exec %d<%q\nrm -f %q\n", childFD, path, path)
				cleanup = func() { _ = os.Remove(path) }
			} else {
				// No wrapper: inherit the fd directly and unlink now - the open fd
				// keeps the inode alive.
				_ = os.Remove(path)
				extraFiles = append(extraFiles, f)
				cleanup = func() { _ = f.Close() }
			}
		}
	}

	// The command to run inside the sandbox (optionally preceded by the
	// configured pre-spawn script, which execs into Argv when it falls through).
	args = append(args, "--")
	args = append(args, withPreSpawn(opts.PreSpawnScript, SandboxPreSpawnEnvFile(opts.TmpDir), opts.Argv)...)

	// Hard egress boundary: wrap the bwrap argv in a pasta netns + nft lock. The
	// wrapper returns a new argv (argv[0] = pasta) that ultimately execs this
	// bwrap, which must therefore NOT --unshare-net (it inherits pasta's netns -
	// satisfied because hard egress only applies with Network.Enabled).
	path, finalArgs := bwrap, args
	if opts.EgressWrap != nil {
		finalArgs = opts.EgressWrap(args, seccompPreExec)
		path = finalArgs[0]
	}

	return &Spec{
		Path:       path,
		Args:       finalArgs,
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
