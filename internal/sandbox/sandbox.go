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
	"log"
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
	AgentTypeCodex   AgentType = "codex"
)

// NetworkMode is the desired egress posture for a head, chosen in config. It is
// the *intent*; the runtime may downgrade "hard" to advisory when the kernel
// tooling (pasta+nft) isn't available (surfaced separately via heads.EgressMode).
type NetworkMode string

const (
	// NetOff disables outbound network entirely (own empty netns).
	NetOff NetworkMode = "off"
	// NetUnrestricted allows network with no host filtering.
	NetUnrestricted NetworkMode = "unrestricted"
	// NetAdvisory filters via the HTTP(S)_PROXY allow-list only - every honest
	// client is filtered, but a determined process can bypass it. Chosen when the
	// user explicitly wants proxy-only filtering (no pasta/nft netns).
	NetAdvisory NetworkMode = "advisory"
	// NetHard requests an inescapable pasta-netns + nft boundary. When the
	// boundary can't be built (pasta/nft unavailable, proxy failed to start) it
	// fails closed (no network) - it never degrades to a weaker posture. The
	// config synonym "on" resolves to NetHard.
	NetHard NetworkMode = "hard"
)

// NormalizeNetworkMode canonicalises a mode string, mapping accepted synonyms to
// their canonical NetworkMode. "on" is a synonym for NetHard (the fully-locked
// default posture); every canonical value maps to itself. Unknown strings are
// returned unchanged so callers can still reject them via ValidNetworkMode.
func NormalizeNetworkMode(s string) NetworkMode {
	switch NetworkMode(s) {
	case "on":
		return NetHard
	default:
		return NetworkMode(s)
	}
}

// ValidNetworkMode reports whether s names a known mode (empty is allowed: it
// means "use the default"). Accepted synonyms (e.g. "on" for "hard") are valid.
func ValidNetworkMode(s string) bool {
	switch NormalizeNetworkMode(s) {
	case "", NetOff, NetUnrestricted, NetAdvisory, NetHard:
		return true
	}
	return false
}

// GitIsolationMode is how much of the repo's shared .git a head may write, chosen
// per head in config (see GIT_ISOLATION.md). It bounds the blast radius of the
// agent's git activity, from "accidentally commits to the wrong branch" up to "a
// rogue agent physically cannot damage the real repo".
type GitIsolationMode string

const (
	// GitIsolationOff is today's behaviour: the whole shared common dir is bound
	// writable, guarded only by the decision gate (heuristic, not a boundary).
	GitIsolationOff GitIsolationMode = "off"
	// GitIsolationRefs binds refs/ + packed-refs read-only (objects + the
	// per-worktree gitdir stay writable): no ref can be updated in-sandbox, so a
	// commit can't land on main or a sibling and the head can't leave its branch.
	// An anti-accident guard only - the writable objects/ still lets a rogue agent
	// destroy the shared object store. Commits are host-mediated.
	GitIsolationRefs GitIsolationMode = "refs"
	// GitIsolationReadonly binds the whole common dir read-only: the agent cannot
	// write .git at all (no commit, add, stash, or object destruction). Staging and
	// commit are host-mediated. Anti-rogue; costs in-sandbox git add / history edit.
	GitIsolationReadonly GitIsolationMode = "readonly"
	// GitIsolationClone gives the head its own standalone repo borrowing main's
	// objects read-only via git alternates: full native git, a rogue agent can only
	// trash its own private store, and the daemon mirrors the branch back into the
	// main repo (see docs/git-isolation.md).
	GitIsolationClone GitIsolationMode = "clone"
)

// NormalizeGitIsolation canonicalises a git-isolation string. Every canonical
// value maps to itself; unknown strings are returned unchanged so callers can
// reject them via ValidGitIsolation.
func NormalizeGitIsolation(s string) GitIsolationMode {
	return GitIsolationMode(s)
}

