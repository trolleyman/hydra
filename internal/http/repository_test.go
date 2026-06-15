package http

import "testing"

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
