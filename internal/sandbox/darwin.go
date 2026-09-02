//go:build darwin

package sandbox

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
)

// sandboxProfileTemplate is the base Seatbelt profile, parameterized by
// WORK_DIR and HOME_DIR. Config-driven rules are appended at launch time and,
// because Seatbelt is last-match-wins, take precedence over the template.
//
//go:embed profiles/sandbox.sb
var sandboxProfileTemplate string

// Available reports whether sandbox-exec is present.
func Available() (bool, string) {
	if _, err := exec.LookPath("sandbox-exec"); err != nil {
		return false, "sandbox-exec is not available on this macOS system"
	}
	return true, ""
}

// BuildSpec assembles a sandbox-exec command line. It materializes the embedded
// Seatbelt profile to a temp file, appends config-driven allow/deny rules, and
// invokes sandbox-exec with WORK_DIR/HOME_DIR params.
func BuildSpec(opts Options) (spec *Spec, retErr error) {
	if err := PrepareSharedCaches(&opts); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if opts.NoSandbox {
		return errtrace.Wrap2(rawSpec(opts))
	}
	if len(opts.Binds) > 0 || len(opts.ROOverlays) > 0 || len(opts.TmpfsDirs) > 0 {
		return nil, errtrace.Wrap(fmt.Errorf(
			"macOS sandbox cannot apply mount-based inputs (binds=%d, read-only overlays=%d, tmpfs dirs=%d)",
			len(opts.Binds), len(opts.ROOverlays), len(opts.TmpfsDirs),
		))
	}

	sandboxExec, err := exec.LookPath("sandbox-exec")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("sandbox-exec not found: %w", err))
	}

	// One-shot test, artifact, preview, and command sandboxes do not have a
	// persistent head temp directory. Give them an ephemeral private directory so
	// standard temp APIs and Hydra's private cache redirects never fall back to
	// the shared macOS user temp root.
	ownedTmpDir := ""
	if opts.TmpDir == "" {
		ownedTmpDir, err = os.MkdirTemp("", "hydra-sandbox-run-")
		if err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("create private sandbox temp: %w", err))
		}
		opts.TmpDir = ownedTmpDir
	}
	defer func() {
		if retErr != nil && ownedTmpDir != "" {
			_ = os.RemoveAll(ownedTmpDir)
		}
	}()

	home := canonicalSBPath(opts.Home)
	worktree := canonicalSBPath(opts.WorktreePath)
	var b strings.Builder
	b.WriteString(sandboxProfileTemplate)
	b.WriteString("\n;; --- Hydra config-driven rules (appended; last match wins) ---\n")

	// macOS cannot mount a private directory over /tmp. Deny the shared OS temp
	// roots and every sibling head's scratch directory first. Later, narrower
	// grants expose this head's own scratch directory and Hydra control socket.
	if opts.TmpDir != "" {
		for _, p := range []string{"/tmp", "/private/tmp", os.TempDir(), filepath.Dir(opts.TmpDir)} {
			fmt.Fprintf(&b, "(deny file-read* file-write* %s)\n", sbPathRule(p))
		}
		// Path-canonicalizing tools (notably Git and SQLite) stat each ancestor
		// before opening a file below TMPDIR. Re-open metadata on the literal
		// ancestors only: directory enumeration and sibling file data stay denied.
		for parent := filepath.Dir(canonicalSBPath(opts.TmpDir)); ; parent = filepath.Dir(parent) {
			fmt.Fprintf(&b, "(allow file-read-metadata %s)\n", sbLiteralPathRule(parent))
			next := filepath.Dir(parent)
			if next == parent {
				break
			}
		}
		fmt.Fprintf(&b, "(allow file-read* file-write* %s)\n", sbPathRule(opts.TmpDir))
	}

	// The worktree's git metadata lives in the main repo's common dir. How much is
	// writable depends on the git-isolation mode (see docs/git-isolation.md); reads are
	// allowed by the base template, so read-only modes simply omit the write grant.
	// Seatbelt is last-match-wins, so a deny after the allow carves out subpaths.
	if opts.GitCommonDir != "" {
		switch opts.GitIsolation {
		case GitIsolationReadonly:
			// No write grant -> the whole common dir is read-only.
		default:
			fmt.Fprintf(&b, "(allow file-write* %s)\n", sbPathRule(opts.GitCommonDir))
		}
	}
	// Writable paths (the worktree is covered by WORK_DIR in the template).
	for _, p := range expandAll(opts.WritablePaths, home) {
		// Create a HOME-anchored writable_path that doesn't exist yet, so a
		// freshly-configured cache/store (e.g. ~/.local/share/aube) can actually
		// be written under - a file-write rule can't create a missing parent.
		ensureWritableDir(p, home)
		fmt.Fprintf(&b, "(allow file-read* file-write* %s)\n", sbPathRule(p))
	}
	// Masked paths: deny both read and write.
	for _, p := range expandAll(opts.MaskedPaths, home) {
		fmt.Fprintf(&b, "(deny file-read* file-write* %s)\n", sbPathRule(p))
	}
	// Restore read-only.
	for _, p := range expandAll(opts.RestoreRO, home) {
		fmt.Fprintf(&b, "(allow file-read* %s)\n", sbPathRule(p))
	}
	// Immutable runtime and generated policy inputs live at real host paths on
	// macOS. Grant reads and carve writes back out after every broader writable
	// rule; Seatbelt's last-match-wins evaluation makes this tamper-resistant.
	for _, p := range expandAll(opts.ImmutablePaths, home) {
		fmt.Fprintf(&b, "(allow file-read* %s)\n", sbPathRule(p))
		fmt.Fprintf(&b, "(deny file-write* %s)\n", sbPathRule(p))
	}
	// The base profile grants writes under WORK_DIR. A project-directory read-only session
	// runs in the real project root, so carve that grant back out after every
	// config-driven allow. Seatbelt is last-match-wins.
	if opts.WorkingDirReadOnly {
		fmt.Fprintf(&b, "(deny file-write* %s)\n", sbPathRule(opts.WorktreePath))
	}
	// A head may signal itself and processes it spawned, but not its supervisor
	// parent or unrelated host processes. Besides containing `kill`/`pkill`, this
	// prevents an agent from killing the hydra-internal process that owns its
	// sandbox and control socket.
	b.WriteString("(deny signal)\n")
	b.WriteString("(allow signal (target self))\n")
	b.WriteString("(allow signal (target children))\n")
	if opts.HardenGUI {
		// macOS GUI, clipboard, and Apple Events access is brokered by these Mach
		// services rather than filesystem sockets. Deny their bootstrap lookups.
		for _, service := range []string{
			"com.apple.windowserver",
			"com.apple.windowserver.active",
			"com.apple.pasteboard.1",
			"com.apple.pboard",
			"com.apple.coreservices.appleevents",
		} {
			fmt.Fprintf(&b, "(deny mach-lookup (global-name %q))\n", service)
		}
	}
	// Network. Hard mode keeps ordinary IP egress denied and opens only the
	// host-loopback filtering proxy plus explicitly configured loopback services.
	// Unix-domain sockets (including mDNSResponder) are unaffected; name
	// resolution is not itself an egress route, and the host-side proxy resolves
	// CONNECT destinations independently.
	if !opts.Network.Enabled {
		b.WriteString("(deny network*)\n")
	} else if opts.Network.Mode == NetHard {
		if opts.Network.HardProxyPort < 1 || opts.Network.HardProxyPort > 65535 {
			return nil, errtrace.Wrap(fmt.Errorf("macOS hard egress requires a valid filtering proxy port"))
		}
		b.WriteString("(deny network-outbound (remote ip))\n")
		b.WriteString("(deny network-bind (local ip))\n")
		b.WriteString("(allow network-bind (local tcp \"localhost:*\") (local udp \"localhost:*\"))\n")
		if port := opts.Network.HardInboundPort; port > 0 && port <= 65535 {
			fmt.Fprintf(&b, "(allow network-bind (local tcp \"*:%d\"))\n", port)
		}
		ports := append([]int{opts.Network.HardProxyPort}, opts.Network.AllowedLoopbackPorts...)
		seen := make(map[int]bool, len(ports))
		for _, port := range ports {
			if port < 1 || port > 65535 || seen[port] {
				continue
			}
			seen[port] = true
			fmt.Fprintf(&b, "(allow network-outbound (remote tcp \"localhost:%d\"))\n", port)
		}
	}

	// Copy-on-write paths. macOS has no overlay primitive in Seatbelt, but APFS
	// has block-level copy-on-write clones when Lower and Dest are distinct. An
	// in-place home/absolute overlay is impossible and must fail instead of
	// silently exposing the shared source as writable.
	for _, m := range opts.CowMounts {
		if err := cowClone(m); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("prepare COW path %s -> %s: %w", m.Lower, m.Dest, err))
		}
	}

	tmp, err := os.CreateTemp("", "hydra-sandbox-*.sb")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create profile temp: %w", err))
	}
	profilePath := tmp.Name()
	if _, err := tmp.WriteString(b.String()); err != nil {
		_ = tmp.Close()
		_ = os.Remove(profilePath)
		return nil, errtrace.Wrap(fmt.Errorf("write profile: %w", err))
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(profilePath)
		return nil, errtrace.Wrap(fmt.Errorf("close profile: %w", err))
	}

	args := []string{
		sandboxExec,
		"-f", profilePath,
		"-D", "WORK_DIR=" + worktree,
		"-D", "HOME_DIR=" + home,
	}
	// Optionally run the configured pre-spawn script first; it execs into Argv
	// when it falls through. The resolved $HYDRA_ENV is persisted in this head's
	// private temp directory so sibling sandboxed shells can reuse it.
	env := SharedCacheEnv(RuntimeEnv(opts.Env, opts.TmpDir), opts.CacheRoot, opts.Caches)
	if opts.HardenGUI {
		env = withoutEnvKeys(env, "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS")
	}
	args = append(args, withPreSpawn(opts.PreSpawnScript, SandboxPreSpawnEnvFile(opts.TmpDir), opts.Argv)...)

	return &Spec{
		Path: sandboxExec,
		Args: args,
		Env:  env,
		Dir:  opts.WorktreePath,
		Cleanup: func() {
			_ = os.Remove(profilePath)
			if ownedTmpDir != "" {
				_ = os.RemoveAll(ownedTmpDir)
			}
		},
	}, nil
}

