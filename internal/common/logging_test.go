package common

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// countBackups returns how many rotated files sit alongside the live log.
func countBackups(t *testing.T, path string) int {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	n := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), filepath.Base(path)+".") {
			n++
		}
	}
	return n
}

func TestRotatingLoggerRotatesAndPrunes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hydra.log")
	// Tiny cap so a handful of writes rolls the file several times.
	rl, err := NewRotatingLogger(path, 64, 2)
	if err != nil {
		t.Fatalf("new logger: %v", err)
	}
	for i := 0; i < 20; i++ {
		if _, err := rl.Write([]byte(strings.Repeat("x", 40) + "\n")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if got := countBackups(t, path); got > 2 {
		t.Errorf("kept %d backups, want at most maxBackups=2", got)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat live log: %v", err)
	}
	if fi.Size() > 64 {
		t.Errorf("live log is %d bytes, want <= maxSize=64", fi.Size())
	}
}

// Every hydra process (CLI, daemon, a foreground server) logs to the same file
// with its own handle. When one rotates, the others must follow the path rather
// than keep writing into the renamed inode - otherwise several "rotated" files
// grow at once and the log directory never shrinks.
func TestRotatingLoggerFollowsRotationByAnotherProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hydra.log")
	a, err := NewRotatingLogger(path, 1<<20, 3)
	if err != nil {
		t.Fatalf("new logger a: %v", err)
	}
	b, err := NewRotatingLogger(path, 1<<20, 3)
	if err != nil {
		t.Fatalf("new logger b: %v", err)
	}

	if _, err := a.Write([]byte("before\n")); err != nil {
		t.Fatalf("a write: %v", err)
	}
	// Stand in for "another process rotated": rename the live file away.
	rotated := path + ".rotated"
	if err := os.Rename(path, rotated); err != nil {
		t.Fatalf("rename: %v", err)
	}

	if _, err := b.Write([]byte("after\n")); err != nil {
		t.Fatalf("b write: %v", err)
	}

	live, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read live log: %v", err)
	}
	if !strings.Contains(string(live), "after") {
		t.Errorf("live log = %q, want it to contain the post-rotation write", live)
	}
	old, err := os.ReadFile(rotated)
	if err != nil {
		t.Fatalf("read rotated log: %v", err)
	}
	if strings.Contains(string(old), "after") {
		t.Errorf("rotated file = %q, want the post-rotation write to have gone to the live file", old)
	}
}
