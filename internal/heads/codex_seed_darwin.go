//go:build darwin

package heads

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

func prepareCodexSeedLayout(projectRoot, _ string, id, home string, res *seedResult) (codexSeedLayout, error) {
	hostHome := configuredCodexHome(home)
	runtimeHome := filepath.Join(paths.GetProviderStateDirFromProjectRoot(projectRoot, id), "codex")
	if err := os.MkdirAll(runtimeHome, 0o700); err != nil {
		return codexSeedLayout{}, errtrace.Wrap(fmt.Errorf("create per-head CODEX_HOME: %w", err))
	}
	_ = os.Chmod(runtimeHome, 0o700)

	// File-based authentication is copied once into the persistent per-head home
	// so Codex can refresh it without modifying the user's shared auth file.
	if err := copyFileIfMissing(filepath.Join(hostHome, "auth.json"), filepath.Join(runtimeHome, "auth.json"), 0o600); err != nil {
		return codexSeedLayout{}, errtrace.Wrap(fmt.Errorf("seed Codex authentication: %w", err))
	}
	// Static user extensions remain shared. Their target lives under hostHome,
	// which the Seatbelt profile exposes read-only below.
	for _, name := range []string{"plugins", "prompts", "rules", "skills"} {
		source := filepath.Join(hostHome, name)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(runtimeHome, name)
		if existing, err := os.Readlink(target); err == nil && existing == source {
			continue
		}
		if err := os.RemoveAll(target); err != nil {
			return codexSeedLayout{}, errtrace.Wrap(fmt.Errorf("replace Codex %s link: %w", name, err))
		}
		if err := os.Symlink(source, target); err != nil {
			return codexSeedLayout{}, errtrace.Wrap(fmt.Errorf("link Codex %s: %w", name, err))
		}
	}

	res.Env = append(res.Env, "CODEX_HOME="+runtimeHome)
	res.WritablePaths = append(res.WritablePaths, runtimeHome)
	res.nativeSeedPaths = true
	if filepath.Clean(hostHome) != filepath.Clean(runtimeHome) {
		res.ImmutablePaths = append(res.ImmutablePaths, hostHome)
	}
	return codexSeedLayout{
		hostHome:    hostHome,
		runtimeHome: runtimeHome,
		outputDir:   runtimeHome,
	}, nil
}

func deliverCodexSeedFile(res *seedResult, _ codexSeedLayout, source, _ string, _ bool) {
	res.ImmutablePaths = append(res.ImmutablePaths, source)
}

func copyFileIfMissing(source, target string, mode os.FileMode) error {
	in, err := os.Open(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer in.Close()

	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return errtrace.Wrap(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(target)
		return errtrace.Wrap(err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(target)
		return errtrace.Wrap(err)
	}
	return nil
}