// cowClone populates m.Dest with an APFS copy-on-write clone of m.Lower's
// contents, but only when Dest is empty (so resumes don't clobber the agent's
// edits). `cp -c` requests a clonefile clone, falling back to a normal copy when
// the source and destination are on different/non-APFS volumes. No-op when Lower
// is missing.
func cowClone(m CowMount) error {
	// An empty Upper marks a read-only COW request (e.g. bash shells). macOS has
	// no bind-mount primitive in Seatbelt, so there is nothing to expose read-only
	// here - skip rather than make a writable clone.
	if m.Lower == "" || m.Dest == "" || m.Upper == "" {
		return nil
	}
	if canonicalSBPath(m.Lower) == canonicalSBPath(m.Dest) {
		return errtrace.Errorf("macOS cannot provide an in-place writable CoW overlay; use a worktree-relative cow_path or redirect the tool to private storage")
	}
	if _, err := os.Stat(m.Lower); err != nil {
		return nil
	}
	if err := os.MkdirAll(m.Dest, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	if entries, err := os.ReadDir(m.Dest); err == nil && len(entries) > 0 {
		return nil // already populated (e.g. a resume) - keep the agent's edits
	}
	// Copy Lower's contents (not Lower itself) into the existing Dest dir.
	out, err := exec.Command("cp", "-c", "-R", m.Lower+"/.", m.Dest).CombinedOutput()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("cp -c: %s: %w", strings.TrimSpace(string(out)), err))
	}
	return nil
}