// ValidGitIsolation reports whether s names a known mode (empty allowed: "use the
// default", which is off).
func ValidGitIsolation(s string) bool {
	switch NormalizeGitIsolation(s) {
	case "", GitIsolationOff, GitIsolationRefs, GitIsolationReadonly, GitIsolationClone:
		return true
	}
	return false
}

// HostMediatedCommit reports whether commits for this mode must run on the host
// (refs are read-only in the sandbox, so an in-sandbox commit can't update a ref).
func (m GitIsolationMode) HostMediatedCommit() bool {
	return m == GitIsolationRefs || m == GitIsolationReadonly
}

// NetworkPolicy controls the sandbox's network access.
type NetworkPolicy struct {
	// Enabled allows outbound network access when true. When false the agent
	// runs with no network at all. Derived from Mode.
	Enabled bool
	// FilterHosts, when true, enforces AllowedHosts as a deny-by-default allow-list
	// (only listed hosts are reachable; an empty list blocks all egress). When
	// false, every host is reachable (subject to Enabled). Derived from Mode.
	FilterHosts bool
	// Mode is the resolved egress posture (off/unrestricted/advisory/hard). It
	// decides whether startEgress attempts the hard pasta+nft boundary; hard
	// fails closed (no network) when that boundary can't be built.
	Mode NetworkMode
	// AllowedHosts is the user's outbound host allow-list, unioned on top of
	// DefaultAllowedHosts and enforced by the egress proxy when FilterHosts is true
	// (exact host or *.suffix wildcard).
	AllowedHosts []string
	// BlockedHosts overrides the effective allow-list (user + defaults): a host
	// matching BlockedHosts is denied even if it is otherwise allowed.
	BlockedHosts []string
	// AllowedLoopbackPorts lists host-loopback TCP ports the sandbox may reach
	// even in hard mode, where the pasta netns otherwise cuts off the host's
	// 127.0.0.1 entirely (pasta splices in-namespace connections to
	// 127.0.0.1:<port> through to the host's loopback). Lets a head talk to a
	// host-local daemon that hardcodes loopback, e.g. adb's server on 5037.
	// Irrelevant outside hard mode: off has no network, and the other modes share
	// the host's loopback anyway.
	AllowedLoopbackPorts []int
}

// DefaultAllowedHosts is the built-in egress allow-list applied whenever host
// filtering is on. It covers what an agent realistically needs to function - the
// common package registries and git hosts every agent shares, plus the
// AI-provider API hosts specific to the given agent type - so that turning on
// deny-by-default filtering does not immediately break every agent. Scoping the
// provider hosts to the agent that uses them means a Claude agent's defaults
// don't silently grant reach to OpenAI's API, and vice versa. User AllowedHosts
// are unioned on top; a host can be subtracted again via BlockedHosts.
func DefaultAllowedHosts(t AgentType) []string {
	return append(InfraAllowedHosts(), providerAllowedHosts(t)...)
}

// InfraAllowedHosts is the shared, provider-independent part of the built-in
// egress allow-list: the package registries, language toolchains, and git hosts
// every agent needs regardless of which AI provider it uses. Kept separate from
// the provider hosts (see ProviderHostGroups) so callers - including the config
// file's self-documentation - can enumerate the two categories independently.
func InfraAllowedHosts() []string {
	return []string{
		// Package registries + language toolchains.
		"registry.npmjs.org", "*.npmjs.org", "*.yarnpkg.com",
		"pypi.org", "*.pypi.org", "files.pythonhosted.org",
		"*.golang.org", "proxy.golang.org", "sum.golang.org",
		"crates.io", "*.crates.io", "static.crates.io",
		"rubygems.org", "*.rubygems.org",
		// Git hosts + code download endpoints.
		"github.com", "*.github.com", "*.githubusercontent.com", "codeload.github.com",
		"gitlab.com", "*.gitlab.com", "bitbucket.org", "*.bitbucket.org",
	}
}

// ProviderHostGroup pairs an agent type with the AI-provider hosts its defaults
// grant (its own model API, auth, and telemetry).
type ProviderHostGroup struct {
	Type  AgentType
	Hosts []string
}

