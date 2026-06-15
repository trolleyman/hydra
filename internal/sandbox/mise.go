package sandbox

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// miseTrustTimeout bounds the `mise trust --show` probe so a hung or wedged
// mise can't stall head spawning / artifact generation.
const miseTrustTimeout = 5 * time.Second

// MiseTrustEnv returns a MISE_TRUSTED_CONFIG_PATHS override that trusts a
// checkout dir's copied mise config — but only when the host already trusts the
// project's mise config. mise trust is path-based, so a copy of the project's
// mise.toml living at a different path (a linked worktree, or an artifact
// generator's ephemeral checkout) would otherwise prompt or error. Returns nil
// when there's nothing to do (runDir is the project root, or — including when
// mise is missing, errors, or emits unparseable output — the host doesn't
// demonstrably trust the project).
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
// config, via `mise trust --show`. It degrades safely to false whenever it
// can't get a clear "trusted" answer: mise not on PATH, the command erroring or
// timing out, or output that doesn't include projectRoot. Only an explicit
// "<projectRoot>: trusted" line yields true.
func hostTrustsMiseConfig(projectRoot string) bool {
	if _, err := exec.LookPath("mise"); err != nil {
		return false // mise not installed
	}
	ctx, cancel := context.WithTimeout(context.Background(), miseTrustTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "mise", "trust", "--show", "-C", projectRoot).Output()
	if err != nil {
		return false // mise errored, timed out, or was killed
	}
	home, _ := os.UserHomeDir()
	return parseMiseTrusted(string(out), projectRoot, home)
}

// parseMiseTrusted scans `mise trust --show` output (lines of "<path>: <status>")
// for projectRoot and reports whether its status is exactly "trusted". A leading
// "~" in a path is expanded against home. Unparseable or non-matching output
// yields false, so garbage from a wedged or unrelated `mise` binary can never be
// mistaken for trust.
func parseMiseTrusted(out, projectRoot, home string) bool {
	for _, line := range strings.Split(out, "\n") {
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
