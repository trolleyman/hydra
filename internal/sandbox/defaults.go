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
		// Writable: developer caches + agent state. The worktree itself is
		// always writable and added separately.
		WritablePaths: []string{
			"~/.cache",                  // global tool cache
			"~/.npm",                    // node package manager cache
			"~/.cargo",                  // rust toolchain registry cache
			"~/.gradle",                 // gradle build cache
			"~/.local/share/mise",       // mise version manager
			"~/.local/share/JetBrains",  // JetBrains toolbox
			"~/.local/share/kotlin",     // kotlin compiler cache
			"~/.local/state",            // XDG state (logs, history)
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
		RestoreRO: []string{
			"~/.config/git",              // git global config
			"~/.config/gh",               // GitHub CLI config
			"~/.config/mise/config.toml", // mise global tool versions (config.local.toml secrets stay masked)
		},
	}
}
