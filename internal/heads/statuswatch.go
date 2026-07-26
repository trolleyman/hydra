package heads

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/trolleyman/hydra/internal/paths"
)

const (
	// watchReconcile is how often the watcher re-syncs its set of watched status
	// dirs/files against the current project roots - so projects added at runtime,
	// and heads spawned since the last sync, start being watched. A brand-new head's
	// first status write before it is watched is covered by the poller's backstop
	// tick, so this interval only bounds the "not yet instant" window, not correctness.
	watchReconcile = 5 * time.Second
	// watchDebounce coalesces a burst of status.json writes (a run of tool calls, or
	// a hook and a daemon-side write landing together) into a single poke per project
	// so the poller isn't re-run per write.
	watchDebounce = 150 * time.Millisecond
)

// watchStatusDirs watches every project's per-head status files and pokes the
// project root on poke whenever one changes, so RunJSONStatusPoller runs an
// immediate cycle instead of waiting for its backstop tick.
//
// It watches BOTH the status directory and each status file, because they catch
// different writers: the in-sandbox trigger-hook rewrites status.json in place
// (os.WriteFile, same inode) - caught only by a watch on the file itself, since a
// directory watch on the host would not see a write whose parent dentry lives in
// the sandbox mount namespace; the daemon-side WriteAgentStatus renames a temp
// over it (new inode) - caught by the directory watch as a create. Writes made
// inside a sandbox still reach here because the status files are bound at their
// real host paths (same inode), so inotify fires on the host.
//
// Best-effort: if the watcher can't be created (e.g. inotify limits) it logs and
// returns, leaving the poller's periodic tick as the sole trigger.
func watchStatusDirs(ctx context.Context, roots func() []string, poke chan<- string) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("warn: status watcher: create: %v (falling back to periodic poll only)", err)
		return
	}
	defer w.Close()

	// watched maps every watched path (a status dir or a status file) to its
	// project root, so an event's path resolves back to the root to poke.
	watched := map[string]string{}
	reconcile := func() {
		for _, root := range roots() {
			dir := paths.GetStatusDirFromProjectRoot(root)
			if _, ok := watched[dir]; !ok {
				// The dir may not exist until the first head is spawned; retry next tick.
				if err := w.Add(dir); err == nil {
					watched[dir] = root
				}
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
					continue
				}
				p := filepath.Join(dir, e.Name())
				if _, ok := watched[p]; ok {
					continue
				}
				if err := w.Add(p); err == nil {
					watched[p] = root
				}
			}
		}
	}
	reconcile()

	recTicker := time.NewTicker(watchReconcile)
	defer recTicker.Stop()

	// Debounce: collect roots touched since the last flush, emit one poke each on a
	// short timer so a run of writes collapses to a single poll.
	pending := map[string]bool{}
	var flush <-chan time.Time
	rootFor := func(name string) (string, bool) {
		if root, ok := watched[name]; ok { // a watched file
			return root, true
		}
		root, ok := watched[filepath.Dir(name)] // a file inside a watched dir
		return root, ok
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-recTicker.C:
			reconcile()
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			// A removed/renamed-away file drops its (now-stale) watch; forget it so a
			// recreated head with the same id is re-watched on the next reconcile.
			if ev.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				delete(watched, ev.Name)
			}
			// Only content changes matter; ignore chmod-only events.
			if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename) == 0 {
				continue
			}
			if root, ok := rootFor(ev.Name); ok {
				pending[root] = true
				if flush == nil {
					flush = time.After(watchDebounce)
				}
			}
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			log.Printf("warn: status watcher: %v", err)
		case <-flush:
			for root := range pending {
				select {
				case poke <- root:
				default: // poke buffer full; the backstop tick will catch up
				}
				delete(pending, root)
			}
			flush = nil
		}
	}
}
