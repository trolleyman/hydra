package sandbox

// DefaultConfig holds the baked-in sandbox policy. User config in config.toml
// is merged on top of these (additive for the path lists).
type DefaultConfig struct {
	WritablePaths []string
	ReadablePaths []string
	MaskedPaths   []string
}

// Defaults returns the built-in sandbox policy: curated allow-lists of writable
// agent state and readable developer/tool state, plus defense-in-depth masks for
// known credentials and secrets. Paths use "~" and are expanded per-head
// against the agent HOME.
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
			// NB: /tmp is deliberately NOT here. Options.TmpDir provides per-head
			// temporary storage on both Linux and macOS; adding /tmp here would
			// expose the host's shared scratch directory.
		},
		// Readable: user-owned toolchains, immutable caches, and configuration that
		// heads conventionally need. Writable paths are inherently readable and do
		// not need to be repeated here. System runtime paths and PATH directories are
		// added by each platform backend.
		ReadablePaths: []string{
			"~/.cache",
			"~/.gitconfig",
			"~/.gitignore_global",
			"~/.cargo",
			"~/.rustup",
			"~/.gradle",
			"~/.m2/repository",
			"~/.nuget/packages",
			"~/.npm",
			"~/.nvm",
			"~/.bun",
			"~/.deno",
			"~/.pyenv",
			"~/.rbenv",
			"~/.sdkman",
			"~/.jdks",
			"~/.local/bin",
			"~/.local/share/aube",
			"~/.local/share/claude",
			"~/.local/share/codex",
			"~/.local/share/kotlin",
			"~/.local/share/mise",
			"~/.local/share/pnpm",
			"~/.local/share/JetBrains",
			"~/Android/Sdk",
			"~/Library/Android/sdk",
			"~/Library/pnpm",
			"~/.config/git",
			"~/.config/mise/config.toml",
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
			"~/.config/gh",                       // forge credentials
			"~/.config/glab-cli",                 // forge credentials
			"~/.cargo/credentials",               // registry credentials
			"~/.cargo/credentials.toml",          // registry credentials
			"~/.netrc",                           // package manager auth tokens
			"~/.git-credentials",                 // git stored credentials
			"~/.npmrc",                           // npm auth tokens
			"~/.pypirc",                          // PyPI upload tokens
			"~/.zsh_history",                     // shell history
			"~/.bash_history",                    //
			"~/.sh_history",                      //
			"~/.config/mise/config.local.toml",   // mise secrets
			"~/.dotfiles/mise/config.local.toml", //
			"~/Library/Keychains",                // macOS credentials
			"~/Library/Mail",                     // macOS user data
			"~/Library/Messages",                 // macOS user data
			"/Volumes",                           // removable/network volumes on macOS
		},
	}
}

// ProviderWritablePaths returns the credential, configuration, and session
// state needed by one selected agent runtime. Keeping these paths out of the
// common defaults prevents a head from reading or modifying another provider's
// authentication state.
func ProviderWritablePaths(agentType AgentType) []string {
	switch agentType {
	case AgentTypeClaude:
		return []string{"~/.claude", "~/.claude.json"}
	case AgentTypeGemini:
		return []string{"~/.gemini"}
	case AgentTypeCopilot:
		return []string{"~/.copilot"}
	case AgentTypeCodex:
		return []string{"~/.codex"}
	default:
		return nil
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
