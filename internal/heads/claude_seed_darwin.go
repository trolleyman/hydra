//go:build darwin

package heads

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

func prepareClaudeSeedLayout(projectRoot, id, home, worktreePath string, res *seedResult) (claudeSeedLayout, error) {
	hostConfigDir := configuredClaudeConfigDir(home)
	runtimeConfigDir := filepath.Join(paths.GetProviderStateDirFromProjectRoot(projectRoot, id), "claude")
	if err := os.MkdirAll(runtimeConfigDir, 0o700); err != nil {
		return claudeSeedLayout{}, errtrace.Wrap(fmt.Errorf("create per-head CLAUDE_CONFIG_DIR: %w", err))
	}
	_ = os.Chmod(runtimeConfigDir, 0o700)
	if err := cloneLegacyClaudeTranscript(hostConfigDir, runtimeConfigDir, worktreePath); err != nil {
		return claudeSeedLayout{}, errtrace.Wrap(err)
	}

	// File credentials are copied once so refreshes and logout remain private to
	// the head. Current macOS Claude builds normally authenticate through the
	// Keychain, which remains available without copying any Keychain material.
	if err := copyFileIfMissing(filepath.Join(hostConfigDir, ".credentials.json"), filepath.Join(runtimeConfigDir, ".credentials.json"), 0o600); err != nil {
		return claudeSeedLayout{}, errtrace.Wrap(fmt.Errorf("seed Claude authentication: %w", err))
	}

	// User-authored, effectively static extensions are shared read-only. Session
	// history, caches, file history, and all other provider-owned state stay in
	// the persistent per-head directory and are never shared between heads.
	for _, name := range []string{"CLAUDE.md", "agents", "commands", "keybindings.json", "output-styles", "plugins", "rules", "skills"} {
		source := filepath.Join(hostConfigDir, name)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(runtimeConfigDir, name)
		if existing, err := os.Readlink(target); err == nil && existing == source {
			continue
		}
		if err := os.RemoveAll(target); err != nil {
			return claudeSeedLayout{}, errtrace.Wrap(fmt.Errorf("replace Claude %s link: %w", name, err))
		}
		if err := os.Symlink(source, target); err != nil {
			return claudeSeedLayout{}, errtrace.Wrap(fmt.Errorf("link Claude %s: %w", name, err))
		}
	}

	res.Env = append(res.Env, "CLAUDE_CONFIG_DIR="+runtimeConfigDir)
	res.WritablePaths = append(res.WritablePaths, runtimeConfigDir)
	res.ClaudeSettingSources = "user"
	res.nativeSeedPaths = true
	if filepath.Clean(hostConfigDir) != filepath.Clean(runtimeConfigDir) {
		res.ImmutablePaths = append(res.ImmutablePaths, hostConfigDir)
	}
	return claudeSeedLayout{
		hostConfigDir:    hostConfigDir,
		hostConfigPath:   configuredClaudeConfigPath(home, hostConfigDir),
		runtimeConfigDir: runtimeConfigDir,
		native:           true,
	}, nil
}

// cloneLegacyClaudeTranscript carries a stopped head's pre-redirect conversation
// into its new provider directory exactly once. The source remains untouched so
// upgrading Hydra never destroys the user's existing Claude history.
func cloneLegacyClaudeTranscript(hostConfigDir, runtimeConfigDir, worktreePath string) error {
	if worktreePath == "" || filepath.Clean(hostConfigDir) == filepath.Clean(runtimeConfigDir) {
		return nil
	}
	slug := paths.ClaudeProjectsSlug(worktreePath)
	source := filepath.Join(hostConfigDir, "projects", slug)
	target := filepath.Join(runtimeConfigDir, "projects", slug)
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	if info, err := os.Stat(source); err != nil || !info.IsDir() {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return errtrace.Wrap(fmt.Errorf("create Claude transcript parent: %w", err))
	}
	out, err := exec.Command("cp", "-c", "-R", source, target).CombinedOutput()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("clone legacy Claude transcript: %s: %w", strings.TrimSpace(string(out)), err))
	}
	return nil
}
