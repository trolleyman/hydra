package heads

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// headTmpDir is a head's private temporary directory under the project's Hydra
// state, keyed by head ID. Linux binds it over /tmp; Darwin exposes the real path
// through the standard temp environment variables. Agent scratchpads, build
// junk, and extractions stay isolated per head and are reclaimed on teardown.
func headTmpDir(projectRoot, id string) string {
	return filepath.Join(paths.GetProjectStateDirFromProjectRoot(projectRoot), "tmp", id)
}

// HeadTmpDir returns the host-side path of a head's private /tmp dir, or ""
// when it doesn't exist (an unsandboxed head writing to the real /tmp). Lets
// the daemon resolve sandbox-relative /tmp paths a head reported (e.g. a
// background task's <output-file>) to their host location.
func HeadTmpDir(projectRoot, id string) string {
	if projectRoot == "" || id == "" {
		return ""
	}
	dir := headTmpDir(projectRoot, id)
	if _, err := os.Stat(dir); err != nil {
		return ""
	}
	return dir
}

// ensureHeadTmpDir creates (idempotently) and returns the head's private temp
// directory, ready for the platform sandbox. Returns "" if it cannot be created
// or on empty inputs.
func ensureHeadTmpDir(projectRoot, id string) string {
	if projectRoot == "" || id == "" {
		return ""
	}
	dir := headTmpDir(projectRoot, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("warn: head tmp: create %s: %v", dir, err)
		return ""
	}
	return dir
}

// removeHeadTmpDir deletes a head's private /tmp dir. Best-effort; called during
// head teardown (mirrors removeCowDir).
func removeHeadTmpDir(projectRoot, id string) {
	if projectRoot == "" || id == "" {
		return
	}
	dir := headTmpDir(projectRoot, id)
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("warn: head tmp: remove for %s: %v", id, err)
	}
	_ = os.Remove(filepath.Dir(dir))
}

// withPrivateTempPrompt tells Darwin agents where their private temporary
// storage actually lives. Linux mounts the same host directory at /tmp, so its
// familiar path needs no additional instruction.
func withPrivateTempPrompt(prePrompt, hostTmpDir string) string {
	visible := sandbox.SandboxTempDir(hostTmpDir)
	if visible == "" || visible == "/tmp" {
		return prePrompt
	}
	return strings.TrimRight(prePrompt, "\n") +
		"\n\n- Your private temporary directory is `$TMPDIR` (`" + visible +
		"`). Shared host `/tmp` is inaccessible. Use `$TMPDIR` or `mktemp` for temporary files.\n"
}
