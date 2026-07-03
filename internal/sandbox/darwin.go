//go:build darwin

package sandbox

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
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
// invokes sandbox-exec with WORK_DIR/HOME_DIR params, mirroring
// sandbox-demo/macos/sandbox.sb.
func BuildSpec(opts Options) (*Spec, error) {
	if opts.NoSandbox {
		return errtrace.Wrap2(rawSpec(opts))
	}

	sandboxExec, err := exec.LookPath("sandbox-exec")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("sandbox-exec not found: %w", err))
	}

	home := opts.Home
	var b strings.Builder
	b.WriteString(sandboxProfileTemplate)
	b.WriteString("\n;; --- Hydra config-driven rules (appended; last match wins) ---\n")

	// The worktree's git metadata lives in the main repo's common dir; allow
	// writes there so the agent can commit (the worktree itself is WORK_DIR).
	if opts.GitCommonDir != "" {
		fmt.Fprintf(&b, "(allow file-write* %s)\n", sbPathRule(opts.GitCommonDir))
	}
	// Writable paths (the worktree is covered by WORK_DIR in the template).
	for _, p := range expandAll(opts.WritablePaths, home) {
		fmt.Fprintf(&b, "(allow file-write* %s)\n", sbPathRule(p))
	}
	// Masked paths: deny both read and write.
	for _, p := range expandAll(opts.MaskedPaths, home) {
		fmt.Fprintf(&b, "(deny file-read* file-write* %s)\n", sbPathRule(p))
	}
	// Restore read-only.
	for _, p := range expandAll(opts.RestoreRO, home) {
		fmt.Fprintf(&b, "(allow file-read* %s)\n", sbPathRule(p))
	}
	// Network.
	if !opts.Network.Enabled {
		b.WriteString("(deny network*)\n")
	}

	// Copy-on-write mounts. macOS has no overlay primitive in Seatbelt, but APFS
	// has block-level copy-on-write clones, so we clone Lower into Dest (instant,
	// only changed blocks ever cost space). Dest is under WORK_DIR, so it is
	// already writable; the agent edits its private clone and Lower is untouched.
	for _, m := range opts.CowMounts {
		if err := cowClone(m); err != nil {
			fmt.Fprintf(os.Stderr, "hydra: COW clone %s -> %s failed, continuing without it: %v\n", m.Lower, m.Dest, err)
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
		"-D", "WORK_DIR=" + opts.WorktreePath,
		"-D", "HOME_DIR=" + home,
	}
	// Optionally run the configured pre-spawn script first; it execs into Argv
	// when it falls through.
	args = append(args, withPreSpawn(opts.PreSpawnScript, opts.Argv)...)

	return &Spec{
		Path:    sandboxExec,
		Args:    args,
		Env:     opts.Env,
		Dir:     opts.WorktreePath,
		Cleanup: func() { _ = os.Remove(profilePath) },
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
	quoted := strings.ReplaceAll(p, `"`, `\"`)
	if info, err := os.Stat(p); err == nil && !info.IsDir() {
		return `(literal "` + quoted + `")`
	}
	return `(subpath "` + quoted + `")`
}
