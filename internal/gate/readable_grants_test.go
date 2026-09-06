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

func TestGrantedReadablePathsRejectsSymlinkStore(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("outside\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, GrantedReadablePathsPath(dir)); err != nil {
		t.Fatal(err)
	}
	if err := EnsureGrantedReadablePathsFile(dir); err == nil {
		t.Fatal("EnsureGrantedReadablePathsFile accepted a symlink store")
	}
	if err := AddGrantedReadablePath(dir, "/opt/sdk"); err == nil {
		t.Fatal("AddGrantedReadablePath accepted a symlink store")
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "outside\n" {
		t.Fatalf("outside file changed: %q, %v", data, err)
	}
}
