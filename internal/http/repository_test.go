package http

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPickDefaultFile(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		want  string
	}{
		{"prefers root README.md", []string{"go.mod", "README.md", "docs/README.md"}, "README.md"},
		{"case-insensitive", []string{"go.mod", "ReadMe.MD"}, "ReadMe.MD"},
		{"readme variant fallback", []string{"go.mod", "README.rst"}, "README.rst"},
		{"ignores nested readmes", []string{"docs/README.md", "src/main.go"}, ""},
		{"none", []string{"go.mod", "main.go"}, ""},
		{"empty", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pickDefaultFile(c.files); got != c.want {
				t.Errorf("pickDefaultFile(%v) = %q, want %q", c.files, got, c.want)
			}
		})
	}
}

func TestResolveSymlink(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, data string) {
		t.Helper()
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	symlink := func(target, rel string) {
		t.Helper()
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, full); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
	}

	git("init", "-q")
	write("real.txt", "hello\n")
	write("docs/page.md", "# page\n")
	symlink("real.txt", "link")           // → file (same dir)
	symlink("link", "link-to-link")       // → another symlink → file
	symlink("../real.txt", "docs/up.txt") // → file via parent dir
	symlink("nope.txt", "broken")         // → missing target
	symlink("/etc/hosts", "abs")          // → absolute (outside repo)
	symlink("../../etc/hosts", "escape")  // → escapes the repo root
	symlink("docs", "dirlink")            // → directory
	symlink("loop-b", "loop-a")           // ↺ cycle
	symlink("loop-a", "loop-b")
	git("add", "-A")
	git("commit", "-qm", "first")

	cases := []struct {
		name       string
		link       string
		wantFinal  string
		wantMode   string
		wantTarget string
		wantOK     bool
	}{
		{"file", "link", "real.txt", "100644", "real.txt", true},
		{"chain", "link-to-link", "real.txt", "100644", "link", true},
		{"relative-up", "docs/up.txt", "real.txt", "100644", "../real.txt", true},
		{"broken", "broken", "", "", "nope.txt", false},
		{"absolute", "abs", "", "", "/etc/hosts", false},
		{"escape", "escape", "", "", "../../etc/hosts", false},
		{"directory", "dirlink", "docs", "040000", "docs", true},
		{"cycle", "loop-a", "", "", "loop-b", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			final, mode, target, ok := resolveSymlink(dir, "HEAD", c.link)
			if ok != c.wantOK || final != c.wantFinal || mode != c.wantMode || target != c.wantTarget {
				t.Errorf("resolveSymlink(%q) = (%q, %q, %q, %v), want (%q, %q, %q, %v)",
					c.link, final, mode, target, ok, c.wantFinal, c.wantMode, c.wantTarget, c.wantOK)
			}
		})
	}
}

func TestLooksBinary(t *testing.T) {
	if looksBinary([]byte("plain text\nwith lines\n")) {
		t.Error("plain text reported as binary")
	}
	if !looksBinary([]byte("has a \x00 null byte")) {
		t.Error("NUL-containing data not reported as binary")
	}
	if looksBinary(nil) {
		t.Error("empty data reported as binary")
	}
}
