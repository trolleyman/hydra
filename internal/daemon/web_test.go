package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestWebURLRecord(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	projectRoot := filepath.Join(t.TempDir(), "project")
	if err := WriteDaemonFiles(projectRoot); err != nil {
		t.Fatalf("WriteDaemonFiles: %v", err)
	}

	if err := WriteWebURL(projectRoot, "http://127.0.0.1:49152"); err != nil {
		t.Fatalf("WriteWebURL: %v", err)
	}
	got, err := ReadWebURL(projectRoot)
	if err != nil {
		t.Fatalf("ReadWebURL: %v", err)
	}
	if want := "http://127.0.0.1:49152"; got != want {
		t.Fatalf("ReadWebURL = %q, want %q", got, want)
	}

	RemoveDaemonFiles(projectRoot)
	if _, err := ReadWebURL(projectRoot); err == nil {
		t.Fatal("ReadWebURL succeeded after RemoveDaemonFiles")
	}
}

func TestReadWebURLRejectsStaleOwner(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	root := t.TempDir()
	if err := WriteDaemonFiles(root); err != nil {
		t.Fatal(err)
	}
	if err := WriteWebURL(root, "http://127.0.0.1:49152"); err != nil {
		t.Fatal(err)
	}
	pidFile, _ := pidPath(root)
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid()+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadWebURL(root); err == nil {
		t.Fatal("ReadWebURL accepted a record owned by another pid")
	}
}

func TestWriteWebURLRejectsInvalidURL(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if err := WriteWebURL(t.TempDir(), "not a URL"); err == nil {
		t.Fatal("WriteWebURL accepted an invalid URL")
	}
	if err := WriteWebURL(t.TempDir(), "http://example.com:49152"); err == nil {
		t.Fatal("WriteWebURL accepted a non-loopback URL")
	}
}