// ProviderHostGroups returns the per-agent-type AI-provider host lists in a
// stable order. It is the single source of truth for providerAllowedHosts and
// for the config file's documentation, so the enforced defaults and the
// documented defaults can never drift apart. The groups are kept separate from
// the shared infra list (InfraAllowedHosts) so each agent's defaults grant only
// its own provider - a Claude agent's defaults don't silently reach OpenAI's
// API, and vice versa.
func ProviderHostGroups() []ProviderHostGroup {
	return []ProviderHostGroup{
		// Anthropic / Claude, including platform.claude.com and Claude Code's
		// Datadog log intake.
		{AgentTypeClaude, []string{
			"*.anthropic.com", "claude.ai", "*.claude.ai", "*.claudeusercontent.com",
			"platform.claude.com", "http-intake.logs.us5.datadoghq.com",
		}},
		{AgentTypeCodex, []string{
			"api.openai.com", "*.openai.com",
			"chatgpt.com", "*.chatgpt.com", "*.oaiusercontent.com",
		}}, // OpenAI / Codex
		{AgentTypeGemini, []string{"*.googleapis.com"}},
		{AgentTypeCopilot, []string{"*.githubcopilot.com"}},
	}
}

// providerAllowedHosts returns the AI-provider hosts the given agent type talks
// to. bash (and any unknown type) is a general shell that may invoke any of the
// CLIs, so it gets the union of every provider.
func providerAllowedHosts(t AgentType) []string {
	groups := ProviderHostGroups()
	for _, g := range groups {
		if g.Type == t {
			return g.Hosts
		}
	}
	// bash / unknown: union of every provider.
	var all []string
	for _, g := range groups {
		all = append(all, g.Hosts...)
	}
	return all
}

// Bind maps a host path into the sandbox at Target. Used to seed per-head
// agent configuration (settings.json, credentials, the hydra binary, etc.).
type Bind struct {
	Source   string
	Target   string
	ReadOnly bool
}

// CowMount exposes a read-only host directory (Lower) at Dest inside the sandbox
// with copy-on-write semantics: the agent sees Lower's contents and may overwrite
// them, but writes land in Upper (a per-head host dir) and never touch Lower.
//
// The mechanism is platform-specific. Linux mounts an overlayfs (Lower as the
// read-only lower layer, Upper as the writable upper, Work as overlayfs's
// scratch dir) - this needs an overlay-capable bwrap, and falls back to a plain
// read-only bind when that is unavailable. macOS clones Lower into Dest with an
// APFS copy-on-write clone (clonefile); Upper and Work are unused there.
//
// All paths are absolute host paths resolved by the caller (see heads). Dest is
// always under the worktree, so its writes stay within the worktree confinement.
type CowMount struct {
	Lower string // read-only source directory (host)
	Upper string // writable upper layer, persisted per-head (host; Linux only)
	Work  string // overlayfs work dir, same filesystem as Upper (host; Linux only)
	Dest  string // mountpoint inside the sandbox, under the worktree
}

