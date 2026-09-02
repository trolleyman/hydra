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
func Defaults() DefaultConfig {
	return DefaultConfig{
		// Writable: agent-owned state only. The worktree itself is always writable
		// and added separately. Shared caches and toolchain installations stay
		// read-only: RuntimeEnv redirects common mutable cache/state locations into
		// each sandbox's private temporary directory. Ecosystem-specific caches may
		// still be added explicitly by trusted project config when sharing them is
		// an accepted tradeoff. See SuggestedWritablePaths, surfaced as hints in
		// the generated config.
		WritablePaths: []string{
			"~/.local/share/hydra/logs", // hydra's own log file (trigger-hook writes here)
			"~/.claude",                 // claude config + conversation logs
			"~/.claude.json",            // claude top-level config
			"~/.gemini",                 // gemini config + creds
			"~/.copilot",                // copilot config + creds
			"~/.codex",                  // codex config + creds + session history
			// NB: /tmp is deliberately NOT here. Options.TmpDir provides per-head
			// temporary storage on both Linux and macOS; adding /tmp here would
			// expose the host's shared scratch directory.
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
