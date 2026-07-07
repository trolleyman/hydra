package preview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/git"
)

// worktreeSyncInterval is how often the worktree channel mirrors the live
// worktree's changes into its own checkout (and re-checks staleness). Frequent
// enough to feel live for HMR servers, cheap enough to run continuously.
const worktreeSyncInterval = 2 * time.Second

// syncLoop mirrors the live worktree into this instance's checkout every
// worktreeSyncInterval until ctx is cancelled (the child exited). Once the
// worktree diverges from what this run built, `stale` latches true so the UI
// can offer a rebuild - file sync alone only visibly updates HMR-style servers,
// not build-then-serve ones.
func (in *instance) syncLoop(ctx context.Context) {
	t := time.NewTicker(worktreeSyncInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fp, err := mirrorWorktree(in.syncFrom, in.runDir, in.syncBaseSHA)
			if err != nil {
				continue
			}
			in.mu.Lock()
			if fp != in.baseFingerprint {
				in.stale = true
			}
			in.mu.Unlock()
		}
	}
}

// mirrorWorktree copies worktreeDir's changes since baseSHA (uncommitted edits,
// post-base commits, and non-ignored untracked files) into checkoutDir and
// removes files deleted from the worktree, then returns a fingerprint of the
// mirrored state. The fingerprint changes whenever the mirrored file set or any
// file's size/mtime changes, so a caller can tell when a running server's code
// has moved on.
func mirrorWorktree(worktreeDir, checkoutDir, baseSHA string) (string, error) {
	changed, deleted, err := git.WorktreeChangesSince(worktreeDir, baseSHA)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	for _, rel := range deleted {
		_ = os.Remove(filepath.Join(checkoutDir, filepath.FromSlash(rel)))
	}
	sort.Strings(changed)
	h := sha256.New()
	for _, rel := range changed {
		src := filepath.Join(worktreeDir, filepath.FromSlash(rel))
		dst := filepath.Join(checkoutDir, filepath.FromSlash(rel))
		info, err := copyFile(src, dst)
		if err != nil {
			continue // a file that vanished mid-sync is fine to skip
		}
		fmt.Fprintf(h, "%s\x00%d\x00%d\n", rel, info.Size(), info.ModTime().UnixNano())
	}
	sort.Strings(deleted)
	for _, rel := range deleted {
		fmt.Fprintf(h, "-%s\n", rel)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// copyFile copies src to dst (creating parent dirs, preserving the source mode)
// and returns the source's FileInfo. Symlinks are followed; a src that is a
// directory is an error (git only lists files).
func copyFile(src, dst string) (os.FileInfo, error) {
	in, err := os.Open(src)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	defer in.Close()
	si, err := in.Stat()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if si.IsDir() {
		return nil, errtrace.Errorf("is a directory: %s", src)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return nil, errtrace.Wrap(err)
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, si.Mode().Perm())
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return nil, errtrace.Wrap(err)
	}
	if err := out.Close(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return si, nil
}