// ROOverlay mounts a read-only overlayfs at Dir, unioning the host's real Dir
// (lower layer) with a per-head Upper layer (a host dir mirroring Dir's layout)
// on top. It exists to expose files that belong under an otherwise read-only
// system directory which does NOT exist on the host - e.g. Claude Code's
// tamper-proof managed settings at /etc/claude-code/managed-settings.json (the
// path is fixed and not relocatable). A plain `--tmpfs /etc/claude-code` cannot
// work there: bwrap must mkdir the mountpoint under the read-only `/` bind, which
// fails with EROFS. Overlaying the already-existing parent Dir sidesteps that.
//
// Linux only, and requires an overlay-capable bwrap (same constraint as
// CowMount). Without one the overlay is skipped with a warning and the injected
// files are simply absent, so callers must degrade gracefully (for Claude this
// means the managed gate/status hooks won't load). The overlay is read-only, so
// a sandboxed agent cannot tamper with the injected files.
type ROOverlay struct {
	Dir   string // existing system dir to overlay (also the mountpoint), e.g. "/etc"
	Upper string // per-head host dir merged on top, mirroring Dir's layout
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
	// GitIsolation controls how much of GitCommonDir is writable in the sandbox
	// (see GIT_ISOLATION.md): off (default) = whole dir writable; refs = refs/ +
	// packed-refs re-bound read-only on top; readonly = the whole common dir bound
	// read-only. clone is handled at the head-lifecycle layer, not here. Empty ==
	// off.
	GitIsolation GitIsolationMode
	// Home is the HOME directory the agent should see.
	Home string

	// TmpDir is a host-backed scratch directory bound over /tmp inside the
	// sandbox (Linux only). When set, the agent's temp files - Claude's
	// scratchpad, test-framework extractions, build junk - are isolated per
	// head and reclaimed when the head is torn down, instead of accumulating on
	// the host's shared /tmp. Empty leaves /tmp as the fresh tmpfs from the base
	// args (used by tests and one-off sandboxes). Ignored on macOS, where /tmp
	// stays host-shared via the static profile.
	TmpDir string

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
	// CowMounts expose read-only host dirs at worktree paths with copy-on-write
	// semantics (overlayfs on Linux, APFS clone on macOS). See CowMount.
	CowMounts []CowMount
	// ROOverlays expose per-head files under otherwise read-only system dirs via a
	// read-only overlayfs (e.g. /etc/claude-code/managed-settings.json under /etc).
	// Linux only; requires an overlay-capable bwrap (skipped + warned otherwise).
	ROOverlays []ROOverlay

	// Env is the environment for the sandboxed process.
	Env []string
	// Argv is the command to run inside the sandbox (e.g. claude --resume).
	Argv []string
	// StdioPipes runs the process on plain stdin/stdout pipes instead of a PTY
	// (stderr folds into the daemon log). Used by chat-mode heads, whose stdout
	// is a JSONL protocol stream that must not pass through a
	// terminal device (echo and CRLF translation would corrupt it). Honoured by
	// the namespace-host spawn path; resize is a no-op for such sessions.
	StdioPipes bool
	// PreSpawnScript is an optional shell script run inside the sandbox via
	// /bin/bash immediately before Argv (same worktree, env and confinement). The
	// real command execs after it returns; an explicit non-zero `exit` (or a
	// `set -e` failure) aborts the launch and prints a diagnostic to the terminal
	// (see preSpawnExitTrap). Empty to skip. Ignored when NoSandbox is set.
	//
	// The script is given $HYDRA_ENV, a path it can append `KEY=value` lines to;
	// each is exported into the environment the agent (and every command it runs)
	// inherits, so a pre-spawn script can set static env vars for the whole head
	// (see preSpawnEnvSetup / preSpawnEnvApply).
	PreSpawnScript string

	// EgressWrap, when set, transforms the assembled bwrap argv into a final argv
	// run in its place (argv[0] is the executable). Hydra uses it to wrap bwrap in
	// a pasta network namespace with an nft egress lock, giving a hard
	// allow-listed-egress boundary (see internal/egress). Linux only; nil = run
	// bwrap directly. Ignored when NoSandbox is set.
	//
	// preExec is a shell snippet the wrapper must run in the innermost shell
	// (inside the netns, holding CAP_NET_ADMIN) right before it execs bwrap. Hydra
	// uses it to reopen the seccomp blob by path onto bwrap's --seccomp fd, because
	// the fd Go inherits to the immediate child (pasta) does not survive pasta's
	// re-exec + netns fork. Empty when there is nothing to inject.
	EgressWrap func(bwrapArgv []string, preExec string) []string

	// HardenGUI hides the per-user runtime dir and unsets DISPLAY/WAYLAND/etc
	// so the agent cannot drive the desktop session. Default true.
	HardenGUI bool
	// Seccomp applies the embedded syscall blocklist on Linux when true.
	Seccomp bool
	// NoSandbox runs Argv directly on the host with no confinement at all (full
	// host access). Used only for the user-opted-in "regular shell"; never for
	// agents. All other sandbox fields are ignored when set.
	NoSandbox bool
}

