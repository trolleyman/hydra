package gate

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestGrantedReadablePathsRoundTripAndDeduplicate(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureGrantedReadablePathsFile(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(string(filepath.Separator), "opt", "sdk")
	if err := AddGrantedReadablePath(dir, path); err != nil {
		t.Fatal(err)
	}
	if err := AddGrantedReadablePath(dir, path+string(filepath.Separator)+"."); err != nil {
		t.Fatal(err)
	}
	got := LoadGrantedReadablePaths(dir)
	if len(got) != 1 || !slices.Contains(got, path) {
		t.Fatalf("grants = %v, want [%s]", got, path)
	}
	info, err := os.Stat(GrantedReadablePathsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("grant store mode = %o, want 600", info.Mode().Perm())
	}
}
