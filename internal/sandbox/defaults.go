package sandbox

// DefaultConfig holds the baked-in sandbox policy. User config in config.toml
// is merged on top of these (additive for the path lists).
type DefaultConfig struct {
	WritablePaths []string
	MaskedPaths   []string
	RestoreRO     []string
}

// Defaults returns the built-in sandbox policy: a curated allow-list of
// writable developer/agent paths, a blocklist of credential + secret
// locations, and read-only restores for tool configs that live under masked
// directories. Paths use "~" and are expanded per-head against the agent HOME.
//
// These mirror sandbox-demo/{linux/claude-sandboxed,macos/sandbox.sb}.
func Defaults() DefaultConfig {
	return DefaultConfig{
		// Writable: broad tool cache/state + toolchain + agent config. The
		// worktree itself is always writable and added separately. This list is
		// deliberately lean - ecosystem-specific build caches (Rust, Gradle,
		// Node, ...) are NOT here; a project adds the ones it uses to
		// [<agent>.sandbox] writable_paths (or cow_paths for per-head isolation).
		// See SuggestedWritablePaths, surfaced as hints in the generated config.
		WritablePaths: []string{
			"~/.cache",                  // broad XDG cache shared by many tools
			"~/.local/share/mise",       // mise version manager (resolves the toolchain)
			"~/.local/share/hydra/logs", // hydra's own log file (trigger-hook writes here)
			"~/.claude",                 // claude config + conversation logs
			"~/.claude.json",            // claude top-level config
			"~/.gemini",                 // gemini config + creds
			"~/.copilot",                // copilot config + creds
			"~/.codex",                  // codex config + creds + session history
			// NB: /tmp is deliberately NOT here. On Linux it is a per-head
			// private dir (Options.TmpDir, bound over /tmp in linux.go) so agent
			// temp files are reclaimed on teardown; on macOS the static profile
			// (profiles/sandbox.sb) allows /tmp writes. Adding it here would
			// re-bind the host's shared /tmp and leak temp across heads.
		},
		// Masked: credential + secret directories/files hidden entirely.
		MaskedPaths: []string{
			"~/.ssh",                             // SSH keys
			"~/.aws",                             // AWS credentials
			"~/.azure",                           // Azure credentials
			"~/.gnupg",                           // GPG keys
			"~/.docker",                          // Docker auth tokens
			"~/.kube",                            // Kubernetes credentials
			"~/.password-store",                  // pass password manager
			"~/.config",                          // global app configuration
			"~/.netrc",                           // package manager auth tokens
			"~/.git-credentials",                 // git stored credentials
			"~/.npmrc",                           // npm auth tokens
			"~/.pypirc",                          // PyPI upload tokens
			"~/.zsh_history",                     // shell history
			"~/.bash_history",                    //
			"~/.sh_history",                      //
			"~/.config/mise/config.local.toml",   // mise secrets
			"~/.dotfiles/mise/config.local.toml", //
		},
		// RestoreRO: re-expose specific tool configs read-only after masking
		// the parent (~/.config). Order matters: restores apply after masks.
		//
		// Deliberately NOT restored: ~/.config/gh (and other forge CLI configs
		// like ~/.config/glab-cli). They hold live API tokens, and `gh auth
		// token` from Bash would hand a head the user's forge identity with no
		// approval step - the gate's Read-tool deny on credential paths can't
		// cover a CLI that reads its own config. A project that accepts heads
		// acting as the user can opt in via [<agent>.sandbox] restore_ro.
		RestoreRO: []string{
			"~/.config/git",              // git global config
			"~/.config/mise/config.toml", // mise global tool versions (config.local.toml secrets stay masked)
		},
	}
}

// SuggestedPath is a per-project writable-path suggestion: a tool cache that is
// NOT writable by default, plus a one-line note on what uses it.
type SuggestedPath struct {
	Path    string
	Purpose string
}

// SuggestedWritablePaths lists common ecosystem build caches kept OUT of the
// baked-in defaults (see Defaults) so the default policy stays lean. A project
// adds the ones it actually uses to [<agent>.sandbox] writable_paths - or, for
// per-head isolation without cross-head lock contention, cow_paths. This is
// purely documentation surfaced in the generated config; nothing enforces it.
func SuggestedWritablePaths() []SuggestedPath {
	return []SuggestedPath{
		{"~/.cargo", "Rust registry + toolchain cache"},
		{"~/.gradle", "Gradle / Android / Kotlin build cache (cow_paths gives per-head isolation)"},
		{"~/.npm", "Node / npm (npx) package cache"},
		{"~/.local/share/kotlin", "Kotlin compiler cache"},
		{"~/.local/share/JetBrains", "JetBrains toolbox"},
		{"~/.local/state", "XDG state (some tools persist logs/history here)"},
	}
}