// StrictShellPreamble makes a bash `-c` script fail-fast: errexit (`set -e`, so a
// failing command aborts the script) plus pipefail (so a failure anywhere in a
// pipeline propagates rather than being hidden by the last stage's exit code).
// Without it a mid-script failure whose final command happens to exit 0 is
// silently swallowed - which would cache a half-broken artifact render as a
// success, or read a service that failed its setup as healthy. nounset (`-u`) is
// deliberately NOT included: config scripts routinely read optional environment
// variables, and aborting on the first unset one would break too many real
// scripts. A script opts out of strict mode by leading with `set +e` /
// `set +o pipefail` (or, for [[artifacts]]/[[services]], `strict = false`).
const StrictShellPreamble = "set -eo pipefail\n"

// StrictScript prepends StrictShellPreamble to a user-supplied config.toml
// command so its failures propagate. Used for the `bash -c <command>` config
// commands ([[artifacts]], [[services]], pre_exit_script). pre_spawn applies the
// same preamble inline (only when its interpreter is bash - see withPreSpawn).
func StrictScript(command string) string {
	return StrictShellPreamble + command
}

// interpIsBash reports whether an interpreter command line (as returned by
// preSpawnInterp) runs bash - either a direct `#!/<...>/bash` or a
// `#!/<...>/env bash`. Only then can a pre-spawn script safely take the
// bash-only StrictShellPreamble; a non-bash interpreter (zsh, dash, ...) is left
// untouched (`set -o pipefail` is a bashism dash rejects outright). The default
// (no shebang) is ["/bin/bash"], so plain scripts get strict mode.
func interpIsBash(interp []string) bool {
	if len(interp) == 0 {
		return false
	}
	if filepath.Base(interp[0]) == "bash" {
		return true
	}
	if filepath.Base(interp[0]) == "env" {
		for _, f := range interp[1:] {
			if f == "" || strings.HasPrefix(f, "-") {
				continue // skip env's own flags / VAR=val assignments
			}
			if strings.Contains(f, "=") {
				continue
			}
			return filepath.Base(f) == "bash" // first program word
		}
	}
	return false
}

// preSpawnExitTrap is installed before the pre-spawn script runs and fires only
// when the script aborts the launch: an explicit `exit N`, or a `set -e` failure,
// terminates the shell before it reaches `exec`, leaving this EXIT trap to run.
// It prints a clear, greppable diagnostic to the terminal so a gated launch reads
// as "your pre_spawn_script failed" rather than an agent that died on startup for
// no visible reason (the same failure mode on spawn and on resume). The trap is
// cleared immediately before `exec`, and a successful `exec` replaces the process
// image, so a script that falls through never triggers it.
const preSpawnExitTrap = `trap 'hydra_ec=$?; printf "\n[hydra] pre_spawn_script failed (exit %s) - agent not started; fix or clear pre_spawn_script, then relaunch\n" "$hydra_ec" >&2' EXIT`

// PreSpawnEnvFileName is the basename of the file the pre-spawn wrapper persists
// the resolved $HYDRA_ENV to, inside the per-head /tmp (Options.TmpDir, mounted at
// /tmp in the sandbox). When a launch persists it, the daemon reads it back from
// the host side of that same dir to inject the identical vars into the head's
// sibling sandboxed bash shells - so a "+"-tab shell sees the same environment the
// pre_spawn_script set up for the agent, without re-running the script.
const PreSpawnEnvFileName = "hydra-pre-spawn.env"

// SandboxPreSpawnEnvFile returns the sandbox-visible path the pre-spawn wrapper
// persists resolved env vars to (the per-head TmpDir is bind-mounted at /tmp), or
// "" when there is no host-backed TmpDir to persist into - in which case the
// wrapper falls back to an ephemeral temp file and nothing is shared with shells.
func SandboxPreSpawnEnvFile(tmpDir string) string {
	if tmpDir == "" {
		return ""
	}
	return "/tmp/" + PreSpawnEnvFileName
}

