package daemon

import (
	"path/filepath"
	"testing"
)

func TestWebURLRecord(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	projectRoot := filepath.Join(t.TempDir(), "project")

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

func TestWriteWebURLRejectsInvalidURL(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if err := WriteWebURL(t.TempDir(), "not a URL"); err == nil {
		t.Fatal("WriteWebURL accepted an invalid URL")
	}
}
