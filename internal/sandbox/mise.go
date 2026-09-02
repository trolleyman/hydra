package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// miseTrustTimeout bounds the `mise trust --show` probe so a hung or wedged
// mise can't stall head spawning / artifact generation.
const miseTrustTimeout = 5 * time.Second

// MiseEnv returns the host mise state that a sandbox may safely reuse. The
// resolved MISE_INSTALL_PATH is a read-only executable, not mutable mise state;
// retaining it keeps mise.run-backed shims from downloading the launcher again
// after RuntimeEnv assigns each sandbox a private MISE_DATA_DIR.
//
// It also returns a MISE_TRUSTED_CONFIG_PATHS override that trusts a checkout
// dir's copied mise config - but only when the host already trusts the project's
// mise config. mise trust is path-based, so a copy of the project's mise.toml
// living at a different path (a linked worktree, or an artifact generator's
// ephemeral checkout) would otherwise prompt or error.
func MiseEnv(projectRoot, runDir string) []string {
	return miseEnv(projectRoot, runDir, hostMiseInstallPath())
}

func miseEnv(projectRoot, runDir, installPath string) []string {
	var env []string
	if installPath != "" {
		env = append(env, "MISE_INSTALL_PATH="+installPath)
	}
	if runDir == "" || runDir == projectRoot {
		return env // no separate dir: the project path is already trusted
	}
	if !hostTrustsMiseConfig(projectRoot) {
		return env
	}
	val := runDir
	if existing := os.Getenv("MISE_TRUSTED_CONFIG_PATHS"); existing != "" {
		val = existing + string(os.PathListSeparator) + runDir
	}
	return append(env, "MISE_TRUSTED_CONFIG_PATHS="+val)
}

// hostMiseInstallPath asks an existing mise.run launcher which bootstrap binary
// it has already resolved. The probe is offline and only runs when a bootstrap
// executable already exists in mise's host data/cache locations, so this helper
// cannot turn discovery into an installation or network request. A directly
// exported MISE_INSTALL_PATH takes precedence and needs no subprocess.
func hostMiseInstallPath() string {
	if installPath := os.Getenv("MISE_INSTALL_PATH"); validMiseInstallPath(installPath) {
		return installPath
	}
	if runtime.GOOS == "windows" || !hostHasMiseBootstrap() {
		return ""
	}
	if _, err := exec.LookPath("mise"); err != nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), miseTrustTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "mise", "--no-config", "exec", "--", "sh", "-c", `printf '%s\n' "${MISE_INSTALL_PATH:-}"`)
	cmd.Env = setEnvValue(os.Environ(), "MISE_OFFLINE", "1")
	cmd.Env = setEnvValue(cmd.Env, "MISE_AUTO_UPDATE", "0")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	installPath := strings.TrimSpace(string(out))
	if !validMiseInstallPath(installPath) {
		return ""
	}
	return installPath
}

func validMiseInstallPath(path string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func hostHasMiseBootstrap() bool {
	home, _ := os.UserHomeDir()
	dataDir := os.Getenv("MISE_DATA_DIR")
	if dataDir == "" {
		if xdgData := os.Getenv("XDG_DATA_HOME"); xdgData != "" {
			dataDir = filepath.Join(xdgData, "mise")
		} else if home != "" {
			dataDir = filepath.Join(home, ".local", "share", "mise")
		}
	}
	cacheDir := os.Getenv("XDG_CACHE_HOME")
	if cacheDir == "" && home != "" {
		cacheDir = filepath.Join(home, ".cache")
	}
	for _, dir := range []string{filepath.Join(expandMiseHome(dataDir, home), "bootstrap"), filepath.Join(expandMiseHome(cacheDir, home), "mise")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "mise-") && validMiseInstallPath(filepath.Join(dir, entry.Name())) {
				return true
			}
		}
	}
	return false
}

func expandMiseHome(path, home string) string {
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~"+string(filepath.Separator)) {
		return filepath.Join(home, path[2:])
	}
	return path
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