// HostPreSpawnEnvFile returns the host path of that same persisted file, for the
// daemon to read back. "" when tmpDir is empty (nothing was persisted).
func HostPreSpawnEnvFile(tmpDir string) string {
	if tmpDir == "" {
		return ""
	}
	return filepath.Join(tmpDir, PreSpawnEnvFileName)
}

// preSpawnEnvSetup points $HYDRA_ENV at a writable file before the user's script
// runs, so the script can persist environment variables into the launched agent
// by appending `KEY=value` lines to it (the GitHub Actions $GITHUB_ENV model) -
// e.g. `echo "GRADLE_USER_HOME=/tmp/gradle-iso" >> "$HYDRA_ENV"`. This is an
// explicit, no-surprises channel that does not rely on the script's own `export`s
// surviving into the agent. When envFile is set it is a fixed per-head path
// (truncated fresh each launch) that survives for the daemon to read back and
// share with sibling shells; when empty it is an ephemeral temp file in $TMPDIR
// (the per-head /tmp), reclaimed with the head.
func preSpawnEnvSetup(envFile string) string {
	if envFile == "" {
		return `export HYDRA_ENV="$(mktemp "${TMPDIR:-/tmp}/hydra-env.XXXXXX")"`
	}
	// envFile is a trusted internal constant path (no single quotes), so a
	// single-quoted assignment is safe; truncate it so a prior launch's vars do
	// not linger.
	return "export HYDRA_ENV='" + envFile + "'\n: > \"$HYDRA_ENV\""
}

// preSpawnEnvApply runs after the user's script and before `exec`s the agent: it
// reads back every `KEY=value` line the script wrote to $HYDRA_ENV and exports it
// into the environment the agent (and every command it later runs) inherits.
// Each line is exported literally - no shell evaluation of the value - so spaces
// and metacharacters are preserved and there is no accidental command
// substitution; blank lines and `#` comments are skipped. These vars OVERRIDE any
// existing value in the agent's environment. HYDRA_ENV is then unset so it does
// not leak to the agent (appending to it post-spawn has no effect). An ephemeral
// file is also removed; a persisted one (persist=true) is kept so the daemon can
// read it back for the head's sibling shells. A malformed line (bad identifier)
// fails under strict mode and gates the launch with the pre_spawn_script
// diagnostic, same as any other script error.
func preSpawnEnvApply(persist bool) string {
	remove := "\n\trm -f \"$HYDRA_ENV\""
	if persist {
		remove = ""
	}
	return `if [ -n "$HYDRA_ENV" ] && [ -f "$HYDRA_ENV" ]; then
	while IFS= read -r hydra_env_line || [ -n "$hydra_env_line" ]; do
		case "$hydra_env_line" in ''|'#'*) continue ;; esac
		export "$hydra_env_line"
	done < "$HYDRA_ENV"` + remove + `
fi
unset HYDRA_ENV`
}

// withPreSpawn wraps argv so that script runs inside the sandbox before the real
// command. The script shares the agent's shell: falling through it execs argv,
// while an explicit `exit N` (or a `set -e` failure) aborts the launch and prints
// the preSpawnExitTrap diagnostic. Returns argv unchanged when no script is
// configured. Used by the platform BuildSpec impls.
//
// The interpreter honors the script's `#!` shebang line (so e.g. `#!/bin/zsh`
// runs under zsh, `#!/usr/bin/env bash` under bash). With no shebang it defaults
// to /bin/bash, so bashisms like `set -o pipefail` - which dash rejects with
// "Illegal option" - work out of the box. The shebang line itself is a harmless
// comment to the interpreter that ends up running the wrapper.
//
// When that interpreter is bash (the default, or an explicit bash shebang) the
// script also runs under StrictShellPreamble so a failing setup step aborts the
// launch (the EXIT trap reports it) instead of being swallowed; a non-bash
// interpreter is left as-is. Lead the script with `set +e` to opt out.
func withPreSpawn(script, envFile string, argv []string) []string {
	if strings.TrimSpace(script) == "" || len(argv) == 0 {
		return argv
	}
	interp := preSpawnInterp(script)
	body := script
	if interpIsBash(interp) {
		body = StrictShellPreamble + script
	}
	// Run the script in the agent's own shell (so its exports carry into the
	// exec'd agent), guarded by an EXIT trap that reports a gating failure. $0 is
	// the wrapper name; $@ is the original argv, exec'd once the script falls
	// through (the trap is cleared first so exec-failure isn't misreported).
	// preSpawnEnvSetup exposes $HYDRA_ENV to the script; preSpawnEnvApply exports
	// what it wrote there into the agent's environment just before exec. When
	// envFile is set the file is persisted (not removed) for the daemon to read.
	wrapper := strings.Join([]string{
		preSpawnExitTrap,
		preSpawnEnvSetup(envFile),
		body,
		preSpawnEnvApply(envFile != ""),
		"trap - EXIT",
		`exec "$@"`,
	}, "\n")
	cmd := append(interp, "-c", wrapper, "hydra-pre-spawn")
	return append(cmd, argv...)
}

