// Package sandbox launches agent processes inside an OS-level sandbox that
// confines filesystem writes to an allow-list and masks credential locations,
// mirroring the approach used by Codex (https://developers.openai.com/codex/concepts/sandboxing).
//
// The concrete mechanism is platform-specific: bubblewrap (bwrap) on Linux,
// sandbox-exec (Seatbelt) on macOS, and a not-yet-supported stub on Windows.
// Each platform file provides BuildSpec and Available; this file holds the
// shared types and helpers.
package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
)

// AgentType identifies which AI agent runs inside the sandbox.
type AgentType string

const (
	AgentTypeClaude  AgentType = "claude"
	AgentTypeGemini  AgentType = "gemini"
	AgentTypeBash    AgentType = "bash"
	AgentTypeCopilot AgentType = "copilot"
)

// NetworkPolicy controls the sandbox's network access.
type NetworkPolicy struct {
	// Enabled allows outbound network access when true. When false the agent
	// runs with no network at all.
	Enabled bool
	// AllowedHosts is reserved for a future proxy-based host allow-list. It is
	// not enforced yet; an empty list with Enabled=true means "all hosts".
	AllowedHosts []string
}

// Bind maps a host path into the sandbox at Target. Used to seed per-head
// agent configuration (settings.json, credentials, the hydra binary, etc.).
type Bind struct {
	Source   string
	Target   string
	ReadOnly bool
}

// Options describes a sandbox launch request. Paths use the host's real
// filesystem layout; "~" and "$VAR" are expanded against Home/the environment.
type Options struct {
	AgentType AgentType

	// WorktreePath is the agent's working directory; always writable.
	WorktreePath string
	// GitCommonDir is the repository's shared git dir (the main repo's .git),
	// bound writable so the agent can commit from its linked worktree. Empty to
	// skip. See git.GetCommonDir.
	GitCommonDir string
	// Home is the HOME directory the agent should see.
	Home string

	// WritablePaths, MaskedPaths and RestoreRO come from config + baked-in
	// defaults (see DefaultSandboxConfig). Masks are applied before restores.
	WritablePaths []string
	MaskedPaths   []string
	RestoreRO     []string

	Network NetworkPolicy

	// Binds are extra host->sandbox mounts (per-head config seeding).
	Binds []Bind
	// TmpfsDirs are directories overlaid with a fresh writable tmpfs inside the
	// sandbox (applied before Binds), so per-head files can be bind-mounted into
	// otherwise read-only locations like $HOME/.hydra.
	TmpfsDirs []string

	// Env is the environment for the sandboxed process.
	Env []string
	// Argv is the command to run inside the sandbox (e.g. claude --resume).
	Argv []string
	// PreSpawnScript is an optional shell script run inside the sandbox via
	// /bin/sh immediately before Argv (same worktree, env and confinement). The
	// real command execs after it returns; an explicit non-zero `exit` in the
	// script aborts the launch. Empty to skip. Ignored when NoSandbox is set.
	PreSpawnScript string

	// HardenGUI hides the per-user runtime dir and unsets DISPLAY/WAYLAND/etc
	// so the agent cannot drive the desktop session. Default true.
	HardenGUI bool
	// Seccomp applies the embedded syscall blocklist on Linux when true.
	Seccomp bool
	// Interactive marks a hands-on shell (not an agent). It keeps the sandbox in
	// the PTY's session so bash gets a controlling terminal and job control,
	// instead of starting a detached new session. Default false (agents don't
	// need job control and benefit from the extra isolation).
	Interactive bool
	// NoSandbox runs Argv directly on the host with no confinement at all (full
	// host access). Used only for the user-opted-in "regular shell"; never for
	// agents. All other sandbox fields are ignored when set.
	NoSandbox bool
}

// withPreSpawn wraps argv so that script runs inside the sandbox (via /bin/sh)
// before the real command. The script shares the agent's shell: falling through
// it execs argv, while an explicit `exit N` aborts the launch. Returns argv
// unchanged when no script is configured. Used by the platform BuildSpec impls.
func withPreSpawn(script string, argv []string) []string {
	if strings.TrimSpace(script) == "" || len(argv) == 0 {
		return argv
	}
	// $0 is the wrapper name; $@ is the original argv, exec'd after the script.
	wrapper := script + "\nexec \"$@\""
	return append([]string{"/bin/sh", "-c", wrapper, "hydra-pre-spawn"}, argv...)
}

// rawSpec builds a launch spec that runs opts.Argv directly on the host with no
// sandbox. Backs the regular (non-sandboxed) shell the user can opt into.
func rawSpec(opts Options) (*Spec, error) {
	if len(opts.Argv) == 0 {
		return nil, errtrace.Wrap(fmt.Errorf("rawSpec: no command to run"))
	}
	return &Spec{
		Path:    opts.Argv[0],
		Args:    opts.Argv,
		Env:     opts.Env,
		Dir:     opts.WorktreePath,
		Cleanup: func() {},
	}, nil
}

// Spec is the fully-resolved launch command produced by BuildSpec. The session
// layer turns it into a PTY-attached process.
type Spec struct {
	// Path is argv[0] (absolute path to bwrap / sandbox-exec).
	Path string
	// Args is the full argv, including Path as Args[0].
	Args []string
	// Env is the process environment.
	Env []string
	// Dir is the working directory for the launcher process itself.
	Dir string
	// ExtraFiles are inherited file descriptors (e.g. the seccomp blob),
	// numbered starting at fd 3 in the child.
	ExtraFiles []*os.File
	// Cleanup releases temporary resources (temp profiles, fds) after the
	// process exits. Always non-nil.
	Cleanup func()
}

// expandPath expands a leading "~" (to home) and any $VARS in p. A trailing
// result that is still relative is returned unchanged.
func expandPath(p, home string) string {
	if p == "" {
		return ""
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		p = filepath.Join(home, p[2:])
	}
	if strings.ContainsRune(p, '$') {
		p = os.Expand(p, func(key string) string {
			if key == "HOME" {
				return home
			}
			return os.Getenv(key)
		})
	}
	return p
}

// expandAll expands every path in the slice and drops empties/duplicates while
// preserving order.
func expandAll(paths []string, home string) []string {
	seen := make(map[string]struct{}, len(paths))
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		e := expandPath(p, home)
		if e == "" {
			continue
		}
		if _, ok := seen[e]; ok {
			continue
		}
		seen[e] = struct{}{}
		out = append(out, e)
	}
	return out
}