// sbPathRule returns a Seatbelt path predicate: (subpath "..") for directories,
// (literal "..") for files. Falls back to subpath when the path can't be
// stat'd (e.g. not yet created).
func sbPathRule(p string) string {
	p = canonicalSBPath(p)
	if info, err := os.Stat(p); err == nil && !info.IsDir() {
		return sbLiteralPathRule(p)
	}
	quoted := strings.ReplaceAll(p, `"`, `\"`)
	return `(subpath "` + quoted + `")`
}

func sbLiteralPathRule(p string) string {
	p = canonicalSBPath(p)
	quoted := strings.ReplaceAll(p, `"`, `\"`)
	return `(literal "` + quoted + `")`
}

// canonicalSBPath resolves macOS's visible compatibility symlinks (notably
// /tmp -> /private/tmp and /var -> /private/var). Seatbelt compares the kernel's
// canonical path, so a literal rule using the visible alias does not match.
func canonicalSBPath(p string) string {
	if p == "" {
		return p
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	// The leaf may not exist yet. Resolve the closest existing parent and append
	// the unresolved suffix so rules for create targets still use canonical roots.
	parent := filepath.Dir(p)
	if parent == p {
		return filepath.Clean(p)
	}
	if resolved, err := filepath.EvalSymlinks(parent); err == nil {
		return filepath.Join(resolved, filepath.Base(p))
	}
	return filepath.Clean(p)
}
