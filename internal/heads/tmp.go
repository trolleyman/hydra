package heads

import (
	"log"
	"os"
	"path/filepath"

	"github.com/trolleyman/hydra/internal/paths"
)

// headTmpDir is a head's private /tmp: a host-backed scratch directory under the
// project's .hydra/local, keyed by head ID. It is bound over /tmp inside the
// head's sandbox (sandbox.Options.TmpDir → linux.go) so the agent's temp files
// - Claude's scratchpad, test-framework extractions, build junk - stay isolated
// per head and are reclaimed on teardown instead of accumulating on the host's
// shared /tmp.
func headTmpDir(projectRoot, id string) string {
	return filepath.Join(paths.GetHydraInstanceLocalDirFromProjectRoot(projectRoot), "tmp", id)
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

// ensureHeadTmpDir creates (idempotently) and returns the head's private /tmp
// dir, ready to bind into the sandbox. Returns "" if it can't be created (the
// sandbox then falls back to the fresh tmpfs /tmp) or on empty inputs.
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
	if err := os.RemoveAll(headTmpDir(projectRoot, id)); err != nil {
		log.Printf("warn: head tmp: remove for %s: %v", id, err)
	}
}
