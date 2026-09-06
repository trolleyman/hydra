//go:build darwin

package heads

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/statepath"
)

var stagedHydraRuntime struct {
	sync.Once
	path string
	err  error
}

func hydraRuntimeForSandbox() (*hydraRuntime, error) {
	stagedHydraRuntime.Do(func() {
		stagedHydraRuntime.path, stagedHydraRuntime.err = stageHydraRuntime()
	})
	if stagedHydraRuntime.err != nil {
		return nil, errtrace.Wrap(stagedHydraRuntime.err)
	}
	return &hydraRuntime{
		VisiblePath:    stagedHydraRuntime.path,
		ImmutablePaths: []string{stagedHydraRuntime.path},
	}, nil
}

func stageHydraRuntime() (string, error) {
	sourcePath, err := os.Executable()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("resolve hydra executable: %w", err))
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("open hydra executable: %w", err))
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, source); err != nil {
		_ = source.Close()
		return "", errtrace.Wrap(fmt.Errorf("hash hydra executable: %w", err))
	}
	if err := source.Close(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("close hydra executable: %w", err))
	}

	runtimeRoot, err := statepath.RuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	buildDir := filepath.Join(runtimeRoot, hex.EncodeToString(hash.Sum(nil)))
	destination := filepath.Join(buildDir, "hydra-internal")
	if info, err := os.Stat(destination); err == nil && info.Mode().IsRegular() {
		return destination, nil
	}
	if err := os.MkdirAll(buildDir, 0o700); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create runtime directory: %w", err))
	}

	source, err = os.Open(sourcePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("reopen hydra executable: %w", err))
	}
	defer source.Close()
	tmp, err := os.CreateTemp(buildDir, ".hydra-internal-*")
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create staged hydra executable: %w", err))
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := io.Copy(tmp, source); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("copy hydra executable: %w", err))
	}
	if err := tmp.Chmod(0o500); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("protect staged hydra executable: %w", err))
	}
	if err := tmp.Sync(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("sync staged hydra executable: %w", err))
	}
	if err := tmp.Close(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("close staged hydra executable: %w", err))
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		if info, statErr := os.Stat(destination); statErr == nil && info.Mode().IsRegular() {
			return destination, nil
		}
		return "", errtrace.Wrap(fmt.Errorf("publish staged hydra executable: %w", err))
	}
	committed = true
	return destination, nil
}
