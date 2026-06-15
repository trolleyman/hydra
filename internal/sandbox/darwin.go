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
		return rawSpec(opts)
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
