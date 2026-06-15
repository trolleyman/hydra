package sandbox

import (
	"os"
	"os/exec"
	"strings"
)

// MiseTrustEnv returns a MISE_TRUSTED_CONFIG_PATHS override that trusts a
// checkout dir's copied mise config — but only when the host already trusts the
// project's mise config. mise trust is path-based, so a copy of the project's
// mise.toml living at a different path (a linked worktree, or an artifact
// generator's ephemeral checkout) would otherwise prompt or error. Returns nil
// when there's nothing to do (runDir is the project root, or the host doesn't
// trust the project).
func MiseTrustEnv(projectRoot, runDir string) []string {
	if runDir == "" || runDir == projectRoot {
		return nil // no separate dir: the project path is already trusted
	}
	if !hostTrustsMiseConfig(projectRoot) {
		return nil
	}
	val := runDir
	if existing := os.Getenv("MISE_TRUSTED_CONFIG_PATHS"); existing != "" {
		val = existing + string(os.PathListSeparator) + runDir
	}
	return []string{"MISE_TRUSTED_CONFIG_PATHS=" + val}
}

// hostTrustsMiseConfig reports whether the host user trusts projectRoot's mise
// config, via `mise trust --show` (which prints "<path>: <status>" for each
// config in the dir hierarchy). False if mise is absent or the project is untrusted.
func hostTrustsMiseConfig(projectRoot string) bool {
	out, err := exec.Command("mise", "trust", "--show", "-C", projectRoot).Output()
	if err != nil {
		return false
	}
	home, _ := os.UserHomeDir()
	for _, line := range strings.Split(string(out), "\n") {
		idx := strings.LastIndex(line, ": ")
		if idx < 0 {
			continue
		}
		p := strings.TrimSpace(line[:idx])
		status := strings.TrimSpace(line[idx+2:])
		if home != "" && strings.HasPrefix(p, "~") {
			p = home + p[len("~"):]
		}
		if p == projectRoot {
			return status == "trusted"
		}
	}
	return false
}
