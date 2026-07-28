package common

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
)

// (A second, unused LoggingMiddleware used to live here, logging a line per
// request unconditionally. Both real servers wire internal/http's version, so
// this one was only ever a trap for anyone reading the two side by side.)

// RotatingLogger is a simple size-based rotating logger.
type RotatingLogger struct {
	mu         sync.Mutex
	path       string
	maxSize    int64
	maxBackups int
	file       *os.File
}

// NewRotatingLogger creates or opens the log file and returns a RotatingLogger.
func NewRotatingLogger(path string, maxSize int64, maxBackups int) (*RotatingLogger, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, errtrace.Wrap(err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &RotatingLogger{path: path, maxSize: maxSize, maxBackups: maxBackups, file: f}, nil
}

func (r *RotatingLogger) Write(p []byte) (n int, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.file == nil {
		return 0, errtrace.Wrap(fmt.Errorf("logger file is nil"))
	}

	// Another hydra process may have rotated the file out from under us since
	// our last write - see adoptCurrent.
	if err := r.adoptCurrent(); err != nil {
		return 0, errtrace.Wrap(err)
	}

	fi, err := r.file.Stat()
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	if fi.Size()+int64(len(p)) > r.maxSize {
		if err := r.rotate(); err != nil {
			return 0, errtrace.Wrap(err)
		}
	}
	return errtrace.Wrap2(r.file.Write(p))
}

// adoptCurrent re-opens r.path when the file this logger holds is no longer the
// one living there. Every hydra process - the CLI, the daemon, a foreground
// `hydra server` - logs to the same file, each with its own open handle. When
// one of them rotates, a rename leaves the others writing into the renamed
// inode, so several "rotated" files keep growing at once and the directory
// never actually shrinks. Following the path instead makes them all converge on
// the live file.
func (r *RotatingLogger) adoptCurrent() error {
	onDisk, err := os.Stat(r.path)
	if err != nil {
		if !os.IsNotExist(err) {
			return errtrace.Wrap(err)
		}
		return errtrace.Wrap(r.reopen())
	}
	mine, err := r.file.Stat()
	if err != nil || !os.SameFile(onDisk, mine) {
		return errtrace.Wrap(r.reopen())
	}
	return nil
}

// reopen swaps r.file for a fresh append handle on r.path.
func (r *RotatingLogger) reopen() error {
	if r.file != nil {
		r.file.Close()
	}
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return errtrace.Wrap(err)
	}
	r.file = f
	return nil
}

func (r *RotatingLogger) rotate() error {
	// Close current before renaming (Windows won't rename an open file).
	if r.file != nil {
		r.file.Close()
		r.file = nil
	}
	// Rename with timestamp. Local time, to match the timestamps on the lines
	// inside the file - a UTC name over local-time contents made the rotated
	// files look like they held an hour that isn't in them.
	ts := time.Now().Format("20060102-150405")
	newName := fmt.Sprintf("%s.%s", r.path, ts)
	if err := os.Rename(r.path, newName); err != nil {
		// If rename fails because file doesn't exist, ignore
		if !os.IsNotExist(err) {
			return errtrace.Wrap(err)
		}
	}
	// Recreate current log file
	if err := r.reopen(); err != nil {
		return errtrace.Wrap(err)
	}

	// Enforce backups limit
	if err := r.enforceBackups(); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

func (r *RotatingLogger) enforceBackups() error {
	dir := filepath.Dir(r.path)
	base := filepath.Base(r.path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	// collect rotated files matching base.
	type backup struct {
		name string
		mod  time.Time
	}
	var candidates []backup
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, base+".") {
			continue
		}
		// Sort on mtime, not name: the rotated-name format has changed over
		// time (a UTC "...T150405Z" suffix, now a local "...-150405" one) and
		// those two don't interleave in lexical order, so sorting by name would
		// happily delete the newest files and keep the stalest.
		info, err := e.Info()
		if err != nil {
			continue
		}
		candidates = append(candidates, backup{name: name, mod: info.ModTime()})
	}
	if len(candidates) <= r.maxBackups {
		return nil
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].mod.Before(candidates[j].mod) })
	toRemove := len(candidates) - r.maxBackups
	for i := 0; i < toRemove; i++ {
		_ = os.Remove(filepath.Join(dir, candidates[i].name))
	}
	return nil
}