// WrapPreSpawn exposes withPreSpawn for callers that spawn sandboxed children
// outside BuildSpec (the namespace host supervisor), so a configured pre-spawn
// script still runs in-sandbox before the agent. envFile is the sandbox-visible
// path to persist resolved $HYDRA_ENV vars to (see SandboxPreSpawnEnvFile), or ""
// for an ephemeral file. Returns argv unchanged when the script is empty.
func WrapPreSpawn(script, envFile string, argv []string) []string {
	return withPreSpawn(script, envFile, argv)
}

// preSpawnInterp returns the interpreter command line for a pre-spawn script: the
// fields of a leading `#!` shebang (e.g. ["/usr/bin/env", "zsh"]), or the default
// ["/bin/bash"] when the script has none. Invoked as `<interp...> -c <script>`.
func preSpawnInterp(script string) []string {
	s := strings.TrimLeft(script, " \t\r\n")
	if line, ok := strings.CutPrefix(s, "#!"); ok {
		if i := strings.IndexAny(line, "\r\n"); i >= 0 {
			line = line[:i]
		}
		if fields := strings.Fields(line); len(fields) > 0 {
			return fields
		}
	}
	return []string{"/bin/bash"}
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

// ExpandPath expands a leading "~" (to home) and any $VARS in p against the
// given HOME, exactly as the sandbox path lists (writable/masked/restore) are
// expanded. Exported so callers building mounts (see heads) can resolve
// home/absolute config entries the same way. A result that is still relative is
// returned unchanged.
func ExpandPath(p, home string) string { return expandPath(p, home) }

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

// ensureWritableDir best-effort creates a configured writable_path that does not
// yet exist on the host, so a freshly-added cache/store dir (e.g.
// ~/.local/share/aube) is present for the sandbox to bind (Linux) or allow
// (macOS). Without this a writable_path pointing at a not-yet-created dir is
// silently skipped - bwrap won't bind a missing source, and a Seatbelt
// file-write rule can't write under a missing parent.
//
// Scoped to HOME-anchored paths: a config typo can then only ever create a stray
// dir under the user's own HOME, never a system path, and MkdirAll on an absolute
// system path would usually fail on permissions anyway. p must already be
// expanded (see expandPath). Failures are logged and non-fatal - the path is left
// missing and skipped downstream, exactly as before this call existed.
func ensureWritableDir(p, home string) {
	if p == "" || home == "" {
		return
	}
	if _, err := os.Stat(p); err == nil {
		return // already exists - nothing to do
	} else if !os.IsNotExist(err) {
		return // a stat error other than "missing" (e.g. EACCES) - don't touch it
	}
	// Only auto-create paths that resolve to somewhere under HOME.
	rel, err := filepath.Rel(home, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return
	}
	if err := os.MkdirAll(p, 0o755); err != nil {
		log.Printf("sandbox: could not create writable_path %s: %v (leaving it unbound)", p, err)
		return
	}
	log.Printf("sandbox: created missing writable_path %s", p)
}
