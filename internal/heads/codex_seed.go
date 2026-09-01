package heads

import (
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
)

type codexSeedLayout struct {
	hostHome    string
	runtimeHome string
	outputDir   string
	filePrefix  string
}

func (l codexSeedLayout) generatedPath(name string) string {
	return filepath.Join(l.outputDir, l.filePrefix+name)
}

func (l codexSeedLayout) visiblePath(name string) string {
	return filepath.Join(l.runtimeHome, name)
}

func configuredCodexHome(home string) string {
	if dir := os.Getenv("CODEX_HOME"); dir != "" {
		return dir
	}
	return filepath.Join(home, ".codex")
}

// writeCodexSeedFile atomically replaces a generated config file. Darwin keeps
// these files in a provider-writable directory, so following an old symlink on
// resume could otherwise redirect the daemon's write outside CODEX_HOME.
func writeCodexSeedFile(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".hydra-codex-seed-*")
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("create temporary Codex seed: %w", err))
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return errtrace.Wrap(err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return errtrace.Wrap(err)
	}
	if err := tmp.Close(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return errtrace.Wrap(fmt.Errorf("install Codex seed %s: %w", path, err))
	}
	return nil
}
